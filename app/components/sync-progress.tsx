import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useFetcher } from "react-router";
import { Icon } from "./easy-migrate-ui";
import type {
  SyncProgressAction,
  SyncProgressItemKind,
  SyncProgressPhase,
  SyncProgressResponse,
  SyncProgressSnapshot,
  SyncProgressStatus,
} from "../lib/definition-sync/progress.shared";

/*
 * Live progress for a running sync or CSV import. The sync request only
 * answers once everything is done, so while it runs the page polls
 * /app/sync-progress for what the server has got through so far.
 */

const POLL_INTERVAL_MS = 800;
// How long the finished panel stays up before the normal result shows.
const SETTLE_MS = 1600;
const FEED_ROWS = 8;
const FEED_STAGGER_MS = 70;

export type SyncOutcome = "running" | "success" | "warning" | "failed";

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function newRunId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Call `begin()` when submitting and send the id it returns as `runId`.
 * `running` is whether that submission is still in flight. The panel stays
 * `visible` for a moment after it lands so the finish can be seen.
 */
export function useSyncProgress(running: boolean) {
  const fetcher = useFetcher<SyncProgressResponse>();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [runId, setRunId] = useState<string | null>(null);
  const [settling, setSettling] = useState(false);
  const wasRunningRef = useRef(false);

  useEffect(() => {
    if (!running || !runId) {
      return;
    }

    function poll() {
      // Skip a beat rather than stack requests on a slow connection.
      if (fetcherRef.current.state === "idle") {
        fetcherRef.current.load(
          `/app/sync-progress?runId=${encodeURIComponent(runId as string)}`,
        );
      }
    }

    poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [running, runId]);

  useEffect(() => {
    if (running) {
      wasRunningRef.current = true;
      return;
    }

    if (!wasRunningRef.current) {
      return;
    }

    wasRunningRef.current = false;
    setSettling(true);
    const timer = window.setTimeout(() => setSettling(false), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [running]);

  const begin = useCallback(() => {
    const id = newRunId();
    setRunId(id);
    return id;
  }, []);

  const data = fetcher.data;

  return {
    begin,
    progress: data && data.runId === runId ? data.progress : null,
    visible: running || settling,
  };
}

function useCountUp(target: number, duration = 450) {
  const [value, setValue] = useState(target);
  const valueRef = useRef(target);

  useEffect(() => {
    const from = valueRef.current;

    if (from === target || prefersReducedMotion()) {
      valueRef.current = target;
      setValue(target);
      return;
    }

    const start = performance.now();
    let frame = 0;

    function step(now: number) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      const next = Math.round(from + (target - from) * eased);
      valueRef.current = next;
      setValue(next);

      if (t < 1) {
        frame = requestAnimationFrame(step);
      }
    }

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return value;
}

/** Slides the old content up and out while the new content slides in. */
function Swap({ swapKey, children }: { swapKey: string; children: ReactNode }) {
  const [leaving, setLeaving] = useState<{ key: string; node: ReactNode } | null>(
    null,
  );
  const shownKeyRef = useRef(swapKey);
  const latestNodeRef = useRef<ReactNode>(children);

  // Runs before the effect below, so latestNodeRef still holds the old node.
  useLayoutEffect(() => {
    if (shownKeyRef.current === swapKey) {
      return;
    }

    setLeaving({ key: shownKeyRef.current, node: latestNodeRef.current });
    shownKeyRef.current = swapKey;
    const timer = window.setTimeout(() => setLeaving(null), 300);
    return () => window.clearTimeout(timer);
  }, [swapKey]);

  useEffect(() => {
    latestNodeRef.current = children;
  });

  return (
    <div className="em-swap">
      {leaving ? (
        <div
          key={`out-${leaving.key}`}
          className="em-swap__item em-swap__item--out"
          aria-hidden="true"
        >
          {leaving.node}
        </div>
      ) : null}
      <div key={`in-${swapKey}`} className="em-swap__item em-swap__item--in">
        {children}
      </div>
    </div>
  );
}

function CheckMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} />
    </svg>
  );
}

function CrossMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M7 7l10 10M17 7L7 17" pathLength={1} />
    </svg>
  );
}

const PHASE_LABELS: Record<SyncProgressPhase, string> = {
  preparing: "Preparing",
  metaobjects: "Metaobjects",
  metafields: "Metafields",
  content: "Entries",
  done: "Done",
  failed: "Failed",
};

const ACTION_VERBS: Record<SyncProgressAction, string> = {
  read: "Reading",
  create: "Creating",
  update: "Updating",
  add_fields: "Adding fields to",
  retry: "Retrying",
  copy_entries: "Copying entries of",
};

const KIND_LABELS: Record<SyncProgressItemKind, string> = {
  metaobject: "Metaobject",
  metaobject_field: "Field",
  metafield: "Metafield",
  entry: "Entry",
};

const STATUS_LABELS: Record<SyncProgressStatus, string> = {
  created: "Created",
  updated: "Updated",
  exists: "Already there",
  skipped: "Skipped",
  conflict: "Conflict",
  failed: "Failed",
};

const STATUS_ICONS: Record<SyncProgressStatus, string> = {
  created: "check_circle",
  updated: "change_circle",
  exists: "radio_button_checked",
  skipped: "do_not_disturb_on",
  conflict: "warning",
  failed: "error",
};

const COUNT_ORDER: SyncProgressStatus[] = [
  "created",
  "updated",
  "exists",
  "skipped",
  "conflict",
  "failed",
];

/** `PRODUCT:custom:care` reads better as `custom.care · PRODUCT`. */
function displayKey(kind: SyncProgressItemKind, key: string) {
  if (kind !== "metafield") {
    return key;
  }

  const [ownerType, namespace, ...rest] = key.split(":");
  return rest.length ? `${namespace}.${rest.join(":")} · ${ownerType}` : key;
}

/** Counts up to `value`. Its own component, so each animation frame
    re-renders only this number rather than the whole panel. */
function CountUp({ value }: { value: number }) {
  return <>{useCountUp(value)}</>;
}

function CountChip({ status, count }: { status: SyncProgressStatus; count: number }) {
  return (
    <span className={`em-sync-chip em-sync-chip--${status}`}>
      <span className="em-sync-chip__value">
        <CountUp value={count} />
      </span>
      {STATUS_LABELS[status].toLowerCase()}
    </span>
  );
}

export function SyncProgressPanel({
  noun,
  progress,
  outcome,
  failedCount = 0,
  error,
}: {
  noun: "sync" | "import";
  progress: SyncProgressSnapshot | null;
  outcome: SyncOutcome;
  failedCount?: number;
  error?: string | null;
}) {
  const finished = outcome !== "running";
  const phases = progress?.phases ?? ["preparing"];
  const runningIndex = Math.max(0, phases.indexOf(progress?.phase ?? "preparing"));

  // On failure the snapshot no longer says which step was running, so keep
  // the last one seen.
  const lastStepRef = useRef(0);
  useEffect(() => {
    if (!finished) {
      lastStepRef.current = runningIndex;
    }
  });

  const totalUnits = progress ? progress.total + progress.content.total : 0;
  const doneUnits = progress ? progress.done + progress.content.done : 0;
  const succeeded = outcome === "success" || outcome === "warning";
  const ratio = succeeded ? 1 : totalUnits > 0 ? doneUnits / totalUnits : 0;
  const indeterminate = outcome === "running" && totalUnits === 0;

  // Rows newer than the last render arrive one after another, oldest first.
  const rows = (progress?.recent ?? []).slice(0, FEED_ROWS);
  const seenIdRef = useRef(0);
  const newIds = rows
    .filter((row) => row.id > seenIdRef.current)
    .map((row) => row.id);
  useEffect(() => {
    if (rows[0]) {
      seenIdRef.current = Math.max(seenIdRef.current, rows[0].id);
    }
  });

  const Noun = noun === "sync" ? "Sync" : "Import";
  const title =
    outcome === "success"
      ? `${Noun} complete`
      : outcome === "warning"
        ? `${Noun} finished with ${String(failedCount)} failure${failedCount === 1 ? "" : "s"}`
        : outcome === "failed"
          ? `${Noun} failed`
          : noun === "sync"
            ? "Syncing definitions"
            : "Importing definitions";

  const current = finished ? null : (progress?.current ?? null);
  const swapKey = finished
    ? `end-${outcome}`
    : current
      ? `${current.kind}:${current.key}:${current.action}`
      : `phase-${progress?.phase ?? "preparing"}`;

  let nowContent: ReactNode;
  if (finished) {
    nowContent = (
      <p className="em-sync-now__message">
        {outcome === "success"
          ? "Everything you selected is in place."
          : outcome === "warning"
            ? "Everything else went through. The failed items are listed next."
            : (error ?? "Something went wrong before the run could finish.")}
      </p>
    );
  } else if (current) {
    nowContent = (
      <>
        <p className="em-sync-now__text">
          <span className="em-sync-now__verb">{ACTION_VERBS[current.action]}</span>{" "}
          <span className="em-strong em-sync-now__name">{current.name}</span>
          <span className="em-sync-now__kind">{KIND_LABELS[current.kind]}</span>
        </p>
        <p className="em-code em-sync-now__key">
          {displayKey(current.kind, current.key)}
          {current.step
            ? `  ·  ${String(current.step.done)} of ${String(current.step.total)} entries`
            : ""}
        </p>
      </>
    );
  } else {
    nowContent = (
      <p className="em-sync-now__text">
        {progress?.phase && progress.phase !== "preparing"
          ? "Working…"
          : noun === "sync"
            ? "Reading both stores…"
            : "Reading this store…"}
      </p>
    );
  }

  const counts = progress
    ? COUNT_ORDER.filter((status) => progress.counts[status] > 0)
    : [];
  const stepAnnouncement = finished ? title : PHASE_LABELS[phases[runningIndex]];

  return (
    <section
      className={`em-card em-sync-panel em-sync-panel--${outcome}`}
      aria-busy={!finished}
      aria-label={title}
    >
      <p className="em-sr-only" aria-live="polite">
        {stepAnnouncement}
      </p>

      <header className="em-sync-panel__header">
        <div className="em-sync-panel__heading">
          {finished ? (
            <span className={`em-sync-badge em-sync-badge--${outcome}`}>
              {outcome === "failed" ? (
                <CrossMark className="em-draw" />
              ) : (
                <CheckMark className="em-draw" />
              )}
            </span>
          ) : null}
          <h3 className="em-section-heading em-truncate">{title}</h3>
        </div>
        {/* Always rendered so its line height is reserved from the start. */}
        <span
          className={`em-sync-panel__percent${indeterminate ? " em-sync-panel__percent--hidden" : ""}`}
          aria-hidden="true"
        >
          <CountUp value={Math.round(ratio * 100)} />%
        </span>
      </header>

      <ol className="em-sync-steps">
        {phases.map((phase, index) => {
          const state =
            outcome === "failed"
              ? index < lastStepRef.current
                ? "done"
                : index === lastStepRef.current
                  ? "failed"
                  : "todo"
              : finished || index < runningIndex
                ? "done"
                : index === runningIndex
                  ? "active"
                  : "todo";

          return (
            <li key={phase} className={`em-sync-step em-sync-step--${state}`}>
              <span className="em-sync-step__marker" aria-hidden="true">
                {state === "done" ? <CheckMark className="em-draw" /> : null}
                {state === "failed" ? <CrossMark className="em-draw" /> : null}
              </span>
              <span className="em-sync-step__label">{PHASE_LABELS[phase]}</span>
            </li>
          );
        })}
      </ol>

      <div
        className={`em-sync-bar${indeterminate ? " em-sync-bar--indeterminate" : ""}`}
        role="progressbar"
        aria-label={`${Noun} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : Math.round(ratio * 100)}
      >
        <div
          className="em-sync-bar__fill"
          style={indeterminate ? undefined : { width: `${String(ratio * 100)}%` }}
        />
      </div>
      <div className="em-sync-panel__meta">
        <span className="em-body-sm em-sync-panel__done">
          {totalUnits > 0 ? (
            <>
              <CountUp value={succeeded ? totalUnits : doneUnits} />
              {` of ${String(totalUnits)} done`}
            </>
          ) : null}
        </span>
        <span className="em-sync-chips">
          {counts.map((status) => (
            <CountChip
              key={status}
              status={status}
              count={progress?.counts[status] ?? 0}
            />
          ))}
        </span>
      </div>

      <div className="em-sync-now">
        <Swap swapKey={swapKey}>{nowContent}</Swap>
      </div>

      {/* Always FEED_ROWS tall, so rows arriving never change the panel's
          height or move the page. */}
      <ul
        className={`em-sync-feed${rows.length >= FEED_ROWS ? " em-sync-feed--full" : ""}`}
        style={{ "--em-feed-rows": String(FEED_ROWS) } as CSSProperties}
        aria-label="Recently finished"
      >
        {rows.length === 0 ? (
          <li className="em-sync-feed__empty">Finished items will appear here.</li>
        ) : null}
        {rows.map((row) => {
          const newIndex = newIds.indexOf(row.id);
          const delay =
            newIndex === -1 ? 0 : (newIds.length - 1 - newIndex) * FEED_STAGGER_MS;

          return (
            <li
              key={row.id}
              className="em-sync-feed__row"
              style={{ "--em-delay": `${String(delay)}ms` } as CSSProperties}
            >
              {/* The outer row animates its height from zero, so rows below
                  glide down; padding lives on the inner content. */}
              <div className="em-sync-feed__inner">
                <div className="em-sync-feed__content">
                  <span
                    className={`em-sync-feed__icon em-sync-feed__icon--${row.status}`}
                  >
                    <Icon name={STATUS_ICONS[row.status]} size={18} filled />
                  </span>
                  <span className="em-sync-feed__name em-truncate">{row.name}</span>
                  <span className="em-sync-feed__kind">{KIND_LABELS[row.kind]}</span>
                  <span
                    className={`em-sync-feed__status em-sync-feed__status--${row.status}`}
                  >
                    {STATUS_LABELS[row.status]}
                  </span>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Hidden rather than removed when finished, to keep its space. */}
      <p
        className={`em-body-sm em-sync-panel__note${finished ? " em-sync-panel__note--hidden" : ""}`}
        aria-hidden={finished}
      >
        {`You can leave this page. The ${noun} keeps running, and the full log will be in History.`}
      </p>
    </section>
  );
}
