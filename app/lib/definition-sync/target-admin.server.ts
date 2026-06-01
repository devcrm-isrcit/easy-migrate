import type { GraphqlUserError } from "./types.server";

interface TargetAdminClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

interface GraphqlEnvelope<TData> {
  data?: TData;
  errors?: Array<{ message: string }>;
}

export async function targetAdminGraphql<
  TData,
  TVariables extends Record<string, unknown> = Record<string, unknown>,
>(
  admin: TargetAdminClient,
  query: string,
  variables?: TVariables,
): Promise<TData> {
  const response = await admin.graphql(query, { variables });
  const payload = (await response.json()) as GraphqlEnvelope<TData>;

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  if (!payload.data) {
    throw new Error("Target store did not return any data.");
  }

  return payload.data;
}

export function assertNoUserErrors(
  errors: GraphqlUserError[] | undefined,
  fallbackMessage: string,
) {
  if (!errors?.length) {
    return;
  }

  throw new Error(
    errors.map((error) => error.message).join("; ") || fallbackMessage,
  );
}
