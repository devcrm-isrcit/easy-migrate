import { sourceAdminGraphql } from "./source-admin.server";
import { assertNoUserErrors, targetAdminGraphql } from "./target-admin.server";
import {
  isAppReservedMetaobjectType,
  toMetaobjectDefinitionCreateType,
} from "./metaobject-type.server";
import type {
  GraphqlUserError,
  MetaobjectDefinitionFetchResult,
  MetaobjectDefinitionRecord,
  MetaobjectFieldDefinitionRecord,
  ValidationRule,
} from "./types.server";

type AdminGraphqlClient = Parameters<typeof targetAdminGraphql>[0];

/**
 * MetafieldDefinitionValidationInput accepts only `name` and `value`. Our
 * internal ValidationRule also carries `type`, which Shopify rejects outright,
 * so the mutation input is always built explicitly rather than passed through.
 */
function toValidationInput(validations: ValidationRule[] | undefined) {
  return (validations ?? []).map((validation) => ({
    name: validation.name,
    value: validation.value,
  }));
}

interface FetchSourceOptions {
  shop: string;
  token: string;
}

interface MetaobjectDefinitionsResponse {
  metaobjectDefinitions: {
    nodes: Array<{
      id: string;
      type: string;
      name: string;
      description?: string | null;
      displayNameKey?: string | null;
      access: {
        admin: string;
        storefront: string;
      };
      capabilities?: {
        publishable?: {
          enabled: boolean;
        };
      };
      fieldDefinitions: Array<{
        key: string;
        name: string;
        description?: string | null;
        required: boolean;
        type: { name: string };
        validations?: Array<{ name: string; value?: string | null }>;
      }>;
    }>;
    pageInfo: {
      hasNextPage: boolean;
      endCursor?: string | null;
    };
  };
}

export function normalizeMetaobjectDefinition(
  definition: MetaobjectDefinitionsResponse["metaobjectDefinitions"]["nodes"][number],
): MetaobjectDefinitionRecord {
  return {
    id: definition.id,
    type: definition.type,
    name: definition.name,
    description: definition.description ?? null,
    displayNameKey: definition.displayNameKey ?? null,
    access: {
      admin: definition.access.admin,
      storefront: definition.access.storefront,
    },
    capabilities: definition.capabilities?.publishable
      ? { publishable: { enabled: definition.capabilities.publishable.enabled } }
      : undefined,
    fieldDefinitions: definition.fieldDefinitions.map((field) => ({
      key: field.key,
      name: field.name,
      description: field.description ?? null,
      required: field.required,
      type: field.type.name,
      validations:
        field.validations?.map((validation) => ({
          name: validation.name,
          value: validation.value ?? null,
        })) ?? [],
    })),
  };
}

async function fetchAll(
  runQuery: <TData, TVariables extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    variables?: TVariables,
  ) => Promise<TData>,
) {
  const definitions: MetaobjectDefinitionRecord[] = [];
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const data: MetaobjectDefinitionsResponse = await runQuery<
      MetaobjectDefinitionsResponse,
      { after?: string | null }
    >(
      `#graphql
        query MetaobjectDefinitions($after: String) {
          metaobjectDefinitions(first: 100, after: $after) {
            nodes {
              id
              type
              name
              description
              displayNameKey
              access {
                admin
                storefront
              }
              capabilities {
                publishable {
                  enabled
                }
              }
              fieldDefinitions {
                key
                name
                description
                required
                type {
                  name
                }
                validations {
                  name
                  value
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

    definitions.push(
      ...data.metaobjectDefinitions.nodes.map(normalizeMetaobjectDefinition),
    );
    hasNextPage = data.metaobjectDefinitions.pageInfo.hasNextPage;
    cursor = data.metaobjectDefinitions.pageInfo.endCursor ?? null;
  }

  return definitions;
}

export async function fetchMetaobjectDefinitions(options: {
  source?: FetchSourceOptions;
  admin?: AdminGraphqlClient;
}): Promise<MetaobjectDefinitionFetchResult> {
  return {
    definitions: options.source
      ? await fetchAll((query, variables) =>
          sourceAdminGraphql({
            shop: options.source!.shop,
            token: options.source!.token,
            query,
            variables,
          }),
        )
      : await fetchAll((query, variables) =>
          targetAdminGraphql(options.admin!, query, variables),
        ),
  };
}

export async function createMetaobjectDefinition(
  admin: AdminGraphqlClient,
  definition: MetaobjectDefinitionRecord,
) {
  const targetType = toMetaobjectDefinitionCreateType(definition.type);

  // Fixed values, never copied from the source definition, so every definition
  // this app creates lands with predictable access. The `admin` key is only
  // accepted on app-reserved types: Shopify rejects it outright on a
  // merchant-owned type ("Admin access can only be specified on metaobject
  // definitions that have an app-reserved type."), so it is omitted there.
  const access = isAppReservedMetaobjectType(definition.type)
    ? { admin: "MERCHANT_READ_WRITE", storefront: "PUBLIC_READ" }
    : { storefront: "PUBLIC_READ" };

  const data = await targetAdminGraphql<
    {
      metaobjectDefinitionCreate: {
        metaobjectDefinition?: { id: string } | null;
        userErrors: GraphqlUserError[];
      };
    },
    { definition: Record<string, unknown> }
  >(
    admin,
    `#graphql
      mutation CreateMetaobjectDefinition($definition: MetaobjectDefinitionCreateInput!) {
        metaobjectDefinitionCreate(definition: $definition) {
          metaobjectDefinition {
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
        type: targetType,
        description: definition.description,
        displayNameKey: definition.displayNameKey,
        access,
        capabilities: definition.capabilities?.publishable?.enabled
          ? { publishable: { enabled: true } }
          : undefined,
        fieldDefinitions: definition.fieldDefinitions.map((field) => ({
          key: field.key,
          name: field.name,
          type: field.type,
          description: field.description,
          required: field.required,
          validations: toValidationInput(field.validations),
        })),
      },
    },
  );

  assertNoUserErrors(
    data.metaobjectDefinitionCreate.userErrors,
    "Failed to create metaobject definition.",
  );

  if (!data.metaobjectDefinitionCreate.metaobjectDefinition) {
    throw new Error("Shopify did not return the created metaobject definition.");
  }

  return data.metaobjectDefinitionCreate.metaobjectDefinition;
}

export async function addMissingMetaobjectFields(
  admin: AdminGraphqlClient,
  metaobjectDefinitionId: string,
  fields: MetaobjectFieldDefinitionRecord[],
  displayNameKey?: string | null,
) {
  const data = await targetAdminGraphql<
    {
      metaobjectDefinitionUpdate: {
        metaobjectDefinition?: { id: string } | null;
        userErrors: GraphqlUserError[];
      };
    },
    { id: string; definition: Record<string, unknown> }
  >(
    admin,
    `#graphql
      mutation AddMissingMetaobjectFields($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
        metaobjectDefinitionUpdate(id: $id, definition: $definition) {
          metaobjectDefinition {
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
      id: metaobjectDefinitionId,
      definition: {
        displayNameKey: displayNameKey ?? undefined,
        fieldDefinitions: fields.map((field) => ({
          create: {
            key: field.key,
            name: field.name,
            type: field.type,
            description: field.description,
            required: field.required,
            validations: toValidationInput(field.validations),
          },
        })),
      },
    },
  );

  assertNoUserErrors(
    data.metaobjectDefinitionUpdate.userErrors,
    "Failed to add missing metaobject fields.",
  );

  if (!data.metaobjectDefinitionUpdate.metaobjectDefinition) {
    throw new Error("Shopify did not return the updated metaobject definition.");
  }

  return data.metaobjectDefinitionUpdate.metaobjectDefinition;
}

/**
 * Brings an existing metaobject definition in line with the source: creates the
 * fields it lacks, updates fields whose name/description/required/validations
 * drifted, and applies definition-level changes. Field types are never touched
 * (Shopify forbids retyping) and target-only fields are never deleted.
 */
export async function reconcileMetaobjectDefinition(
  admin: AdminGraphqlClient,
  metaobjectDefinitionId: string,
  input: {
    createFields?: MetaobjectFieldDefinitionRecord[];
    updateFields?: MetaobjectFieldDefinitionRecord[];
    name?: string;
    description?: string | null;
    displayNameKey?: string | null;
    publishable?: boolean;
  },
) {
  const fieldDefinitions = [
    ...(input.createFields ?? []).map((field) => ({
      create: {
        key: field.key,
        name: field.name,
        type: field.type,
        description: field.description,
        required: field.required,
        validations: toValidationInput(field.validations),
      },
    })),
    ...(input.updateFields ?? []).map((field) => ({
      update: {
        key: field.key,
        name: field.name,
        description: field.description,
        required: field.required,
        validations: toValidationInput(field.validations),
      },
    })),
  ];

  const definition: Record<string, unknown> = {};

  if (fieldDefinitions.length) {
    definition.fieldDefinitions = fieldDefinitions;
  }

  if (input.name !== undefined) {
    definition.name = input.name;
  }

  if (input.description !== undefined) {
    definition.description = input.description;
  }

  if (input.displayNameKey !== undefined) {
    definition.displayNameKey = input.displayNameKey;
  }

  if (input.publishable !== undefined) {
    definition.capabilities = { publishable: { enabled: input.publishable } };
  }

  if (!Object.keys(definition).length) {
    return { id: metaobjectDefinitionId };
  }

  const data = await targetAdminGraphql<
    {
      metaobjectDefinitionUpdate: {
        metaobjectDefinition?: { id: string } | null;
        userErrors: GraphqlUserError[];
      };
    },
    { id: string; definition: Record<string, unknown> }
  >(
    admin,
    `#graphql
      mutation ReconcileMetaobjectDefinition($id: ID!, $definition: MetaobjectDefinitionUpdateInput!) {
        metaobjectDefinitionUpdate(id: $id, definition: $definition) {
          metaobjectDefinition {
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
    { id: metaobjectDefinitionId, definition },
  );

  assertNoUserErrors(
    data.metaobjectDefinitionUpdate.userErrors,
    "Failed to update metaobject definition.",
  );

  if (!data.metaobjectDefinitionUpdate.metaobjectDefinition) {
    throw new Error("Shopify did not return the updated metaobject definition.");
  }

  return data.metaobjectDefinitionUpdate.metaobjectDefinition;
}
