import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  InlineGrid,
  InlineStack,
  Layout,
  Link,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  useEffect,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  useFetcher,
  useLoaderData,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import prisma from "../db.server";
import {
  StatusBadge,
  SummaryTable,
} from "../components/definition-sync";
import { fetchFileMigrationPreview, runFileMigration } from "../lib/file-sync.server";
import { authenticate } from "../shopify.server";

interface PreviewFile {
  id: string;
  alt: string | null;
  contentType: "IMAGE" | "VIDEO" | "FILE";
  filename: string | null;
  sourceUrl: string;
  alreadyInTarget?: boolean;
}

const mediaFrameStyle: CSSProperties = {
  width: "100%",
  aspectRatio: "1 / 1",
  borderRadius: 12,
  overflow: "hidden",
  background: "var(--p-color-bg-surface-secondary)",
  border: "1px solid var(--p-color-border-secondary)",
};

const stickyActionBarStyle: CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 20,
  background: "var(--p-color-bg-surface)",
  padding: "12px 0",
};

type FileFilter = "all" | "image" | "video" | "other" | "already_in_target";
const PAGE_SIZE = 50;

function getFileFilterType(file: PreviewFile): Exclude<FileFilter, "all"> {
  if (file.contentType === "IMAGE") {
    return "image";
  }

  if (file.contentType === "VIDEO") {
    return "video";
  }

  return "other";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  const credential = await prisma.sourceStoreCredential.findUnique({
    where: { targetShop: session.shop },
  });

  let preview: Awaited<ReturnType<typeof fetchFileMigrationPreview>> | null = null;
  let previewError: string | null = null;

  if (credential?.tokenStatus === "valid") {
    try {
      preview = await fetchFileMigrationPreview({
        targetShop: session.shop,
        admin,
      });
    } catch (error) {
      previewError =
        error instanceof Error ? error.message : "Failed to load file preview.";
    }
  }

  return {
    credential: credential
      ? {
          sourceShop: credential.sourceShop,
          tokenStatus: credential.tokenStatus,
        }
      : null,
    preview,
    previewError,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "migrate");

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

function MediaPreview({ file }: { file: PreviewFile }) {
  if (file.contentType === "IMAGE") {
    return (
      <div style={mediaFrameStyle}>
        <img
          src={file.sourceUrl}
          alt={file.alt ?? file.filename ?? "Source image"}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      </div>
    );
  }

  if (file.contentType === "VIDEO") {
    return (
      <div style={mediaFrameStyle}>
        <video
          src={file.sourceUrl}
          controls
          preload="metadata"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        ...mediaFrameStyle,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        textAlign: "center",
      }}
    >
      <BlockStack gap="100">
        <Text as="span" variant="headingMd">
          FILE
        </Text>
        <Text as="span" variant="bodySm" tone="subdued">
          No visual preview
        </Text>
      </BlockStack>
    </div>
  );
}

export default function FileMigrationPage() {
  const { credential, preview, previewError } = useLoaderData<typeof loader>();
  const migrationFetcher = useFetcher<typeof action>();
  const migrationData = migrationFetcher.data as
    | {
        ok: boolean;
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
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [activeFilter, setActiveFilter] = useState<FileFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const isMigrating = migrationFetcher.state !== "idle";
  const logs = migrationData?.result?.logs ?? [];
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const filteredFiles = files.filter((file) => {
    const matchesFilter =
      activeFilter === "all"
        ? true
        : activeFilter === "already_in_target"
          ? Boolean(file.alreadyInTarget)
          : getFileFilterType(file) === activeFilter;
    const identifier = (file.filename ?? file.id).toLowerCase();
    const altText = (file.alt ?? "").toLowerCase();
    const matchesQuery =
      normalizedQuery.length === 0 ||
      identifier.includes(normalizedQuery) ||
      altText.includes(normalizedQuery);

    return matchesFilter && matchesQuery;
  });
  const totalPages = Math.max(1, Math.ceil(filteredFiles.length / PAGE_SIZE));
  const paginatedFiles = filteredFiles.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );
  const allVisibleSelected =
    paginatedFiles.length > 0 &&
    paginatedFiles.every((file) => selectedFileIds.includes(file.id));
  const imageCount = files.filter((file) => getFileFilterType(file) === "image").length;
  const videoCount = files.filter((file) => getFileFilterType(file) === "video").length;
  const otherCount = files.filter((file) => getFileFilterType(file) === "other").length;
  const alreadyInTargetCount = files.filter((file) => file.alreadyInTarget).length;
  const transferableCount = files.filter((file) => !file.alreadyInTarget).length;

  useEffect(() => {
    setSelectedFileIds([]);
  }, [preview?.sourceShop, files.length]);

  useEffect(() => {
    setCurrentPage(1);
  }, [activeFilter, searchQuery, preview?.sourceShop]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  function handleMigrate() {
    const formData = new FormData();
    formData.set("intent", "migrate");
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
      const visibleIds = new Set(paginatedFiles.map((file) => file.id));
      setSelectedFileIds((current) => current.filter((id) => !visibleIds.has(id)));
      return;
    }

    setSelectedFileIds((current) => {
      const next = new Set(current);
      for (const file of paginatedFiles) {
        next.add(file.id);
      }
      return [...next];
    });
  }

  return (
    <Page
      title="Files Migration"
      subtitle="Copy selected files and media from the connected source store."
      backAction={{ url: "/app" }}
      fullWidth
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {!credential ? (
              <Banner tone="warning">
                <p>Connect a source store on the dashboard before migrating files.</p>
              </Banner>
            ) : null}

            {credential && credential.tokenStatus !== "valid" ? (
              <Banner tone="critical">
                <p>Validate the source store token on the dashboard before migrating files.</p>
              </Banner>
            ) : null}

            {previewError ? (
              <Banner tone="critical">
                <p>{previewError}</p>
              </Banner>
            ) : null}

            {preview ? (
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="100">
                      <Text as="h2" variant="headingMd">
                        Migration preview
                      </Text>
                      <Text as="p" tone="subdued">
                        Source store: {preview.sourceShop}
                      </Text>
                    </BlockStack>
                  </InlineStack>

                  <div style={stickyActionBarStyle}>
                    <InlineStack align="end" blockAlign="center" gap="200">
                      <Button
                        onClick={toggleSelectAll}
                        disabled={paginatedFiles.length === 0 || isMigrating}
                      >
                        {allVisibleSelected ? "Clear All" : "Select All"}
                      </Button>
                      <Button
                        variant="primary"
                        onClick={handleMigrate}
                        loading={isMigrating}
                        disabled={
                          selectedFileIds.length === 0 ||
                          !selectedFileIds.some((id) =>
                            files.some((file) => file.id === id && !file.alreadyInTarget),
                          )
                        }
                      >
                        Migrate selected ({String(selectedFileIds.length)})
                      </Button>
                    </InlineStack>
                  </div>

                  <SummaryTable
                    rows={[
                      ["Total source files", preview.totalSourceFiles],
                      ["Transferable files", transferableCount],
                      ["Already in target", preview.skippedExistingFiles],
                      ["Matching files", filteredFiles.length],
                      ["Page", `${currentPage} / ${totalPages}`],
                      ["Selected files", selectedFileIds.length],
                    ]}
                  />

                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="p" tone="subdued">
                      The page matches files by content type and filename. Only the selected items
                      below will be copied.
                    </Text>
                  </InlineStack>

                  <InlineStack gap="300" align="space-between" blockAlign="end">
                    <div style={{ minWidth: 280, flex: "1 1 280px" }}>
                      <TextField
                        label="Search files"
                        value={searchQuery}
                        onChange={setSearchQuery}
                        autoComplete="off"
                        placeholder="Search by filename or alt text"
                        clearButton
                        onClearButtonClick={() => setSearchQuery("")}
                      />
                    </div>
                    <div style={{ minWidth: 220 }}>
                      <Select
                        label="Filter"
                        options={[
                          { label: `All (${files.length})`, value: "all" },
                          { label: `Images (${imageCount})`, value: "image" },
                          { label: `Videos (${videoCount})`, value: "video" },
                          { label: `Other (${otherCount})`, value: "other" },
                          {
                            label: `Already in target (${alreadyInTargetCount})`,
                            value: "already_in_target",
                          },
                        ]}
                        value={activeFilter}
                        onChange={(value) => setActiveFilter(value as FileFilter)}
                      />
                    </div>
                  </InlineStack>

                  {paginatedFiles.length > 0 ? (
                    <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 4, xl: 5 }} gap="300">
                      {paginatedFiles.map((file) => {
                        const checked = selectedFileIds.includes(file.id);
                        const filterType = getFileFilterType(file);
                        return (
                          <div
                            key={file.id}
                            role="button"
                            tabIndex={0}
                            style={{ cursor: "pointer" }}
                            onClick={() => toggleFileSelection(file.id)}
                            onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                toggleFileSelection(file.id);
                              }
                            }}
                          >
                            <Box
                              padding="300"
                              borderRadius="300"
                              borderWidth="025"
                              borderColor={checked ? "border-emphasis" : "border-secondary"}
                              background={checked ? "bg-surface-selected" : "bg-surface"}
                            >
                              <BlockStack gap="200">
                                <InlineStack align="space-between" blockAlign="start">
                                  <InlineStack gap="100">
                                    <StatusBadge status={checked ? "created" : "skipped"}>
                                      {file.contentType}
                                    </StatusBadge>
                                    {file.alreadyInTarget ? (
                                      <StatusBadge status="exists">
                                        Already in target
                                      </StatusBadge>
                                    ) : null}
                                  </InlineStack>
                                  <span
                                    onClick={(event: MouseEvent<HTMLSpanElement>) =>
                                      event.stopPropagation()
                                    }
                                  >
                                    <Checkbox
                                      label=""
                                      checked={checked}
                                      onChange={() => toggleFileSelection(file.id)}
                                    />
                                  </span>
                                </InlineStack>

                                <MediaPreview file={file} />

                                <BlockStack gap="100">
                                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                                    {file.filename ?? file.id}
                                  </Text>
                                  {file.alt ? (
                                    <Text as="p" variant="bodySm" tone="subdued">
                                      {file.alt}
                                    </Text>
                                  ) : null}
                                  {file.alreadyInTarget ? (
                                    <Text as="p" variant="bodySm" tone="subdued">
                                      This item already exists in the target store and will be skipped if selected.
                                    </Text>
                                  ) : null}
                                  <span
                                    onClick={(event: MouseEvent<HTMLSpanElement>) =>
                                      event.stopPropagation()
                                    }
                                  >
                                    <Link target="_blank" url={file.sourceUrl}>
                                      Preview
                                    </Link>
                                  </span>
                                </BlockStack>
                              </BlockStack>
                            </Box>
                          </div>
                        );
                      })}
                    </InlineGrid>
                  ) : (
                    <Banner tone={files.length > 0 ? "info" : "success"}>
                      <p>
                        {files.length > 0
                          ? "No files match the current filter or search."
                          : "No transferable files were found. The target already has all supported files."}
                      </p>
                    </Banner>
                  )}

                  {filteredFiles.length > 0 ? (
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="span" variant="bodySm" tone="subdued">
                        Showing {String((currentPage - 1) * PAGE_SIZE + 1)}-
                        {String(Math.min(currentPage * PAGE_SIZE, filteredFiles.length))} of{" "}
                        {String(filteredFiles.length)}
                      </Text>
                      <InlineStack gap="200">
                        <Button
                          size="slim"
                          onClick={() => setCurrentPage((page) => Math.max(1, page - 1))}
                          disabled={currentPage <= 1}
                        >
                          Previous
                        </Button>
                        <Button
                          size="slim"
                          onClick={() =>
                            setCurrentPage((page) => Math.min(totalPages, page + 1))
                          }
                          disabled={currentPage >= totalPages}
                        >
                          Next
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  ) : null}
                </BlockStack>
              </Card>
            ) : null}

            {migrationData ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Migration result
                  </Text>

                  <Banner tone={migrationData.ok ? "success" : "critical"}>
                    <p>{migrationData.ok ? migrationData.message : migrationData.error}</p>
                  </Banner>

                  {migrationData.result ? (
                    <>
                      <SummaryTable
                        rows={[
                          ["Selected source files", migrationData.result.totalSourceFiles],
                          ["Created files", migrationData.result.createdCount],
                          ["Skipped files", migrationData.result.skippedCount],
                          ["Failed files", migrationData.result.failedCount],
                        ]}
                      />

                      {logs.length > 0 ? (
                        <div style={{ maxHeight: 420, overflow: "auto" }}>
                          <table
                            style={{
                              width: "100%",
                              borderCollapse: "collapse",
                              tableLayout: "fixed",
                            }}
                          >
                            <thead>
                              <tr style={{ background: "var(--p-color-bg-surface-secondary)" }}>
                                <th style={{ padding: "12px 16px", textAlign: "left" }}>Status</th>
                                <th style={{ padding: "12px 16px", textAlign: "left" }}>Identifier</th>
                                <th style={{ padding: "12px 16px", textAlign: "left" }}>Message</th>
                              </tr>
                            </thead>
                            <tbody>
                              {logs.map((log) => (
                                <tr key={`${log.status}-${log.identifier}`}>
                                  <td style={{ padding: "12px 16px", verticalAlign: "top" }}>
                                    <StatusBadge status={log.status} />
                                  </td>
                                  <td style={{ padding: "12px 16px", verticalAlign: "top" }}>
                                    {log.identifier}
                                  </td>
                                  <td style={{ padding: "12px 16px", verticalAlign: "top" }}>
                                    {log.message}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </BlockStack>
              </Card>
            ) : null}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
