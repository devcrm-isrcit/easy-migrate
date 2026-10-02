import type { LoaderFunctionArgs } from "react-router";
import {
  isValidSyncRunId,
  readSyncProgress,
  type SyncProgressResponse,
} from "../lib/definition-sync/progress.server";
import { authenticate } from "../shopify.server";

/**
 * Polled by the dashboard and the CSV import while a sync runs. Runs are
 * stored per shop, so a shop can only ever read its own progress.
 */
export async function loader({
  request,
}: LoaderFunctionArgs): Promise<SyncProgressResponse> {
  const { session } = await authenticate.admin(request);
  const runId = new URL(request.url).searchParams.get("runId");

  if (!isValidSyncRunId(runId)) {
    return { runId: null, progress: null };
  }

  return {
    runId,
    progress: readSyncProgress({ shop: session.shop, runId }),
  };
}
