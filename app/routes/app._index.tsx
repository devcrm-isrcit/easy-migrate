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
import { useEffect, useState } from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import prisma from "../db.server";
import {
  KeyValueTable,
  StatusBadge,
  SummaryTable,
  WarningsBanner,
} from "../components/definition-sync";
import {
  decryptToken,
  encryptToken,
} from "../lib/definition-sync/encryption.server";
import {
  getLatestSyncJob,
  getSyncLogs,
} from "../lib/definition-sync/logger.server";
import {
  buildDefinitionScanPreview,
  runDefinitionSync,
} from "../lib/definition-sync/sync.server";
import { validateSourceToken } from "../lib/definition-sync/source-admin.server";
import {
  normalizeShopDomain,
  validateShopDomain,
} from "../lib/definition-sync/shop-domain.server";
import { authenticate } from "../shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  const [credential, latestJob, shopResponse] = await Promise.all([
    prisma.sourceStoreCredential.findUnique({
      where: { targetShop: session.shop },
    }),
    getLatestSyncJob(session.shop),
    admin.graphql(`#graphql
      query DashboardShop {
        shop { name myshopifyDomain }
      }
    `),
  ]);

  const shopPayload = await shopResponse.json();
  const logs = latestJob ? await getSyncLogs(latestJob.id) : [];

  return {
    shop: shopPayload.data.shop,
    credential: credential
      ? {
          sourceShop: credential.sourceShop,
          tokenStatus: credential.tokenStatus,
          lastValidatedAt: credential.lastValidatedAt?.toISOString() ?? null,
        }
      : null,
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
    latestLogs: logs.map((log) => ({
      ...log,
      createdAt: log.createdAt.toISOString(),
    })),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "save");

  if (intent === "remove") {
    await prisma.sourceStoreCredential.deleteMany({
      where: { targetShop: session.shop },
    });
    return { ok: true, intent, message: "Source credentials removed." };
  }

  if (intent === "reset") {
    const jobs = await prisma.definitionSyncJob.findMany({
      where: { targetShop: session.shop },
      select: { id: true },
    });
    if (jobs.length) {
      await prisma.definitionSyncLog.deleteMany({
        where: { jobId: { in: jobs.map((j) => j.id) } },
      });
      await prisma.definitionSyncJob.deleteMany({
        where: { targetShop: session.shop },
      });
    }
    await prisma.sourceStoreCredential.deleteMany({
      where: { targetShop: session.shop },
    });
    return { ok: true, intent, message: "App reset to fresh state." };
  }

  if (intent === "scan") {
    const credential = await prisma.sourceStoreCredential.findUnique({
      where: { targetShop: session.shop },
    });

    if (!credential || credential.tokenStatus !== "valid") {
      return {
        ok: false,
        intent,
        error: "Connect a valid source store first.",
      };
    }

    try {
      const preview = await buildDefinitionScanPreview({
        sourceShop: credential.sourceShop,
        sourceToken: decryptToken(credential.encryptedToken),
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

  const sourceShopInput = String(formData.get("sourceShop") || "");
  const token = String(formData.get("sourceToken") || "");
  const normalizedShop = normalizeShopDomain(sourceShopInput);
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

    await prisma.sourceStoreCredential.upsert({
      where: { targetShop: session.shop },
      update: {
        sourceShop: validation.sourceShop,
        encryptedToken: encryptToken(token),
        tokenStatus: "valid",
        lastValidatedAt: new Date(),
      },
      create: {
        targetShop: session.shop,
        sourceShop: validation.sourceShop,
        encryptedToken: encryptToken(token),
        tokenStatus: "valid",
        lastValidatedAt: new Date(),
      },
    });

    return {
      ok: true,
      intent,
      message: `Connected to ${validation.shopName} (${validation.sourceShop}).`,
    };
  } catch (error) {
    await prisma.sourceStoreCredential.upsert({
      where: { targetShop: session.shop },
      update: {
        sourceShop: normalizedShop,
        encryptedToken: encryptToken(token),
        tokenStatus: "invalid",
        lastValidatedAt: new Date(),
      },
      create: {
        targetShop: session.shop,
        sourceShop: normalizedShop,
        encryptedToken: encryptToken(token),
        tokenStatus: "invalid",
        lastValidatedAt: new Date(),
      },
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
  const { shop, credential, latestJob, latestLogs } =
    useLoaderData<typeof loader>();

  const connectionFetcher = useFetcher<typeof action>();
  const scanFetcher = useFetcher<typeof action>();
  const syncFetcher = useFetcher<typeof action>();
  const resetFetcher = useFetcher<typeof action>();

  const [sourceShop, setSourceShop] = useState(credential?.sourceShop ?? "");
  const [sourceToken, setSourceToken] = useState("");
  const [selectedMetaobjectTypes, setSelectedMetaobjectTypes] = useState<
    string[]
  >([]);
  const [selectedMetafieldKeys, setSelectedMetafieldKeys] = useState<string[]>(
    [],
  );
  const [copyContent, setCopyContent] = useState(false);
  const [logsPage, setLogsPage] = useState(1);
  const [showConnectionForm, setShowConnectionForm] = useState(!credential);

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
        fieldErrors?: { sourceShop?: string; sourceToken?: string };
      }
    | undefined;

  useEffect(() => {
    setSelectedMetaobjectTypes([]);
    setSelectedMetafieldKeys([]);
  }, [preview]);

  useEffect(() => {
    setLogsPage(1);
  }, [latestJob?.id]);

  useEffect(() => {
    if (connectionData?.ok && connectionData.intent === "remove") {
      setShowConnectionForm(true);
    }
  }, [connectionData]);

  const resetData = resetFetcher.data as
    | { ok: boolean; intent: string; message?: string }
    | undefined;

  useEffect(() => {
    if (resetData?.ok && resetData.intent === "reset") {
      setSourceShop("");
      setSourceToken("");
      setSelectedMetaobjectTypes([]);
      setSelectedMetafieldKeys([]);
      setCopyContent(false);
      setShowConnectionForm(true);
      setLogsPage(1);
      window.location.reload();
    }
  }, [resetData]);

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

  const typedLogs = latestLogs as Array<{
    id: string;
    itemType: string;
    itemKey: string;
    status: string;
    message: string;
    createdAt: string;
  }>;
  const paginatedLogs = typedLogs.slice((logsPage - 1) * 10, logsPage * 10);
  const totalLogPages = Math.max(1, Math.ceil(typedLogs.length / 10));

  function handleSave() {
    connectionFetcher.submit(
      { intent: "save", sourceShop, sourceToken },
      { method: "post" },
    );
  }

  function handleRemove() {
    connectionFetcher.submit({ intent: "remove" }, { method: "post" });
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

  function displayItemType(itemType: string) {
    if (itemType === "metafield_definition") return "Metafield";
    if (itemType === "metaobject_entry") return "Entry";
    return "Metaobject";
  }

  function displayIdentifier(log: (typeof typedLogs)[number]) {
    if (log.itemKey === "scope-warning") return "Warning";
    if (log.itemType === "metafield_definition")
      return metafieldNameByIdentifier.get(log.itemKey) ?? log.itemKey;
    if (log.itemType === "metaobject_field")
      return metaobjectFieldNameByIdentifier.get(log.itemKey) ?? log.itemKey;
    return metaobjectNameByType.get(log.itemKey) ?? log.itemKey;
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
              {credential && !showConnectionForm ? (
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center" align="space-between">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        {credential.sourceShop}
                      </Text>
                      <StatusBadge status={credential.tokenStatus} />
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
                        loading={isSaving}
                        onClick={handleRemove}
                      >
                        Disconnect
                      </Button>
                    </InlineStack>
                  </InlineStack>
                  {credential.lastValidatedAt ? (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Last validated:{" "}
                      {new Date(credential.lastValidatedAt).toLocaleString()}
                    </Text>
                  ) : null}
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
                      value={sourceShop}
                      onChange={setSourceShop}
                      helpText="Example: source-store.myshopify.com"
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
                      {credential ? "Update connection" : "Connect"}
                    </Button>
                    {credential ? (
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
        {credential?.tokenStatus === "valid" ? (
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
                                  <Checkbox
                                    label=""
                                    checked={selectedMetaobjectTypes.includes(
                                      item.type,
                                    )}
                                    onChange={() =>
                                      toggleMetaobjectSelection(item.type)
                                    }
                                  />
                                </InlineStack>
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
                                  <Checkbox
                                    label=""
                                    checked={selectedMetaobjectTypes.includes(
                                      item.source.type,
                                    )}
                                    onChange={() =>
                                      toggleMetaobjectSelection(item.source.type)
                                    }
                                  />
                                </InlineStack>
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
                                    <Checkbox
                                      label=""
                                      checked={selectedMetafieldKeys.includes(
                                        identifier,
                                      )}
                                      onChange={() =>
                                        toggleMetafieldSelection(identifier)
                                      }
                                    />
                                  </InlineStack>
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
        ) : credential ? (
          <Layout.Section>
            <Banner tone="warning">
              <p>
                The source store token is invalid. Update the connection above
                with a working Admin API access token.
              </p>
            </Banner>
          </Layout.Section>
        ) : null}

        {/* ── Latest Sync Result ── */}
        {latestJob ? (
          <Layout.Section>
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

                {typedLogs.length > 0 ? (
                  <>
                    <Divider />
                    <Text as="h3" variant="headingSm">
                      Sync log
                    </Text>
                    <KeyValueTable
                      headings={["Status", "Item", "Identifier", "Message", "Date & Time"]}
                      rows={paginatedLogs.map((log) => [
                        <StatusBadge
                          key={`${log.id}-status`}
                          status={log.status}
                        />,
                        displayItemType(log.itemType),
                        displayIdentifier(log),
                        log.message,
                        new Date(log.createdAt).toLocaleString(),
                      ])}
                    />
                    {totalLogPages > 1 ? (
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="span" tone="subdued" variant="bodySm">
                          Page {logsPage} of {totalLogPages}
                        </Text>
                        <InlineStack gap="200">
                          <Button
                            size="slim"
                            onClick={() =>
                              setLogsPage((p) => Math.max(1, p - 1))
                            }
                            disabled={logsPage === 1}
                          >
                            Previous
                          </Button>
                          <Button
                            size="slim"
                            onClick={() =>
                              setLogsPage((p) =>
                                Math.min(totalLogPages, p + 1),
                              )
                            }
                            disabled={logsPage === totalLogPages}
                          >
                            Next
                          </Button>
                        </InlineStack>
                      </InlineStack>
                    ) : null}
                  </>
                ) : null}
              </BlockStack>
            </Card>
          </Layout.Section>
        ) : null}
        <Layout.Section>
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm" tone="critical">
                Reset app
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Remove all credentials, sync history, and logs. This does not
                undo changes already made in the target store.
              </Text>
              <InlineStack>
                <Button
                  tone="critical"
                  onClick={() =>
                    resetFetcher.submit({ intent: "reset" }, { method: "post" })
                  }
                  loading={resetFetcher.state !== "idle"}
                >
                  Reset to fresh state
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
