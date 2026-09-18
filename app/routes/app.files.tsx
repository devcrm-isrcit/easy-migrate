import { useAppBridge } from "@shopify/app-bridge-react";
import { useRef, useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  useNavigate,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import {
  Banner,
  Button,
  EmptyState,
  Icon,
  LinkButton,
  Modal,
  Pill,
  StatGrid,
  StatTile,
} from "../components/easy-migrate-ui";
import { fetchFileMigrationPreview, runFileMigration } from "../lib/file-sync.server";
import { readStoredSourceCredential } from "../lib/source-credentials.client";
import { authenticate } from "../shopify.server";

interface PreviewFile {
  id: string;
  alt: string | null;
  contentType: "IMAGE" | "VIDEO" | "FILE";
  filename: string | null;
  sourceUrl: string;
  alreadyInTarget?: boolean;
}

type TypeFilter = "all" | "image" | "video" | "other";
type ScopeFilter = "transferable" | "everything";

const PAGE_SIZE = 50;

const CONTENT_TYPE_LABELS: Record<PreviewFile["contentType"], string> = {
  IMAGE: "MediaImage",
  VIDEO: "Video",
  FILE: "GenericFile",
};

const LOG_STATUS_LABELS: Record<string, string> = {
  created: "Created",
  skipped: "Skipped",
  failed: "Failed",
};

function getFileFilterType(file: PreviewFile): Exclude<TypeFilter, "all"> {
  if (file.contentType === "IMAGE") {
    return "image";
  }

  if (file.contentType === "VIDEO") {
    return "video";
  }

  return "other";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);

  return {
    targetShop: session.shop,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "preview");
  const sourceShop = String(formData.get("sourceShop") || "").trim();
  const sourceToken = String(formData.get("sourceToken") || "").trim();

  if (!sourceShop || !sourceToken) {
    return {
      ok: false,
      error: "Enter a source store domain and token first.",
    };
  }

  if (intent === "preview") {
    try {
      const preview = await fetchFileMigrationPreview({
        sourceShop,
        sourceToken,
        targetShop: session.shop,
        admin,
      });

      return {
        ok: true,
        intent,
        preview,
      };
    } catch (error) {
      return {
        ok: false,
        intent,
        error:
          error instanceof Error ? error.message : "Failed to load file preview.",
      };
    }
  }

  if (intent !== "migrate") {
    return { ok: false, error: "Unsupported action." };
  }

  const selectedFileIds = JSON.parse(
    String(formData.get("selectedFileIds") || "[]"),
  ) as string[];

  if (selectedFileIds.length === 0) {
    return {
      ok: false,
      error: "Select at least one file or media item to migrate.",
    };
  }

  try {
    const result = await runFileMigration({
      sourceShop,
      sourceToken,
      targetShop: session.shop,
      admin,
      selectedFileIds,
    });

    return {
      ok: true,
      message: "File migration completed.",
      result,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "File migration failed.",
    };
  }
}

function FileThumb({ file }: { file: PreviewFile }) {
  const muted = Boolean(file.alreadyInTarget);

  if (file.contentType === "IMAGE") {
    return (
      <div className={muted ? "em-thumb em-thumb--muted" : "em-thumb"}>
        <img src={file.sourceUrl} alt={file.alt ?? file.filename ?? "Source file"} />
      </div>
    );
  }

  return (
    <div className={muted ? "em-thumb em-thumb--muted" : "em-thumb"}>
      <Icon name={file.contentType === "VIDEO" ? "movie" : "description"} />
    </div>
  );
}

export default function FileMigrationPage() {
  const shopify = useAppBridge();
  const { targetShop } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const previewFetcher = useFetcher<typeof action>();
  const migrationFetcher = useFetcher<typeof action>();
  const migrationResultRef = useRef<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<{
    sourceShop: string;
    totalSourceFiles: number;
    transferableFiles: number;
    skippedExistingFiles: number;
    files: PreviewFile[];
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewData = previewFetcher.data as
    | {
        ok: boolean;
        intent?: string;
        preview?: {
          sourceShop: string;
          totalSourceFiles: number;
          transferableFiles: number;
          skippedExistingFiles: number;
          files: PreviewFile[];
        };
        error?: string;
      }
    | undefined;
  const migrationData = migrationFetcher.data as
    | {
        ok: boolean;
        intent?: string;
        message?: string;
        error?: string;
        result?: {
          sourceShop: string;
          totalSourceFiles: number;
          createdCount: number;
          skippedCount: number;
          failedCount: number;
          logs: Array<{
            status: "created" | "skipped" | "failed";
            identifier: string;
            message: string;
          }>;
        };
      }
    | undefined;
  const files = preview?.files ?? [];
  const [sourceShop, setSourceShop] = useState("");
  const [sourceToken, setSourceToken] = useState("");
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("transferable");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [hasStoredCredential, setHasStoredCredential] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [previewFile, setPreviewFile] = useState<PreviewFile | null>(null);
  const [previewFileFailed, setPreviewFileFailed] = useState(false);
  const isLoadingPreview = previewFetcher.state !== "idle";
  const isMigrating = migrationFetcher.state !== "idle";
  const logs = migrationData?.result?.logs ?? [];
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredFiles = files.filter((file) => {
    const matchesType =
      typeFilter === "all" ? true : getFileFilterType(file) === typeFilter;
    const matchesScope =
      scopeFilter === "everything" ? true : !file.alreadyInTarget;
    const identifier = (file.filename ?? file.id).toLowerCase();
    const altText = (file.alt ?? "").toLowerCase();
    const matchesQuery =
      normalizedQuery.length === 0 ||
      identifier.includes(normalizedQuery) ||
      altText.includes(normalizedQuery);

    return matchesType && matchesScope && matchesQuery;
  });
  const totalPages = Math.max(1, Math.ceil(filteredFiles.length / PAGE_SIZE));
  const paginatedFiles = filteredFiles.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const selectableVisibleFiles = paginatedFiles.filter(
    (file) => !file.alreadyInTarget,
  );
  const allVisibleSelected =
    selectableVisibleFiles.length > 0 &&
    selectableVisibleFiles.every((file) => selectedFileIds.includes(file.id));
  const imageCount = files.filter((file) => getFileFilterType(file) === "image").length;
  const videoCount = files.filter((file) => getFileFilterType(file) === "video").length;
  const otherCount = files.filter((file) => getFileFilterType(file) === "other").length;
  const transferableCount = files.filter((file) => !file.alreadyInTarget).length;
  const hasFilters =
    normalizedQuery.length > 0 || typeFilter !== "all" || scopeFilter !== "everything";

  useEffect(() => {
    const storedCredential = readStoredSourceCredential(targetShop);

    if (!storedCredential) {
      setHasStoredCredential(false);
      setIsInitializing(false);
      return;
    }

    setHasStoredCredential(true);
    setSourceShop(storedCredential.sourceShop);
    setSourceToken(storedCredential.sourceToken);

    const formData = new FormData();
    formData.set("intent", "preview");
    formData.set("sourceShop", storedCredential.sourceShop);
    formData.set("sourceToken", storedCredential.sourceToken);
    previewFetcher.submit(formData, { method: "post" });
  }, [targetShop]);

  useEffect(() => {
    if (!previewData) {
      return;
    }

    if (previewData.ok && previewData.preview) {
      setPreview(previewData.preview);
      setPreviewError(null);
      setIsInitializing(false);
      return;
    }

    setPreview(null);
    setPreviewError(previewData.error ?? "Failed to load file preview.");
    setIsInitializing(false);
  }, [previewData]);

  useEffect(() => {
    if (!previewError) {
      return;
    }

    shopify.toast.show(previewError, { isError: true });
  }, [previewError, shopify]);

  useEffect(() => {
    if (!migrationData) {
      return;
    }

    if (migrationData.ok) {
      shopify.toast.show(migrationData.message ?? "File migration completed.");
      return;
    }

    if (migrationData.error) {
      shopify.toast.show(migrationData.error, { isError: true });
    }
  }, [migrationData, shopify]);

  useEffect(() => {
    if (!migrationData) {
      return;
    }

    migrationResultRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [migrationData]);

  useEffect(() => {
    setSelectedFileIds([]);
  }, [preview?.sourceShop, files.length]);

  useEffect(() => {
    setCurrentPage(1);
  }, [typeFilter, scopeFilter, searchQuery, preview?.sourceShop]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  function handleMigrate() {
    const formData = new FormData();
    formData.set("intent", "migrate");
    formData.set("sourceShop", sourceShop);
    formData.set("sourceToken", sourceToken);
    formData.set("selectedFileIds", JSON.stringify(selectedFileIds));
    migrationFetcher.submit(formData, { method: "post" });
  }

  function toggleFileSelection(fileId: string) {
    setSelectedFileIds((current) =>
      current.includes(fileId)
        ? current.filter((id) => id !== fileId)
        : [...current, fileId],
    );
  }

  function toggleSelectAll() {
    if (allVisibleSelected) {
      const visibleIds = new Set(selectableVisibleFiles.map((file) => file.id));
      setSelectedFileIds((current) => current.filter((id) => !visibleIds.has(id)));
      return;
    }

    setSelectedFileIds((current) => {
      const next = new Set(current);
      for (const file of selectableVisibleFiles) {
        next.add(file.id);
      }
      return [...next];
    });
  }

  function clearFilters() {
    setSearchQuery("");
    setTypeFilter("all");
    setScopeFilter("everything");
  }

  return (
    <div className="em-app">
      <div className="em-page">
        <header className="em-page-header">
          <h2 className="em-page-title">Files Migration</h2>
          <p className="em-page-subtitle">
            Select and manage files for migration to the target store.
          </p>
        </header>

        {isInitializing ? (
          <div className="em-card">
            <div className="em-center">
              <Icon name="progress_activity" size={32} className="em-spin" />
              <span className="em-body-sm">
                Verifying the saved source connection and loading the migration
                preview.
              </span>
            </div>
          </div>
        ) : null}

        {!hasStoredCredential && !isLoadingPreview ? (
          <div className="em-card">
            <EmptyState
              icon="link_off"
              title="No source store connected"
              body="Files Migration uses the same browser session as the dashboard. Connect a source store first."
              action={
                <Button
                  variant="primary"
                  icon="dashboard"
                  onClick={() => navigate("/app")}
                >
                  Go to Dashboard
                </Button>
              }
            />
          </div>
        ) : null}

        {previewError ? (
          <Banner
            tone="critical"
            title="Couldn't reach the source store"
            action={
              <LinkButton onClick={() => navigate("/app")}>
                Update connection
              </LinkButton>
            }
          >
            {previewError}
          </Banner>
        ) : null}

        {preview && !isInitializing ? (
          <>
            {/* ── Overview stat tiles ── */}
            <StatGrid gap="md">
              <StatTile
                label="Total files"
                value={preview.totalSourceFiles}
                variant="bordered"
              />
              <StatTile
                label="Transferable"
                value={transferableCount}
                variant="bordered"
              />
              <StatTile
                label="Already in target"
                value={preview.skippedExistingFiles}
                variant="bordered"
              />
              <StatTile
                label="Selected"
                value={selectedFileIds.length}
                variant="selected"
              />
            </StatGrid>

            {/* ── Choose files ── */}
            <div className="em-card em-card--flush">
              <div className="em-list-toolbar">
                <div className="em-list-toolbar__row">
                  <div className="em-search" style={{ maxWidth: 300 }}>
                    <Icon name="search" className="em-search__icon" />
                    <input
                      className="em-input"
                      type="text"
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="Search files..."
                      aria-label="Search files"
                    />
                  </div>
                  <div className="em-spacer" />
                  <div className="em-select-wrap">
                    <Icon name="filter_list" className="em-select-wrap__icon" />
                    <select
                      className="em-select"
                      value={typeFilter}
                      onChange={(event) =>
                        setTypeFilter(event.target.value as TypeFilter)
                      }
                      aria-label="Filter by file type"
                    >
                      <option value="all">{`All types (${String(files.length)})`}</option>
                      <option value="image">{`Images (${String(imageCount)})`}</option>
                      <option value="video">{`Videos (${String(videoCount)})`}</option>
                      <option value="other">{`Documents (${String(otherCount)})`}</option>
                    </select>
                  </div>
                  <div className="em-select-wrap">
                    <Icon name="tune" className="em-select-wrap__icon" />
                    <select
                      className="em-select"
                      value={scopeFilter}
                      onChange={(event) =>
                        setScopeFilter(event.target.value as ScopeFilter)
                      }
                      aria-label="Filter by migration status"
                    >
                      <option value="transferable">Transferable only</option>
                      <option value="everything">Everything</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="em-list-head em-grid-files">
                <div className="em-cell-center">
                  <input
                    className="em-checkbox"
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    disabled={selectableVisibleFiles.length === 0 || isMigrating}
                    aria-label="Select every file on this page"
                  />
                </div>
                <div>File Details</div>
                <div className="em-cell-right">Type</div>
                <div>Status</div>
              </div>

              <div className="em-list-scroll em-list-scroll--500">
                {paginatedFiles.length > 0 ? (
                  paginatedFiles.map((file) => {
                    const checked = selectedFileIds.includes(file.id);
                    const alreadyInTarget = Boolean(file.alreadyInTarget);

                    return (
                      <label
                        key={file.id}
                        className={[
                          "em-list-row em-grid-files",
                          checked ? "em-list-row--selected" : "",
                          alreadyInTarget ? "em-list-row--disabled" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        <div className="em-cell-center">
                          <input
                            className="em-checkbox"
                            type="checkbox"
                            checked={checked}
                            disabled={alreadyInTarget || isMigrating}
                            onChange={() => toggleFileSelection(file.id)}
                            aria-label={`Select ${file.filename ?? file.id}`}
                          />
                        </div>
                        <div className="em-cell-file">
                          <FileThumb file={file} />
                          <div className="em-cell-stack">
                            <span
                              className={
                                alreadyInTarget
                                  ? "em-body em-truncate em-strike"
                                  : "em-body em-strong em-truncate"
                              }
                            >
                              {file.filename ?? file.id}
                            </span>
                            <span className="em-body-sm em-truncate">
                              {file.alt ? `Alt: ${file.alt}` : "No alt text"}
                            </span>
                          </div>
                        </div>
                        <div className="em-cell-right em-code" style={{ color: "var(--em-secondary)" }}>
                          {CONTENT_TYPE_LABELS[file.contentType]}
                        </div>
                        <div className="em-row-inline">
                          {alreadyInTarget ? (
                            <Pill tone="neutral">Already in target</Pill>
                          ) : (
                            <Pill tone="ready">Ready</Pill>
                          )}
                          <button
                            type="button"
                            className="em-link-btn"
                            onClick={(event) => {
                              // The row is a <label>; keep this click off the checkbox.
                              event.preventDefault();
                              setPreviewFileFailed(false);
                              setPreviewFile(file);
                            }}
                          >
                            Preview
                          </button>
                        </div>
                      </label>
                    );
                  })
                ) : files.length === 0 || transferableCount === 0 ? (
                  <EmptyState
                    compact
                    icon="check_circle"
                    title="Nothing left to copy"
                    body="The target store already has every supported file from the source store."
                  />
                ) : (
                  <EmptyState
                    compact
                    icon="search_off"
                    title="No files match your search"
                    body="Try a different term, or clear the filters to see every file in the source store."
                    action={
                      hasFilters ? (
                        <Button onClick={clearFilters}>Clear filters</Button>
                      ) : undefined
                    }
                  />
                )}
              </div>

              {filteredFiles.length > PAGE_SIZE ? (
                <div
                  className="em-row-between"
                  style={{
                    padding: "12px 20px",
                    borderTop: "1px solid var(--em-border)",
                  }}
                >
                  <span className="em-body-sm">
                    {`Showing ${String((currentPage - 1) * PAGE_SIZE + 1)}–${String(
                      Math.min(currentPage * PAGE_SIZE, filteredFiles.length),
                    )} of ${String(filteredFiles.length)}`}
                  </span>
                  <div className="em-row-inline">
                    <Button
                      size="sm"
                      onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                      disabled={currentPage <= 1}
                    >
                      Previous
                    </Button>
                    <Button
                      size="sm"
                      onClick={() =>
                        setCurrentPage((page) => Math.min(totalPages, page + 1))
                      }
                      disabled={currentPage >= totalPages}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {/* ── Migration result ── */}
        {migrationData ? (
          <div className="em-card" ref={migrationResultRef}>
            <div className="em-card__body">
              <h3 className="em-section-heading">Last migration result</h3>

              <Banner
                tone={migrationData.ok ? "success" : "critical"}
                title={migrationData.ok ? "Migration completed" : "Migration failed"}
              >
                {migrationData.ok ? migrationData.message : migrationData.error}
              </Banner>

              {migrationData.result ? (
                <>
                  <StatGrid>
                    <StatTile
                      label="Selected"
                      value={migrationData.result.totalSourceFiles}
                    />
                    <StatTile
                      label="Created"
                      value={migrationData.result.createdCount}
                    />
                    <StatTile
                      label="Skipped"
                      value={migrationData.result.skippedCount}
                    />
                    <StatTile
                      label="Failed"
                      value={migrationData.result.failedCount}
                      tone="critical"
                    />
                  </StatGrid>

                  {logs.length > 0 ? (
                    <div className="em-table-wrap">
                      <table className="em-table">
                        <thead>
                          <tr>
                            <th scope="col">Status</th>
                            <th scope="col">Identifier</th>
                            <th scope="col">Message</th>
                          </tr>
                        </thead>
                        <tbody>
                          {logs.map((log) => (
                            <tr key={`${log.status}-${log.identifier}`}>
                              <td>
                                <Pill
                                  tone={
                                    log.status === "created"
                                      ? "ready"
                                      : log.status === "failed"
                                        ? "failed"
                                        : "neutral"
                                  }
                                >
                                  {LOG_STATUS_LABELS[log.status] ?? log.status}
                                </Pill>
                              </td>
                              <td className="em-table__id">{log.identifier}</td>
                              <td>{log.message}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ── Sticky action bar ── */}
        {preview && !isInitializing ? (
          <div className="em-actionbar">
            <div className="em-row-inline">
              <span className="em-actionbar__label">
                {`${String(selectedFileIds.length)} files selected`}
              </span>
              <LinkButton
                tone="muted"
                onClick={() => setSelectedFileIds([])}
                disabled={selectedFileIds.length === 0}
              >
                Clear selection
              </LinkButton>
            </div>
            <div className="em-row-inline">
              <Button onClick={() => navigate("/app")}>Cancel</Button>
              <Button
                variant="primary"
                icon="publish"
                onClick={handleMigrate}
                loading={isMigrating}
                disabled={
                  selectedFileIds.length === 0 ||
                  !selectedFileIds.some((id) =>
                    files.some((file) => file.id === id && !file.alreadyInTarget),
                  )
                }
              >
                {`Migrate ${String(selectedFileIds.length)} files`}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {/* ── File preview modal ── */}
      {previewFile ? (
        <Modal
          title="File preview"
          onClose={() => setPreviewFile(null)}
          footer={
            <>
              <Button onClick={() => setPreviewFile(null)}>Close</Button>
              {previewFile.alreadyInTarget ? null : (
                <Button
                  variant="primary"
                  onClick={() => {
                    toggleFileSelection(previewFile.id);
                    setPreviewFile(null);
                  }}
                >
                  {selectedFileIds.includes(previewFile.id)
                    ? "Clear this file"
                    : "Select this file"}
                </Button>
              )}
            </>
          }
        >
          <div
            className={
              previewFileFailed
                ? "em-preview-panel em-preview-panel--message"
                : "em-preview-panel"
            }
          >
            {previewFileFailed ? (
              <>
                <Icon name="broken_image" size={32} />
                <span className="em-body-sm">Failed to load file preview.</span>
              </>
            ) : previewFile.contentType === "IMAGE" ? (
              <img
                src={previewFile.sourceUrl}
                alt={previewFile.alt ?? previewFile.filename ?? "Source file"}
                onError={() => setPreviewFileFailed(true)}
              />
            ) : previewFile.contentType === "VIDEO" ? (
              <video
                src={previewFile.sourceUrl}
                controls
                preload="metadata"
                onError={() => setPreviewFileFailed(true)}
              >
                {/* Source-store videos carry no caption track. */}
                <track kind="captions" />
              </video>
            ) : (
              <div className="em-preview-panel--message">
                <Icon name="description" size={32} />
                <span className="em-body-sm">
                  No visual preview for this file type.
                </span>
              </div>
            )}
          </div>

          <dl className="em-definition-list">
            <dt>Filename</dt>
            <dd>{previewFile.filename ?? previewFile.id}</dd>
            <dt>Type</dt>
            <dd>{CONTENT_TYPE_LABELS[previewFile.contentType]}</dd>
            <dt>Alt text</dt>
            <dd>{previewFile.alt ?? "Not set"}</dd>
            <dt>Status</dt>
            <dd>
              {previewFile.alreadyInTarget ? "Already in target" : "Transferable"}
            </dd>
            <dt>Source URL</dt>
            <dd>
              <code className="em-code-chip">{previewFile.sourceUrl}</code>
            </dd>
          </dl>
        </Modal>
      ) : null}
    </div>
  );
}
