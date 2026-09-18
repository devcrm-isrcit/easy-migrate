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
  StatGrid,
  StatTile,
  StatusText,
  formatDateTime,
} from "../components/easy-migrate-ui";
import {
  getLatestSyncJob,
} from "../lib/definition-sync/logger.server";
import { createStoreConnectionHistory } from "../lib/history.server";
import {
  buildDefinitionScanPreview,
  runDefinitionSync,
} from "../lib/definition-sync/sync.server";
import { deleteAppCreatedDefinitions } from "../lib/definition-sync/delete-definitions.server";
import { validateSourceToken } from "../lib/definition-sync/source-admin.server";
import {
  normalizeShopDomain,
  validateShopDomain,
} from "../lib/definition-sync/shop-domain.server";
import type { DefinitionScanPreview as ServerDefinitionScanPreview } from "../lib/definition-sync/types.shared";
import {
  clearStoredSourceCredential,
  readStoredSourceCredential,
  writeStoredSourceCredential,
} from "../lib/source-credentials.client";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  const [latestJob, shopResponse] = await Promise.all([
    getLatestSyncJob(session.shop),
    admin.graphql(`#graphql
      query DashboardShop {
        shop { name myshopifyDomain }
      }
    `),
  ]);

  const shopPayload = await shopResponse.json();
  return {
    shop: shopPayload.data.shop,
    adminAccessToken: session.accessToken,
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

  const sourceShopInput = String(formData.get("sourceShop") || "");
  const token = String(formData.get("sourceToken") || "");
  const normalizedShop = normalizeShopDomain(sourceShopInput);

  if (intent === "scan") {
    if (!normalizedShop || !token.trim()) {
      return {
        ok: false,
        intent,
        error: "Enter a source store domain and token first.",
      };
    }

    try {
      const preview = await buildDefinitionScanPreview({
        sourceShop: normalizedShop,
        sourceToken: token,
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
    if (!normalizedShop || !token.trim()) {
      return {
        ok: false,
        intent,
        error: "Enter a source store domain and token first.",
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

    try {
      const result = await runDefinitionSync({
        sourceShop: normalizedShop,
        sourceToken: token,
        targetShop: session.shop,
        admin,
        selectedMetaobjectTypes,
        selectedMetafieldKeys,
        copyContent,
      });
      return {
        ok: true,
        intent,
        message: "Sync completed successfully.",
        jobId: result.jobId,
      };
    } catch (error) {
      return {
        ok: false,
        intent,
        error: error instanceof Error ? error.message : "Sync failed.",
      };
    }
  }

  if (intent === "clear_connection") {
    await createStoreConnectionHistory({
      targetShop: session.shop,
      sourceShop: normalizedShop || null,
      status: "cleared",
      event: "session_cleared",
      message: normalizedShop
        ? `Cleared the saved browser session for ${normalizedShop}.`
        : "Cleared the saved browser session for the source store connection.",
    });

    return { ok: true, intent, message: "Source session cleared." };
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

  const domainError = validateShopDomain(sourceShopInput);

  if (domainError) {
    return {
      ok: false,
      intent,
      error: domainError,
      fieldErrors: { sourceShop: domainError },
    };
  }

  if (!token.trim()) {
    return {
      ok: false,
      intent,
      error: "Source Admin API access token is required.",
      fieldErrors: { sourceToken: "Source Admin API access token is required." },
    };
  }

  try {
    const validation = await validateSourceToken(normalizedShop, token);
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
      sourceShop: validation.sourceShop,
      tokenStatus: "valid",
    };
  } catch (error) {
    await createStoreConnectionHistory({
      targetShop: session.shop,
      sourceShop: normalizedShop || null,
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
  const { adminAccessToken, shop, latestJob } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const connectionFetcher = useFetcher<typeof action>();
  const scanFetcher = useFetcher<typeof action>();
  const syncFetcher = useFetcher<typeof action>();
  const lastSubmittedSourceTokenRef = useRef("");
  const latestSyncResultRef = useRef<HTMLDivElement | null>(null);
  const connectionFormRef = useRef<HTMLFormElement | null>(null);

  const [sourceShop, setSourceShop] = useState("");
  const [sourceToken, setSourceToken] = useState("");
  const [tokenStatus, setTokenStatus] = useState<string>("unchecked");
  const [selectedMetaobjectTypes, setSelectedMetaobjectTypes] = useState<
    string[]
  >([]);
  const [selectedMetafieldKeys, setSelectedMetafieldKeys] = useState<string[]>(
    [],
  );
  const [copyContent, setCopyContent] = useState(false);
  const [showConnectionForm, setShowConnectionForm] = useState(true);
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);
  const [selectionQuery, setSelectionQuery] = useState("");
  const [selectionView, setSelectionView] = useState<
    "all" | "metaobjects" | "metafields"
  >("all");
  const [metafieldOwnerFilter, setMetafieldOwnerFilter] = useState("all");
  const [scannedAt, setScannedAt] = useState<string | null>(null);
  const [showSourceToken, setShowSourceToken] = useState(false);

  useEffect(() => {
    const stored = readStoredSourceCredential(shop.myshopifyDomain);
    if (stored) {
      setSourceShop(stored.sourceShop);
      setSourceToken(stored.sourceToken);
      setTokenStatus("valid");
      setShowConnectionForm(false);
      lastSubmittedSourceTokenRef.current = stored.sourceToken;
    }
    setCredentialsLoaded(true);
  }, [shop.myshopifyDomain]);

  const isSaving = connectionFetcher.state !== "idle";
  const isScanning = scanFetcher.state !== "idle";
  const isSyncing = syncFetcher.state !== "idle";

  const scanData = scanFetcher.data as
    | {
        ok: boolean;
        intent: string;
        preview?: ScanPreview;
        error?: string;
      }
    | undefined;
  const preview =
    scanData?.intent === "scan" && scanData?.ok
      ? (scanData.preview as ScanPreview)
      : null;
  const scanError =
    scanData?.intent === "scan" && !scanData?.ok ? scanData.error : null;

  const syncData = syncFetcher.data as
    | { ok: boolean; intent: string; message?: string; error?: string }
    | undefined;

  const connectionData = connectionFetcher.data as
    | {
        ok: boolean;
        intent: string;
        message?: string;
        error?: string;
        sourceShop?: string;
        tokenStatus?: string;
        fieldErrors?: { sourceShop?: string; sourceToken?: string };
      }
    | undefined;


  useEffect(() => {
    setSelectedMetaobjectTypes([]);
    setSelectedMetafieldKeys([]);
    setSelectionQuery("");
    setSelectionView("all");
    setMetafieldOwnerFilter("all");
    setScannedAt(preview ? new Date().toISOString() : null);
  }, [preview]);

  useEffect(() => {
    if (!connectionData) {
      return;
    }

    if (connectionData.intent === "clear_connection" && connectionData.ok) {
      clearStoredSourceCredential(shop.myshopifyDomain);
      setSourceShop("");
      setSourceToken("");
      setTokenStatus("unchecked");
      setSelectedMetaobjectTypes([]);
      setSelectedMetafieldKeys([]);
      setCopyContent(false);
      setShowConnectionForm(true);
      return;
    }

    if (connectionData.intent !== "save") {
      return;
    }

    if (!connectionData.ok || !connectionData.sourceShop) {
      setTokenStatus("invalid");
      return;
    }

    setSourceShop(connectionData.sourceShop);
    setTokenStatus(connectionData.tokenStatus ?? "valid");
    writeStoredSourceCredential(shop.myshopifyDomain, {
      sourceShop: connectionData.sourceShop,
      sourceToken: lastSubmittedSourceTokenRef.current,
    });
    setShowConnectionForm(false);
  }, [connectionData, shop.myshopifyDomain]);

  useEffect(() => {
    if (syncData?.intent !== "sync" || !syncData.ok) {
      return;
    }

    setSelectedMetaobjectTypes([]);
    setSelectedMetafieldKeys([]);

    window.setTimeout(() => {
      latestSyncResultRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }, 150);
  }, [syncData]);

  const missingMetaobjects = preview?.metaobjects.missing ?? [];
  const existingMetaobjects = preview?.metaobjects.existing ?? [];
  const missingMetafields = preview?.metafields.missing ?? [];
  const hasConnectionDraft = sourceShop.trim().length > 0 || sourceToken.trim().length > 0;
  const hasVerifiedConnection =
    sourceShop.trim().length > 0 &&
    sourceToken.trim().length > 0 &&
    tokenStatus === "valid";
  const normalizedSelectionQuery = selectionQuery.trim().toLowerCase();
  const totalSelectedCount =
    selectedMetaobjectTypes.length + selectedMetafieldKeys.length;
  const allSelectableTypes = [
    ...missingMetaobjects.map((i) => i.type),
    ...(copyContent ? existingMetaobjects.map((i) => i.source.type) : []),
  ];
  const allSelectableCount = allSelectableTypes.length + missingMetafields.length;
  const allSelected =
    allSelectableCount > 0 && totalSelectedCount === allSelectableCount;
  const missingMetaobjectTypes = missingMetaobjects.map((item) => item.type);
  const existingMetaobjectTypes = copyContent
    ? existingMetaobjects.map((item) => item.source.type)
    : [];
  const missingMetafieldIdentifiers = missingMetafields.map(
    (item) => `${item.ownerType}:${item.namespace}:${item.key}`,
  );
  const allMissingMetaobjectsSelected =
    missingMetaobjectTypes.length > 0 &&
    missingMetaobjectTypes.every((type) =>
      selectedMetaobjectTypes.includes(type),
    );
  const allExistingMetaobjectsSelected =
    existingMetaobjectTypes.length > 0 &&
    existingMetaobjectTypes.every((type) =>
      selectedMetaobjectTypes.includes(type),
    );
  const allMissingMetafieldsSelected =
    missingMetafieldIdentifiers.length > 0 &&
    missingMetafieldIdentifiers.every((id) =>
      selectedMetafieldKeys.includes(id),
    );
  const missingMetafieldsByOwnerType = missingMetafields.reduce<
    Array<{
      ownerType: string;
      items: typeof missingMetafields;
    }>
  >((groups, item) => {
    const existingGroup = groups.find(
      (group) => group.ownerType === item.ownerType,
    );

    if (existingGroup) {
      existingGroup.items.push(item);
      return groups;
    }

    groups.push({
      ownerType: item.ownerType,
      items: [item],
    });
    return groups;
  }, []);
  const metafieldOwnerOptions = [
    { label: "All owner types", value: "all" },
    ...missingMetafieldsByOwnerType.map((group) => ({
      label: `${group.ownerType} (${group.items.length})`,
      value: group.ownerType,
    })),
  ];
  const filteredMissingMetaobjects = missingMetaobjects.filter((item) => {
    if (!normalizedSelectionQuery) {
      return true;
    }

    return [
      item.name,
      item.type,
      ...item.fieldDefinitions.map((field) => `${field.name} ${field.key}`),
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedSelectionQuery);
  });
  const filteredExistingMetaobjects = existingMetaobjects.filter((item) => {
    if (!normalizedSelectionQuery) {
      return true;
    }

    return [
      item.source.name,
      item.source.type,
      ...item.source.fieldDefinitions.map(
        (field) => `${field.name} ${field.key}`,
      ),
    ]
      .join(" ")
      .toLowerCase()
      .includes(normalizedSelectionQuery);
  });
  const filteredMissingMetafields = missingMetafields.filter((item) => {
    if (
      metafieldOwnerFilter !== "all" &&
      item.ownerType !== metafieldOwnerFilter
    ) {
      return false;
    }

    if (!normalizedSelectionQuery) {
      return true;
    }

    return [item.name, item.namespace, item.key, item.type, item.ownerType]
      .join(" ")
      .toLowerCase()
      .includes(normalizedSelectionQuery);
  });
  const visibleMetaobjectTypes = [
    ...filteredMissingMetaobjects.map((item) => item.type),
    ...(copyContent
      ? filteredExistingMetaobjects.map((item) => item.source.type)
      : []),
  ];
  const visibleMetafieldIdentifiers = filteredMissingMetafields.map(
    (item) => `${item.ownerType}:${item.namespace}:${item.key}`,
  );
  const metafieldNameByIdentifier = new Map<string, string>();
  const metaobjectNameByType = new Map<string, string>();
  const metaobjectFieldNameByIdentifier = new Map<string, string>();

  if (preview) {
    for (const def of [
      ...preview.metafields.missing,
      ...preview.metafields.existing,
      ...preview.metafields.conflicts.map((c) => c.source),
    ]) {
      metafieldNameByIdentifier.set(
        `${(def as any).ownerType}:${(def as any).namespace}:${(def as any).key}`,
        def.name,
      );
    }
    for (const def of [
      ...preview.metaobjects.missing,
      ...preview.metaobjects.existing.map((i) => i.source),
      ...preview.metaobjects.conflicts.map((i) => i.source),
    ]) {
      metaobjectNameByType.set(def.type, def.name);
      for (const field of def.fieldDefinitions) {
        metaobjectFieldNameByIdentifier.set(
          `${def.type}.${field.key}`,
          `${def.name} — ${field.name}`,
        );
      }
    }
  }

  function handleSave() {
    const formData = connectionFormRef.current
      ? new FormData(connectionFormRef.current)
      : null;
    const submittedSourceShop = String(
      formData?.get("sourceShop") ?? sourceShop,
    ).trim();
    const submittedSourceToken = String(
      formData?.get("sourceToken") ?? sourceToken,
    ).trim();

    setSourceShop(submittedSourceShop);
    setSourceToken(submittedSourceToken);
    lastSubmittedSourceTokenRef.current = submittedSourceToken;

    connectionFetcher.submit(
      {
        intent: "save",
        sourceShop: submittedSourceShop,
        sourceToken: submittedSourceToken,
      },
      { method: "post" },
    );
  }

  function handleRemove() {
    connectionFetcher.submit(
      { intent: "clear_connection", sourceShop },
      { method: "post" },
    );
  }

  function handleScan() {
    scanFetcher.submit(
      { intent: "scan", sourceShop, sourceToken },
      { method: "post" },
    );
  }

  function handleSync() {
    const fd = new FormData();
    fd.set("intent", "sync");
    fd.set("sourceShop", sourceShop);
    fd.set("sourceToken", sourceToken);
    fd.set("selectedMetaobjectTypes", JSON.stringify(selectedMetaobjectTypes));
    fd.set("selectedMetafieldKeys", JSON.stringify(selectedMetafieldKeys));
    fd.set("copyContent", copyContent ? "true" : "false");
    syncFetcher.submit(fd, { method: "post" });
  }

  function toggleMetaobjectSelection(type: string) {
    setSelectedMetaobjectTypes((c) =>
      c.includes(type) ? c.filter((v) => v !== type) : [...c, type],
    );
  }

  function toggleMetafieldSelection(id: string) {
    setSelectedMetafieldKeys((c) =>
      c.includes(id) ? c.filter((v) => v !== id) : [...c, id],
    );
  }

  function toggleSelectAll() {
    if (allSelected) {
      setSelectedMetaobjectTypes([]);
      setSelectedMetafieldKeys([]);
    } else {
      setSelectedMetaobjectTypes(allSelectableTypes);
      setSelectedMetafieldKeys(
        missingMetafields.map(
          (i) => `${i.ownerType}:${i.namespace}:${i.key}`,
        ),
      );
    }
  }

  function toggleMissingMetaobjectsSelectAll() {
    setSelectedMetaobjectTypes((current) => {
      if (allMissingMetaobjectsSelected) {
        return current.filter((type) => !missingMetaobjectTypes.includes(type));
      }

      return [...new Set([...current, ...missingMetaobjectTypes])];
    });
  }

  function toggleExistingMetaobjectsSelectAll() {
    setSelectedMetaobjectTypes((current) => {
      if (allExistingMetaobjectsSelected) {
        return current.filter((type) => !existingMetaobjectTypes.includes(type));
      }

      return [...new Set([...current, ...existingMetaobjectTypes])];
    });
  }

  function toggleMissingMetafieldsSelectAll() {
    setSelectedMetafieldKeys((current) => {
      if (allMissingMetafieldsSelected) {
        return current.filter((id) => !missingMetafieldIdentifiers.includes(id));
      }

      return [...new Set([...current, ...missingMetafieldIdentifiers])];
    });
  }

  if (!credentialsLoaded) {
    return (
      <div className="em-app">
        <div className="em-page">
          <div className="em-card">
            <div className="em-center">
              <Icon name="progress_activity" size={32} className="em-spin" />
              <span className="em-body-sm">Loading…</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const conflictingMetafields = preview?.metafields.conflicts ?? [];
  const conflictingMetaobjects = preview?.metaobjects.conflicts ?? [];
  const conflictKeys = new Set<string>([
    ...conflictingMetafields.map(
      (conflict) =>
        `${conflict.source.ownerType}:${conflict.source.namespace}:${conflict.source.key}`,
    ),
  ]);
  const conflictingMetaobjectTypes = new Set<string>(
    conflictingMetaobjects.map((item) => item.type),
  );
  const totalConflicts =
    (preview?.summary.conflictingMetafieldDefinitions ?? 0) +
    (preview?.summary.conflictingMetaobjectFields ?? 0);
  const visibleItemCount =
    visibleMetaobjectTypes.length + visibleMetafieldIdentifiers.length;
  const syncFailed = syncData?.intent === "sync" && !syncData.ok;
  const syncSucceeded = syncData?.intent === "sync" && syncData.ok;

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
                    <Icon name="progress_activity" size={32} className="em-spin" />
                    <span className="em-body-sm">
                      Verifying source store connection…
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  {hasConnectionDraft && tokenStatus === "invalid" ? (
                    <Banner tone="critical" title="Source token was rejected">
                      Check the domain and Admin API token in the source store
                      card, then connect again.
                    </Banner>
                  ) : null}
                  <div className="em-card">
                    <EmptyState
                      icon="link"
                      title="Connect a source store to begin"
                      body="To sync definitions, you first need to establish a connection with the source store by providing its domain and an admin API token."
                      action={
                        <a
                          className="em-btn em-btn--secondary"
                          href="https://help.shopify.com/en/manual/apps/app-types/custom-apps"
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Icon name="key" size={18} />
                          How to create an Admin token
                        </a>
                      }
                    />
                  </div>
                </>
              )
            ) : (
              <>
                {/* ── Scan control ── */}
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
                        {preview ? "Re-scan" : "Scan definitions"}
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
                    ) : !preview ? (
                      <p className="em-body-sm">
                        Scanning reads data only — nothing is copied until you
                        choose.
                      </p>
                    ) : null}
                  </div>
                </div>

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
                            size="sm"
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
                      >
                        Some definitions exist on the destination store with
                        different types or validations. Easy Migrate skips them
                        so nothing is overwritten.
                      </Banner>
                    ) : null}

                    {syncFailed ? (
                      <Banner tone="critical" title="Sync failed">
                        {syncData?.error}
                      </Banner>
                    ) : null}

                    {syncSucceeded ? (
                      <Banner tone="success" title="Sync completed">
                        {syncData?.message}
                      </Banner>
                    ) : null}

                    {isSyncing ? (
                      <Banner tone="info" title="Sync running">
                        Keep this page open. Closing it stops the sync after the
                        current item.
                      </Banner>
                    ) : null}

                    {/* ── Selection list ── */}
                    {allSelectableCount > 0 ? (
                      <div className="em-card em-card--flush em-list-card">
                        <div className="em-list-toolbar">
                          <div className="em-row-between">
                            <h3 className="em-section-heading">
                              Select what to copy
                            </h3>
                            <span className="em-label-caps">
                              {`Showing ${String(visibleItemCount)} items`}
                            </span>
                          </div>
                          <div className="em-list-toolbar__row">
                            <div className="em-search">
                              <Icon name="search" className="em-search__icon" />
                              <input
                                className="em-input"
                                type="text"
                                value={selectionQuery}
                                onChange={(event) =>
                                  setSelectionQuery(event.target.value)
                                }
                                placeholder="Search namespaces, keys..."
                                aria-label="Search definitions"
                              />
                            </div>
                            <select
                              className="em-select"
                              style={{ width: 170 }}
                              value={selectionView}
                              onChange={(event) =>
                                setSelectionView(
                                  event.target.value as
                                    | "all"
                                    | "metaobjects"
                                    | "metafields",
                                )
                              }
                              disabled={isSyncing}
                              aria-label="Filter by definition type"
                            >
                              <option value="all">Everything</option>
                              <option value="metaobjects">Metaobjects only</option>
                              <option value="metafields">Metafields only</option>
                            </select>
                            <select
                              className="em-select"
                              style={{ width: 190 }}
                              value={metafieldOwnerFilter}
                              onChange={(event) =>
                                setMetafieldOwnerFilter(event.target.value)
                              }
                              disabled={isSyncing || selectionView === "metaobjects"}
                              aria-label="Filter by metafield owner type"
                            >
                              {metafieldOwnerOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </div>
                          <label className="em-checkbox-label">
                            <input
                              className="em-checkbox"
                              type="checkbox"
                              checked={copyContent}
                              onChange={(event) =>
                                setCopyContent(event.target.checked)
                              }
                              disabled={isSyncing}
                            />
                            Copy metaobject entries (content and values)
                          </label>
                        </div>

                        <div className="em-list-head em-grid-definitions">
                          <div className="em-cell-center">
                            <input
                              className="em-checkbox"
                              type="checkbox"
                              checked={allSelected}
                              onChange={toggleSelectAll}
                              disabled={isSyncing}
                              aria-label="Select every definition"
                            />
                          </div>
                          <div>Definition Name</div>
                          <div style={{ textAlign: "center" }}>Owner</div>
                          <div className="em-cell-right">Status</div>
                        </div>

                        <div className="em-list-scroll">
                          {selectionView !== "metafields" &&
                          filteredMissingMetaobjects.length > 0 ? (
                            <>
                              <div className="em-group-row">
                                <span className="em-label-caps">
                                  Metaobject definitions
                                </span>
                                <LinkButton
                                  onClick={toggleMissingMetaobjectsSelectAll}
                                  disabled={isSyncing}
                                >
                                  {allMissingMetaobjectsSelected
                                    ? "Clear all"
                                    : "Select all"}
                                </LinkButton>
                              </div>
                              {filteredMissingMetaobjects.map((item) => {
                                const checked = selectedMetaobjectTypes.includes(
                                  item.type,
                                );
                                const isConflict = conflictingMetaobjectTypes.has(
                                  item.type,
                                );

                                return (
                                  <label
                                    key={item.type}
                                    className={[
                                      "em-list-row em-grid-definitions",
                                      checked ? "em-list-row--selected" : "",
                                      isConflict ? "em-list-row--conflict" : "",
                                    ]
                                      .filter(Boolean)
                                      .join(" ")}
                                  >
                                    <div className="em-cell-center">
                                      <input
                                        className="em-checkbox"
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() =>
                                          toggleMetaobjectSelection(item.type)
                                        }
                                        disabled={isSyncing}
                                        aria-label={`Select ${item.name}`}
                                      />
                                    </div>
                                    <div className="em-cell-stack">
                                      <span className="em-body em-strong em-truncate">
                                        {item.name}
                                      </span>
                                      <span className="em-code em-truncate" style={{ color: "var(--em-secondary)" }}>
                                        {item.type}
                                      </span>
                                    </div>
                                    <div className="em-cell-center">
                                      <Pill tone="outline">METAOBJECT</Pill>
                                    </div>
                                    <div className="em-cell-right">
                                      <StatusText
                                        tone={isConflict ? "critical" : "warning"}
                                      >
                                        {isConflict ? "Conflict" : "Missing"}
                                      </StatusText>
                                    </div>
                                  </label>
                                );
                              })}
                            </>
                          ) : null}

                          {selectionView !== "metafields" &&
                          copyContent &&
                          filteredExistingMetaobjects.length > 0 ? (
                            <>
                              <div className="em-group-row">
                                <span className="em-label-caps">
                                  Metaobject entries
                                </span>
                                <LinkButton
                                  onClick={toggleExistingMetaobjectsSelectAll}
                                  disabled={isSyncing}
                                >
                                  {allExistingMetaobjectsSelected
                                    ? "Clear all"
                                    : "Select all"}
                                </LinkButton>
                              </div>
                              {filteredExistingMetaobjects.map((item) => {
                                const checked = selectedMetaobjectTypes.includes(
                                  item.source.type,
                                );

                                return (
                                  <label
                                    key={item.source.type}
                                    className={[
                                      "em-list-row em-grid-definitions",
                                      checked ? "em-list-row--selected" : "",
                                    ]
                                      .filter(Boolean)
                                      .join(" ")}
                                  >
                                    <div className="em-cell-center">
                                      <input
                                        className="em-checkbox"
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() =>
                                          toggleMetaobjectSelection(
                                            item.source.type,
                                          )
                                        }
                                        disabled={isSyncing}
                                        aria-label={`Select ${item.source.name}`}
                                      />
                                    </div>
                                    <div className="em-cell-stack">
                                      <span className="em-body em-strong em-truncate">
                                        {item.source.name}
                                      </span>
                                      <span className="em-code em-truncate" style={{ color: "var(--em-secondary)" }}>
                                        {item.source.type}
                                      </span>
                                    </div>
                                    <div className="em-cell-center">
                                      <Pill tone="outline">ENTRIES</Pill>
                                    </div>
                                    <div className="em-cell-right">
                                      <StatusText tone="secondary">
                                        In target
                                      </StatusText>
                                    </div>
                                  </label>
                                );
                              })}
                            </>
                          ) : null}

                          {selectionView !== "metaobjects" &&
                          filteredMissingMetafields.length > 0 ? (
                            <>
                              <div className="em-group-row">
                                <span className="em-label-caps">
                                  Metafield definitions
                                </span>
                                <LinkButton
                                  onClick={toggleMissingMetafieldsSelectAll}
                                  disabled={isSyncing}
                                >
                                  {allMissingMetafieldsSelected
                                    ? "Clear all"
                                    : "Select all"}
                                </LinkButton>
                              </div>
                              {filteredMissingMetafields.map((item) => {
                                const identifier = `${item.ownerType}:${item.namespace}:${item.key}`;
                                const checked =
                                  selectedMetafieldKeys.includes(identifier);
                                const isConflict = conflictKeys.has(identifier);

                                return (
                                  <label
                                    key={identifier}
                                    className={[
                                      "em-list-row em-grid-definitions",
                                      checked ? "em-list-row--selected" : "",
                                      isConflict ? "em-list-row--conflict" : "",
                                    ]
                                      .filter(Boolean)
                                      .join(" ")}
                                  >
                                    <div className="em-cell-center">
                                      <input
                                        className="em-checkbox"
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() =>
                                          toggleMetafieldSelection(identifier)
                                        }
                                        disabled={isSyncing}
                                        aria-label={`Select ${item.name}`}
                                      />
                                    </div>
                                    <div className="em-cell-stack">
                                      <span className="em-body em-strong em-truncate">
                                        {item.name}
                                      </span>
                                      <span className="em-code em-truncate" style={{ color: "var(--em-secondary)" }}>
                                        {`${item.namespace}.${item.key}`}
                                      </span>
                                    </div>
                                    <div className="em-cell-center">
                                      <Pill tone="outline">{item.ownerType}</Pill>
                                    </div>
                                    <div className="em-cell-right">
                                      <StatusText
                                        tone={isConflict ? "critical" : "warning"}
                                      >
                                        {isConflict ? "Conflict" : "Missing"}
                                      </StatusText>
                                    </div>
                                  </label>
                                );
                              })}
                            </>
                          ) : null}

                          {visibleItemCount === 0 ? (
                            <EmptyState
                              compact
                              icon="search_off"
                              title="No definitions match your search"
                              body="Try a different term, or clear the filters to see everything found in the scan."
                              action={
                                <Button
                                  onClick={() => {
                                    setSelectionQuery("");
                                    setSelectionView("all");
                                    setMetafieldOwnerFilter("all");
                                  }}
                                >
                                  Clear filters
                                </Button>
                              }
                            />
                          ) : null}
                        </div>
                      </div>
                    ) : (
                      <Banner tone="success" title="Everything is already in sync">
                        All metafield and metaobject definitions from the source
                        store already exist in this store.
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
                    tokenStatus === "valid"
                      ? "em-badge em-badge--success"
                      : tokenStatus === "invalid"
                        ? "em-badge em-badge--critical"
                        : "em-badge"
                  }
                >
                  {tokenStatus === "valid"
                    ? "Connected"
                    : tokenStatus === "invalid"
                      ? "Token invalid"
                      : "Not connected"}
                </span>
              </div>

              {sourceShop && sourceToken && !showConnectionForm ? (
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
                    Source credentials are stored in this browser only.
                  </p>

                  <div className="em-row-inline">
                    <Button
                      size="sm"
                      onClick={() => setShowConnectionForm(true)}
                    >
                      Update connection
                    </Button>
                    <Button size="sm" variant="critical" onClick={handleRemove}>
                      Clear session
                    </Button>
                  </div>
                </div>
              ) : (
                <form
                  ref={connectionFormRef}
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
                      label="Store domain"
                      htmlFor="store-domain"
                      help="Enter store name only — .myshopify.com is added for you."
                      error={connectionData?.fieldErrors?.sourceShop}
                    >
                      <input
                        id="store-domain"
                        name="sourceShop"
                        className={
                          connectionData?.fieldErrors?.sourceShop
                            ? "em-input em-input--code em-input--invalid"
                            : "em-input em-input--code"
                        }
                        type="text"
                        autoComplete="off"
                        placeholder="example.myshopify.com"
                        value={sourceShop.replace(/\.myshopify\.com$/i, "")}
                        onChange={(event) =>
                          setSourceShop(
                            event.target.value.replace(/\.myshopify\.com$/i, ""),
                          )
                        }
                      />
                    </Field>

                    <Field
                      label="Admin API token"
                      htmlFor="admin-token"
                      help={
                        <>
                          Requires{" "}
                          <code className="em-code-chip">
                            read_metaobject_definitions
                          </code>{" "}
                          scope.
                        </>
                      }
                      error={connectionData?.fieldErrors?.sourceToken}
                    >
                      <input
                        id="admin-token"
                        name="sourceToken"
                        className={
                          connectionData?.fieldErrors?.sourceToken
                            ? "em-input em-input--code em-input--with-action em-input--invalid"
                            : "em-input em-input--code em-input--with-action"
                        }
                        type={showSourceToken ? "text" : "password"}
                        autoComplete="off"
                        placeholder="shpat_..."
                        value={sourceToken}
                        onChange={(event) => setSourceToken(event.target.value)}
                      />
                      <button
                        type="button"
                        className="em-field__action"
                        onClick={() => setShowSourceToken((current) => !current)}
                        aria-label={
                          showSourceToken ? "Hide token" : "Show token"
                        }
                      >
                        <Icon
                          name={showSourceToken ? "visibility_off" : "visibility"}
                          size={18}
                        />
                      </button>
                    </Field>
                  </div>

                  <div className="em-card__footer" style={{ borderTop: "none", paddingTop: 0 }}>
                    {sourceShop && sourceToken ? (
                      <Button onClick={() => setShowConnectionForm(false)}>
                        Cancel
                      </Button>
                    ) : null}
                    <Button
                      type="submit"
                      variant="primary"
                      loading={isSaving}
                      fullWidth={!(sourceShop && sourceToken)}
                    >
                      Connect store
                    </Button>
                  </div>
                </form>
              )}
            </div>

            <AdminTokenCard token={adminAccessToken} />

            <DangerZoneCard shopDomain={shop.myshopifyDomain} />
          </aside>
        </div>

        {/* ── Sticky action bar ── */}
        {hasVerifiedConnection && preview && allSelectableCount > 0 ? (
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
                onClick={toggleSelectAll}
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

function AdminTokenCard({ token }: { token?: string | null }) {
  const [isVisible, setIsVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const displayToken = token ?? "";

  async function handleCopy() {
    if (!displayToken) {
      return;
    }

    await navigator.clipboard.writeText(displayToken);
    setCopied(true);

    window.setTimeout(() => {
      setCopied(false);
    }, 1500);
  }

  return (
    <div className="em-card em-card--flush">
      <div className="em-card__header">
        <div>
          <h3 className="em-section-heading">Admin token</h3>
          <p className="em-body-sm" style={{ marginTop: 4 }}>
            This store, as a source
          </p>
        </div>
      </div>
      <div className="em-card__body">
        <p className="em-body-sm">
          Use this token when this store needs to act as the source store in
          another Easy Migrate session.
        </p>

        {displayToken ? (
          <>
            <div className="em-conn-tile">
              <span className="em-code" style={{ overflowWrap: "anywhere" }}>
                {isVisible
                  ? displayToken
                  : `${displayToken.slice(0, 6)}${"•".repeat(12)}${displayToken.slice(-4)}`}
              </span>
            </div>
            <div className="em-row-inline">
              <LinkButton
                onClick={() => setIsVisible((current) => !current)}
                icon={isVisible ? "visibility_off" : "visibility"}
              >
                {isVisible ? "Hide token" : "Reveal token"}
              </LinkButton>
              <LinkButton onClick={handleCopy} icon="content_copy">
                {copied ? "Copied" : "Copy token"}
              </LinkButton>
            </div>
          </>
        ) : (
          <p className="em-body-sm">No token available for this session.</p>
        )}
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
