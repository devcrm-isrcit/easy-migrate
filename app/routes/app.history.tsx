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
  Text,
} from "@shopify/polaris";
import { useState } from "react";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import {
  KeyValueTable,
  StatusBadge,
  SummaryTable,
} from "../components/definition-sync";
import {
  getAllSyncJobs,
  getSyncLogs,
} from "../lib/definition-sync/logger.server";
import { authenticate } from "../shopify.server";

const JOBS_PER_PAGE = 10;

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page") || "1"));
  const expandedJobId = url.searchParams.get("jobId") ?? null;

  const { jobs, total, totalPages } = await getAllSyncJobs(
    session.shop,
    page,
    JOBS_PER_PAGE,
  );

  let expandedLogs: Array<{
    id: string;
    itemType: string;
    itemKey: string;
    status: string;
    message: string;
    createdAt: string;
  }> = [];

  if (expandedJobId) {
    const logs = await getSyncLogs(expandedJobId);
    expandedLogs = logs.map((log) => ({
      ...log,
      createdAt: log.createdAt.toISOString(),
    }));
  }

  return {
    jobs: jobs.map((job) => ({
      id: job.id,
      status: job.status,
      sourceShop: job.sourceShop,
      targetShop: job.targetShop,
      createdAt: job.createdAt.toISOString(),
      createdMetafieldDefinitions: job.createdMetafieldDefinitions,
      createdMetaobjectDefinitions: job.createdMetaobjectDefinitions,
      addedMetaobjectFields: job.addedMetaobjectFields,
      copiedMetaobjectEntries: job.copiedMetaobjectEntries,
      skippedMetaobjectEntries: job.skippedMetaobjectEntries,
      failedMetaobjectEntries: job.failedMetaobjectEntries,
      conflictCount: job.conflictCount,
      failedCount: job.failedCount,
      errorMessage: job.errorMessage,
    })),
    total,
    totalPages,
    page,
    expandedJobId,
    expandedLogs,
  };
}

export default function SyncHistoryPage() {
  const { jobs, total, totalPages, page, expandedJobId, expandedLogs } =
    useLoaderData<typeof loader>();
  const [logsPage, setLogsPage] = useState(1);

  const paginatedLogs = expandedLogs.slice(
    (logsPage - 1) * 10,
    logsPage * 10,
  );
  const totalLogPages = Math.max(1, Math.ceil(expandedLogs.length / 10));

  const expandedJob = expandedJobId
    ? jobs.find((j) => j.id === expandedJobId)
    : null;

  function jobStatusTone(status: string) {
    if (status === "completed") return "success" as const;
    if (status === "failed") return "critical" as const;
    return "attention" as const;
  }

  return (
    <Page
      title="Sync History"
      subtitle={`${String(total)} sync jobs`}
      backAction={{ url: "/app" }}
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {jobs.length === 0 ? (
              <Banner tone="info">
                <p>
                  No sync jobs yet. Go to the dashboard and run your first
                  definition sync.
                </p>
              </Banner>
            ) : (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    All sync jobs
                  </Text>

                  {jobs.map((job) => (
                    <Box
                      key={job.id}
                      padding="300"
                      borderRadius="200"
                      background={
                        job.id === expandedJobId
                          ? "bg-surface-selected"
                          : "bg-surface-secondary"
                      }
                    >
                      <BlockStack gap="200">
                        <InlineStack
                          align="space-between"
                          blockAlign="center"
                        >
                          <InlineStack gap="200" blockAlign="center">
                            <Badge tone={jobStatusTone(job.status)}>
                              {job.status}
                            </Badge>
                            <Text as="span" variant="bodyMd" fontWeight="semibold">
                              {job.sourceShop} → {job.targetShop}
                            </Text>
                          </InlineStack>
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodySm" tone="subdued">
                              {new Date(job.createdAt).toLocaleString()}
                            </Text>
                            {job.id !== expandedJobId ? (
                              <Button
                                size="slim"
                                url={`/app/history?page=${String(page)}&jobId=${job.id}`}
                              >
                                Details
                              </Button>
                            ) : (
                              <Button
                                size="slim"
                                url={`/app/history?page=${String(page)}`}
                              >
                                Collapse
                              </Button>
                            )}
                          </InlineStack>
                        </InlineStack>

                        <InlineStack gap="300">
                          <Text as="span" variant="bodySm" tone="subdued">
                            Metafields: {String(job.createdMetafieldDefinitions)}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            Metaobjects: {String(job.createdMetaobjectDefinitions)}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            Fields: {String(job.addedMetaobjectFields)}
                          </Text>
                          {job.copiedMetaobjectEntries > 0 ? (
                            <Text as="span" variant="bodySm" tone="subdued">
                              Entries: {String(job.copiedMetaobjectEntries)}
                            </Text>
                          ) : null}
                          {job.failedCount > 0 ? (
                            <Text as="span" variant="bodySm" tone="critical">
                              Failed: {String(job.failedCount)}
                            </Text>
                          ) : null}
                        </InlineStack>
                      </BlockStack>
                    </Box>
                  ))}

                  {totalPages > 1 ? (
                    <>
                      <Divider />
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="span" variant="bodySm" tone="subdued">
                          Page {String(page)} of {String(totalPages)}
                        </Text>
                        <InlineStack gap="200">
                          <Button
                            size="slim"
                            url={`/app/history?page=${String(Math.max(1, page - 1))}`}
                            disabled={page <= 1}
                          >
                            Previous
                          </Button>
                          <Button
                            size="slim"
                            url={`/app/history?page=${String(Math.min(totalPages, page + 1))}`}
                            disabled={page >= totalPages}
                          >
                            Next
                          </Button>
                        </InlineStack>
                      </InlineStack>
                    </>
                  ) : null}
                </BlockStack>
              </Card>
            )}

            {expandedJob ? (
              <Card>
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Job details
                    </Text>
                    <Badge tone={jobStatusTone(expandedJob.status)}>
                      {expandedJob.status}
                    </Badge>
                  </InlineStack>

                  <Text as="p" tone="subdued" variant="bodySm">
                    {expandedJob.sourceShop} → {expandedJob.targetShop} ·{" "}
                    {new Date(expandedJob.createdAt).toLocaleString()}
                  </Text>

                  {expandedJob.errorMessage ? (
                    <Banner tone="critical">
                      <p>{expandedJob.errorMessage}</p>
                    </Banner>
                  ) : null}

                  <SummaryTable
                    rows={[
                      [
                        "Created metafield definitions",
                        expandedJob.createdMetafieldDefinitions,
                      ],
                      [
                        "Created metaobject definitions",
                        expandedJob.createdMetaobjectDefinitions,
                      ],
                      [
                        "Added metaobject fields",
                        expandedJob.addedMetaobjectFields,
                      ],
                      [
                        "Copied metaobject entries",
                        expandedJob.copiedMetaobjectEntries,
                      ],
                      [
                        "Skipped metaobject entries",
                        expandedJob.skippedMetaobjectEntries,
                      ],
                      ["Warnings / conflicts", expandedJob.conflictCount],
                      ["Failures", expandedJob.failedCount],
                    ]}
                  />

                  {expandedLogs.length > 0 ? (
                    <>
                      <Divider />
                      <Text as="h3" variant="headingSm">
                        Sync log
                      </Text>
                      <KeyValueTable
                        headings={[
                          "Status",
                          "Type",
                          "Identifier",
                          "Message",
                          "Date & Time",
                        ]}
                        rows={paginatedLogs.map((log) => [
                          <StatusBadge
                            key={`${log.id}-s`}
                            status={log.status}
                          />,
                          log.itemType === "metafield_definition"
                            ? "Metafield"
                            : log.itemType === "metaobject_entry"
                              ? "Entry"
                              : "Metaobject",
                          log.itemKey,
                          log.message,
                          new Date(log.createdAt).toLocaleString(),
                        ])}
                      />
                      {totalLogPages > 1 ? (
                        <InlineStack
                          align="space-between"
                          blockAlign="center"
                        >
                          <Text as="span" variant="bodySm" tone="subdued">
                            Log page {String(logsPage)} of {String(totalLogPages)}
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
                  ) : (
                    <Text as="p" tone="subdued">
                      No log entries for this job.
                    </Text>
                  )}
                </BlockStack>
              </Card>
            ) : null}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
