import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  Tabs,
  Text,
} from "@shopify/polaris";
import { useState } from "react";
import {
  useLoaderData,
  useNavigate,
  type LoaderFunctionArgs,
} from "react-router";
import {
  KeyValueTable,
  StatusBadge,
  SummaryTable,
} from "../components/definition-sync";
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
const HISTORY_TABS = [
  { id: "files", content: "Files history" },
  { id: "metaobjects", content: "Metaobject history" },
  { id: "metafields", content: "Metafield history" },
  { id: "connections", content: "Store connection history" },
] as const;
type HistoryTab = (typeof HISTORY_TABS)[number]["id"];

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

const historyMediaFrameStyle = {
  width: 140,
  height: 96,
  borderRadius: 12,
  overflow: "hidden",
  background: "var(--p-color-bg-surface-secondary)",
  border: "1px solid var(--p-color-border-secondary)",
} as const;

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

function FileHistoryPreview({ log }: { log: FileHistoryLog }) {
  if (!log.sourceUrl) {
    return (
      <Box
        padding="200"
        background="bg-surface-secondary"
        borderRadius="200"
      >
        <Text as="span" variant="bodySm" tone="subdued">
          No preview
        </Text>
      </Box>
    );
  }

  if (isPreviewableImage(log)) {
    return (
      <div style={historyMediaFrameStyle}>
        <img
          src={log.sourceUrl}
          alt={log.alt ?? log.identifier}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      </div>
    );
  }

  if (log.contentType === "VIDEO") {
    return (
      <div style={historyMediaFrameStyle}>
        <video
          src={log.sourceUrl}
          preload="metadata"
          controls
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      </div>
    );
  }

  return (
    <a href={log.sourceUrl} target="_blank" rel="noreferrer">
      <Box
        padding="300"
        background="bg-surface-secondary"
        borderRadius="200"
      >
        <Text as="span" variant="bodySm">
          Open file
        </Text>
      </Box>
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
  const [logsPage, setLogsPage] = useState(1);

  const selectedTabIndex = Math.max(
    0,
    HISTORY_TABS.findIndex((item) => item.id === tab),
  );

  const paginatedDefinitionLogs = definitionLogs.slice(
    (logsPage - 1) * 10,
    logsPage * 10,
  );
  const paginatedFileLogs = fileLogs.slice((logsPage - 1) * 10, logsPage * 10);
  const totalDefinitionLogPages = Math.max(
    1,
    Math.ceil(definitionLogs.length / 10),
  );
  const totalFileLogPages = Math.max(1, Math.ceil(fileLogs.length / 10));

  const expandedDefinitionJob = jobId
    ? definitionJobs.find((job) => job.id === jobId)
    : null;
  const expandedFileJob = jobId ? fileJobs.find((job) => job.id === jobId) : null;

  function navigateToTab(nextTab: HistoryTab) {
    navigate(`/app/history?tab=${nextTab}`);
  }

  function renderPagination(baseTab: HistoryTab) {
    if (totalPages <= 1) {
      return null;
    }

    return (
      <>
        <Divider />
        <InlineStack align="space-between" blockAlign="center">
          <Text as="span" variant="bodySm" tone="subdued">
            Page {String(page)} of {String(totalPages)}
          </Text>
          <InlineStack gap="200">
            <Button
              size="slim"
              onClick={() =>
                navigate(
                  `/app/history?tab=${baseTab}&page=${String(Math.max(1, page - 1))}`,
                )
              }
              disabled={page <= 1}
            >
              Previous
            </Button>
            <Button
              size="slim"
              onClick={() =>
                navigate(
                  `/app/history?tab=${baseTab}&page=${String(
                    Math.min(totalPages, page + 1),
                  )}`,
                )
              }
              disabled={page >= totalPages}
            >
              Next
            </Button>
          </InlineStack>
        </InlineStack>
      </>
    );
  }

  return (
    <Page
      title="History"
      subtitle={`${String(total)} records`}
      backAction={{ onAction: () => navigate("/app") }}
    >
      <Layout>
        <Layout.Section>
          <Card>
            <Tabs
              tabs={HISTORY_TABS.map((item) => ({
                id: item.id,
                content: item.content,
              }))}
              selected={selectedTabIndex}
              onSelect={(index) => navigateToTab(HISTORY_TABS[index].id)}
            />
          </Card>
        </Layout.Section>

        <Layout.Section>
          <BlockStack gap="400">
            {tab === "files" ? (
              <>
                {fileJobs.length === 0 ? (
                  <Banner tone="info">
                    <p>No file migration history yet.</p>
                  </Banner>
                ) : (
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        File migration jobs
                      </Text>
                      {fileJobs.map((job) => (
                        <Box
                          key={job.id}
                          padding="300"
                          borderRadius="200"
                          background={
                            job.id === jobId
                              ? "bg-surface-selected"
                              : "bg-surface-secondary"
                          }
                        >
                          <BlockStack gap="200">
                            <InlineStack align="space-between" blockAlign="center">
                              <InlineStack gap="200" blockAlign="center">
                                <StatusBadge status={job.status} />
                                <Text as="span" variant="bodyMd" fontWeight="semibold">
                                  {job.sourceShop} → {job.targetShop}
                                </Text>
                              </InlineStack>
                              <InlineStack gap="200" blockAlign="center">
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {new Date(job.createdAt).toLocaleString()}
                                </Text>
                                <Button
                                  size="slim"
                                  onClick={() =>
                                    navigate(
                                      job.id === jobId
                                        ? `/app/history?tab=files&page=${String(page)}`
                                        : `/app/history?tab=files&page=${String(page)}&jobId=${job.id}`,
                                    )
                                  }
                                >
                                  {job.id === jobId ? "Collapse" : "Details"}
                                </Button>
                              </InlineStack>
                            </InlineStack>
                            <InlineStack gap="300">
                              <Text as="span" variant="bodySm" tone="subdued">
                                Created: {String(job.createdCount)}
                              </Text>
                              <Text as="span" variant="bodySm" tone="subdued">
                                Skipped: {String(job.skippedCount)}
                              </Text>
                              <Text as="span" variant="bodySm" tone="critical">
                                Failed: {String(job.failedCount)}
                              </Text>
                            </InlineStack>
                          </BlockStack>
                        </Box>
                      ))}
                      {renderPagination("files")}
                    </BlockStack>
                  </Card>
                )}

                {expandedFileJob ? (
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        File migration details
                      </Text>
                      {expandedFileJob.errorMessage ? (
                        <Banner tone="critical">
                          <p>{expandedFileJob.errorMessage}</p>
                        </Banner>
                      ) : null}
                      <SummaryTable
                        rows={[
                          ["Selected source files", expandedFileJob.totalSourceFiles],
                          ["Created files", expandedFileJob.createdCount],
                          ["Skipped files", expandedFileJob.skippedCount],
                          ["Failed files", expandedFileJob.failedCount],
                        ]}
                      />
                      {fileLogs.length > 0 ? (
                        <>
                          <Divider />
                          <Text as="h3" variant="headingSm">
                            File sync log
                          </Text>
                          <div
                            style={{
                              border: "1px solid var(--p-color-border-secondary)",
                              borderRadius: 12,
                              overflow: "hidden",
                            }}
                          >
                            <table
                              style={{
                                width: "100%",
                                borderCollapse: "collapse",
                                tableLayout: "fixed",
                              }}
                            >
                              <thead>
                                <tr
                                  style={{
                                    background:
                                      "var(--p-color-bg-surface-secondary)",
                                  }}
                                >
                                  <th style={{ padding: "12px 16px", textAlign: "left", width: 110 }}>
                                    Status
                                  </th>
                                  <th style={{ padding: "12px 16px", textAlign: "left", width: 180 }}>
                                    Preview
                                  </th>
                                  <th style={{ padding: "12px 16px", textAlign: "left", width: 240 }}>
                                    Identifier
                                  </th>
                                  <th style={{ padding: "12px 16px", textAlign: "left" }}>
                                    Message
                                  </th>
                                  <th style={{ padding: "12px 16px", textAlign: "left", width: 180 }}>
                                    Date & Time
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {paginatedFileLogs.map((log, index) => (
                                  <tr key={log.id}>
                                    <td
                                      style={{
                                        padding: "12px 16px",
                                        verticalAlign: "top",
                                        borderBottom:
                                          index === paginatedFileLogs.length - 1
                                            ? "none"
                                            : "1px solid var(--p-color-border-secondary)",
                                      }}
                                    >
                                      <StatusBadge status={log.status} />
                                    </td>
                                    <td
                                      style={{
                                        padding: "12px 16px",
                                        verticalAlign: "top",
                                        borderBottom:
                                          index === paginatedFileLogs.length - 1
                                            ? "none"
                                            : "1px solid var(--p-color-border-secondary)",
                                      }}
                                    >
                                      <FileHistoryPreview log={log} />
                                    </td>
                                    <td
                                      style={{
                                        padding: "12px 16px",
                                        verticalAlign: "top",
                                        borderBottom:
                                          index === paginatedFileLogs.length - 1
                                            ? "none"
                                            : "1px solid var(--p-color-border-secondary)",
                                        overflowWrap: "anywhere",
                                      }}
                                    >
                                      {log.identifier}
                                    </td>
                                    <td
                                      style={{
                                        padding: "12px 16px",
                                        verticalAlign: "top",
                                        borderBottom:
                                          index === paginatedFileLogs.length - 1
                                            ? "none"
                                            : "1px solid var(--p-color-border-secondary)",
                                        overflowWrap: "anywhere",
                                      }}
                                    >
                                      {log.message}
                                    </td>
                                    <td
                                      style={{
                                        padding: "12px 16px",
                                        verticalAlign: "top",
                                        borderBottom:
                                          index === paginatedFileLogs.length - 1
                                            ? "none"
                                            : "1px solid var(--p-color-border-secondary)",
                                      }}
                                    >
                                      {new Date(log.createdAt).toLocaleString()}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {totalFileLogPages > 1 ? (
                            <InlineStack align="space-between" blockAlign="center">
                              <Text as="span" variant="bodySm" tone="subdued">
                                Page {String(logsPage)} of {String(totalFileLogPages)}
                              </Text>
                              <InlineStack gap="200">
                                <Button
                                  size="slim"
                                  onClick={() =>
                                    setLogsPage((current) => Math.max(1, current - 1))
                                  }
                                  disabled={logsPage === 1}
                                >
                                  Previous
                                </Button>
                                <Button
                                  size="slim"
                                  onClick={() =>
                                    setLogsPage((current) =>
                                      Math.min(totalFileLogPages, current + 1),
                                    )
                                  }
                                  disabled={logsPage === totalFileLogPages}
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
                ) : null}
              </>
            ) : null}

            {tab === "metaobjects" || tab === "metafields" ? (
              <>
                {definitionJobs.length === 0 ? (
                  <Banner tone="info">
                    <p>
                      No {tab === "metaobjects" ? "metaobject" : "metafield"} sync
                      history yet.
                    </p>
                  </Banner>
                ) : (
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        {tab === "metaobjects"
                          ? "Metaobject sync jobs"
                          : "Metafield sync jobs"}
                      </Text>
                      {definitionJobs.map((job) => (
                        <Box
                          key={job.id}
                          padding="300"
                          borderRadius="200"
                          background={
                            job.id === jobId
                              ? "bg-surface-selected"
                              : "bg-surface-secondary"
                          }
                        >
                          <BlockStack gap="200">
                            <InlineStack align="space-between" blockAlign="center">
                              <InlineStack gap="200" blockAlign="center">
                                <StatusBadge status={job.status} />
                                <Text as="span" variant="bodyMd" fontWeight="semibold">
                                  {job.sourceShop} → {job.targetShop}
                                </Text>
                              </InlineStack>
                              <InlineStack gap="200" blockAlign="center">
                                <Text as="span" variant="bodySm" tone="subdued">
                                  {new Date(job.createdAt).toLocaleString()}
                                </Text>
                                <Button
                                  size="slim"
                                  onClick={() =>
                                    navigate(
                                      job.id === jobId
                                        ? `/app/history?tab=${tab}&page=${String(page)}`
                                        : `/app/history?tab=${tab}&page=${String(page)}&jobId=${job.id}`,
                                    )
                                  }
                                >
                                  {job.id === jobId ? "Collapse" : "Details"}
                                </Button>
                              </InlineStack>
                            </InlineStack>
                            <InlineStack gap="300">
                              {tab === "metaobjects" ? (
                                <>
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    Definitions: {String(job.createdMetaobjectDefinitions)}
                                  </Text>
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    Fields: {String(job.addedMetaobjectFields)}
                                  </Text>
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    Entries: {String(job.copiedMetaobjectEntries)}
                                  </Text>
                                </>
                              ) : (
                                <Text as="span" variant="bodySm" tone="subdued">
                                  Created: {String(job.createdMetafieldDefinitions)}
                                </Text>
                              )}
                              <Text as="span" variant="bodySm" tone="critical">
                                Failed: {String(job.failedCount)}
                              </Text>
                            </InlineStack>
                          </BlockStack>
                        </Box>
                      ))}
                      {renderPagination(tab)}
                    </BlockStack>
                  </Card>
                )}

                {expandedDefinitionJob ? (
                  <Card>
                    <BlockStack gap="300">
                      <Text as="h2" variant="headingMd">
                        {tab === "metaobjects"
                          ? "Metaobject sync details"
                          : "Metafield sync details"}
                      </Text>
                      {expandedDefinitionJob.errorMessage ? (
                        <Banner tone="critical">
                          <p>{expandedDefinitionJob.errorMessage}</p>
                        </Banner>
                      ) : null}
                      <SummaryTable
                        rows={
                          tab === "metaobjects"
                            ? [
                                [
                                  "Created metaobject definitions",
                                  expandedDefinitionJob.createdMetaobjectDefinitions,
                                ],
                                [
                                  "Added metaobject fields",
                                  expandedDefinitionJob.addedMetaobjectFields,
                                ],
                                [
                                  "Copied metaobject entries",
                                  expandedDefinitionJob.copiedMetaobjectEntries,
                                ],
                                [
                                  "Skipped metaobject entries",
                                  expandedDefinitionJob.skippedMetaobjectEntries,
                                ],
                                ["Failures", expandedDefinitionJob.failedCount],
                              ]
                            : [
                                [
                                  "Created metafield definitions",
                                  expandedDefinitionJob.createdMetafieldDefinitions,
                                ],
                                ["Warnings / conflicts", expandedDefinitionJob.conflictCount],
                                ["Failures", expandedDefinitionJob.failedCount],
                              ]
                        }
                      />
                      {definitionLogs.length > 0 ? (
                        <>
                          <Divider />
                          <Text as="h3" variant="headingSm">
                            {tab === "metaobjects" ? "Metaobject log" : "Metafield log"}
                          </Text>
                          <KeyValueTable
                            headings={["Status", "Type", "Identifier", "Message", "Date & Time"]}
                            rows={paginatedDefinitionLogs.map((log) => [
                              <StatusBadge key={`${log.id}-status`} status={log.status} />,
                              getDefinitionLogLabel(log.itemType),
                              log.itemKey,
                              log.message,
                              new Date(log.createdAt).toLocaleString(),
                            ])}
                          />
                          {(tab === "metaobjects"
                            ? totalDefinitionLogPages
                            : totalDefinitionLogPages) > 1 ? (
                            <InlineStack align="space-between" blockAlign="center">
                              <Text as="span" variant="bodySm" tone="subdued">
                                Page {String(logsPage)} of {String(totalDefinitionLogPages)}
                              </Text>
                              <InlineStack gap="200">
                                <Button
                                  size="slim"
                                  onClick={() =>
                                    setLogsPage((current) => Math.max(1, current - 1))
                                  }
                                  disabled={logsPage === 1}
                                >
                                  Previous
                                </Button>
                                <Button
                                  size="slim"
                                  onClick={() =>
                                    setLogsPage((current) =>
                                      Math.min(totalDefinitionLogPages, current + 1),
                                    )
                                  }
                                  disabled={logsPage === totalDefinitionLogPages}
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
                ) : null}
              </>
            ) : null}

            {tab === "connections" ? (
              connectionEvents.length === 0 ? (
                <Banner tone="info">
                  <p>No store connection history yet.</p>
                </Banner>
              ) : (
                <Card>
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      Store connection events
                    </Text>
                    <KeyValueTable
                      headings={["Status", "Event", "Source store", "Message", "Date & Time"]}
                      rows={connectionEvents.map((event) => [
                        <StatusBadge key={`${event.id}-status`} status={event.status} />,
                        event.event,
                        event.sourceShop ?? "Not provided",
                        event.message,
                        new Date(event.createdAt).toLocaleString(),
                      ])}
                    />
                    {renderPagination("connections")}
                  </BlockStack>
                </Card>
              )
            ) : null}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
