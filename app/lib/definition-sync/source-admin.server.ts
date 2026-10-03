import { SessionNotFoundError } from "@shopify/shopify-app-react-router/server";
import { unauthenticated } from "../../shopify.server";
import {
  SUPPORTED_METAFIELD_OWNER_TYPES,
  type GraphqlUserError,
  type OwnerTypeAccessResult,
} from "./types.server";

interface SourceAdminGraphqlParams<TVariables> {
  shop: string;
  query: string;
  variables?: TVariables;
}

interface GraphqlEnvelope<TData> {
  data?: TData;
  errors?: Array<{ message: string }>;
}

/**
 * Queries the source store with Easy Migrate's own offline session there.
 * `shop` must come from getLinkedSourceShop, never from request input.
 */
export async function sourceAdminGraphql<
  TData,
  TVariables = Record<string, unknown>,
>({
  shop,
  query,
  variables,
}: SourceAdminGraphqlParams<TVariables>): Promise<TData> {
  let admin: Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      throw new Error(
        `Easy Migrate is no longer installed on ${shop}. Install it there and connect again.`,
      );
    }

    throw error;
  }

  const response = await admin.graphql(query, {
    variables: variables as Record<string, unknown> | undefined,
  });
  const payload = (await response.json()) as GraphqlEnvelope<TData>;

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  if (!payload.data) {
    throw new Error("Source store did not return any data.");
  }

  return payload.data;
}

export async function validateSourceConnection(shop: string) {
  const data = await sourceAdminGraphql<{
    shop: { name: string; myshopifyDomain: string };
    metaobjectDefinitions: { nodes: Array<{ id: string }> };
  }>({
    shop,
    query: `#graphql
      query ValidateSourceConnection {
        shop {
          name
          myshopifyDomain
        }
        metaobjectDefinitions(first: 1) {
          nodes {
            id
          }
        }
      }
    `,
  });

  const ownerTypeAccess: OwnerTypeAccessResult[] = [];

  for (const ownerType of SUPPORTED_METAFIELD_OWNER_TYPES) {
    try {
      await sourceAdminGraphql<
        { metafieldDefinitions: { nodes: Array<{ id: string }> } },
        { ownerType: string }
      >({
        shop,
        query: `#graphql
          query ValidateMetafieldAccess($ownerType: MetafieldOwnerType!) {
            metafieldDefinitions(first: 1, ownerType: $ownerType) {
              nodes {
                id
              }
            }
          }
        `,
        variables: { ownerType },
      });

      ownerTypeAccess.push({ ownerType, accessible: true });
    } catch (error) {
      ownerTypeAccess.push({
        ownerType,
        accessible: false,
        message: error instanceof Error ? error.message : "Access denied.",
      });
    }
  }

  return {
    shopName: data.shop.name,
    sourceShop: data.shop.myshopifyDomain,
    ownerTypeAccess,
  };
}

export function formatGraphqlUserErrors(errors: GraphqlUserError[]): string {
  return errors
    .map((error) =>
      error.field?.length
        ? `${error.field.join(".")}: ${error.message}`
        : error.message,
    )
    .join("; ");
}
