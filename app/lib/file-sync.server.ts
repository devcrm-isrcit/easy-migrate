import { sourceAdminGraphql } from "./definition-sync/source-admin.server";
import {
  createFileSyncJob,
  createFileSyncLog,
  updateFileSyncJob,
} from "./history.server";
import { assertNoUserErrors, targetAdminGraphql } from "./definition-sync/target-admin.server";

type AdminGraphqlClient = Parameters<typeof targetAdminGraphql>[0];
type UploadResource = "IMAGE" | "FILE" | "VIDEO";

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

interface DownloadedFile {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

interface StagedUploadTarget {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
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

function mimeTypeFromFilename(filename: string | null) {
  const normalized = filename?.toLowerCase() ?? "";

  if (normalized.endsWith(".svg")) return "image/svg+xml";
  if (normalized.endsWith(".mp4")) return "video/mp4";
  if (normalized.endsWith(".mov")) return "video/quicktime";
  if (normalized.endsWith(".webm")) return "video/webm";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".pdf")) return "application/pdf";
  if (normalized.endsWith(".txt")) return "text/plain";

  return "application/octet-stream";
}

function normalizeMimeType(headerValue: string | null, filename: string | null) {
  const headerMimeType = headerValue?.split(";")[0]?.trim();

  if (headerMimeType) {
    return headerMimeType;
  }

  return mimeTypeFromFilename(filename);
}

function getUploadResource(contentType: FileRecord["contentType"]): UploadResource {
  if (contentType === "VIDEO") {
    return "VIDEO";
  }

  if (contentType === "FILE") {
    return "FILE";
  }

  return "IMAGE";
}

function getSafeFilename(file: FileRecord) {
  return file.filename ?? `${file.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.bin`;
}

async function downloadSourceFile(file: FileRecord): Promise<DownloadedFile> {
  const response = await fetch(file.sourceUrl);

  if (!response.ok) {
    throw new Error(
      `Failed to download source file: ${response.status} ${response.statusText}.`,
    );
  }

  const filename = getSafeFilename(file);
  const mimeType = normalizeMimeType(
    response.headers.get("content-type"),
    filename,
  );
  const arrayBuffer = await response.arrayBuffer();

  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType,
    filename,
  };
}

async function createStagedUploadTarget(
  admin: AdminGraphqlClient,
  file: FileRecord,
  downloadedFile: DownloadedFile,
) {
  const resource = getUploadResource(file.contentType);
  const data = await targetAdminGraphql<
    {
      stagedUploadsCreate: {
        stagedTargets: StagedUploadTarget[];
        userErrors: Array<{ field?: string[] | null; message: string }>;
      };
    },
    {
      input: Array<{
        filename: string;
        mimeType: string;
        httpMethod: "POST";
        resource: UploadResource;
        fileSize?: string;
      }>;
    }
  >(
    admin,
    `#graphql
      mutation CreateStagedUpload($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      input: [
        {
          filename: downloadedFile.filename,
          mimeType: downloadedFile.mimeType,
          httpMethod: "POST",
          resource,
          fileSize:
            resource === "VIDEO"
              ? String(downloadedFile.buffer.byteLength)
              : undefined,
        },
      ],
    },
  );

  assertNoUserErrors(
    data.stagedUploadsCreate.userErrors,
    "Failed to create staged upload target.",
  );

  const target = data.stagedUploadsCreate.stagedTargets[0];

  if (!target) {
    throw new Error("Shopify did not return a staged upload target.");
  }

  return target;
}

async function uploadFileToStagedTarget(
  target: StagedUploadTarget,
  downloadedFile: DownloadedFile,
) {
  const formData = new FormData();

  for (const parameter of target.parameters) {
    formData.append(parameter.name, parameter.value);
  }

  formData.append(
    "file",
    new Blob([new Uint8Array(downloadedFile.buffer)], {
      type: downloadedFile.mimeType,
    }),
    downloadedFile.filename,
  );

  const response = await fetch(target.url, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to upload staged file: ${response.status} ${response.statusText}.`,
    );
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
  const usesDirectSourceUrl = file.contentType === "IMAGE";
  const originalSource = usesDirectSourceUrl
    ? file.sourceUrl
    : await (async () => {
        const downloadedFile = await downloadSourceFile(file);
        const stagedTarget = await createStagedUploadTarget(
          admin,
          file,
          downloadedFile,
        );
        await uploadFileToStagedTarget(stagedTarget, downloadedFile);
        return stagedTarget.resourceUrl;
      })();

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
          filename: usesDirectSourceUrl ? getSafeFilename(file) : undefined,
          originalSource,
        },
      ],
    },
  );

  assertNoUserErrors(data.fileCreate.userErrors, "Failed to create file.");
  return data.fileCreate.files?.[0] ?? null;
}

export async function fetchFileMigrationPreview({
  sourceShop,
  sourceToken,
  targetShop,
  admin,
}: {
  sourceShop: string;
  sourceToken: string;
  targetShop: string;
  admin: AdminGraphqlClient;
}) {
  const source = {
    shop: sourceShop,
    token: sourceToken,
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
    sourceShop,
    totalSourceFiles: sourceFiles.length,
    transferableFiles: transferableFiles.length,
    skippedExistingFiles: sourceFiles.length - transferableFiles.length,
    files,
  };
}

export async function runFileMigration({
  sourceShop,
  sourceToken,
  targetShop,
  admin,
  selectedFileIds,
}: {
  sourceShop: string;
  sourceToken: string;
  targetShop: string;
  admin: AdminGraphqlClient;
  selectedFileIds?: string[];
}) {
  const source = {
    shop: sourceShop,
    token: sourceToken,
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
  const job = await createFileSyncJob({
    sourceShop,
    targetShop,
    status: "syncing",
  });

  await updateFileSyncJob(job.id, {
    totalSourceFiles: candidateFiles.length,
  });

  try {
    for (const file of candidateFiles) {
      const identifier = file.filename ?? file.sourceUrl;
      const signature = `${file.contentType}:${identifier}`;

      if (targetSignatures.has(signature)) {
        skippedCount += 1;
        const message = "File already exists in target store.";
        logs.push({
          status: "skipped",
          identifier,
          message,
        });
        await createFileSyncLog({
          jobId: job.id,
          status: "skipped",
          identifier,
          message,
        });
        continue;
      }

      try {
        const created = await createTargetFile(admin, file);
        createdCount += 1;
        targetSignatures.add(signature);
        const message = created
          ? `Created file with status ${created.fileStatus}.`
          : "Created file.";
        logs.push({
          status: "created",
          identifier,
          message,
        });
        await createFileSyncLog({
          jobId: job.id,
          status: "created",
          identifier,
          message,
        });
      } catch (error) {
        failedCount += 1;
        const message =
          error instanceof Error ? error.message : "File migration failed.";
        logs.push({
          status: "failed",
          identifier,
          message,
        });
        await createFileSyncLog({
          jobId: job.id,
          status: "failed",
          identifier,
          message,
        });
      }
    }

    await updateFileSyncJob(job.id, {
      status: failedCount > 0 ? "failed" : "completed",
      totalSourceFiles: candidateFiles.length,
      createdCount,
      skippedCount,
      failedCount,
      errorMessage:
        failedCount > 0 ? "One or more files failed to migrate." : null,
    });
  } catch (error) {
    await updateFileSyncJob(job.id, {
      status: "failed",
      totalSourceFiles: candidateFiles.length,
      createdCount,
      skippedCount,
      failedCount,
      errorMessage:
        error instanceof Error ? error.message : "File migration failed.",
    });
    throw error;
  }

  return {
    jobId: job.id,
    sourceShop,
    totalSourceFiles: candidateFiles.length,
    createdCount,
    skippedCount,
    failedCount,
    logs,
  };
}
