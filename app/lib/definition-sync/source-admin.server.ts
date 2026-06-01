import { apiVersion } from "../../shopify.server";
import {
  SUPPORTED_METAFIELD_OWNER_TYPES,
  type GraphqlUserError,
  type OwnerTypeAccessResult,
} from "./types.server";
import { normalizeShopDomain, validateShopDomain } from "./shop-domain.server";

interface SourceAdminGraphqlParams<TVariables> {
  shop: string;
  token: string;
  query: string;
  variables?: TVariables;
}

interface GraphqlEnvelope<TData> {
  data?: TData;
  errors?: Array<{ message: string }>;
}

export async function sourceAdminGraphql<
  TData,
  TVariables = Record<string, unknown>,
>({
  shop,
  token,
  query,
  variables,
}: SourceAdminGraphqlParams<TVariables>): Promise<TData> {
  const normalizedShop = normalizeShopDomain(shop);
  const response = await fetch(
    `https://${normalizedShop}/admin/api/${String(apiVersion)}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error("Source token was rejected by Shopify.");
    }

    throw new Error(
      `Source store request failed with status ${response.status}.`,
    );
  }

  const payload = (await response.json()) as GraphqlEnvelope<TData>;

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  if (!payload.data) {
    throw new Error("Source store did not return any data.");
  }

  return payload.data;
}

export async function validateSourceToken(shop: string, token: string) {
  const shopError = validateShopDomain(shop);

  if (shopError) {
    throw new Error(shopError);
  }

  if (!token.trim()) {
    throw new Error("Source Admin API access token is required.");
  }

  const data = await sourceAdminGraphql<{
    shop: { name: string; myshopifyDomain: string };
    metaobjectDefinitions: { nodes: Array<{ id: string }> };
  }>({
    shop,
    token,
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
        token,
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
