import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  useLoaderData,
  useNavigate,
  useSearchParams,
  type LoaderFunctionArgs,
} from "react-router";
import {
  Banner,
  Button,
  EmptyState,
  Icon,
  LinkButton,
  Pill,
  formatDateTime,
} from "../components/easy-migrate-ui";
import {
  getAllSyncJobs,
  getSyncLogs,
} from "../lib/definition-sync/logger.server";
import {
  getAllFileSyncJobs,
  getFileSyncLogs,
  getStoreConnectionHistory,
} from "../lib/history.server";
import { targetAdminGraphql } from "../lib/definition-sync/target-admin.server";
import { authenticate } from "../shopify.server";

const JOBS_PER_PAGE = 10;
const CONNECTIONS_PER_PAGE = 20;
const LOGS_PER_STEP = 10;
const HISTORY_TABS = [
  { id: "files", content: "Files history" },
  { id: "metaobjects", content: "Metaobject" },
  { id: "metafields", content: "Metafield" },
  { id: "connections", content: "Store connection" },
] as const;
type HistoryTab = (typeof HISTORY_TABS)[number]["id"];

const STATUS_LABELS: Record<string, string> = {
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
  syncing: "Running",
  scanning: "Running",
  pending: "Pending",
  created: "Created",
  exists: "Already in target",
  skipped: "Skipped",
  conflict: "Conflict",
  valid: "Connected",
  invalid: "Token invalid",
  cleared: "Session cleared",
};

interface FileHistoryJob {
  id: string;
  sourceShop: string;
  targetShop: string;
  status: string;
  totalSourceFiles: number;
  createdCount: number;
  skippedCount: number;
  failedCount: number;
  errorMessage: string | null;
  createdAt: string;
}

interface FileHistoryLog {
  id: string;
  status: string;
  identifier: string;
  contentType: string | null;
  sourceUrl: string | null;
  alt: string | null;
  message: string;
  createdAt: string;
}

interface DefinitionHistoryJob {
  id: string;
  sourceShop: string;
  targetShop: string;
  status: string;
  createdMetafieldDefinitions: number;
  createdMetaobjectDefinitions: number;
  addedMetaobjectFields: number;
  copiedMetaobjectEntries: number;
  skippedMetaobjectEntries: number;
  conflictCount: number;
  failedCount: number;
  errorMessage: string | null;
  createdAt: string;
}

interface DefinitionHistoryLog {
  id: string;
  itemType: string;
  itemKey: string;
  status: string;
  message: string;
  createdAt: string;
}

interface ConnectionHistoryEvent {
  id: string;
  sourceShop: string | null;
  status: string;
  event: string;
  message: string;
  createdAt: string;
}

interface HistoryTargetFile {
  contentType: string;
  sourceUrl: string;
  alt: string | null;
}

function isHistoryTab(value: string | null): value is HistoryTab {
  return HISTORY_TABS.some((tab) => tab.id === value);
}

function getDefinitionLogLabel(itemType: string) {
  if (itemType === "metafield_definition") return "Metafield";
  if (itemType === "metaobject_field") return "Metaobject field";
  if (itemType === "metaobject_entry") return "Metaobject entry";
  return "Metaobject";
}

function isPreviewableImage(log: FileHistoryLog) {
  const source = log.sourceUrl?.toLowerCase() ?? "";

  return (
    log.contentType === "IMAGE" ||
    source.endsWith(".svg") ||
    source.endsWith(".png") ||
    source.endsWith(".jpg") ||
    source.endsWith(".jpeg") ||
    source.endsWith(".gif") ||
    source.endsWith(".webp")
  );
}

function runId(id: string) {
  return `Run ID: #${id.slice(-6)}`;
}

function accentTone(status: string) {
  if (status === "completed" || status === "valid") return "success";
  if (status === "failed" || status === "invalid") return "critical";
  if (status === "cleared") return "neutral";
  return "warning";
}

function StatusPill({ status }: { status: string }) {
  const label = STATUS_LABELS[status] ?? status;

  if (status === "completed" || status === "valid") {
    return (
      <Pill tone="completed" icon="check_circle">
        {label}
      </Pill>
    );
  }

  if (status === "failed" || status === "invalid") {
    return <Pill tone="failed">{label}</Pill>;
  }

  if (status === "cleared") {
    return <Pill tone="neutral">{label}</Pill>;
  }

  if (status === "completed_with_errors") {
    return <Pill tone="running">{label}</Pill>;
  }

  return (
    <Pill tone="running" dot="warning">
      {label}
    </Pill>
  );
}

function LogStatusPill({ status }: { status: string }) {
  const label = STATUS_LABELS[status] ?? status;

  if (status === "created") {
    return <Pill tone="ready">{label}</Pill>;
  }

  if (status === "failed" || status === "conflict") {
    return <Pill tone="failed">{label}</Pill>;
  }

  return <Pill tone="neutral">{label}</Pill>;
}

function FileHistoryPreview({ log }: { log: FileHistoryLog }) {
  if (!log.sourceUrl) {
    return (
      <div className="em-table__preview">
        <Icon name="description" />
      </div>
    );
  }

  if (isPreviewableImage(log)) {
    return (
      <div className="em-table__preview">
        <img src={log.sourceUrl} alt={log.alt ?? log.identifier} />
      </div>
    );
  }

  return (
    <a href={log.sourceUrl} target="_blank" rel="noreferrer">
      <div className="em-table__preview">
        <Icon name={log.contentType === "VIDEO" ? "movie" : "description"} />
      </div>
    </a>
  );
}

function filenameFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname;
    return pathname.split("/").filter(Boolean).pop() ?? null;
  } catch {
    return null;
  }
}

/** Builds a CSV file in the browser and hands it to the merchant. */
function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\r\n");
  // Leading BOM so Excel opens the file as UTF-8.
  const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function getTargetFilePreviewMap(admin: any) {
  const previewMap = new Map<string, HistoryTargetFile>();
  let hasNextPage = true;
  let cursor: string | null = null;

  while (hasNextPage) {
    const data: {
      files: {
        edges: Array<{
          node: {
            __typename: string;
            alt: string | null;
            image?: { url: string | null } | null;
            url?: string | null;
            sources?: Array<{ url: string | null } | null> | null;
          };
        }>;
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    } = await targetAdminGraphql<
      {
        files: {
          edges: Array<{
            node: {
              __typename: string;
              alt: string | null;
              image?: { url: string | null } | null;
              url?: string | null;
              sources?: Array<{ url: string | null } | null> | null;
            };
          }>;
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string | null;
          };
        };
      },
      { after?: string | null }
    >(
      admin,
      `#graphql
        query HistoryTargetFiles($after: String) {
          files(first: 100, after: $after) {
            edges {
              node {
                __typename
                alt
                ... on MediaImage {
                  image {
                    url
                  }
                }
                ... on GenericFile {
                  url
                }
                ... on Video {
                  sources {
                    url
                  }
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

    for (const edge of data.files.edges) {
      const node = edge.node;
      const sourceUrl =
        node.__typename === "MediaImage"
          ? node.image?.url ?? null
          : node.__typename === "GenericFile"
            ? node.url ?? null
            : node.sources?.[0]?.url ?? null;

      if (!sourceUrl) {
        continue;
      }

      const identifier = filenameFromUrl(sourceUrl);

      if (!identifier) {
        continue;
      }

      previewMap.set(identifier, {
        contentType:
          node.__typename === "MediaImage"
            ? "IMAGE"
            : node.__typename === "Video"
              ? "VIDEO"
              : "FILE",
        sourceUrl,
        alt: node.alt,
      });
    }

    hasNextPage = data.files.pageInfo.hasNextPage;
    cursor = data.files.pageInfo.endCursor;
  }

  return previewMap;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const tab = isHistoryTab(url.searchParams.get("tab"))
    ? (url.searchParams.get("tab") as HistoryTab)
    : "files";
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const jobId = url.searchParams.get("jobId") ?? null;

  if (tab === "files") {
    const { jobs, total, totalPages } = await getAllFileSyncJobs(
      session.shop,
      page,
      JOBS_PER_PAGE,
    );
    const expandedLogs = jobId ? await getFileSyncLogs(jobId) : [];
    const previewMap =
      expandedLogs.some((log) => !log.sourceUrl) && expandedLogs.length > 0
        ? await getTargetFilePreviewMap(admin)
        : new Map<string, HistoryTargetFile>();

    return {
      tab,
      page,
      total,
      totalPages,
      jobId,
      fileJobs: jobs.map((job: any) => ({
        ...job,
        createdAt: job.createdAt.toISOString(),
      })),
      fileLogs: expandedLogs.map((log: any) => {
        const preview = !log.sourceUrl ? previewMap.get(log.identifier) : null;

        return {
          ...log,
          contentType: log.contentType ?? preview?.contentType ?? null,
          sourceUrl: log.sourceUrl ?? preview?.sourceUrl ?? null,
          alt: log.alt ?? preview?.alt ?? null,
          createdAt: log.createdAt.toISOString(),
        };
      }),
      definitionJobs: [],
      definitionLogs: [],
      connectionEvents: [],
    };
  }

  if (tab === "connections") {
    const { events, total, totalPages } = await getStoreConnectionHistory(
      session.shop,
      page,
      CONNECTIONS_PER_PAGE,
    );

    return {
      tab,
      page,
      total,
      totalPages,
      jobId: null,
      fileJobs: [],
      fileLogs: [],
      definitionJobs: [],
      definitionLogs: [],
      connectionEvents: events.map((event: any) => ({
        ...event,
        createdAt: event.createdAt.toISOString(),
      })),
    };
  }

  const { jobs, total, totalPages } = await getAllSyncJobs(
    session.shop,
    page,
    JOBS_PER_PAGE,
  );
  const expandedLogs = jobId ? await getSyncLogs(jobId) : [];
  const definitionLogs = expandedLogs.filter((log) =>
    tab === "metaobjects"
      ? log.itemType !== "metafield_definition"
      : log.itemType === "metafield_definition",
  );

  return {
    tab,
    page,
    total,
    totalPages,
    jobId,
    fileJobs: [],
    fileLogs: [],
    definitionJobs: jobs.map((job: any) => ({
      ...job,
      createdAt: job.createdAt.toISOString(),
    })),
    definitionLogs: definitionLogs.map((log: any) => ({
      ...log,
      createdAt: log.createdAt.toISOString(),
    })),
    connectionEvents: [],
  };
}

function RunCount({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "primary" | "critical";
}) {
  const showTone = tone === "critical" ? value > 0 : Boolean(tone);

  return (
    <div>
      <p className="em-run__count-label">{label}</p>
      <p
        className={
          showTone
            ? `em-run__count-value em-run__count-value--${tone}`
            : "em-run__count-value"
        }
      >
        {value.toLocaleString()}
      </p>
    </div>
  );
}

function RunCard({
  status,
  store,
  timestamp,
  id,
  counts,
  errorMessage,
  expanded,
  onToggle,
  children,
}: {
  status: string;
  store: string;
  timestamp: string;
  id: string;
  counts: ReactNode;
  errorMessage?: string | null;
  expanded: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const isRunning =
    status === "syncing" || status === "scanning" || status === "pending";

  return (
    <div className="em-run">
      <div className={`em-run__accent em-run__accent--${accentTone(status)}`} />

      <div className="em-run__head">
        <div>
          <div className="em-row-inline" style={{ marginBottom: 8 }}>
            <StatusPill status={status} />
            <span className="em-body-sm">{runId(id)}</span>
          </div>
          <h3 className="em-run__store">{store}</h3>
          <p className="em-run__meta">{formatDateTime(timestamp)}</p>
        </div>
        <LinkButton onClick={onToggle} icon="expand_more">
          {expanded ? "Hide Details" : "Details"}
        </LinkButton>
      </div>

      {errorMessage ? (
        <div className="em-error-box">
          <Icon name="error" className="em-icon-lead" filled />
          <div>
            <p className="em-error-box__title">Migration failed</p>
            <p className="em-error-box__code">{errorMessage}</p>
            <p className="em-error-box__hint">
              Check that the source token is still valid and has permission to
              read this data, then run the migration again.
            </p>
          </div>
        </div>
      ) : null}

      <div
        className={
          errorMessage ? "em-run__counts em-run__counts--dim" : "em-run__counts"
        }
      >
        {counts}
      </div>

      {isRunning ? (
        <div className="em-progress">
          <div className="em-progress__fill em-progress__fill--indeterminate" />
        </div>
      ) : null}

      {expanded && children ? children : null}
    </div>
  );
}

export default function HistoryPage() {
  const {
    tab,
    page,
    total,
    totalPages,
    jobId,
    fileJobs,
    fileLogs,
    definitionJobs,
    definitionLogs,
    connectionEvents,
  } = useLoaderData<typeof loader>() as {
    tab: HistoryTab;
    page: number;
    total: number;
    totalPages: number;
    jobId: string | null;
    fileJobs: FileHistoryJob[];
    fileLogs: FileHistoryLog[];
    definitionJobs: DefinitionHistoryJob[];
    definitionLogs: DefinitionHistoryLog[];
    connectionEvents: ConnectionHistoryEvent[];
  };
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [visibleLogCount, setVisibleLogCount] = useState(LOGS_PER_STEP);
  const [statusFilter, setStatusFilter] = useState("all");
  const [rangeFilter, setRangeFilter] = useState("all");
  const detailsRef = useRef<HTMLDivElement | null>(null);

  function matchesFilters(record: { status: string; createdAt: string }) {
    if (statusFilter !== "all" && record.status !== statusFilter) {
      return false;
    }

    if (rangeFilter === "all") {
      return true;
    }

    const days = Number(rangeFilter);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    return new Date(record.createdAt).getTime() >= cutoff;
  }

  const visibleFileJobs = fileJobs.filter(matchesFilters);
  const visibleDefinitionJobs = definitionJobs.filter(matchesFilters);
  const visibleConnectionEvents = connectionEvents.filter(matchesFilters);
  const shownFileLogs = fileLogs.slice(0, visibleLogCount);
  const shownDefinitionLogs = definitionLogs.slice(0, visibleLogCount);

  useEffect(() => {
    setVisibleLogCount(LOGS_PER_STEP);
  }, [jobId, tab]);

  useEffect(() => {
    if (!searchParams.get("jobId") || !detailsRef.current) {
      return;
    }

    window.setTimeout(() => {
      detailsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
  }, [searchParams]);

  function toggleJob(id: string) {
    const base = `/app/history?tab=${tab}&page=${String(page)}`;
    navigate(id === jobId ? base : `${base}&jobId=${id}`);
  }

  const statusOptions =
    tab === "connections"
      ? [
          { label: "Any Status", value: "all" },
          { label: "Connected", value: "valid" },
          { label: "Token invalid", value: "invalid" },
          { label: "Session cleared", value: "cleared" },
        ]
      : [
          { label: "Any Status", value: "all" },
          { label: "Completed", value: "completed" },
          { label: "Completed with errors", value: "completed_with_errors" },
          { label: "Failed", value: "failed" },
        ];

  function renderPagination() {
    if (totalPages <= 1) {
      return null;
    }

    return (
      <div className="em-row-between">
        <span className="em-body-sm">
          {`Page ${String(page)} of ${String(totalPages)}`}
        </span>
        <div className="em-row-inline">
          <Button
            size="sm"
            onClick={() =>
              navigate(
                `/app/history?tab=${tab}&page=${String(Math.max(1, page - 1))}`,
              )
            }
            disabled={page <= 1}
          >
            Previous
          </Button>
          <Button
            size="sm"
            onClick={() =>
              navigate(
                `/app/history?tab=${tab}&page=${String(
                  Math.min(totalPages, page + 1),
                )}`,
              )
            }
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      </div>
    );
  }

  function renderLoadMore(shown: number, totalLogs: number) {
    if (totalLogs === 0) {
      return null;
    }

    return (
      <div className="em-center" style={{ padding: 12 }}>
        {shown < totalLogs ? (
          <Button
            size="sm"
            onClick={() => setVisibleLogCount((current) => current + LOGS_PER_STEP)}
          >
            Load more
          </Button>
        ) : null}
        <span className="em-body-sm">
          {`Showing ${String(shown)} of ${String(totalLogs)}`}
        </span>
      </div>
    );
  }

  function renderEmptyState() {
    return (
      <div className="em-card">
        <EmptyState
          icon="history"
          title="No runs yet"
          body={
            tab === "connections"
              ? "Connection events appear here once you connect a source store."
              : "Your first migration will appear here."
          }
          action={
            <Button
              variant="primary"
              icon={tab === "files" ? "sync_alt" : "dashboard"}
              onClick={() => navigate(tab === "files" ? "/app/files" : "/app")}
            >
              {tab === "files" ? "Go to Files Migration" : "Go to Dashboard"}
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="em-app">
      <div className="em-page">
        <header className="em-page-header">
          <h2 className="em-page-title">History</h2>
          <p className="em-page-subtitle">
            Review past migration runs and details.
          </p>
        </header>

        <div className="em-tabs">
          {HISTORY_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === tab ? "em-tab em-tab--active" : "em-tab"}
              onClick={() => navigate(`/app/history?tab=${item.id}`)}
            >
              {item.content}
            </button>
          ))}
        </div>

        <div className="em-row-inline">
          <select
            className="em-select"
            style={{ width: "auto" }}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            aria-label="Filter by status"
          >
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            className="em-select"
            style={{ width: "auto" }}
            value={rangeFilter}
            onChange={(event) => setRangeFilter(event.target.value)}
            aria-label="Filter by date range"
          >
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="all">All time</option>
          </select>
          <span className="em-body-sm em-spacer">
            {`${String(total)} ${tab === "connections" ? "events" : "runs"}`}
          </span>
        </div>

        {/* ── Files history ── */}
        {tab === "files" ? (
          visibleFileJobs.length === 0 ? (
            renderEmptyState()
          ) : (
            <div className="em-stack">
              {visibleFileJobs.map((job) => (
                <div key={job.id} ref={job.id === jobId ? detailsRef : undefined}>
                  <RunCard
                    status={job.status}
                    store={job.sourceShop}
                    timestamp={job.createdAt}
                    id={job.id}
                    errorMessage={job.errorMessage}
                    expanded={job.id === jobId}
                    onToggle={() => toggleJob(job.id)}
                    counts={
                      <>
                        <RunCount label="Selected" value={job.totalSourceFiles} />
                        <RunCount
                          label="Created"
                          value={job.createdCount}
                          tone="primary"
                        />
                        <RunCount label="Skipped" value={job.skippedCount} />
                        <RunCount
                          label="Failed"
                          value={job.failedCount}
                          tone="critical"
                        />
                      </>
                    }
                  >
                    {fileLogs.length > 0 ? (
                      <>
                        <div className="em-row-between">
                          <h4 className="em-section-heading">Files log</h4>
                          <Button
                            size="sm"
                            icon="download"
                            onClick={() =>
                              downloadCsv(`easy-migrate-files-${job.id}.csv`, [
                                ["Status", "Identifier", "Message", "Date & Time"],
                                ...fileLogs.map((log) => [
                                  STATUS_LABELS[log.status] ?? log.status,
                                  log.identifier,
                                  log.message,
                                  formatDateTime(log.createdAt),
                                ]),
                              ])
                            }
                          >
                            Download CSV
                          </Button>
                        </div>
                        <div className="em-table-wrap">
                          <table className="em-table">
                            <thead>
                              <tr>
                                <th scope="col">Status</th>
                                <th scope="col">Preview</th>
                                <th scope="col">Identifier</th>
                                <th scope="col">Message</th>
                                <th scope="col">Date &amp; Time</th>
                              </tr>
                            </thead>
                            <tbody>
                              {shownFileLogs.map((log) => (
                                <tr key={log.id}>
                                  <td>
                                    <LogStatusPill status={log.status} />
                                  </td>
                                  <td>
                                    <FileHistoryPreview log={log} />
                                  </td>
                                  <td className="em-table__id">{log.identifier}</td>
                                  <td>{log.message}</td>
                                  <td className="em-table__time">
                                    {formatDateTime(log.createdAt)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {renderLoadMore(shownFileLogs.length, fileLogs.length)}
                      </>
                    ) : (
                      <p className="em-body-sm">
                        No per-file log entries were recorded for this run.
                      </p>
                    )}
                  </RunCard>
                </div>
              ))}
              {renderPagination()}
            </div>
          )
        ) : null}

        {/* ── Definition history ── */}
        {tab === "metaobjects" || tab === "metafields" ? (
          visibleDefinitionJobs.length === 0 ? (
            renderEmptyState()
          ) : (
            <div className="em-stack">
              {visibleDefinitionJobs.map((job) => (
                <div key={job.id} ref={job.id === jobId ? detailsRef : undefined}>
                  <RunCard
                    status={job.status}
                    store={job.sourceShop}
                    timestamp={job.createdAt}
                    id={job.id}
                    errorMessage={job.errorMessage}
                    expanded={job.id === jobId}
                    onToggle={() => toggleJob(job.id)}
                    counts={
                      tab === "metaobjects" ? (
                        <>
                          <RunCount
                            label="Definitions"
                            value={job.createdMetaobjectDefinitions}
                            tone="primary"
                          />
                          <RunCount
                            label="Fields"
                            value={job.addedMetaobjectFields}
                          />
                          <RunCount
                            label="Entries"
                            value={job.copiedMetaobjectEntries}
                          />
                          <RunCount
                            label="Failed"
                            value={job.failedCount}
                            tone="critical"
                          />
                        </>
                      ) : (
                        <>
                          <RunCount
                            label="Created"
                            value={job.createdMetafieldDefinitions}
                            tone="primary"
                          />
                          <RunCount label="Conflicts" value={job.conflictCount} />
                          <RunCount
                            label="Failed"
                            value={job.failedCount}
                            tone="critical"
                          />
                        </>
                      )
                    }
                  >
                    {tab === "metaobjects" && job.copiedMetaobjectEntries > 0 ? (
                      <Banner tone="warning" title="Reference fields not migrated">
                        Metaobject fields of type product, collection, product
                        variant, page, and URL cannot be copied between stores.
                        They are left empty in this store and must be set
                        manually.
                      </Banner>
                    ) : null}

                    {definitionLogs.length > 0 ? (
                      <>
                        <div className="em-row-between">
                          <h4 className="em-section-heading">
                            {tab === "metaobjects"
                              ? "Metaobject log"
                              : "Metafield log"}
                          </h4>
                          <Button
                            size="sm"
                            icon="download"
                            onClick={() =>
                              downloadCsv(`easy-migrate-${tab}-${job.id}.csv`, [
                                [
                                  "Status",
                                  "Type",
                                  "Identifier",
                                  "Message",
                                  "Date & Time",
                                ],
                                ...definitionLogs.map((log) => [
                                  STATUS_LABELS[log.status] ?? log.status,
                                  getDefinitionLogLabel(log.itemType),
                                  log.itemKey,
                                  log.message,
                                  formatDateTime(log.createdAt),
                                ]),
                              ])
                            }
                          >
                            Download CSV
                          </Button>
                        </div>
                        <div className="em-table-wrap">
                          <table className="em-table">
                            <thead>
                              <tr>
                                <th scope="col">Status</th>
                                <th scope="col">Type</th>
                                <th scope="col">Identifier</th>
                                <th scope="col">Message</th>
                                <th scope="col">Date &amp; Time</th>
                              </tr>
                            </thead>
                            <tbody>
                              {shownDefinitionLogs.map((log) => (
                                <tr key={log.id}>
                                  <td>
                                    <LogStatusPill status={log.status} />
                                  </td>
                                  <td>{getDefinitionLogLabel(log.itemType)}</td>
                                  <td className="em-table__id">{log.itemKey}</td>
                                  <td>{log.message}</td>
                                  <td className="em-table__time">
                                    {formatDateTime(log.createdAt)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {renderLoadMore(
                          shownDefinitionLogs.length,
                          definitionLogs.length,
                        )}
                      </>
                    ) : (
                      <p className="em-body-sm">
                        No log entries were recorded for this run.
                      </p>
                    )}
                  </RunCard>
                </div>
              ))}
              {renderPagination()}
            </div>
          )
        ) : null}

        {/* ── Store connection history ── */}
        {tab === "connections" ? (
          visibleConnectionEvents.length === 0 ? (
            renderEmptyState()
          ) : (
            <div className="em-card">
              <div className="em-card__body">
                <h3 className="em-section-heading">Store connection events</h3>
                <div className="em-table-wrap">
                  <table className="em-table">
                    <thead>
                      <tr>
                        <th scope="col">Status</th>
                        <th scope="col">Event</th>
                        <th scope="col">Source store</th>
                        <th scope="col">Message</th>
                        <th scope="col">Date &amp; Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleConnectionEvents.map((event) => (
                        <tr key={event.id}>
                          <td>
                            <StatusPill status={event.status} />
                          </td>
                          <td>{event.event}</td>
                          <td>
                            {event.sourceShop ? (
                              <code className="em-code-chip">
                                {event.sourceShop}
                              </code>
                            ) : (
                              "Not provided"
                            )}
                          </td>
                          <td>{event.message}</td>
                          <td className="em-table__time">
                            {formatDateTime(event.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {renderPagination()}
              </div>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
