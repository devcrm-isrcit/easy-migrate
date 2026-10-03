import { useEffect, useRef, useState } from "react";
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
  Field,
  Icon,
  LinkButton,
  Modal,
  Pill,
  Spinner,
  StatGrid,
  StatTile,
  formatDateTime,
} from "../components/easy-migrate-ui";
import { ConflictDetailsButton } from "../components/conflict-details";
import {
  DefinitionSelectionList,
  countSelection,
  getSelectableDefinitions,
} from "../components/definition-scan-results";
import {
  SyncProgressPanel,
  useSyncProgress,
  type SyncOutcome,
} from "../components/sync-progress";
import {
  getLatestSyncJob,
} from "../lib/definition-sync/logger.server";
import { createStoreConnectionHistory } from "../lib/history.server";
import {
  buildDefinitionScanPreview,
  runDefinitionSync,
} from "../lib/definition-sync/sync.server";
import { deleteAppCreatedDefinitions } from "../lib/definition-sync/delete-definitions.server";
import { validateSourceConnection } from "../lib/definition-sync/source-admin.server";
import { startSyncProgress } from "../lib/definition-sync/progress.server";
import type { DefinitionScanPreview as ServerDefinitionScanPreview } from "../lib/definition-sync/types.shared";
import {
  createConnectionCode,
  getLinkedSourceShop,
  getLinkedTargetShops,
  redeemConnectionCode,
  removeSourceLink,
} from "../lib/source-link.server";
import { CODE_TTL_MINUTES } from "../lib/source-link.shared";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  const [latestJob, shopResponse, sourceShop, connectedTargets] =
    await Promise.all([
      getLatestSyncJob(session.shop),
      admin.graphql(`#graphql
        query DashboardShop {
          shop { name myshopifyDomain }
        }
      `),
      getLinkedSourceShop(session.shop),
      getLinkedTargetShops(session.shop),
    ]);

  const shopPayload = await shopResponse.json();
  return {
    shop: shopPayload.data.shop,
    sourceShop,
    connectedTargets,
    latestJob: latestJob
      ? {
          id: latestJob.id,
          status: latestJob.status,
          sourceShop: latestJob.sourceShop,
          targetShop: latestJob.targetShop,
          createdAt: latestJob.createdAt.toISOString(),
          updatedAt: latestJob.updatedAt.toISOString(),
          createdMetafieldDefinitions: latestJob.createdMetafieldDefinitions,
          createdMetaobjectDefinitions: latestJob.createdMetaobjectDefinitions,
          addedMetaobjectFields: latestJob.addedMetaobjectFields,
          copiedMetaobjectEntries: latestJob.copiedMetaobjectEntries,
          skippedMetaobjectEntries: latestJob.skippedMetaobjectEntries,
          failedMetaobjectEntries: latestJob.failedMetaobjectEntries,
          conflictCount: latestJob.conflictCount,
          failedCount: latestJob.failedCount,
          errorMessage: latestJob.errorMessage,
        }
      : null,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "save");

  // Live reads only ever go to the store this shop linked with a code.
  const sourceShop = await getLinkedSourceShop(session.shop);

  if (intent === "scan") {
    if (!sourceShop) {
      return {
        ok: false,
        intent,
        error: "Connect a source store first.",
      };
    }

    try {
      const preview = await buildDefinitionScanPreview({
        sourceShop,
        targetShop: session.shop,
        admin,
      });
      return { ok: true, intent, preview };
    } catch (error) {
      return {
        ok: false,
        intent,
        error:
          error instanceof Error
            ? error.message
            : "Failed to scan definitions.",
      };
    }
  }

  if (intent === "sync") {
    if (!sourceShop) {
      return {
        ok: false,
        intent,
        error: "Connect a source store first.",
      };
    }

    const selectedMetaobjectTypes = JSON.parse(
      String(formData.get("selectedMetaobjectTypes") || "[]"),
    ) as string[];
    const selectedMetafieldKeys = JSON.parse(
      String(formData.get("selectedMetafieldKeys") || "[]"),
    ) as string[];

    const copyContent = String(formData.get("copyContent")) === "true";

    if (!selectedMetaobjectTypes.length && !selectedMetafieldKeys.length) {
      return {
        ok: false,
        intent,
        error: "Select at least one definition to sync.",
      };
    }

    const progress = startSyncProgress({
      shop: session.shop,
      runId: formData.get("runId"),
    });

    try {
      const result = await runDefinitionSync({
        sourceShop,
        targetShop: session.shop,
        admin,
        selectedMetaobjectTypes,
        selectedMetafieldKeys,
        copyContent,
        progress,
      });
      progress.finish();
      return {
        ok: true,
        intent,
        message: "Sync completed successfully.",
        jobId: result.jobId,
        failedCount: result.failedCount,
        failures: result.failures,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed.";
      progress.fail(message);
      return {
        ok: false,
        intent,
        error: message,
      };
    }
  }

  if (intent === "clear_connection") {
    await removeSourceLink(session.shop);
    await createStoreConnectionHistory({
      targetShop: session.shop,
      sourceShop,
      status: "cleared",
      event: "session_cleared",
      message: sourceShop
        ? `Disconnected the source store ${sourceShop}.`
        : "Disconnected the source store.",
    });

    return { ok: true, intent, message: "Source store disconnected." };
  }

  if (intent === "create_code") {
    const { code } = await createConnectionCode(session.shop);
    return { ok: true, intent, code };
  }

  if (intent === "disconnect_target") {
    const targetShop = String(formData.get("targetShop") || "");
    // Scoped to this shop as the source, so a store can only cut its own links.
    await removeSourceLink(targetShop, session.shop);
    await createStoreConnectionHistory({
      targetShop,
      sourceShop: session.shop,
      status: "cleared",
      event: "session_cleared",
      message: `${session.shop} removed this store's access to it as a source.`,
    });

    return { ok: true, intent };
  }

  if (intent === "delete_definitions") {
    const deleteMetafields = String(formData.get("deleteMetafields")) === "true";
    const deleteMetaobjects = String(formData.get("deleteMetaobjects")) === "true";

    if (!deleteMetafields && !deleteMetaobjects) {
      return {
        ok: false,
        intent,
        error: "Select at least one type to delete.",
      };
    }

    try {
      const result = await deleteAppCreatedDefinitions({
        admin,
        targetShop: session.shop,
        deleteMetafields,
        deleteMetaobjects,
      });

      return { ok: true, intent, result };
    } catch (error) {
      return {
        ok: false,
        intent,
        error:
          error instanceof Error
            ? error.message
            : "Failed to delete definitions.",
      };
    }
  }

  let linkedShop: string;

  try {
    linkedShop = await redeemConnectionCode(
      session.shop,
      String(formData.get("code") || ""),
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to connect.";
    return { ok: false, intent, error: message, fieldErrors: { code: message } };
  }

  try {
    const validation = await validateSourceConnection(linkedShop);
    await createStoreConnectionHistory({
      targetShop: session.shop,
      sourceShop: validation.sourceShop,
      status: "valid",
      event: "connected",
      message: `Validated source store connection for ${validation.sourceShop}.`,
    });

    return {
      ok: true,
      intent,
      message: `Connected to ${validation.shopName} (${validation.sourceShop}).`,
    };
  } catch (error) {
    // A link the app can't read through is no use, so don't keep it.
    await removeSourceLink(session.shop);
    await createStoreConnectionHistory({
      targetShop: session.shop,
      sourceShop: linkedShop,
      status: "invalid",
      event: "validation_failed",
      message:
        error instanceof Error
          ? error.message
          : "Failed to validate the source connection.",
    });

    return {
      ok: false,
      intent,
      error:
        error instanceof Error
          ? error.message
          : "Failed to validate the source connection.",
    };
  }
}

type ScanPreview = ServerDefinitionScanPreview;

const STATUS_LABELS: Record<string, string> = {
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
  pending: "Pending",
  scanning: "Running",
  syncing: "Running",
};

export default function DefinitionSyncDashboard() {
  const { shop, sourceShop, connectedTargets, latestJob } =
    useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const connectionFetcher = useFetcher<typeof action>();
  const scanFetcher = useFetcher<typeof action>();
  const syncFetcher = useFetcher<typeof action>();
  const latestSyncResultRef = useRef<HTMLDivElement | null>(null);

  const [connectionCode, setConnectionCode] = useState("");
  const [selectedMetaobjectTypes, setSelectedMetaobjectTypes] = useState<
    string[]
  >([]);
  const [selectedMetafieldKeys, setSelectedMetafieldKeys] = useState<string[]>(
    [],
  );
  const [copyContent, setCopyContent] = useState(false);
  // True while a connected merchant is entering a code for a different store.
  const [showConnectionForm, setShowConnectionForm] = useState(false);
  const [scannedAt, setScannedAt] = useState<string | null>(null);

  const isSaving = connectionFetcher.state !== "idle";
  const isScanning = scanFetcher.state !== "idle";
  const isSyncing = syncFetcher.state !== "idle";
  const syncProgress = useSyncProgress(isSyncing);

  const scanData = scanFetcher.data as
    | {
        ok: boolean;
        intent: string;
        preview?: ScanPreview;
        error?: string;
      }
    | undefined;
  // A scan of a store this shop is no longer linked to must not be synced.
  const preview =
    scanData?.intent === "scan" &&
    scanData?.ok &&
    scanData.preview?.sourceShop === sourceShop
      ? (scanData.preview as ScanPreview)
      : null;
  const scanError =
    scanData?.intent === "scan" && !scanData?.ok ? scanData.error : null;

  const syncData = syncFetcher.data as
    | {
        ok: boolean;
        intent: string;
        message?: string;
        error?: string;
        jobId?: string;
        failedCount?: number;
        failures?: Array<{ itemType: string; itemKey: string; message: string }>;
      }
    | undefined;

  const connectionData = connectionFetcher.data as
    | {
        ok: boolean;
        intent: string;
        message?: string;
        error?: string;
        fieldErrors?: { code?: string };
      }
    | undefined;


  useEffect(() => {
    setSelectedMetaobjectTypes([]);
    setSelectedMetafieldKeys([]);
    setScannedAt(preview ? new Date().toISOString() : null);
  }, [preview]);

  // The loader revalidates after each action, so `sourceShop` follows the
  // saved link on its own; only local selection state needs resetting.
  useEffect(() => {
    if (!connectionData?.ok) {
      return;
    }

    if (connectionData.intent === "clear_connection") {
      setSelectedMetaobjectTypes([]);
      setSelectedMetafieldKeys([]);
      setCopyContent(false);
    }

    setConnectionCode("");
    setShowConnectionForm(false);
  }, [connectionData]);

  useEffect(() => {
    if (syncData?.intent !== "sync" || !syncData.ok) {
      return;
    }

    setSelectedMetaobjectTypes([]);
    setSelectedMetafieldKeys([]);
  }, [syncData]);

  // Scroll to the result once the progress panel has made way for it.
  const scrolledForSyncRef = useRef<unknown>(null);
  useEffect(() => {
    if (
      syncProgress.visible ||
      syncData?.intent !== "sync" ||
      !syncData.ok ||
      scrolledForSyncRef.current === syncData
    ) {
      return;
    }

    scrolledForSyncRef.current = syncData;
    latestSyncResultRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [syncData, syncProgress.visible]);

  const hasVerifiedConnection = Boolean(sourceShop);
  const totalSelectedCount =
    selectedMetaobjectTypes.length + selectedMetafieldKeys.length;
  // Missing definitions to create plus existing ones that differ, as the list
  // shows them.
  const allSelectableCount = countSelection(
    getSelectableDefinitions(preview, copyContent),
  );

  function handleSave() {
    connectionFetcher.submit(
      { intent: "save", code: connectionCode },
      { method: "post" },
    );
  }

  function handleRemove() {
    connectionFetcher.submit(
      { intent: "clear_connection" },
      { method: "post" },
    );
  }

  function handleScan() {
    scanFetcher.submit({ intent: "scan" }, { method: "post" });
  }

  function handleSync() {
    const fd = new FormData();
    fd.set("intent", "sync");
    fd.set("selectedMetaobjectTypes", JSON.stringify(selectedMetaobjectTypes));
    fd.set("selectedMetafieldKeys", JSON.stringify(selectedMetafieldKeys));
    fd.set("copyContent", copyContent ? "true" : "false");
    fd.set("runId", syncProgress.begin());
    syncFetcher.submit(fd, { method: "post" });
  }

  function clearSelection() {
    setSelectedMetaobjectTypes([]);
    setSelectedMetafieldKeys([]);
  }

  const conflictingMetafields = preview?.metafields.conflicts ?? [];
  const conflictingMetaobjects = preview?.metaobjects.conflicts ?? [];
  const totalConflicts =
    (preview?.summary.conflictingMetafieldDefinitions ?? 0) +
    (preview?.summary.conflictingMetaobjectFields ?? 0);
  const syncFailed = syncData?.intent === "sync" && !syncData.ok;
  const syncSucceeded = syncData?.intent === "sync" && syncData.ok;
  // Items fail individually without throwing, so a resolved sync is not
  // necessarily a clean one.
  const syncFailureCount = syncSucceeded ? (syncData?.failedCount ?? 0) : 0;
  const syncOutcome: SyncOutcome = isSyncing
    ? "running"
    : syncFailed
      ? "failed"
      : syncFailureCount > 0
        ? "warning"
        : "success";

  return (
    <div className="em-app">
      <div className="em-page">
        <header className="em-page-header">
          <h2 className="em-page-title">
            {preview ? "Scan Results" : "Definition Sync"}
          </h2>
          <p className="em-page-subtitle">
            {preview
              ? "Review missing definitions and select items to migrate to the destination store."
              : "Copy metafield and metaobject definitions from another Shopify store."}
          </p>
        </header>

        <div className="em-split">
          {/* ── Main column ── */}
          <div className="em-split__main">
            {!hasVerifiedConnection ? (
              isSaving ? (
                <div className="em-card">
                  <div className="em-center">
                    <Spinner size={32} />
                    <span className="em-body-sm">
                      Verifying source store connection…
                    </span>
                  </div>
                </div>
              ) : (
                <div className="em-card">
                  <EmptyState
                    icon="link"
                    title="Connect a source store to begin"
                    body="Install Easy Migrate on the store you want to copy from. Open it there, generate a connection code, then enter the code in the Source store card."
                  />
                </div>
              )
            ) : (
              <>
                {/* ── Scan control: only until there are results; after that the
                    Scan Summary card holds the Re-scan button. ── */}
                {!preview ? (
                  <div className="em-card">
                    <div className="em-card__body">
                      <div className="em-row-between">
                        <div>
                          <h3 className="em-section-heading">Definition scan</h3>
                          <p className="em-body-sm" style={{ marginTop: 4 }}>
                            Compare the source store against this store to find
                            missing definitions.
                          </p>
                        </div>
                        <Button
                          variant="primary"
                          icon="search"
                          onClick={handleScan}
                          loading={isScanning}
                          disabled={isSyncing}
                        >
                          Scan definitions
                        </Button>
                      </div>

                      {isScanning ? (
                        <>
                          <p className="em-body-sm">
                            Reading definitions from the source store…
                          </p>
                          <div className="em-progress">
                            <div className="em-progress__fill em-progress__fill--indeterminate" />
                          </div>
                          <div className="em-stat-grid">
                            <div className="em-skeleton em-skeleton--tile" />
                            <div className="em-skeleton em-skeleton--tile" />
                            <div className="em-skeleton em-skeleton--tile" />
                            <div className="em-skeleton em-skeleton--tile" />
                          </div>
                        </>
                      ) : scanError ? (
                        <Banner tone="critical" title="Scan failed">
                          {scanError}
                        </Banner>
                      ) : (
                        <p className="em-body-sm">
                          Scanning reads data only — nothing is copied until you
                          choose.
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}

                {preview ? (
                  <>
                    {preview.ownerTypeWarnings.length > 0 ? (
                      <Banner tone="warning" title="Scan warnings and limits">
                        {preview.ownerTypeWarnings.join(" ")}
                      </Banner>
                    ) : null}

                    {/* ── Scan summary ── */}
                    <div className="em-card">
                      <div className="em-card__body">
                        <h3 className="em-section-heading">Scan Summary</h3>
                        <StatGrid>
                          <StatTile
                            label="Missing Metafields"
                            value={preview.summary.missingMetafieldDefinitions}
                          />
                          <StatTile
                            label="Missing Metaobjects"
                            value={preview.summary.missingMetaobjectDefinitions}
                          />
                          <StatTile
                            label="Fields"
                            value={preview.summary.missingMetaobjectFields}
                          />
                          <StatTile
                            label="To update"
                            value={
                              preview.summary.updatableMetaobjectDefinitions +
                              preview.summary.changedMetafieldDefinitions
                            }
                          />
                          <StatTile
                            label="Conflicts"
                            value={totalConflicts}
                            tone="critical"
                          />
                        </StatGrid>
                        <div className="em-row-between">
                          <span className="em-body-sm">
                            {scannedAt
                              ? `Scanned ${formatDateTime(scannedAt)}`
                              : `Source store ${preview.sourceShop}`}
                          </span>
                          <Button
                            variant="primary"
                            icon="refresh"
                            onClick={handleScan}
                            loading={isScanning}
                            disabled={isSyncing}
                          >
                            Re-scan
                          </Button>
                        </div>
                      </div>
                    </div>

                    {/* ── Conflicts ── */}
                    {totalConflicts > 0 ? (
                      <Banner
                        tone="critical"
                        title={`${String(totalConflicts)} Conflicts Detected`}
                        titleAction={
                          <ConflictDetailsButton
                            metafieldConflicts={conflictingMetafields}
                            metaobjectConflicts={conflictingMetaobjects}
                          />
                        }
                      >
                        Some definitions exist on the destination store with
                        different types or validations. Easy Migrate skips them
                        so nothing is overwritten.
                      </Banner>
                    ) : null}

                    {!syncProgress.visible && syncFailed ? (
                      <Banner tone="critical" title="Sync failed">
                        {syncData?.error}
                      </Banner>
                    ) : null}

                    {!syncProgress.visible && syncSucceeded ? (
                      <Banner
                        tone={syncFailureCount > 0 ? "warning" : "success"}
                        title={
                          syncFailureCount > 0
                            ? `Sync finished with ${String(syncFailureCount)} failure(s)`
                            : "Sync completed"
                        }
                      >
                        {syncFailureCount > 0 ? (
                          <>
                            <ul
                              className="em-body-sm"
                              style={{ margin: 0, paddingLeft: 18 }}
                            >
                              {(syncData?.failures ?? []).map((failure) => (
                                <li key={`${failure.itemType}-${failure.itemKey}`}>
                                  <code className="em-code-chip">
                                    {failure.itemKey}
                                  </code>
                                  {` — ${failure.message}`}
                                </li>
                              ))}
                            </ul>
                            {syncFailureCount > (syncData?.failures?.length ?? 0) ? (
                              <p className="em-body-sm">
                                {`…and ${String(
                                  syncFailureCount -
                                    (syncData?.failures?.length ?? 0),
                                )} more. Open the full log to see everything.`}
                              </p>
                            ) : null}
                          </>
                        ) : (
                          syncData?.message
                        )}
                      </Banner>
                    ) : null}

                    {syncProgress.visible ? (
                      <SyncProgressPanel
                        noun="sync"
                        progress={syncProgress.progress}
                        outcome={syncOutcome}
                        failedCount={syncFailureCount}
                        error={syncData?.error}
                      />
                    ) : null}


                    {/* ── Selection list ── */}
                    {syncProgress.visible ? null : allSelectableCount > 0 ? (
                      <DefinitionSelectionList
                        preview={preview}
                        selection={{
                          metaobjectTypes: selectedMetaobjectTypes,
                          metafieldKeys: selectedMetafieldKeys,
                        }}
                        onChange={(next) => {
                          setSelectedMetaobjectTypes(next.metaobjectTypes);
                          setSelectedMetafieldKeys(next.metafieldKeys);
                        }}
                        disabled={isSyncing}
                        title="Select what to copy"
                        copyContent={copyContent}
                        onCopyContentChange={setCopyContent}
                        expandable
                      />
                    ) : (
                      <Banner tone="success" title="Everything is already in sync">
                        All metafield and metaobject definitions from the source
                        store already exist in this store and match it.
                      </Banner>
                    )}
                  </>
                ) : null}
              </>
            )}

            {/* ── Last sync result ── */}
            {latestJob ? (
              <div className="em-card" ref={latestSyncResultRef}>
                <div className="em-card__body">
                  <div className="em-row-between">
                    <h3 className="em-section-heading">Last sync result</h3>
                    <Pill
                      tone={
                        latestJob.status === "completed"
                          ? "completed"
                          : latestJob.status === "failed"
                            ? "failed"
                            : "running"
                      }
                      icon={
                        latestJob.status === "completed" ? "check_circle" : undefined
                      }
                    >
                      {STATUS_LABELS[latestJob.status] ?? latestJob.status}
                    </Pill>
                  </div>
                  <p className="em-body-sm">
                    {`${latestJob.sourceShop} → ${latestJob.targetShop} · ${formatDateTime(latestJob.createdAt)}`}
                  </p>

                  {latestJob.errorMessage ? (
                    <Banner tone="critical" title="Sync failed">
                      {latestJob.errorMessage}
                    </Banner>
                  ) : null}

                  {latestJob.copiedMetaobjectEntries > 0 ? (
                    <Banner tone="warning" title="Reference fields not migrated">
                      Metaobject fields of type product, collection, product
                      variant, page, and URL cannot be copied between stores.
                      They are left empty in this store and must be set manually.
                    </Banner>
                  ) : null}

                  <StatGrid columns={3}>
                    <StatTile
                      label="Metafield defs"
                      value={latestJob.createdMetafieldDefinitions}
                    />
                    <StatTile
                      label="Metaobject defs"
                      value={latestJob.createdMetaobjectDefinitions}
                    />
                    <StatTile
                      label="Fields added"
                      value={latestJob.addedMetaobjectFields}
                    />
                    <StatTile
                      label="Entries copied"
                      value={latestJob.copiedMetaobjectEntries}
                    />
                    <StatTile
                      label="Entries skipped"
                      value={latestJob.skippedMetaobjectEntries}
                    />
                    <StatTile
                      label="Failures"
                      value={latestJob.failedCount}
                      tone="critical"
                    />
                  </StatGrid>

                  <div className="em-row-inline">
                    <Button
                      size="sm"
                      icon="description"
                      onClick={() =>
                        navigate(
                          `/app/history?tab=metaobjects&jobId=${latestJob.id}`,
                        )
                      }
                    >
                      View full log
                    </Button>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* ── Aside ── */}
          <aside className="em-split__aside">
            <div className="em-card em-card--flush">
              <div className="em-card__header">
                <div>
                  <h3 className="em-section-heading">Source store</h3>
                  <p className="em-body-sm" style={{ marginTop: 4 }}>
                    Origin of definitions
                  </p>
                </div>
                <span
                  className={
                    sourceShop ? "em-badge em-badge--success" : "em-badge"
                  }
                >
                  {sourceShop ? "Connected" : "Not connected"}
                </span>
              </div>

              {sourceShop && !showConnectionForm ? (
                <div className="em-card__body">
                  <div className="em-conn-tile">
                    <span className="em-label-caps em-conn-tile__label">
                      Source store
                    </span>
                    <div className="em-conn-tile__value">
                      <Icon name="storefront" size={18} />
                      <span>{sourceShop}</span>
                    </div>
                    <div
                      className="em-conn-tile__status"
                      style={{ color: "var(--em-success)" }}
                    >
                      <span className="em-dot em-dot--success" />
                      Connected
                    </div>
                  </div>

                  <div className="em-conn-arrow">
                    <Icon name="arrow_downward" />
                  </div>

                  <div className="em-conn-tile">
                    <span className="em-label-caps em-conn-tile__label">
                      Destination store
                    </span>
                    <div className="em-conn-tile__value">
                      <Icon name="storefront" size={18} />
                      <span>{shop.myshopifyDomain}</span>
                    </div>
                    <div
                      className="em-conn-tile__status"
                      style={{ color: "var(--em-success)" }}
                    >
                      <span className="em-dot em-dot--success" />
                      Connected
                    </div>
                  </div>

                  <p className="em-body-sm">
                    Easy Migrate reads the source store through its own
                    install there. Disconnect any time.
                  </p>

                  <div className="em-row-inline">
                    <Button
                      size="sm"
                      onClick={() => setShowConnectionForm(true)}
                    >
                      Change source store
                    </Button>
                    <Button size="sm" variant="critical" onClick={handleRemove}>
                      Disconnect
                    </Button>
                  </div>
                </div>
              ) : (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleSave();
                  }}
                >
                  <div className="em-card__body">
                    {connectionData?.error ? (
                      <Banner tone="critical" title="Couldn't connect">
                        {connectionData.error}
                      </Banner>
                    ) : null}

                    <Field
                      label="Connection code"
                      htmlFor="connection-code"
                      help={`In the store you want to copy from, open Easy Migrate and generate a code under "Use this store as a source". Codes work once and expire after ${String(CODE_TTL_MINUTES)} minutes.`}
                      error={connectionData?.fieldErrors?.code}
                    >
                      <input
                        id="connection-code"
                        name="code"
                        className={
                          connectionData?.fieldErrors?.code
                            ? "em-input em-input--code em-input--invalid"
                            : "em-input em-input--code"
                        }
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="ABCD-2345"
                        value={connectionCode}
                        onChange={(event) =>
                          setConnectionCode(event.target.value)
                        }
                      />
                    </Field>
                  </div>

                  <div className="em-card__footer" style={{ borderTop: "none", paddingTop: 0 }}>
                    {sourceShop ? (
                      <Button onClick={() => setShowConnectionForm(false)}>
                        Cancel
                      </Button>
                    ) : null}
                    <Button
                      type="submit"
                      variant="primary"
                      loading={isSaving}
                      disabled={!connectionCode.trim()}
                      fullWidth={!sourceShop}
                    >
                      Connect store
                    </Button>
                  </div>
                </form>
              )}
            </div>

            <ConnectionCodeCard connectedTargets={connectedTargets} />

            <DangerZoneCard shopDomain={shop.myshopifyDomain} />
          </aside>
        </div>

        {/* ── Sticky action bar ── */}
        {hasVerifiedConnection &&
        preview &&
        allSelectableCount > 0 &&
        !syncProgress.visible ? (
          <div className="em-actionbar">
            <div className="em-row-inline">
              <span className="em-actionbar__label">
                {`${String(totalSelectedCount)} definitions selected`}
              </span>
              <span className="em-body-sm">
                {`(from ${String(allSelectableCount)} total missing)`}
              </span>
            </div>
            <div className="em-row-inline">
              <LinkButton
                tone="muted"
                onClick={clearSelection}
                disabled={isSyncing || totalSelectedCount === 0}
              >
                Clear selection
              </LinkButton>
              <Button
                variant="primary"
                icon="sync"
                onClick={handleSync}
                loading={isSyncing}
                disabled={isSaving || totalSelectedCount === 0}
              >
                {`Sync ${String(totalSelectedCount)} definitions`}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConnectionCodeCard({
  connectedTargets,
}: {
  connectedTargets: string[];
}) {
  const codeFetcher = useFetcher<typeof action>();
  const disconnectFetcher = useFetcher<typeof action>();
  const [copied, setCopied] = useState(false);
  const [timer, setTimer] = useState<{ code: string; deadline: number } | null>(
    null,
  );
  const [now, setNow] = useState(() => Date.now());

  const codeData = codeFetcher.data as
    | { ok: boolean; intent: string; code?: string }
    | undefined;
  const code = codeData?.intent === "create_code" ? codeData.code : undefined;
  // Shown as two groups of four so it is easy to read out and retype.
  const displayCode = code ? `${code.slice(0, 4)}-${code.slice(4)}` : "";

  // Counted from when the code arrived rather than from the server's expiry
  // time, so a merchant's wrong system clock can't skew the countdown.
  useEffect(() => {
    if (!codeData?.code) {
      return;
    }

    const deadline = Date.now() + CODE_TTL_MINUTES * 60_000;
    setTimer({ code: codeData.code, deadline });
    setNow(Date.now());

    const interval = window.setInterval(() => {
      const current = Date.now();
      setNow(current);

      if (current >= deadline) {
        window.clearInterval(interval);
      }
    }, 1000);

    return () => window.clearInterval(interval);
  }, [codeData]);

  // Until the effect has stored this code's deadline, show the full time
  // rather than the previous code's (possibly expired) countdown.
  const deadline = timer && timer.code === code ? timer.deadline : null;
  const secondsLeft =
    deadline === null
      ? CODE_TTL_MINUTES * 60
      : Math.max(0, Math.ceil((deadline - now) / 1000));
  const isExpired = Boolean(code) && secondsLeft === 0;
  const countdown = `${String(Math.floor(secondsLeft / 60))}:${String(
    secondsLeft % 60,
  ).padStart(2, "0")}`;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(displayCode);
    } catch {
      return;
    }

    setCopied(true);

    window.setTimeout(() => {
      setCopied(false);
    }, 1500);
  }

  return (
    <div className="em-card em-card--flush">
      <div className="em-card__header">
        <div>
          <h3 className="em-section-heading">Use this store as a source</h3>
          <p className="em-body-sm" style={{ marginTop: 4 }}>
            Let another of your stores copy from this one
          </p>
        </div>
      </div>
      <div className="em-card__body">
        <p className="em-body-sm">
          {`Generate a code here, then enter it in Easy Migrate on the store you want to copy to. The code works once and expires after ${String(CODE_TTL_MINUTES)} minutes.`}
        </p>

        {code && !isExpired ? (
          <>
            <div className="em-conn-tile">
              <span className="em-code">{displayCode}</span>
            </div>
            <p
              className="em-body-sm"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {`Expires in ${countdown}`}
            </p>
          </>
        ) : null}

        {isExpired ? (
          <p className="em-body-sm" style={{ color: "var(--em-critical)" }}>
            This code has expired. Generate a new one.
          </p>
        ) : null}

        <div className="em-row-inline">
          <Button
            size="sm"
            icon="key"
            loading={codeFetcher.state !== "idle"}
            onClick={() =>
              codeFetcher.submit({ intent: "create_code" }, { method: "post" })
            }
          >
            {code ? "Generate new code" : "Generate code"}
          </Button>
          {code && !isExpired ? (
            <LinkButton onClick={handleCopy} icon="content_copy">
              {copied ? "Copied" : "Copy"}
            </LinkButton>
          ) : null}
        </div>

        {connectedTargets.length > 0 ? (
          <>
            <span className="em-label-caps">Stores copying from this store</span>
            {connectedTargets.map((targetShop) => (
              <div className="em-row-between" key={targetShop}>
                <span className="em-body-sm">{targetShop}</span>
                <LinkButton
                  tone="critical"
                  disabled={disconnectFetcher.state !== "idle"}
                  onClick={() =>
                    disconnectFetcher.submit(
                      { intent: "disconnect_target", targetShop },
                      { method: "post" },
                    )
                  }
                >
                  Remove
                </LinkButton>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}

function DangerZoneCard({ shopDomain }: { shopDomain: string }) {
  const deleteFetcher = useFetcher<typeof action>();
  const [deleteMetaobjects, setDeleteMetaobjects] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const isDeleting = deleteFetcher.state !== "idle";
  const deleteData = deleteFetcher.data as
    | {
        ok: boolean;
        intent: string;
        error?: string;
        result?: {
          deletedMetafieldDefinitions: number;
          deletedMetaobjectDefinitions: number;
          failed: Array<{ type: string; key: string; message: string }>;
        };
      }
    | undefined;

  const deleteResult =
    deleteData?.intent === "delete_definitions" && deleteData.ok
      ? deleteData.result
      : null;
  const deleteError =
    deleteData?.intent === "delete_definitions" && !deleteData.ok
      ? deleteData.error
      : null;
  const canDelete = deleteMetaobjects;

  function handleConfirmDelete() {
    setShowConfirm(false);
    deleteFetcher.submit(
      {
        intent: "delete_definitions",
        deleteMetafields: "false",
        deleteMetaobjects: deleteMetaobjects ? "true" : "false",
      },
      { method: "post" },
    );
  }

  return (
    <div className="em-card em-card--flush">
      <div className="em-card__header">
        <div>
          <h3 className="em-section-heading">Danger zone</h3>
          <p className="em-body-sm" style={{ marginTop: 4 }}>
            Remove definitions this app created
          </p>
        </div>
      </div>
      <div className="em-card__body">
        <p className="em-body-sm">
          Permanently delete metaobject definitions that Easy Migrate created
          on this store, including any values stored in them. Definitions you
          or another app created are never touched.
        </p>

        {deleteError ? (
          <Banner tone="critical" title="Deletion failed">
            {deleteError}
          </Banner>
        ) : null}

        {deleteResult ? (
          <Banner
            tone={deleteResult.failed.length > 0 ? "warning" : "success"}
            title="Deletion complete"
          >
            <p className="em-body-sm">
              {`Deleted ${String(deleteResult.deletedMetaobjectDefinitions)} metaobject definition(s).`}
              {deleteResult.failed.length > 0
                ? ` ${String(deleteResult.failed.length)} item(s) failed:`
                : ""}
            </p>
            {deleteResult.failed.length > 0 ? (
              <ul className="em-body-sm" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
                {deleteResult.failed.map((failure) => (
                  <li key={failure.key}>
                    <code className="em-code-chip">{failure.key}</code>
                    {` — ${failure.message}`}
                  </li>
                ))}
              </ul>
            ) : null}
          </Banner>
        ) : null}

        <label className="em-checkbox-label">
          <input
            className="em-checkbox"
            type="checkbox"
            checked={deleteMetaobjects}
            onChange={(event) => setDeleteMetaobjects(event.target.checked)}
            disabled={isDeleting}
          />
          Delete all metaobjects (and values) created by this app
        </label>

        <Button
          variant="critical"
          icon="delete"
          fullWidth
          disabled={!canDelete || isDeleting}
          loading={isDeleting}
          onClick={() => setShowConfirm(true)}
        >
          Delete metaobjects
        </Button>
      </div>

      {showConfirm ? (
        <Modal
          title="Confirm deletion"
          onClose={() => setShowConfirm(false)}
          footer={
            <>
              <Button onClick={() => setShowConfirm(false)}>Cancel</Button>
              <Button variant="critical" onClick={handleConfirmDelete}>
                Yes, delete permanently
              </Button>
            </>
          }
        >
          <p className="em-body-sm">
            {`This will permanently delete all metaobject definitions created by this app on ${shopDomain}, along with any values stored in them. This cannot be undone.`}
          </p>
        </Modal>
      ) : null}
    </div>
  );
}
