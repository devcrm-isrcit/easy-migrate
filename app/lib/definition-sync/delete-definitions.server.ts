import { getAppCreatedDefinitionKeys } from "./logger.server";
import { fetchMetafieldDefinitions } from "./metafield-definitions.server";
import { assertNoUserErrors, targetAdminGraphql } from "./target-admin.server";
import type { GraphqlUserError } from "./types.server";

type AdminGraphqlClient = Parameters<typeof targetAdminGraphql>[0];

export interface DeleteDefinitionsResult {
  deletedMetafieldDefinitions: number;
  deletedMetaobjectDefinitions: number;
  failed: Array<{ type: "metafield" | "metaobject"; key: string; message: string }>;
}

interface CurrentApp {
  id: string;
  title: string;
}

// Shopify resolves a "$app:" reserved namespace/type to "app--<numeric app id>--<name>"
// once it's created. Only the owning app can manage a definition with its own id here,
// so this is a hard, platform-enforced ownership signal.
const APP_OWNED_PREFIX_PATTERN = /^app--(\d+)--/;

function getEmbeddedAppId(value: string): string | null {
  return value.match(APP_OWNED_PREFIX_PATTERN)?.[1] ?? null;
}

function parseNumericAppId(gid: string | null | undefined): string | null {
  return gid?.match(/\/App\/(\d+)/)?.[1] ?? null;
}

async function getCurrentApp(admin: AdminGraphqlClient): Promise<CurrentApp | null> {
  try {
    const data = await targetAdminGraphql<{
      currentAppInstallation: { app: { id: string; title: string } };
    }>(
      admin,
      `#graphql
        query CurrentApp {
          currentAppInstallation {
            app {
              id
              title
            }
          }
        }
      `,
    );

    return data.currentAppInstallation.app;
  } catch {
    return null;
  }
}

interface MetaobjectDefinitionForDeletion {
  id: string;
  type: string;
  createdByApp: { id: string; title: string } | null;
}

interface MetaobjectDefinitionsForDeletionResponse {
  metaobjectDefinitions: {
    nodes: Array<{
      id: string;
      type: string;
      createdByApp?: { id: string; title: string } | null;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  };
}

async function fetchMetaobjectDefinitionsForDeletion(
  admin: AdminGraphqlClient,
): Promise<MetaobjectDefinitionForDeletion[]> {
  const definitions: MetaobjectDefinitionForDeletion[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const data: MetaobjectDefinitionsForDeletionResponse = await targetAdminGraphql<
      MetaobjectDefinitionsForDeletionResponse,
      { after: string | null }
    >(
      admin,
      `#graphql
        query MetaobjectDefinitionsForDeletion($after: String) {
          metaobjectDefinitions(first: 100, after: $after) {
            nodes {
              id
              type
              createdByApp {
                id
                title
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

    definitions.push(
      ...data.metaobjectDefinitions.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        createdByApp: node.createdByApp ?? null,
      })),
    );
    hasNextPage = data.metaobjectDefinitions.pageInfo.hasNextPage;
    cursor = data.metaobjectDefinitions.pageInfo.endCursor ?? null;
  }

  return definitions;
}

/**
 * Metaobject definitions: Shopify tracks the creating app directly via
 * `createdByApp`, so that's the authoritative check. The reserved-namespace id
 * and our own sync log are kept as a fallback in case `createdByApp` is ever
 * unavailable.
 */
function metaobjectBelongsToApp(
  definition: MetaobjectDefinitionForDeletion,
  ourApp: CurrentApp | null,
  loggedFallbackMatch: boolean,
): boolean {
  if (definition.createdByApp && ourApp) {
    if (parseNumericAppId(definition.createdByApp.id) === parseNumericAppId(ourApp.id)) {
      return true;
    }
    if (definition.createdByApp.title === ourApp.title) {
      return true;
    }
  }

  const embeddedAppId = getEmbeddedAppId(definition.type);
  if (embeddedAppId) {
    return embeddedAppId === parseNumericAppId(ourApp?.id);
  }

  return loggedFallbackMatch;
}

/**
 * Metafield definitions expose no creator-app field at all in Shopify's schema —
 * the reserved-namespace id is the only platform-provided signal. Everything
 * else falls back to our own sync log.
 */
function metafieldBelongsToApp(
  namespace: string,
  ourApp: CurrentApp | null,
  loggedFallbackMatch: boolean,
): boolean {
  const embeddedAppId = getEmbeddedAppId(namespace);
  if (embeddedAppId) {
    return embeddedAppId === parseNumericAppId(ourApp?.id);
  }

  return loggedFallbackMatch;
}

async function deleteMetafieldDefinition(admin: AdminGraphqlClient, id: string) {
  const data = await targetAdminGraphql<
    {
      metafieldDefinitionDelete: {
        deletedDefinitionId?: string | null;
        userErrors: GraphqlUserError[];
      };
    },
    { id: string; deleteAllAssociatedMetafields: boolean }
  >(
    admin,
    `#graphql
      mutation DeleteMetafieldDefinition($id: ID!, $deleteAllAssociatedMetafields: Boolean!) {
        metafieldDefinitionDelete(
          id: $id
          deleteAllAssociatedMetafields: $deleteAllAssociatedMetafields
        ) {
          deletedDefinitionId
          userErrors {
            field
            message
            code
          }
        }
      }
    `,
    { id, deleteAllAssociatedMetafields: true },
  );

  assertNoUserErrors(
    data.metafieldDefinitionDelete.userErrors,
    "Failed to delete metafield definition.",
  );
}

async function deleteMetaobjectDefinition(admin: AdminGraphqlClient, id: string) {
  const data = await targetAdminGraphql<
    {
      metaobjectDefinitionDelete: {
        deletedId?: string | null;
        userErrors: GraphqlUserError[];
      };
    },
    { id: string }
  >(
    admin,
    `#graphql
      mutation DeleteMetaobjectDefinition($id: ID!) {
        metaobjectDefinitionDelete(id: $id) {
          deletedId
          userErrors {
            field
            message
            code
          }
        }
      }
    `,
    { id },
  );

  assertNoUserErrors(
    data.metaobjectDefinitionDelete.userErrors,
    "Failed to delete metaobject definition.",
  );
}

export async function deleteAppCreatedDefinitions(options: {
  admin: AdminGraphqlClient;
  targetShop: string;
  deleteMetafields: boolean;
  deleteMetaobjects: boolean;
}): Promise<DeleteDefinitionsResult> {
  const { admin, targetShop, deleteMetafields, deleteMetaobjects } = options;
  const [{ metafieldKeys, metaobjectTypes }, ourApp] = await Promise.all([
    getAppCreatedDefinitionKeys(targetShop),
    getCurrentApp(admin),
  ]);

  const result: DeleteDefinitionsResult = {
    deletedMetafieldDefinitions: 0,
    deletedMetaobjectDefinitions: 0,
    failed: [],
  };

  if (deleteMetafields) {
    const { definitions } = await fetchMetafieldDefinitions({ admin });
    const matches = definitions.filter(
      (definition): definition is typeof definition & { id: string } =>
        Boolean(definition.id) &&
        metafieldBelongsToApp(
          definition.namespace,
          ourApp,
          metafieldKeys.has(
            `${definition.ownerType}:${definition.namespace}:${definition.key}`,
          ),
        ),
    );

    for (const definition of matches) {
      try {
        await deleteMetafieldDefinition(admin, definition.id);
        result.deletedMetafieldDefinitions += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete.";
        const key = `${definition.ownerType}:${definition.namespace}:${definition.key}`;
        console.error(`[delete-definitions] Failed to delete metafield definition ${key}: ${message}`);
        result.failed.push({ type: "metafield", key, message });
      }
    }
  }

  if (deleteMetaobjects) {
    const definitions = await fetchMetaobjectDefinitionsForDeletion(admin);
    const matches = definitions.filter((definition) =>
      metaobjectBelongsToApp(
        definition,
        ourApp,
        metaobjectTypes.has(definition.type),
      ),
    );

    for (const definition of matches) {
      try {
        await deleteMetaobjectDefinition(admin, definition.id);
        result.deletedMetaobjectDefinitions += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to delete.";
        console.error(
          `[delete-definitions] Failed to delete metaobject definition ${definition.type}: ${message}`,
        );
        result.failed.push({ type: "metaobject", key: definition.type, message });
      }
    }
  }

  return result;
}
