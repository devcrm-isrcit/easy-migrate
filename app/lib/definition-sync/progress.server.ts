import {
  isValidSyncRunId,
  type SyncProgressCurrent,
  type SyncProgressItem,
  type SyncProgressPhase,
  type SyncProgressSnapshot,
  type SyncProgressStatus,
} from "./progress.shared";

export * from "./progress.shared";

/**
 * Live sync progress, kept in this server's memory. The sync request itself
 * only answers when everything is done, so the page polls this store from
 * `/app/sync-progress` while it waits.
 *
 * Memory, not the database, because it is throwaway and changes many times a
 * second. It assumes one server process: with several, a poll can land on a
 * process that never saw the run, and the page then just shows "Working…"
 * until the sync response arrives.
 */

export interface SyncProgressReporter {
  /** Moves to the next step of the run. */
  phase(phase: SyncProgressPhase): void;
  /** Called once the selection is known. */
  plan(input: {
    total: number;
    contentTotal: number;
    phases: SyncProgressPhase[];
  }): void;
  /** The item the sync is working on right now. */
  working(current: SyncProgressCurrent): void;
  /**
   * Something happened to an item. `tick` marks one selected definition as
   * finished; each one counts once however often it is recorded.
   */
  record(
    item: SyncProgressItem,
    status: SyncProgressStatus,
    options?: { tick?: boolean },
  ): void;
  /** One metaobject type's entries are copied (or skipped, or failed). */
  contentTypeDone(): void;
  finish(): void;
  fail(message: string): void;
}

const RECENT_LIMIT = 30;
const FINISHED_RETENTION_MS = 10 * 60 * 1000;
// A run whose request died without finishing is dropped after this.
const MAX_RUN_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_RUNS = 200;

interface StoredRun {
  snapshot: SyncProgressSnapshot;
  startedAt: number;
  finishedAt: number | null;
}

declare global {
  // eslint-disable-next-line no-var
  var emSyncProgressRuns: Map<string, StoredRun> | undefined;
}

// Kept on globalThis so a dev-server module reload does not drop live runs.
const runs = (globalThis.emSyncProgressRuns ??= new Map<string, StoredRun>());

function storeKey(shop: string, runId: string) {
  return `${shop}::${runId}`;
}

function prune(now: number) {
  for (const [key, run] of runs) {
    const expired =
      run.finishedAt !== null
        ? now - run.finishedAt > FINISHED_RETENTION_MS
        : now - run.startedAt > MAX_RUN_AGE_MS;

    if (expired) {
      runs.delete(key);
    }
  }

  // Map keeps insertion order, so the first keys are the oldest runs.
  for (const key of runs.keys()) {
    if (runs.size <= MAX_RUNS) {
      break;
    }

    runs.delete(key);
  }
}

function emptySnapshot(): SyncProgressSnapshot {
  return {
    phase: "preparing",
    phases: ["preparing"],
    total: 0,
    done: 0,
    content: { total: 0, done: 0 },
    current: null,
    recent: [],
    counts: {
      created: 0,
      updated: 0,
      exists: 0,
      skipped: 0,
      conflict: 0,
      failed: 0,
    },
    error: null,
  };
}

/** For callers that track no progress. */
export const silentSyncProgress: SyncProgressReporter = {
  phase() {},
  plan() {},
  working() {},
  record() {},
  contentTypeDone() {},
  finish() {},
  fail() {},
};

/**
 * Starts tracking a run. An invalid run id gives a reporter that does
 * nothing, so a sync never fails because of its progress display.
 */
export function startSyncProgress({
  shop,
  runId,
  now = Date.now(),
}: {
  shop: string;
  runId: unknown;
  now?: number;
}): SyncProgressReporter {
  if (!isValidSyncRunId(runId)) {
    return silentSyncProgress;
  }

  prune(now);

  const run: StoredRun = {
    snapshot: emptySnapshot(),
    startedAt: now,
    finishedAt: null,
  };
  const key = storeKey(shop, runId);
  runs.delete(key);
  runs.set(key, run);

  const state = run.snapshot;
  const ticked = new Set<string>();
  let nextEventId = 1;

  return {
    phase(phase) {
      state.phase = phase;
      state.current = null;
    },
    plan({ total, contentTotal, phases }) {
      state.total = total;
      state.content.total = contentTotal;
      state.phases = phases;
    },
    working(current) {
      state.current = current;
    },
    record(item, status, options) {
      state.counts[status] += 1;
      state.recent.unshift({ ...item, status, id: nextEventId++ });
      state.recent.length = Math.min(state.recent.length, RECENT_LIMIT);

      if (options?.tick) {
        ticked.add(`${item.kind}:${item.key}`);
        state.done = Math.min(ticked.size, state.total);
      }
    },
    contentTypeDone() {
      state.content.done = Math.min(state.content.done + 1, state.content.total);
    },
    finish() {
      state.phase = "done";
      state.current = null;
      state.done = state.total;
      state.content.done = state.content.total;
      run.finishedAt = Date.now();
    },
    fail(message) {
      state.phase = "failed";
      state.current = null;
      state.error = message;
      run.finishedAt = Date.now();
    },
  };
}

export function readSyncProgress({
  shop,
  runId,
  now = Date.now(),
}: {
  shop: string;
  runId: string;
  now?: number;
}): SyncProgressSnapshot | null {
  prune(now);
  return runs.get(storeKey(shop, runId))?.snapshot ?? null;
}
