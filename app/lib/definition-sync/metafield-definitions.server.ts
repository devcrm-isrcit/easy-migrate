import { formatGraphqlUserErrors, sourceAdminGraphql } from "./source-admin.server";
import { assertNoUserErrors, targetAdminGraphql } from "./target-admin.server";
import {
  SUPPORTED_METAFIELD_OWNER_TYPES,
  type GraphqlUserError,
  type MetafieldDefinitionFetchResult,
  type MetafieldDefinitionRecord,
} from "./types.server";

type AdminGraphqlClient = Parameters<typeof targetAdminGraphql>[0];

interface FetchSourceOptions {
  shop: string;
  token: string;
}

interface MetafieldDefinitionsResponse {
  metafieldDefinitions: {
    nodes: Array<{
      id: string;
      name: string;
      namespace: string;
      key: string;
      ownerType: string;
      description?: string | null;
      type: { name: string };
      validations?: Array<{
        name: string;
        value?: string | null;
        type?: string | null;
      }>;
    }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor?: string | null;
    };
  };
}

export function normalizeMetafieldDefinition(
  definition: MetafieldDefinitionsResponse["metafieldDefinitions"]["nodes"][number],
): MetafieldDefinitionRecord {
  return {
    id: definition.id,
    name: definition.name,
    namespace: definition.namespace,
    key: definition.key,
    ownerType: definition.ownerType,
    type: definition.type.name,
    description: definition.description ?? null,
    validations:
      definition.validations?.map((validation) => ({
        name: validation.name,
        value: validation.value ?? null,
        type: validation.type ?? null,
      })) ?? [],
  };
}

async function fetchByOwnerType(
  runQuery: <TData, TVariables extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    variables?: TVariables,
  ) => Promise<TData>,
  ownerType: string,
) {
  const definitions: MetafieldDefinitionRecord[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const data: MetafieldDefinitionsResponse = await runQuery<
      MetafieldDefinitionsResponse,
      { ownerType: string; after?: string | null }
    >(
      `#graphql
        query MetafieldDefinitions($ownerType: MetafieldOwnerType!, $after: String) {
          metafieldDefinitions(first: 100, ownerType: $ownerType, after: $after) {
            nodes {
              id
              name
              namespace
              key
              ownerType
              description
              type {
                name
              }
              validations {
                name
                value
                type
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      { ownerType, after: cursor },
    );

    definitions.push(
      ...data.metafieldDefinitions.nodes.map(normalizeMetafieldDefinition),
    );
    hasNextPage = data.metafieldDefinitions.pageInfo.hasNextPage;
    cursor = data.metafieldDefinitions.pageInfo.endCursor ?? null;
  }

  return definitions;
}

export async function fetchMetafieldDefinitions(options: {
  source?: FetchSourceOptions;
  admin?: AdminGraphqlClient;
}): Promise<MetafieldDefinitionFetchResult> {
  const definitions: MetafieldDefinitionRecord[] = [];
  const ownerTypeAccess = [];

  for (const ownerType of SUPPORTED_METAFIELD_OWNER_TYPES) {
    try {
      const items = options.source
        ? await fetchByOwnerType(
            (query, variables) =>
              sourceAdminGraphql({
                shop: options.source!.shop,
                token: options.source!.token,
                query,
                variables,
              }),
            ownerType,
          )
        : await fetchByOwnerType(
            (query, variables) =>
              targetAdminGraphql(options.admin!, query, variables),
            ownerType,
          );

      definitions.push(...items);
      ownerTypeAccess.push({ ownerType, accessible: true });
    } catch (error) {
      ownerTypeAccess.push({
        ownerType,
        accessible: false,
        message: error instanceof Error ? error.message : "Access denied.",
      });
    }
  }

  return { definitions, ownerTypeAccess };
}

export async function createMetafieldDefinition(
  admin: AdminGraphqlClient,
  definition: MetafieldDefinitionRecord,
) {
  const data = await targetAdminGraphql<
    {
      metafieldDefinitionCreate: {
        createdDefinition?: { id: string } | null;
        userErrors: GraphqlUserError[];
      };
    },
    { definition: Record<string, unknown> }
  >(
    admin,
    `#graphql
      mutation CreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition {
            id
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
      definition: {
        name: definition.name,
        namespace: definition.namespace,
        key: definition.key,
        ownerType: definition.ownerType,
        type: definition.type,
        description: definition.description,
        validations: definition.validations.map((validation) => ({
          name: validation.name,
          value: validation.value,
        })),
      },
    },
  );

  assertNoUserErrors(
    data.metafieldDefinitionCreate.userErrors,
    "Failed to create metafield definition.",
  );

  if (!data.metafieldDefinitionCreate.createdDefinition) {
    throw new Error("Shopify did not return the created metafield definition.");
  }

  return data.metafieldDefinitionCreate.createdDefinition;
}

export { formatGraphqlUserErrors };
