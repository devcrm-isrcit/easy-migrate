/**
 * Live progress of a definition sync, as the page polls it from
 * `/app/sync-progress`. The server side lives in `progress.server.ts`.
 */

export type SyncProgressPhase =
  | "preparing"
  | "metaobjects"
  | "metafields"
  | "content"
  | "done"
  | "failed";

/** What is happening to the item the sync is working on right now. */
export type SyncProgressAction =
  | "read"
  | "create"
  | "update"
  | "add_fields"
  | "retry"
  | "copy_entries";

export type SyncProgressItemKind =
  | "metaobject"
  | "metaobject_field"
  | "metafield"
  | "entry";

export type SyncProgressStatus =
  | "created"
  | "updated"
  | "exists"
  | "skipped"
  | "conflict"
  | "failed";

export interface SyncProgressItem {
  kind: SyncProgressItemKind;
  /** Handle shown in mono under the name, e.g. `PRODUCT:custom.care`. */
  key: string;
  name: string;
}

export interface SyncProgressCurrent extends SyncProgressItem {
  action: SyncProgressAction;
  /** Set while copying entries: how far through this metaobject's entries. */
  step?: { done: number; total: number };
}

export interface SyncProgressEvent extends SyncProgressItem {
  /** Increases by one per event within a run, so the page can spot new ones. */
  id: number;
  status: SyncProgressStatus;
}

export interface SyncProgressSnapshot {
  phase: SyncProgressPhase;
  /** The steps this run goes through, in order. Never includes done/failed. */
  phases: SyncProgressPhase[];
  /** Selected definitions. Each one counts once, when its main step ends. */
  total: number;
  done: number;
  /** Metaobject types whose entries are copied, when content copy is on. */
  content: { total: number; done: number };
  current: SyncProgressCurrent | null;
  /** Newest first. */
  recent: SyncProgressEvent[];
  counts: Record<SyncProgressStatus, number>;
  error: string | null;
}

export interface SyncProgressResponse {
  runId: string | null;
  progress: SyncProgressSnapshot | null;
}

/** Run ids come from the browser, so keep them to a safe, bounded shape. */
export function isValidSyncRunId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value);
}
