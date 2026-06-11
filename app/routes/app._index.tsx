import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  FormLayout,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import {
  StatusBadge,
  SummaryTable,
  WarningsBanner,
} from "../components/definition-sync";
import {
  getLatestSyncJob,
} from "../lib/definition-sync/logger.server";
import { createStoreConnectionHistory } from "../lib/history.server";
import {
  buildDefinitionScanPreview,
  runDefinitionSync,
} from "../lib/definition-sync/sync.server";
import { validateSourceToken } from "../lib/definition-sync/source-admin.server";
import {
  normalizeShopDomain,
  validateShopDomain,
} from "../lib/definition-sync/shop-domain.server";
import {
  SUPPORTED_METAFIELD_OWNER_TYPES,
  type DefinitionScanPreview as ServerDefinitionScanPreview,
} from "../lib/definition-sync/types.shared";
import {
  clearStoredSourceCredential,
  readStoredSourceCredential,
  writeStoredSourceCredential,
} from "../lib/source-credentials.client";
import { authenticate } from "../shopify.server";

const stickyActionBarStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 20,
  background: "var(--p-color-bg-surface)",
  padding: "12px 0",
};

const selectableRowStyle: CSSProperties = {
  cursor: "pointer",
};

const scrollPanelStyle: CSSProperties = {
  maxHeight: "28rem",
  overflowY: "auto",
  paddingRight: "0.25rem",
};

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

export default function DefinitionSyncDashboard() {
  const { adminAccessToken, shop, latestJob } = useLoaderData<typeof loader>();

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
  const ownerTypeStatus = preview?.ownerTypeStatus ?? [];
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
  const filteredMissingMetafieldsByOwnerType = filteredMissingMetafields.reduce<
    Array<{
      ownerType: string;
      items: typeof filteredMissingMetafields;
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
  const visibleMetaobjectTypes = [
    ...filteredMissingMetaobjects.map((item) => item.type),
    ...(copyContent
      ? filteredExistingMetaobjects.map((item) => item.source.type)
      : []),
  ];
  const visibleMetafieldIdentifiers = filteredMissingMetafields.map(
    (item) => `${item.ownerType}:${item.namespace}:${item.key}`,
  );
  const visibleSelectedCount =
    visibleMetaobjectTypes.filter((type) =>
      selectedMetaobjectTypes.includes(type),
    ).length +
    visibleMetafieldIdentifiers.filter((id) =>
      selectedMetafieldKeys.includes(id),
    ).length;
  const allVisibleSelected =
    visibleMetaobjectTypes.length + visibleMetafieldIdentifiers.length > 0 &&
    visibleSelectedCount ===
      visibleMetaobjectTypes.length + visibleMetafieldIdentifiers.length;
  const inaccessibleOwnerTypes = ownerTypeStatus.filter(
    (item) => !item.sourceAccessible || !item.targetAccessible,
  );
  const missingOwnerTypes = ownerTypeStatus.filter(
    (item) =>
      item.sourceAccessible &&
      item.targetAccessible &&
      item.missingCount > 0,
  );
  const existingOnlyOwnerTypes = ownerTypeStatus.filter(
    (item) =>
      item.sourceAccessible &&
      item.targetAccessible &&
      item.missingCount === 0 &&
      (item.existingCount > 0 || item.conflictCount > 0),
  );
  const untouchedOwnerTypes = SUPPORTED_METAFIELD_OWNER_TYPES.filter(
    (ownerType) =>
      !ownerTypeStatus.some((item) => item.ownerType === ownerType),
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

  function toggleVisibleSelections() {
    if (allVisibleSelected) {
      setSelectedMetaobjectTypes((current) =>
        current.filter((type) => !visibleMetaobjectTypes.includes(type)),
      );
      setSelectedMetafieldKeys((current) =>
        current.filter((id) => !visibleMetafieldIdentifiers.includes(id)),
      );
      return;
    }

    setSelectedMetaobjectTypes((current) => [
      ...new Set([...current, ...visibleMetaobjectTypes]),
    ]);
    setSelectedMetafieldKeys((current) => [
      ...new Set([...current, ...visibleMetafieldIdentifiers]),
    ]);
  }

  if (!credentialsLoaded) {
    return (
      <Page
        title="Definition Sync"
        subtitle={`${shop.name} (${shop.myshopifyDomain})`}
      >
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300" inlineAlign="center">
                <Spinner size="small" />
                <Text as="p" tone="subdued" variant="bodySm">
                  Loading…
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  return (
    <Page
      title="Definition Sync"
      subtitle={`${shop.name} (${shop.myshopifyDomain})`}
    >
      <Layout>
        {/* ── Connection Section ── */}
        <Layout.AnnotatedSection
          title="Admin token"
          description="Reveal the installed shop's Admin API token from this app session. This uses the existing Easy Migrate installation and does not request extra scopes."
        >
          <Card>
            <AdminTokenCard token={adminAccessToken} />
          </Card>
        </Layout.AnnotatedSection>

        <Layout.AnnotatedSection
          title="Source store"
          description="Connect the source store you want to copy metafield and metaobject definitions from. Provide the .myshopify.com domain and a custom-app Admin API token."
        >
          <Card>
            <BlockStack gap="400">
              {sourceShop && sourceToken && !showConnectionForm ? (
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center" align="space-between">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {sourceShop}
                      </Text>
                      <StatusBadge status={tokenStatus} />
                    </InlineStack>
                    <InlineStack gap="200">
                      <Button
                        size="slim"
                        onClick={handleSave}
                        loading={isSaving}
                      >
                        Re-sync
                      </Button>
                      <Button
                        size="slim"
                        tone="critical"
                        onClick={handleRemove}
                      >
                        Clear session
                      </Button>
                    </InlineStack>
                  </InlineStack>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Source credentials are stored locally in this browser.
                  </Text>
                </BlockStack>
              ) : (
                <BlockStack gap="300">
                  {connectionData?.message ? (
                    <Banner
                      tone={connectionData.ok ? "success" : "critical"}
                      onDismiss={() => {}}
                    >
                      <p>{connectionData.message}</p>
                    </Banner>
                  ) : null}

                  {connectionData?.error && !connectionData.message ? (
                    <Banner tone="critical">
                      <p>{connectionData.error}</p>
                    </Banner>
                  ) : null}

                  <form
                    ref={connectionFormRef}
                    onSubmit={(event) => {
                      event.preventDefault();
                      handleSave();
                    }}
                  >
                    <BlockStack gap="300">
                      <FormLayout>
                        <TextField
                          label="Source store domain"
                          name="sourceShop"
                          autoComplete="off"
                          value={sourceShop.replace(/\.myshopify\.com$/i, "")}
                          onChange={(val) =>
                            setSourceShop(
                              val.replace(/\.myshopify\.com$/i, ""),
                            )
                          }
                          suffix=".myshopify.com"
                          helpText="Enter store name only"
                          error={connectionData?.fieldErrors?.sourceShop}
                        />
                        <TextField
                          label="Source store Admin token"
                          name="sourceToken"
                          autoComplete="off"
                          type="password"
                          value={sourceToken}
                          onChange={setSourceToken}
                          helpText="Create a custom app in the source store and paste its Admin API token here."
                          error={connectionData?.fieldErrors?.sourceToken}
                        />
                      </FormLayout>

                      <InlineStack gap="200">
                        <Button submit variant="primary" loading={isSaving}>
                          {hasConnectionDraft ? "Update connection" : "Connect"}
                        </Button>
                        {sourceShop ? (
                          <Button
                            onClick={() => setShowConnectionForm(false)}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </InlineStack>
                    </BlockStack>
                  </form>
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── Scan & Sync Section ── */}
        {hasVerifiedConnection ? (
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingMd">
                        Scan definitions
                      </Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        Compare metafield and metaobject definitions between source and target stores.
                      </Text>
                    </BlockStack>
                    <Button
                      variant="primary"
                      loading={isScanning}
                      onClick={handleScan}
                      disabled={isSyncing}
                    >
                      {preview ? "Re-scan" : "Scan definitions"}
                    </Button>
                  </InlineStack>

                  {isScanning ? (
                    <BlockStack gap="200">
                      <Text as="p" tone="subdued">
                        Scanning metafield and metaobject definitions across both stores…
                      </Text>
                      <ProgressBar progress={75} size="small" tone="primary" />
                    </BlockStack>
                  ) : null}

                  {scanError ? (
                    <Banner tone="critical" title="Scan failed">
                      <p>{scanError}</p>
                    </Banner>
                  ) : null}
                </BlockStack>
              </Card>

              {preview ? (
                <>
                  <WarningsBanner warnings={preview.ownerTypeWarnings} />

                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        Scan summary
                      </Text>
                      <SummaryTable
                        rows={[
                          [
                            "Missing metafield definitions",
                            preview.summary.missingMetafieldDefinitions,
                          ],
                          [
                            "Missing metaobject definitions",
                            preview.summary.missingMetaobjectDefinitions,
                          ],
                          [
                            "Missing metaobject fields",
                            preview.summary.missingMetaobjectFields,
                          ],
                          [
                            "Conflicting metafield definitions",
                            preview.summary.conflictingMetafieldDefinitions,
                          ],
                          [
                            "Conflicting metaobject fields",
                            preview.summary.conflictingMetaobjectFields,
                          ],
                        ]}
                      />
                    </BlockStack>
                  </Card>

                  <Card>
                    <BlockStack gap="300">
                      <BlockStack gap="100">
                        <Text as="h2" variant="headingMd">
                          Metafield owner type status
                        </Text>
                        <Text as="p" tone="subdued" variant="bodySm">
                          See which owner types have missing definitions, which
                          are already covered, and which are blocked by access.
                        </Text>
                      </BlockStack>

                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">
                          Missing in target ({String(missingOwnerTypes.length)})
                        </Text>
                        {missingOwnerTypes.length > 0 ? (
                          <InlineStack gap="200" wrap>
                            {missingOwnerTypes.map((item) => (
                              <Badge key={item.ownerType} tone="attention">
                                {`${item.ownerType} (${String(item.missingCount)})`}
                              </Badge>
                            ))}
                          </InlineStack>
                        ) : (
                          <Text as="p" tone="subdued" variant="bodySm">
                            No owner types with missing metafield definitions.
                          </Text>
                        )}
                      </BlockStack>

                      <Divider />

                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">
                          Already present / no missing defs (
                          {String(existingOnlyOwnerTypes.length)})
                        </Text>
                        {existingOnlyOwnerTypes.length > 0 ? (
                          <InlineStack gap="200" wrap>
                            {existingOnlyOwnerTypes.map((item) => (
                              <Badge key={item.ownerType} tone="success">
                                {`${item.ownerType}${
                                  item.existingCount > 0
                                    ? ` (${String(item.existingCount)} existing)`
                                    : ""
                                }${
                                  item.conflictCount > 0
                                    ? ` (${String(item.conflictCount)} conflict)`
                                    : ""
                                }`}
                              </Badge>
                            ))}
                          </InlineStack>
                        ) : (
                          <Text as="p" tone="subdued" variant="bodySm">
                            No accessible owner types are fully matched yet.
                          </Text>
                        )}
                      </BlockStack>

                      <Divider />

                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">
                          Inaccessible ({String(inaccessibleOwnerTypes.length)})
                        </Text>
                        {inaccessibleOwnerTypes.length > 0 ? (
                          <InlineStack gap="200" wrap>
                            {inaccessibleOwnerTypes.map((item) => (
                              <Badge key={item.ownerType} tone="critical">
                                {`${item.ownerType}${
                                  !item.sourceAccessible && !item.targetAccessible
                                    ? " (source + target)"
                                    : !item.sourceAccessible
                                      ? " (source)"
                                      : " (target)"
                                }`}
                              </Badge>
                            ))}
                          </InlineStack>
                        ) : (
                          <Text as="p" tone="subdued" variant="bodySm">
                            All scanned owner types were accessible.
                          </Text>
                        )}
                      </BlockStack>

                      {untouchedOwnerTypes.length > 0 ? (
                        <>
                          <Divider />
                          <BlockStack gap="200">
                            <Text as="h3" variant="headingSm">
                              No defs found in either store
                            </Text>
                            <Text as="p" tone="subdued" variant="bodySm">
                              {untouchedOwnerTypes.join(", ")}
                            </Text>
                          </BlockStack>
                        </>
                      ) : null}
                    </BlockStack>
                  </Card>

                  {allSelectableCount > 0 ? (
                    <Card>
                      <BlockStack gap="400">
                        <div style={stickyActionBarStyle}>
                          <BlockStack gap="300">
                            <InlineStack
                              align="space-between"
                              blockAlign="center"
                            >
                              <BlockStack gap="050">
                                <Text as="h2" variant="headingMd">
                                  Select definitions to sync
                                </Text>
                                <Text as="p" tone="subdued" variant="bodySm">
                                  Selected {String(totalSelectedCount)} of{" "}
                                  {String(allSelectableCount)} definitions
                                </Text>
                              </BlockStack>
                              <InlineStack gap="200">
                                <Button
                                  onClick={toggleVisibleSelections}
                                  disabled={
                                    isSyncing ||
                                    visibleMetaobjectTypes.length +
                                      visibleMetafieldIdentifiers.length ===
                                      0
                                  }
                                >
                                  {allVisibleSelected
                                    ? "Clear visible"
                                    : "Select visible"}
                                </Button>
                                <Button
                                  onClick={toggleSelectAll}
                                  disabled={isSyncing}
                                >
                                  {allSelected ? "Clear all" : "Select all"}
                                </Button>
                                <Button
                                  variant="primary"
                                  onClick={handleSync}
                                  loading={isSyncing}
                                  disabled={isSaving || totalSelectedCount === 0}
                                >
                                  Sync selected ({String(totalSelectedCount)})
                                </Button>
                              </InlineStack>
                            </InlineStack>

                            <InlineStack gap="300" blockAlign="end" wrap>
                              <div style={{ minWidth: "16rem", flex: "1 1 18rem" }}>
                                <TextField
                                  label="Search definitions"
                                  autoComplete="off"
                                  value={selectionQuery}
                                  onChange={setSelectionQuery}
                                  placeholder="Search by name, type, namespace, or key"
                                  clearButton
                                  onClearButtonClick={() => setSelectionQuery("")}
                                />
                              </div>
                              <div style={{ minWidth: "14rem" }}>
                                <Select
                                  label="Show"
                                  options={[
                                    { label: "Everything", value: "all" },
                                    { label: "Metaobjects only", value: "metaobjects" },
                                    { label: "Metafields only", value: "metafields" },
                                  ]}
                                  value={selectionView}
                                  onChange={(value) =>
                                    setSelectionView(
                                      value as "all" | "metaobjects" | "metafields",
                                    )
                                  }
                                  disabled={isSyncing}
                                />
                              </div>
                              <div style={{ minWidth: "16rem" }}>
                                <Select
                                  label="Metafield owner type"
                                  options={metafieldOwnerOptions}
                                  value={metafieldOwnerFilter}
                                  onChange={setMetafieldOwnerFilter}
                                  disabled={
                                    isSyncing || selectionView === "metaobjects"
                                  }
                                />
                              </div>
                            </InlineStack>
                          </BlockStack>
                        </div>

                        <Checkbox
                          label="Copy metaobject entries (content/values)"
                          checked={copyContent}
                          onChange={setCopyContent}
                          helpText="Also copy all metaobject entries from the source store to the target store."
                          disabled={isSyncing}
                        />

                        {syncData?.intent === "sync" ? (
                          <Banner
                            tone={syncData.ok ? "success" : "critical"}
                          >
                            <p>
                              {syncData.ok
                                ? syncData.message
                                : syncData.error}
                            </p>
                          </Banner>
                        ) : null}

                        {isSyncing ? (
                          <BlockStack gap="200">
                            <Text as="p" tone="subdued">
                              Syncing selected definitions…
                            </Text>
                            <ProgressBar
                              progress={50}
                              size="small"
                              tone="primary"
                            />
                          </BlockStack>
                        ) : null}

                        {selectionView !== "metafields" &&
                        missingMetaobjects.length > 0 ? (
                          <BlockStack gap="200">
                            <InlineStack
                              align="space-between"
                              blockAlign="center"
                            >
                              <Text as="h3" variant="headingSm">
                                Missing metaobjects
                              </Text>
                              <Button
                                size="slim"
                                onClick={toggleMissingMetaobjectsSelectAll}
                                disabled={isSyncing}
                              >
                                {allMissingMetaobjectsSelected
                                  ? "Clear all"
                                  : "Select all"}
                              </Button>
                            </InlineStack>
                            <div style={scrollPanelStyle}>
                              <BlockStack gap="200">
                                {filteredMissingMetaobjects.map((item) => (
                                  <Box
                                    key={item.type}
                                    padding="200"
                                    borderRadius="200"
                                    background="bg-surface-secondary"
                                  >
                                    <div
                                      onClick={() =>
                                        toggleMetaobjectSelection(item.type)
                                      }
                                      style={selectableRowStyle}
                                    >
                                      <InlineStack
                                        align="space-between"
                                        blockAlign="center"
                                      >
                                        <BlockStack gap="050">
                                          <Text
                                            as="span"
                                            variant="bodyMd"
                                            fontWeight="semibold"
                                          >
                                            {item.name}
                                          </Text>
                                          <Text
                                            as="span"
                                            variant="bodySm"
                                            tone="subdued"
                                          >
                                            Type: {item.type} ·{" "}
                                            {item.fieldDefinitions.length} fields
                                          </Text>
                                        </BlockStack>
                                        <div
                                          onClick={(event) =>
                                            event.stopPropagation()
                                          }
                                        >
                                          <Checkbox
                                            label=""
                                            checked={selectedMetaobjectTypes.includes(
                                              item.type,
                                            )}
                                            onChange={() =>
                                              toggleMetaobjectSelection(item.type)
                                            }
                                          />
                                        </div>
                                      </InlineStack>
                                    </div>
                                  </Box>
                                ))}
                              </BlockStack>
                            </div>
                          </BlockStack>
                        ) : null}

                        {selectionView !== "metafields" &&
                        copyContent &&
                        existingMetaobjects.length > 0 ? (
                          <BlockStack gap="200">
                            <InlineStack
                              align="space-between"
                              blockAlign="center"
                            >
                              <Text as="h3" variant="headingSm">
                                Existing metaobjects (copy entries)
                              </Text>
                              <Button
                                size="slim"
                                onClick={toggleExistingMetaobjectsSelectAll}
                                disabled={isSyncing}
                              >
                                {allExistingMetaobjectsSelected
                                  ? "Clear all"
                                  : "Select all"}
                              </Button>
                            </InlineStack>
                            <div style={scrollPanelStyle}>
                              <BlockStack gap="200">
                                {filteredExistingMetaobjects.map((item) => (
                                  <Box
                                    key={item.source.type}
                                    padding="200"
                                    borderRadius="200"
                                    background="bg-surface-secondary"
                                  >
                                    <div
                                      onClick={() =>
                                        toggleMetaobjectSelection(
                                          item.source.type,
                                        )
                                      }
                                      style={selectableRowStyle}
                                    >
                                      <InlineStack
                                        align="space-between"
                                        blockAlign="center"
                                      >
                                        <BlockStack gap="050">
                                          <Text
                                            as="span"
                                            variant="bodyMd"
                                            fontWeight="semibold"
                                          >
                                            {item.source.name}
                                          </Text>
                                          <Text
                                            as="span"
                                            variant="bodySm"
                                            tone="subdued"
                                          >
                                            Type: {item.source.type} · Definition
                                            exists, entries will be copied
                                          </Text>
                                        </BlockStack>
                                        <div
                                          onClick={(event) =>
                                            event.stopPropagation()
                                          }
                                        >
                                          <Checkbox
                                            label=""
                                            checked={selectedMetaobjectTypes.includes(
                                              item.source.type,
                                            )}
                                            onChange={() =>
                                              toggleMetaobjectSelection(
                                                item.source.type,
                                              )
                                            }
                                          />
                                        </div>
                                      </InlineStack>
                                    </div>
                                  </Box>
                                ))}
                              </BlockStack>
                            </div>
                          </BlockStack>
                        ) : null}

                        {(missingMetaobjects.length > 0 || (copyContent && existingMetaobjects.length > 0)) &&
                        missingMetafields.length > 0 ? (
                          <Divider />
                        ) : null}

                        {selectionView !== "metaobjects" &&
                        missingMetafields.length > 0 ? (
                          <BlockStack gap="200">
                            <InlineStack
                              align="space-between"
                              blockAlign="center"
                            >
                              <Text as="h3" variant="headingSm">
                                Missing metafields
                              </Text>
                              <Button
                                size="slim"
                                onClick={toggleMissingMetafieldsSelectAll}
                                disabled={isSyncing}
                              >
                                {allMissingMetafieldsSelected
                                  ? "Clear all"
                                  : "Select all"}
                              </Button>
                            </InlineStack>
                            <div style={scrollPanelStyle}>
                              <BlockStack gap="200">
                                {filteredMissingMetafieldsByOwnerType.map((group) => (
                                  <BlockStack key={group.ownerType} gap="150">
                                    <Text as="h4" variant="headingXs" tone="subdued">
                                      {group.ownerType} ({group.items.length})
                                    </Text>
                                    {group.items.map((item) => {
                                      const identifier = `${item.ownerType}:${item.namespace}:${item.key}`;
                                      return (
                                        <Box
                                          key={identifier}
                                          padding="200"
                                          borderRadius="200"
                                          background="bg-surface-secondary"
                                        >
                                          <div
                                            onClick={() =>
                                              toggleMetafieldSelection(identifier)
                                            }
                                            style={selectableRowStyle}
                                          >
                                            <InlineStack
                                              align="space-between"
                                              blockAlign="center"
                                            >
                                              <BlockStack gap="050">
                                                <Text
                                                  as="span"
                                                  variant="bodyMd"
                                                  fontWeight="semibold"
                                                >
                                                  {item.name}
                                                </Text>
                                                <Text
                                                  as="span"
                                                  variant="bodySm"
                                                  tone="subdued"
                                                >
                                                  {item.namespace}.{item.key} ·{" "}
                                                  {item.type}
                                                </Text>
                                              </BlockStack>
                                              <div
                                                onClick={(event) =>
                                                  event.stopPropagation()
                                                }
                                              >
                                                <Checkbox
                                                  label=""
                                                  checked={selectedMetafieldKeys.includes(
                                                    identifier,
                                                  )}
                                                  onChange={() =>
                                                    toggleMetafieldSelection(
                                                      identifier,
                                                    )
                                                  }
                                                />
                                              </div>
                                            </InlineStack>
                                          </div>
                                        </Box>
                                      );
                                    })}
                                  </BlockStack>
                                ))}
                              </BlockStack>
                            </div>
                          </BlockStack>
                        ) : null}
                      </BlockStack>
                    </Card>
                  ) : (
                    <Banner tone="success">
                      <p>
                        All metafield and metaobject definitions are already in
                        sync between source and target stores.
                      </p>
                    </Banner>
                  )}
                </>
              ) : null}
            </BlockStack>
          </Layout.Section>
        ) : isSaving ? (
          <Layout.Section>
            <Card>
              <BlockStack gap="300" inlineAlign="center">
                <Spinner size="small" />
                <Text as="p" tone="subdued" variant="bodySm">
                  Verifying source store connection…
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : sourceShop || sourceToken ? (
          <Layout.Section>
            <Banner tone="warning">
              <p>
                Verify a valid source store token above before scanning
                definitions or running a sync.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}

        {/* ── Latest Sync Result ── */}
        {latestJob ? (
          <Layout.Section>
            <div ref={latestSyncResultRef}>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Latest sync result
                  </Text>
                  <Badge tone={latestJob.status === "completed" ? "success" : latestJob.status === "failed" ? "critical" : "attention"}>
                    {latestJob.status}
                  </Badge>
                </InlineStack>

                <Text as="p" tone="subdued" variant="bodySm">
                  {latestJob.sourceShop} → {latestJob.targetShop} ·{" "}
                  {new Date(latestJob.createdAt).toLocaleString()}
                </Text>

                {latestJob.errorMessage ? (
                  <Banner tone="critical">
                    <p>{latestJob.errorMessage}</p>
                  </Banner>
                ) : null}

                {latestJob.copiedMetaobjectEntries > 0 ? (
                  <Banner tone="warning">
                    <p>
                      <strong>Reference fields not migrated:</strong> Metaobject fields of type{" "}
                      <strong>product</strong>, <strong>collection</strong>,{" "}
                      <strong>product variant</strong>, <strong>page</strong>, and{" "}
                      <strong>URL</strong> cannot be automatically copied between stores. These
                      fields have been left empty in the destination store and must be manually
                      updated after migration.
                    </p>
                  </Banner>
                ) : null}

                <SummaryTable
                  rows={[
                    [
                      "Created metafield definitions",
                      latestJob.createdMetafieldDefinitions,
                    ],
                    [
                      "Created metaobject definitions",
                      latestJob.createdMetaobjectDefinitions,
                    ],
                    [
                      "Added metaobject fields",
                      latestJob.addedMetaobjectFields,
                    ],
                    [
                      "Copied metaobject entries",
                      latestJob.copiedMetaobjectEntries,
                    ],
                    [
                      "Skipped metaobject entries",
                      latestJob.skippedMetaobjectEntries,
                    ],
                    ["Warnings / conflicts", latestJob.conflictCount],
                    ["Failures", latestJob.failedCount],
                  ]}
                />
              </BlockStack>
            </Card>
            </div>
          </Layout.Section>
        ) : null}
      </Layout>
    </Page>
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
    <BlockStack gap="300">
      <Text as="p" tone="subdued" variant="bodySm">
        Use this token when this store needs to act as the source store in
        another Easy Migrate session.
      </Text>
      <Box
        background="bg-surface-secondary"
        borderColor="border"
        borderRadius="300"
        borderWidth="025"
        padding="300"
      >
        <Text as="p" variant="bodyMd" breakWord>
          {isVisible
            ? displayToken || "No token available for this session."
            : "\u2022".repeat(Math.max(displayToken.length, 24))}
        </Text>
      </Box>
      <InlineStack gap="200">
        <Button onClick={() => setIsVisible((current) => !current)} disabled={!displayToken}>
          {isVisible ? "Hide token" : "Reveal token"}
        </Button>
        <Button onClick={handleCopy} disabled={!displayToken}>
          {copied ? "Copied" : "Copy token"}
        </Button>
      </InlineStack>
    </BlockStack>
  );
}
