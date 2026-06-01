import prisma from "../db.server";
import { decryptToken } from "./definition-sync/encryption.server";
import { sourceAdminGraphql } from "./definition-sync/source-admin.server";
import { assertNoUserErrors, targetAdminGraphql } from "./definition-sync/target-admin.server";

type AdminGraphqlClient = Parameters<typeof targetAdminGraphql>[0];

interface FileRecord {
  id: string;
  alt: string | null;
  contentType: "IMAGE" | "VIDEO" | "FILE";
  filename: string | null;
  sourceUrl: string;
  alreadyInTarget?: boolean;
}

interface FilesQueryResponse {
  files: {
    edges: Array<{
      node: {
        id: string;
        __typename: string;
        alt: string | null;
        image?: { url: string | null } | null;
        url?: string | null;
        sources?: Array<{ url: string | null } | null> | null;
      };
    }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
}

function filenameFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname;
    const lastSegment = pathname.split("/").filter(Boolean).pop() ?? "";
    return lastSegment || null;
  } catch {
    return null;
  }
}

function normalizeFileNode(
  node: FilesQueryResponse["files"]["edges"][number]["node"],
): FileRecord | null {
  if (node.__typename === "MediaImage" && node.image?.url) {
    return {
      id: node.id,
      alt: node.alt,
      contentType: "IMAGE",
      filename: filenameFromUrl(node.image.url),
      sourceUrl: node.image.url,
    };
  }

  if (node.__typename === "GenericFile" && node.url) {
    return {
      id: node.id,
      alt: node.alt,
      contentType: "FILE",
      filename: filenameFromUrl(node.url),
      sourceUrl: node.url,
    };
  }

  if (node.__typename === "Video" && node.sources?.[0]?.url) {
    return {
      id: node.id,
      alt: node.alt,
      contentType: "VIDEO",
      filename: filenameFromUrl(node.sources[0].url),
      sourceUrl: node.sources[0].url,
    };
  }

  return null;
}

async function fetchFilesFromSource(source: { shop: string; token: string }) {
  const files: FileRecord[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const data: FilesQueryResponse = await sourceAdminGraphql<
      FilesQueryResponse,
      { after?: string | null }
    >({
      shop: source.shop,
      token: source.token,
      query: `#graphql
        query SourceFiles($after: String) {
          files(first: 100, after: $after) {
            edges {
              node {
                id
                __typename
                alt
                ... on MediaImage {
                  image {
                    url
                  }
                }
                ... on GenericFile {
                  url
                }
                ... on Video {
                  sources {
                    url
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      variables: { after: cursor },
    });

    for (const edge of data.files.edges) {
      const normalized = normalizeFileNode(edge.node);
      if (normalized) {
        files.push(normalized);
      }
    }

    hasNextPage = data.files.pageInfo.hasNextPage;
    cursor = data.files.pageInfo.endCursor;
  }

  return files;
}

async function fetchTargetFileSignatures(admin: AdminGraphqlClient) {
  const signatures = new Set<string>();
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const data: FilesQueryResponse = await targetAdminGraphql<
      FilesQueryResponse,
      { after?: string | null }
    >(
      admin,
      `#graphql
        query TargetFiles($after: String) {
          files(first: 100, after: $after) {
            edges {
              node {
                id
                __typename
                alt
                ... on MediaImage {
                  image {
                    url
                  }
                }
                ... on GenericFile {
                  url
                }
                ... on Video {
                  sources {
                    url
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      { after: cursor },
    );

    for (const edge of data.files.edges) {
      const normalized = normalizeFileNode(edge.node);
      if (normalized) {
        signatures.add(
          `${normalized.contentType}:${normalized.filename ?? normalized.sourceUrl}`,
        );
      }
    }

    hasNextPage = data.files.pageInfo.hasNextPage;
    cursor = data.files.pageInfo.endCursor;
  }

  return signatures;
}

async function createTargetFile(
  admin: AdminGraphqlClient,
  file: FileRecord,
) {
  const data = await targetAdminGraphql<
    {
      fileCreate: {
        files: Array<{ id: string; fileStatus: string }> | null;
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    },
    { files: Array<Record<string, unknown>> }
  >(
    admin,
    `#graphql
      mutation CreateFile($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            fileStatus
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      files: [
        {
          alt: file.alt,
          contentType: file.contentType,
          filename: file.filename ?? undefined,
          originalSource: file.sourceUrl,
        },
      ],
    },
  );

  assertNoUserErrors(data.fileCreate.userErrors, "Failed to create file.");
  return data.fileCreate.files?.[0] ?? null;
}

export async function fetchFileMigrationPreview({
  targetShop,
  admin,
}: {
  targetShop: string;
  admin: AdminGraphqlClient;
}) {
  const credential = await prisma.sourceStoreCredential.findUnique({
    where: { targetShop },
  });

  if (!credential) {
    throw new Error("Connect a source store before migrating files.");
  }

  const source = {
    shop: credential.sourceShop,
    token: decryptToken(credential.encryptedToken),
  };

  const [sourceFiles, targetSignatures] = await Promise.all([
    fetchFilesFromSource(source),
    fetchTargetFileSignatures(admin),
  ]);

  const transferableFiles = sourceFiles.filter((file) => {
    const signature = `${file.contentType}:${file.filename ?? file.sourceUrl}`;
    return !targetSignatures.has(signature);
  });
  const files = sourceFiles.map((file) => {
    const signature = `${file.contentType}:${file.filename ?? file.sourceUrl}`;
    return {
      ...file,
      alreadyInTarget: targetSignatures.has(signature),
    };
  });

  return {
    sourceShop: credential.sourceShop,
    totalSourceFiles: sourceFiles.length,
    transferableFiles: transferableFiles.length,
    skippedExistingFiles: sourceFiles.length - transferableFiles.length,
    files,
  };
}

export async function runFileMigration({
  targetShop,
  admin,
  selectedFileIds,
}: {
  targetShop: string;
  admin: AdminGraphqlClient;
  selectedFileIds?: string[];
}) {
  const credential = await prisma.sourceStoreCredential.findUnique({
    where: { targetShop },
  });

  if (!credential) {
    throw new Error("Connect a source store before migrating files.");
  }

  const source = {
    shop: credential.sourceShop,
    token: decryptToken(credential.encryptedToken),
  };

  const [sourceFiles, targetSignatures] = await Promise.all([
    fetchFilesFromSource(source),
    fetchTargetFileSignatures(admin),
  ]);
  const selectedFileIdSet = new Set(selectedFileIds ?? []);
  const hasSelection = selectedFileIdSet.size > 0;
  const candidateFiles = sourceFiles.filter((file) => {
    if (!hasSelection) {
      return true;
    }

    return selectedFileIdSet.has(file.id);
  });

  let createdCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const logs: Array<{
    status: "created" | "skipped" | "failed";
    identifier: string;
    message: string;
  }> = [];

  for (const file of candidateFiles) {
    const identifier = file.filename ?? file.sourceUrl;
    const signature = `${file.contentType}:${identifier}`;

    if (targetSignatures.has(signature)) {
      skippedCount += 1;
      logs.push({
        status: "skipped",
        identifier,
        message: "File already exists in target store.",
      });
      continue;
    }

    try {
      const created = await createTargetFile(admin, file);
      createdCount += 1;
      targetSignatures.add(signature);
      logs.push({
        status: "created",
        identifier,
        message: created
          ? `Created file with status ${created.fileStatus}.`
          : "Created file.",
      });
    } catch (error) {
      failedCount += 1;
      logs.push({
        status: "failed",
        identifier,
        message: error instanceof Error ? error.message : "File migration failed.",
      });
    }
  }

  return {
    sourceShop: credential.sourceShop,
    totalSourceFiles: candidateFiles.length,
    createdCount,
    skippedCount,
    failedCount,
    logs,
  };
}
