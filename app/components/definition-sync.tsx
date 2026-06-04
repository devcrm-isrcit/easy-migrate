import { Badge, Banner, Card, DataTable, Text } from "@shopify/polaris";
import type { ReactNode } from "react";

export function statusTone(status: string) {
  switch (status) {
    case "valid":
    case "completed":
    case "created":
    case "exists":
      return "success";
    case "pending":
    case "scanning":
    case "syncing":
    case "unchecked":
    case "skipped":
    case "completed_with_errors":
      return "attention";
    case "invalid":
    case "failed":
    case "conflict":
      return "critical";
    default:
      return "info";
  }
}

const STATUS_LABELS: Record<string, string> = {
  completed_with_errors: "partial",
};

export function StatusBadge({
  status,
  children,
}: {
  status: string;
  children?: string;
}) {
  return (
    <Badge tone={statusTone(status)}>
      {children ?? STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export function SummaryTable({
  rows,
}: {
  rows: Array<[string, string | number]>;
}) {
  return (
    <DataTable
      columnContentTypes={["text", "numeric"]}
      headings={["Metric", "Count"]}
      rows={rows.map(([label, value]) => [label, String(value)])}
    />
  );
}

export function KeyValueTable({
  headings,
  rows,
}: {
  headings: string[];
  rows: ReactNode[][];
}) {
  return (
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
          <tr style={{ background: "var(--p-color-bg-surface-secondary)" }}>
            {headings.map((heading) => (
              <th
                key={heading}
                style={{
                  padding: "12px 16px",
                  textAlign: "left",
                  fontSize: 14,
                  fontWeight: 600,
                  borderBottom: "1px solid var(--p-color-border-secondary)",
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                }}
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td
                  key={`cell-${rowIndex}-${cellIndex}`}
                  style={{
                    padding: "12px 16px",
                    verticalAlign: "top",
                    borderBottom:
                      rowIndex === rows.length - 1
                        ? "none"
                        : "1px solid var(--p-color-border-secondary)",
                    whiteSpace: "normal",
                    wordBreak: "break-word",
                    overflowWrap: "anywhere",
                  }}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InfoCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <Card>
      <Text as="h2" variant="headingMd">
        {title}
      </Text>
      <div style={{ marginTop: 12 }}>{children}</div>
    </Card>
  );
}

export function WarningsBanner({ warnings }: { warnings: string[] }) {
  if (!warnings.length) {
    return null;
  }

  return (
    <Banner tone="warning" title="Scan warnings and limits">
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </Banner>
  );
}
