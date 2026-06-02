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

interface ScanPreview {
  summary: Record<string, number>;
  metafields: {
    missing: Array<{
      id?: string;
      name: string;
      namespace: string;
      key: string;
      ownerType: string;
      type: string;
    }>;
    existing: Array<{
      name: string;
      namespace: string;
      key: string;
      ownerType: string;
      type: string;
    }>;
    conflicts: Array<{
      key: string;
      source: { name: string; type: string };
      target: { type: string };
    }>;
  };
  metaobjects: {
    missing: Array<{
      type: string;
      name: string;
      fieldDefinitions: Array<{ key: string; name: string }>;
    }>;
    existing: Array<{
      source: {
        type: string;
        name: string;
        fieldDefinitions: Array<{ key: string; name: string }>;
      };
    }>;
    conflicts: Array<{
      source: {
        type: string;
        name: string;
        fieldDefinitions: Array<{ key: string; name: string }>;
      };
    }>;
  };
  ownerTypeWarnings: string[];
}

export default function DefinitionSyncDashboard() {
  const { shop, latestJob } = useLoaderData<typeof loader>();

  const connectionFetcher = useFetcher<typeof action>();
  const scanFetcher = useFetcher<typeof action>();
  const syncFetcher = useFetcher<typeof action>();
  const lastSubmittedSourceTokenRef = useRef("");
  const latestSyncResultRef = useRef<HTMLDivElement | null>(null);

  const [sourceShop, setSourceShop] = useState("");
  const [sourceToken, setSourceToken] = useState("");
  const [tokenStatus, setTokenStatus] = useState("unchecked");
  const [selectedMetaobjectTypes, setSelectedMetaobjectTypes] = useState<
    string[]
  >([]);
  const [selectedMetafieldKeys, setSelectedMetafieldKeys] = useState<string[]>(
    [],
  );
  const [copyContent, setCopyContent] = useState(false);
  const [showConnectionForm, setShowConnectionForm] = useState(true);

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
    const storedCredential = readStoredSourceCredential(shop.myshopifyDomain);

    if (!storedCredential) {
      return;
    }

    setSourceShop(storedCredential.sourceShop);
    setSourceToken(storedCredential.sourceToken);
    setTokenStatus("unchecked");
    setShowConnectionForm(false);
  }, [shop.myshopifyDomain]);

  useEffect(() => {
    setSelectedMetaobjectTypes([]);
    setSelectedMetafieldKeys([]);
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
  const totalSelectedCount =
    selectedMetaobjectTypes.length + selectedMetafieldKeys.length;
  const allSelectableTypes = [
    ...missingMetaobjects.map((i) => i.type),
    ...(copyContent ? existingMetaobjects.map((i) => i.source.type) : []),
  ];
  const allSelectableCount = allSelectableTypes.length + missingMetafields.length;
  const allSelected =
    allSelectableCount > 0 && totalSelectedCount === allSelectableCount;

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
    lastSubmittedSourceTokenRef.current = sourceToken.trim();
    connectionFetcher.submit(
      { intent: "save", sourceShop, sourceToken },
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

  return (
    <Page
      title="Definition Sync"
      subtitle={`${shop.name} (${shop.myshopifyDomain})`}
    >
      <Layout>
        {/* ── Connection Section ── */}
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
                        onClick={() => setShowConnectionForm(true)}
                      >
                        Edit
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

                  <FormLayout>
                    <TextField
                      label="Source store domain"
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
                      label="Admin API access token"
                      autoComplete="off"
                      type="password"
                      value={sourceToken}
                      onChange={setSourceToken}
                      helpText="Create a custom app in the source store and paste its Admin API token here."
                      error={connectionData?.fieldErrors?.sourceToken}
                    />
                  </FormLayout>

                  <InlineStack gap="200">
                    <Button
                      variant="primary"
                      loading={isSaving}
                      onClick={handleSave}
                    >
                      {sourceShop ? "Connect" : "Update connection"}
                    </Button>
                    {sourceShop ? (
                      <Button onClick={() => setShowConnectionForm(false)}>
                        Cancel
                      </Button>
                    ) : null}
                  </InlineStack>
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.AnnotatedSection>

        {/* ── Scan & Sync Section ── */}
        {sourceShop && sourceToken ? (
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

                  {allSelectableCount > 0 ? (
                    <Card>
                      <BlockStack gap="400">
                        <div style={stickyActionBarStyle}>
                          <InlineStack
                            align="space-between"
                            blockAlign="center"
                          >
                            <Text as="h2" variant="headingMd">
                              Select definitions to sync
                            </Text>
                            <InlineStack gap="200">
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

                        {missingMetaobjects.length > 0 ? (
                          <BlockStack gap="200">
                            <Text as="h3" variant="headingSm">
                              Missing metaobjects
                            </Text>
                            {missingMetaobjects.map((item) => (
                              <Box
                                key={item.type}
                                padding="200"
                                borderRadius="200"
                                background="bg-surface-secondary"
                              >
                                <div
                                  onClick={() => toggleMetaobjectSelection(item.type)}
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
                                      <Text as="span" variant="bodySm" tone="subdued">
                                        Type: {item.type} ·{" "}
                                        {item.fieldDefinitions.length} fields
                                      </Text>
                                    </BlockStack>
                                    <div onClick={(event) => event.stopPropagation()}>
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
                        ) : null}

                        {copyContent && existingMetaobjects.length > 0 ? (
                          <BlockStack gap="200">
                            <Text as="h3" variant="headingSm">
                              Existing metaobjects (copy entries)
                            </Text>
                            {existingMetaobjects.map((item) => (
                              <Box
                                key={item.source.type}
                                padding="200"
                                borderRadius="200"
                                background="bg-surface-secondary"
                              >
                                <div
                                  onClick={() =>
                                    toggleMetaobjectSelection(item.source.type)
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
                                      <Text as="span" variant="bodySm" tone="subdued">
                                        Type: {item.source.type} · Definition exists, entries will be copied
                                      </Text>
                                    </BlockStack>
                                    <div onClick={(event) => event.stopPropagation()}>
                                      <Checkbox
                                        label=""
                                        checked={selectedMetaobjectTypes.includes(
                                          item.source.type,
                                        )}
                                        onChange={() =>
                                          toggleMetaobjectSelection(item.source.type)
                                        }
                                      />
                                    </div>
                                  </InlineStack>
                                </div>
                              </Box>
                            ))}
                          </BlockStack>
                        ) : null}

                        {(missingMetaobjects.length > 0 || (copyContent && existingMetaobjects.length > 0)) &&
                        missingMetafields.length > 0 ? (
                          <Divider />
                        ) : null}

                        {missingMetafields.length > 0 ? (
                          <BlockStack gap="200">
                            <Text as="h3" variant="headingSm">
                              Missing metafields
                            </Text>
                            {missingMetafields.map((item) => {
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
                                          {item.ownerType} · {item.namespace}.
                                          {item.key} · {item.type}
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
                                            toggleMetafieldSelection(identifier)
                                          }
                                        />
                                      </div>
                                    </InlineStack>
                                  </div>
                                </Box>
                              );
                            })}
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
        ) : sourceShop ? (
          <Layout.Section>
            <Banner tone="warning">
              <p>
                Connect a valid source store token above to scan definitions or
                run a sync.
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
