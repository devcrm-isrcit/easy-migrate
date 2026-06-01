import { sourceAdminGraphql } from "./source-admin.server";
import { assertNoUserErrors, targetAdminGraphql } from "./target-admin.server";
import { createSyncLog } from "./logger.server";
import {
  getMetaobjectTypeLogicalKey,
  isAppReservedMetaobjectType,
} from "./metaobject-type.server";
import type { GraphqlUserError } from "./types.server";

type AdminGraphqlClient = Parameters<typeof targetAdminGraphql>[0];

const FILE_TYPES = new Set(["file_reference", "list.file_reference"]);
const SKIP_REFERENCE_TYPES = new Set([
  "metaobject_reference",
  "list.metaobject_reference",
  "mixed_reference",
  "list.mixed_reference",
  "product_reference",
  "list.product_reference",
  "collection_reference",
  "list.collection_reference",
  "variant_reference",
  "list.variant_reference",
  "page_reference",
  "list.page_reference",
]);

interface MetaobjectEntry {
  handle: string;
  type: string;
  fields: Array<{ key: string; value: string | null }>;
  capabilities?: {
    publishable?: { status: string };
  };
}

interface MetaobjectsQueryResponse {
  metaobjects: {
    nodes: Array<{
      id: string;
      handle: string;
      type: string;
      fields: Array<{ key: string; value: string | null }>;
      capabilities?: {
        publishable?: { status: string };
      };
    }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
  };
}

async function fetchFieldTypes(
  source: { shop: string; token: string },
  type: string,
): Promise<Map<string, string>> {
  const data: {
    metaobjectDefinitionByType: {
      fieldDefinitions: Array<{ key: string; type: { name: string } }>;
    } | null;
  } = await sourceAdminGraphql({
    shop: source.shop,
    token: source.token,
    query: `#graphql
      query MetaobjectFieldTypes($type: String!) {
        metaobjectDefinitionByType(type: $type) {
          fieldDefinitions {
            key
            type { name }
          }
        }
      }
    `,
    variables: { type },
  });

  const map = new Map<string, string>();
  if (data.metaobjectDefinitionByType) {
    for (const f of data.metaobjectDefinitionByType.fieldDefinitions) {
      map.set(f.key, f.type.name);
    }
  }
  return map;
}

async function fetchSourceFileUrl(
  source: { shop: string; token: string },
  fileGid: string,
): Promise<{ url: string; contentType: "IMAGE" | "VIDEO" | "GENERIC_FILE" } | null> {
  try {
    const data: {
      node: {
        __typename: string;
        image?: { url: string };
        url?: string;
        sources?: Array<{ url: string }>;
      } | null;
    } = await sourceAdminGraphql({
      shop: source.shop,
      token: source.token,
      query: `#graphql
        query FetchFileUrl($id: ID!) {
          node(id: $id) {
            __typename
            ... on MediaImage {
              image { url }
            }
            ... on GenericFile {
              url
            }
            ... on Video {
              sources { url }
            }
          }
        }
      `,
      variables: { id: fileGid },
    });

    if (!data.node) return null;

    if (data.node.__typename === "MediaImage" && data.node.image?.url) {
      return { url: data.node.image.url, contentType: "IMAGE" };
    }
    if (data.node.__typename === "Video" && data.node.sources?.[0]?.url) {
      return { url: data.node.sources[0].url, contentType: "VIDEO" };
    }
    if (data.node.__typename === "GenericFile" && data.node.url) {
      return { url: data.node.url, contentType: "GENERIC_FILE" };
    }

    return null;
  } catch {
    return null;
  }
}

async function createFileInTarget(
  admin: AdminGraphqlClient,
  sourceUrl: string,
  contentType: "IMAGE" | "VIDEO" | "GENERIC_FILE",
): Promise<string | null> {
  try {
    const data: {
      fileCreate: {
        files: Array<{ id: string }> | null;
        userErrors: GraphqlUserError[];
      };
    } = await targetAdminGraphql(
      admin,
      `#graphql
        mutation CreateFile($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files { id }
            userErrors { field message }
          }
        }
      `,
      { files: [{ originalSource: sourceUrl, contentType }] },
    );

    if (data.fileCreate.userErrors.length) return null;
    return data.fileCreate.files?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function migrateFile(
  source: { shop: string; token: string },
  admin: AdminGraphqlClient,
  sourceGid: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  if (cache.has(sourceGid)) return cache.get(sourceGid) ?? null;

  const info = await fetchSourceFileUrl(source, sourceGid);
  if (!info) {
    cache.set(sourceGid, null);
    return null;
  }

  const targetGid = await createFileInTarget(admin, info.url, info.contentType);
  cache.set(sourceGid, targetGid);
  return targetGid;
}

async function processFields(
  source: { shop: string; token: string },
  admin: AdminGraphqlClient,
  fields: Array<{ key: string; value: string | null }>,
  fieldTypes: Map<string, string>,
  fileCache: Map<string, string | null>,
): Promise<{ fields: Array<{ key: string; value: string | null }>; skippedRefs: string[] }> {
  const processed: Array<{ key: string; value: string | null }> = [];
  const skippedRefs: string[] = [];

  for (const field of fields) {
    const ft = fieldTypes.get(field.key);

    if (!ft || !field.value) {
      processed.push(field);
      continue;
    }

    if (ft === "file_reference") {
      const targetGid = await migrateFile(source, admin, field.value, fileCache);
      if (targetGid) {
        processed.push({ key: field.key, value: targetGid });
      } else {
        skippedRefs.push(field.key);
      }
      continue;
    }

    if (ft === "list.file_reference") {
      try {
        const gids: string[] = JSON.parse(field.value);
        const mapped: string[] = [];
        for (const gid of gids) {
          const targetGid = await migrateFile(source, admin, gid, fileCache);
          if (targetGid) mapped.push(targetGid);
        }
        if (mapped.length) {
          processed.push({ key: field.key, value: JSON.stringify(mapped) });
        } else {
          skippedRefs.push(field.key);
        }
      } catch {
        skippedRefs.push(field.key);
      }
      continue;
    }

    if (SKIP_REFERENCE_TYPES.has(ft)) {
      skippedRefs.push(field.key);
      continue;
    }

    processed.push(field);
  }

  return { fields: processed, skippedRefs };
}

async function fetchMetaobjectEntries(
  source: { shop: string; token: string },
  type: string,
): Promise<MetaobjectEntry[]> {
  const entries: MetaobjectEntry[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const data: MetaobjectsQueryResponse = await sourceAdminGraphql({
      shop: source.shop,
      token: source.token,
      query: `#graphql
        query FetchMetaobjectEntries($type: String!, $after: String) {
          metaobjects(type: $type, first: 50, after: $after) {
            nodes {
              id
              handle
              type
              fields {
                key
                value
              }
              capabilities {
                publishable {
                  status
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
      variables: { type, after: cursor },
    });

    entries.push(
      ...data.metaobjects.nodes.map((node: MetaobjectsQueryResponse["metaobjects"]["nodes"][number]) => ({
        handle: node.handle,
        type: node.type,
        fields: node.fields,
        capabilities: node.capabilities,
      })),
    );
    hasNextPage = data.metaobjects.pageInfo.hasNextPage;
    cursor = data.metaobjects.pageInfo.endCursor;
  }

  return entries;
}

async function fetchExistingHandles(
  admin: AdminGraphqlClient,
  type: string,
): Promise<Set<string>> {
  const handles = new Set<string>();
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const data: {
      metaobjects: {
        nodes: Array<{ handle: string }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } = await targetAdminGraphql(
      admin,
      `#graphql
        query ExistingMetaobjectHandles($type: String!, $after: String) {
          metaobjects(type: $type, first: 100, after: $after) {
            nodes { handle }
            pageInfo { hasNextPage endCursor }
          }
        }
      `,
      { type, after: cursor },
    );

    for (const node of data.metaobjects.nodes) {
      handles.add(node.handle);
    }
    hasNextPage = data.metaobjects.pageInfo.hasNextPage;
    cursor = data.metaobjects.pageInfo.endCursor;
  }

  return handles;
}

async function createMetaobjectEntry(
  admin: AdminGraphqlClient,
  entry: MetaobjectEntry,
  targetType: string,
  publishableEnabled: boolean,
) {
  const data = await targetAdminGraphql<
    {
      metaobjectCreate: {
        metaobject: { id: string; handle: string } | null;
        userErrors: GraphqlUserError[];
      };
    },
    { metaobject: Record<string, unknown> }
  >(
    admin,
    `#graphql
      mutation CreateMetaobjectEntry($metaobject: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $metaobject) {
          metaobject {
            id
            handle
          }
          userErrors {
            field
            message
            code
          }
        }
      }
    `,
    {
      metaobject: {
        type: targetType,
        handle: entry.handle,
        capabilities: publishableEnabled && entry.capabilities?.publishable
          ? { publishable: { status: entry.capabilities.publishable.status } }
          : undefined,
        fields: entry.fields
          .filter((f) => f.value !== null)
          .map((f) => ({ key: f.key, value: f.value })),
      },
    },
  );

  assertNoUserErrors(
    data.metaobjectCreate.userErrors,
    `Failed to create metaobject entry ${entry.type}/${entry.handle}.`,
  );

  return data.metaobjectCreate.metaobject;
}

async function ensureWriteAccess(
  admin: AdminGraphqlClient,
  type: string,
): Promise<{ publishableEnabled: boolean }> {
  if (!isAppReservedMetaobjectType(type)) {
    return { publishableEnabled: false };
  }

  const data: {
    metaobjectDefinitionByType: {
      id: string;
      access: { admin: string };
      capabilities?: { publishable?: { enabled: boolean } };
    } | null;
  } = await targetAdminGraphql(
    admin,
    `#graphql
      query MetaobjectAccess($type: String!) {
        metaobjectDefinitionByType(type: $type) {
          id
          access { admin }
          capabilities {
            publishable {
              enabled
            }
          }
        }
      }
    `,
    { type },
  );

  const def = data.metaobjectDefinitionByType;
  if (!def) {
    return { publishableEnabled: false };
  }

  if (def.access.admin === "MERCHANT_READ_WRITE") {
    return {
      publishableEnabled: def.capabilities?.publishable?.enabled ?? false,
    };
  }

  await targetAdminGraphql(
    admin,
    `#graphql
      mutation UpdateMetaobjectAccess($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
        metaobjectDefinitionUpdate(id: $id, definition: $definition) {
          metaobjectDefinition { id }
          userErrors { field message }
        }
      }
    `,
    {
      id: def.id,
      definition: { access: { admin: "MERCHANT_READ_WRITE" } },
    },
  );

  return {
    publishableEnabled: def.capabilities?.publishable?.enabled ?? false,
  };
}

export async function syncMetaobjectContent({
  sourceShop,
  sourceToken,
  admin,
  jobId,
  metaobjectTypes,
  targetTypeBySourceType,
}: {
  sourceShop: string;
  sourceToken: string;
  admin: AdminGraphqlClient;
  jobId: string;
  metaobjectTypes: string[];
  targetTypeBySourceType: Map<string, string>;
}): Promise<{ copiedEntries: number; skippedEntries: number; failedEntries: number }> {
  let copiedEntries = 0;
  let skippedEntries = 0;
  let failedEntries = 0;
  const source = { shop: sourceShop, token: sourceToken };
  const fileCache = new Map<string, string | null>();

  for (const type of metaobjectTypes) {
    try {
      const targetType =
        targetTypeBySourceType.get(type) ??
        targetTypeBySourceType.get(getMetaobjectTypeLogicalKey(type));

      if (!targetType) {
        failedEntries += 1;
        await createSyncLog({
          jobId,
          itemType: "metaobject_entry",
          itemKey: type,
          status: "failed",
          message: "No matching target metaobject definition was found for this source type.",
        });
        continue;
      }

      const { publishableEnabled } = await ensureWriteAccess(admin, targetType);

      const [sourceEntries, existingHandles, fieldTypes] = await Promise.all([
        fetchMetaobjectEntries(source, type),
        fetchExistingHandles(admin, targetType),
        fetchFieldTypes(source, type),
      ]);

      if (sourceEntries.length === 0) {
        await createSyncLog({
          jobId,
          itemType: "metaobject_entry",
          itemKey: type,
          status: "skipped",
          message: "No entries found in source store.",
        });
        continue;
      }

      for (const entry of sourceEntries) {
        if (existingHandles.has(entry.handle)) {
          skippedEntries += 1;
          await createSyncLog({
            jobId,
            itemType: "metaobject_entry",
            itemKey: `${type}/${entry.handle}`,
            status: "exists",
            message: "Entry already exists in target store.",
          });
          continue;
        }

        try {
          const { fields: processedFields, skippedRefs } = await processFields(
            source,
            admin,
            entry.fields,
            fieldTypes,
            fileCache,
          );

          await createMetaobjectEntry(admin, {
            ...entry,
            fields: processedFields,
          }, targetType, publishableEnabled);
          copiedEntries += 1;

          const msg = skippedRefs.length
            ? `Copied entry. Skipped reference fields: ${skippedRefs.join(", ")}`
            : "Copied entry from source store.";

          await createSyncLog({
            jobId,
            itemType: "metaobject_entry",
            itemKey: `${type}/${entry.handle}`,
            status: "created",
            message: msg,
          });
        } catch (error) {
          failedEntries += 1;
          await createSyncLog({
            jobId,
            itemType: "metaobject_entry",
            itemKey: `${type}/${entry.handle}`,
            status: "failed",
            message: error instanceof Error ? error.message : "Failed to create entry.",
          });
        }
      }
    } catch (error) {
      failedEntries += 1;
      await createSyncLog({
        jobId,
        itemType: "metaobject_entry",
        itemKey: type,
        status: "failed",
        message: error instanceof Error ? error.message : "Failed to fetch entries.",
      });
    }
  }

  return { copiedEntries, skippedEntries, failedEntries };
}
