import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import {
  useFetcher,
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
  Pill,
  StatGrid,
  StatTile,
} from "../components/easy-migrate-ui";
import {
  DefinitionSelectionList,
  countSelection,
  getSelectableDefinitions,
  type DefinitionSelection,
} from "../components/definition-scan-results";
import {
  buildDefinitionCsv,
  buildDefinitionCsvFileName,
  metafieldIdentifier,
} from "../lib/definition-csv/export.server";
import { parseDefinitionCsv } from "../lib/definition-csv/import.server";
import type { DefinitionCsvIssue } from "../lib/definition-csv/import.server";
import { getReferencedMetaobjectTypes } from "../lib/definition-sync/metaobject-references.server";
import { fetchMetafieldDefinitions } from "../lib/definition-sync/metafield-definitions.server";
import { fetchMetaobjectDefinitions } from "../lib/definition-sync/metaobject-definitions.server";
import {
  buildDefinitionScanPreviewFromDefinitions,
  runDefinitionSyncFromPreview,
} from "../lib/definition-sync/sync.server";
import type { DefinitionScanPreview } from "../lib/definition-sync/types.shared";
import { authenticate } from "../shopify.server";

const MAX_CSV_BYTES = 10 * 1024 * 1024;

export async function loader({ request }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  return { shop: session.shop };
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (intent === "load_definitions") {
    try {
      const [metafields, metaobjects] = await Promise.all([
        fetchMetafieldDefinitions({ admin }),
        fetchMetaobjectDefinitions({ admin }),
      ]);

      const metaobjectTypeById = new Map<string, string>();
      for (const definition of metaobjects.definitions) {
        if (definition.id) {
          metaobjectTypeById.set(definition.id, definition.type);
        }
      }

      return {
        ok: true as const,
        intent,
        metafields: metafields.definitions.map((definition) => ({
          identifier: metafieldIdentifier(definition),
          name: definition.name,
          namespace: definition.namespace,
          key: definition.key,
          ownerType: definition.ownerType,
          type: definition.type,
          dependsOn: getReferencedMetaobjectTypes(
            definition.validations,
            metaobjectTypeById,
          ),
        })),
        metaobjects: metaobjects.definitions.map((definition) => ({
          type: definition.type,
          name: definition.name,
          fieldCount: definition.fieldDefinitions.length,
          dependsOn: [
            ...new Set(
              definition.fieldDefinitions.flatMap((field) =>
                getReferencedMetaobjectTypes(field.validations, metaobjectTypeById),
              ),
            ),
          ],
        })),
        warnings: metafields.ownerTypeAccess
          .filter((item) => !item.accessible)
          .map(
            (item) =>
              `This app can't read ${item.ownerType} metafield definitions with its current scopes, so they are not in the list.`,
          ),
      };
    } catch (error) {
      return {
        ok: false as const,
        intent,
        error:
          error instanceof Error
            ? error.message
            : "Failed to read definitions from this store.",
      };
    }
  }

  if (intent === "export") {
    const selectedMetafieldKeys = JSON.parse(
      String(formData.get("selectedMetafieldKeys") || "[]"),
    ) as string[];
    const selectedMetaobjectTypes = JSON.parse(
      String(formData.get("selectedMetaobjectTypes") || "[]"),
    ) as string[];

    if (!selectedMetafieldKeys.length && !selectedMetaobjectTypes.length) {
      return {
        ok: false as const,
        intent,
        error: "Select at least one definition to export.",
      };
    }

    try {
      const [metafields, metaobjects] = await Promise.all([
        fetchMetafieldDefinitions({ admin }),
        fetchMetaobjectDefinitions({ admin }),
      ]);

      const exportedAt = new Date().toISOString();
      const result = buildDefinitionCsv({
        sourceShop: session.shop,
        exportedAt,
        metafields,
        metaobjects,
        selectedMetafieldKeys,
        selectedMetaobjectTypes,
      });

      return {
        ok: true as const,
        intent,
        csv: result.csv,
        fileName: buildDefinitionCsvFileName(session.shop, exportedAt),
        downloadId: exportedAt,
        counts: result.counts,
        warnings: result.warnings,
      };
    } catch (error) {
      return {
        ok: false as const,
        intent,
        error:
          error instanceof Error ? error.message : "Failed to build the CSV.",
      };
    }
  }

  if (intent === "scan_csv" || intent === "sync_csv") {
    const csvText = String(formData.get("csvText") || "");
    const fileName = String(formData.get("fileName") || "") || null;

    if (!csvText.trim()) {
      return { ok: false as const, intent, error: "Choose a CSV file first." };
    }

    if (csvText.length > MAX_CSV_BYTES) {
      return {
        ok: false as const,
        intent,
        error: "That file is larger than 10 MB. Split it into smaller exports.",
      };
    }

    const parsed = parseDefinitionCsv(csvText);

    if (parsed.errors.length > 0) {
      return {
        ok: false as const,
        intent,
        error: `The CSV has ${parsed.errors.length} problem(s) that must be fixed before importing.`,
        parseErrors: parsed.errors,
        parseWarnings: parsed.warnings,
      };
    }

    const sourceShop = parsed.meta.sourceShop || fileName || "csv-import";

    try {
      const preview = await buildDefinitionScanPreviewFromDefinitions({
        sourceShop,
        targetShop: session.shop,
        admin,
        sourceMetafields: parsed.sourceMetafields,
        sourceMetaobjects: parsed.sourceMetaobjects,
        sourceKind: "csv",
      });

      if (intent === "scan_csv") {
        return {
          ok: true as const,
          intent,
          preview,
          meta: parsed.meta,
          counts: parsed.counts,
          parseWarnings: parsed.warnings,
        };
      }

      const selectedMetafieldKeys = JSON.parse(
        String(formData.get("selectedMetafieldKeys") || "[]"),
      ) as string[];
      const selectedMetaobjectTypes = JSON.parse(
        String(formData.get("selectedMetaobjectTypes") || "[]"),
      ) as string[];

      if (!selectedMetafieldKeys.length && !selectedMetaobjectTypes.length) {
        return {
          ok: false as const,
          intent,
          error: "Select at least one definition to import.",
        };
      }

      const result = await runDefinitionSyncFromPreview({
        preview,
        sourceShop,
        targetShop: session.shop,
        admin,
        selectedMetaobjectTypes,
        selectedMetafieldKeys,
        copyContent: false,
        sourceKind: "csv",
        sourceFileName: fileName,
      });

      return {
        ok: true as const,
        intent,
        jobId: result.jobId,
        status: result.status,
        createdMetafieldDefinitions: result.createdMetafieldDefinitions,
        createdMetaobjectDefinitions: result.createdMetaobjectDefinitions,
        addedMetaobjectFields: result.addedMetaobjectFields,
        updatedMetafieldDefinitions: result.updatedMetafieldDefinitions,
        updatedMetaobjectDefinitions: result.updatedMetaobjectDefinitions,
        updatedMetaobjectFields: result.updatedMetaobjectFields,
        conflictCount: result.conflictCount,
        failedCount: result.failedCount,
        failures: result.failures,
        recordingError: result.recordingError,
      };
    } catch (error) {
      return {
        ok: false as const,
        intent,
        error:
          error instanceof Error
            ? error.message
            : intent === "scan_csv"
              ? "Failed to scan this store."
              : "Import failed.",
      };
    }
  }

  return { ok: false as const, intent, error: "Unknown action." };
}

interface ExportMetafield {
  identifier: string;
  name: string;
  namespace: string;
  key: string;
  ownerType: string;
  type: string;
  dependsOn: string[];
}

interface ExportMetaobject {
  type: string;
  name: string;
  fieldCount: number;
  dependsOn: string[];
}

interface CsvMeta {
  formatVersion: string | null;
  sourceShop: string | null;
  exportedAt: string | null;
}

interface DefinitionCounts {
  metafieldDefinitions: number;
  metaobjectDefinitions: number;
  metaobjectFields: number;
}

type LoadDefinitionsResponse =
  | {
      ok: true;
      metafields: ExportMetafield[];
      metaobjects: ExportMetaobject[];
      warnings: string[];
    }
  | { ok: false; error: string };

type ExportResponse =
  | {
      ok: true;
      csv: string;
      fileName: string;
      downloadId: string;
      counts: DefinitionCounts;
      warnings: string[];
    }
  | { ok: false; error: string };

type ScanCsvResponse =
  | {
      ok: true;
      preview: DefinitionScanPreview;
      meta: CsvMeta;
      counts: DefinitionCounts;
      parseWarnings: string[];
    }
  | {
      ok: false;
      error: string;
      parseErrors?: DefinitionCsvIssue[];
      parseWarnings?: string[];
    };

type SyncCsvResponse =
  | {
      ok: true;
      jobId: string;
      status: string;
      createdMetafieldDefinitions: number;
      createdMetaobjectDefinitions: number;
      addedMetaobjectFields: number;
      updatedMetafieldDefinitions: number;
      updatedMetaobjectDefinitions: number;
      updatedMetaobjectFields: number;
      conflictCount: number;
      failedCount: number;
      failures: Array<{ itemType: string; itemKey: string; message: string }>;
      recordingError: string | null;
    }
  | { ok: false; error: string; parseErrors?: DefinitionCsvIssue[] };

const TABS = [
  { id: "import", label: "Import" },
  { id: "export", label: "Export" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function formatFileSize(bytes: number) {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function triggerCsvDownload(csv: string, fileName: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * A reference field can only be recreated if the metaobject definition it
 * points at travels in the same file, so pull in referenced types transitively.
 */
function collectRequiredMetaobjectTypes({
  metafields,
  metaobjects,
  selectedMetafieldKeys,
  selectedMetaobjectTypes,
}: {
  metafields: ExportMetafield[];
  metaobjects: ExportMetaobject[];
  selectedMetafieldKeys: string[];
  selectedMetaobjectTypes: string[];
}) {
  const dependsOnByType = new Map(
    metaobjects.map((item) => [item.type, item.dependsOn]),
  );
  const selectedKeys = new Set(selectedMetafieldKeys);
  const selectedTypes = new Set(selectedMetaobjectTypes);

  const queue = [
    ...metafields
      .filter((item) => selectedKeys.has(item.identifier))
      .flatMap((item) => item.dependsOn),
    ...selectedTypes,
  ];

  const visited = new Set<string>();
  const required = new Set<string>();

  while (queue.length > 0) {
    const type = queue.shift() as string;

    if (visited.has(type)) {
      continue;
    }

    visited.add(type);

    if (!selectedTypes.has(type)) {
      required.add(type);
    }

    queue.push(...(dependsOnByType.get(type) ?? []));
  }

  return [...required].sort();
}

export default function ImportExportPage() {
  const [tab, setTab] = useState<TabId>("import");
  // Reading every owner type from the Admin API takes seconds, and a scan
  // result is expensive to rebuild, so a tab stays mounted once it is opened.
  // Export is not mounted up front, so opening the page costs no API calls.
  const [openedTabs, setOpenedTabs] = useState<TabId[]>(["import"]);

  function selectTab(next: TabId) {
    setTab(next);
    setOpenedTabs((current) =>
      current.includes(next) ? current : [...current, next],
    );
  }

  return (
    <div className="em-app">
      <div className="em-page">
        <header className="em-page-header">
          <h2 className="em-page-title">Import / Export</h2>
          <p className="em-page-subtitle">
            Move metafield and metaobject definitions between stores as a CSV
            file, without sharing an Admin API token.
          </p>
        </header>

        <div className="em-tabs">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === tab ? "em-tab em-tab--active" : "em-tab"}
              onClick={() => selectTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        {TABS.filter((item) => openedTabs.includes(item.id)).map((item) => (
          <div
            key={item.id}
            className="em-stack em-stack--lg"
            style={item.id === tab ? undefined : { display: "none" }}
          >
            {item.id === "export" ? <ExportTab /> : <ImportTab />}
          </div>
        ))}
      </div>
    </div>
  );
}

function ExportTab() {
  const loadFetcher = useFetcher<LoadDefinitionsResponse>();
  const exportFetcher = useFetcher<ExportResponse>();

  const [selectedMetafieldKeys, setSelectedMetafieldKeys] = useState<string[]>([]);
  const [selectedMetaobjectTypes, setSelectedMetaobjectTypes] = useState<string[]>(
    [],
  );
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"all" | "metaobjects" | "metafields">("all");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [hasPreselected, setHasPreselected] = useState(false);
  const lastDownloadRef = useRef<string | null>(null);
  const hasRequestedLoadRef = useRef(false);

  const isLoading = loadFetcher.state !== "idle";
  const isExporting = exportFetcher.state !== "idle";

  const submitLoad = loadFetcher.submit;

  useEffect(() => {
    if (hasRequestedLoadRef.current) {
      return;
    }

    hasRequestedLoadRef.current = true;
    submitLoad({ intent: "load_definitions" }, { method: "post" });
  }, [submitLoad]);

  const loadData = loadFetcher.data;
  const metafields = useMemo<ExportMetafield[]>(
    () => (loadData?.ok ? loadData.metafields : []),
    [loadData],
  );
  const metaobjects = useMemo<ExportMetaobject[]>(
    () => (loadData?.ok ? loadData.metaobjects : []),
    [loadData],
  );
  const loadWarnings = loadData?.ok ? loadData.warnings : [];
  const loadError = loadData && !loadData.ok ? loadData.error : null;

  // Everything is ticked by default, once, the first time the list arrives.
  useEffect(() => {
    if (hasPreselected || (!metafields.length && !metaobjects.length)) {
      return;
    }

    setSelectedMetafieldKeys(metafields.map((item) => item.identifier));
    setSelectedMetaobjectTypes(metaobjects.map((item) => item.type));
    setHasPreselected(true);
  }, [hasPreselected, metafields, metaobjects]);

  const exportData = exportFetcher.data;
  const exportError = exportData && !exportData.ok ? exportData.error : null;
  const exportResult = exportData?.ok ? exportData : null;

  useEffect(() => {
    if (!exportResult || lastDownloadRef.current === exportResult.downloadId) {
      return;
    }

    lastDownloadRef.current = exportResult.downloadId;
    triggerCsvDownload(exportResult.csv, exportResult.fileName);
  }, [exportResult]);

  const requiredMetaobjectTypes = collectRequiredMetaobjectTypes({
    metafields,
    metaobjects,
    selectedMetafieldKeys,
    selectedMetaobjectTypes,
  });

  const normalizedQuery = query.trim().toLowerCase();
  const visibleMetaobjects = metaobjects.filter((item) => {
    if (view === "metafields") {
      return false;
    }

    return (
      !normalizedQuery ||
      `${item.name} ${item.type}`.toLowerCase().includes(normalizedQuery)
    );
  });
  const visibleMetafields = metafields.filter((item) => {
    if (view === "metaobjects") {
      return false;
    }

    if (ownerFilter !== "all" && item.ownerType !== ownerFilter) {
      return false;
    }

    return (
      !normalizedQuery ||
      `${item.name} ${item.namespace} ${item.key} ${item.ownerType}`
        .toLowerCase()
        .includes(normalizedQuery)
    );
  });

  const metafieldCountByOwnerType = metafields.reduce<Map<string, number>>(
    (counts, item) => counts.set(item.ownerType, (counts.get(item.ownerType) ?? 0) + 1),
    new Map(),
  );
  const ownerFilterOptions = [
    { label: "All owner types", value: "all" },
    ...[...metafieldCountByOwnerType.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ownerType, count]) => ({
        label: `${ownerType} (${String(count)})`,
        value: ownerType,
      })),
  ];

  function clearFilters() {
    setQuery("");
    setView("all");
    setOwnerFilter("all");
  }

  const totalSelected =
    selectedMetafieldKeys.length + selectedMetaobjectTypes.length;
  const totalAvailable = metafields.length + metaobjects.length;
  const allSelected = totalAvailable > 0 && totalSelected === totalAvailable;

  function toggleAll() {
    if (allSelected) {
      setSelectedMetafieldKeys([]);
      setSelectedMetaobjectTypes([]);
      return;
    }

    setSelectedMetafieldKeys(metafields.map((item) => item.identifier));
    setSelectedMetaobjectTypes(metaobjects.map((item) => item.type));
  }

  function handleExport() {
    exportFetcher.submit(
      {
        intent: "export",
        selectedMetafieldKeys: JSON.stringify(selectedMetafieldKeys),
        selectedMetaobjectTypes: JSON.stringify(selectedMetaobjectTypes),
      },
      { method: "post" },
    );
  }

  if (isLoading && !loadData) {
    return (
      <div className="em-card">
        <div className="em-center">
          <Icon name="progress_activity" size={32} className="em-spin" />
          <span className="em-body-sm">Reading definitions from this store…</span>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <Banner tone="critical" title="Couldn't read definitions">
        {loadError}
      </Banner>
    );
  }

  if (totalAvailable === 0) {
    return (
      <div className="em-card">
        <EmptyState
          icon="inventory_2"
          title="Nothing to export yet"
          body="This store has no metafield or metaobject definitions that this app can read."
        />
      </div>
    );
  }

  return (
    <>
      {loadWarnings.map((warning) => (
        <Banner key={warning} tone="warning" title="Scope limit">
          {warning}
        </Banner>
      ))}

      {exportError ? (
        <Banner tone="critical" title="Export failed">
          {exportError}
        </Banner>
      ) : null}

      {exportResult ? (
        <Banner tone="success" title="CSV downloaded">
          {`${String(exportResult.counts.metafieldDefinitions)} metafield definition(s) and ${String(
            exportResult.counts.metaobjectDefinitions,
          )} metaobject definition(s) with ${String(
            exportResult.counts.metaobjectFields,
          )} field(s) were written to ${exportResult.fileName}.`}
        </Banner>
      ) : null}

      {requiredMetaobjectTypes.length > 0 ? (
        <Banner tone="warning" title="Missing referenced definitions">
          <p className="em-body-sm">
            {`Selected definitions reference metaobject definitions that are not selected: ${requiredMetaobjectTypes.join(
              ", ",
            )}. Their reference fields will fail on import unless you include them.`}
          </p>
          <div className="em-row-inline">
            <Button
              size="sm"
              onClick={() =>
                setSelectedMetaobjectTypes((current) => [
                  ...new Set([...current, ...requiredMetaobjectTypes]),
                ])
              }
            >
              Include them
            </Button>
          </div>
        </Banner>
      ) : null}

      <div className="em-card em-card--flush em-list-card">
        <div className="em-list-toolbar">
          <div className="em-row-between">
            <h3 className="em-section-heading">Select what to export</h3>
            <span className="em-label-caps">
              {`${String(totalSelected)} of ${String(totalAvailable)} selected`}
            </span>
          </div>
          <div className="em-list-toolbar__row">
            <div className="em-search">
              <Icon name="search" className="em-search__icon" />
              <input
                className="em-input"
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search namespaces, keys..."
                aria-label="Search definitions"
              />
            </div>
            <select
              className="em-select"
              style={{ width: 170 }}
              value={view}
              onChange={(event) =>
                setView(event.target.value as "all" | "metaobjects" | "metafields")
              }
              disabled={isExporting}
              aria-label="Filter by definition type"
            >
              <option value="all">Everything</option>
              <option value="metaobjects">Metaobjects only</option>
              <option value="metafields">Metafields only</option>
            </select>
            <select
              className="em-select"
              style={{ width: 190 }}
              value={ownerFilter}
              onChange={(event) => setOwnerFilter(event.target.value)}
              disabled={isExporting || view === "metaobjects"}
              aria-label="Filter by metafield owner type"
            >
              {ownerFilterOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="em-list-head em-grid-definitions">
          <div className="em-cell-center">
            <input
              className="em-checkbox"
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              disabled={isExporting}
              aria-label="Select every definition"
            />
          </div>
          <div>Definition Name</div>
          <div style={{ textAlign: "center" }}>Owner</div>
          <div className="em-cell-right">Detail</div>
        </div>

        <div className="em-list-scroll">
          {visibleMetaobjects.length > 0 ? (
            <>
              <div className="em-group-row">
                <span className="em-label-caps">Metaobject definitions</span>
                <LinkButton
                  onClick={() =>
                    setSelectedMetaobjectTypes(
                      selectedMetaobjectTypes.length === metaobjects.length
                        ? []
                        : metaobjects.map((item) => item.type),
                    )
                  }
                  disabled={isExporting}
                >
                  {selectedMetaobjectTypes.length === metaobjects.length
                    ? "Clear all"
                    : "Select all"}
                </LinkButton>
              </div>
              {visibleMetaobjects.map((item) => {
                const checked = selectedMetaobjectTypes.includes(item.type);

                return (
                  <label
                    key={item.type}
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
                          setSelectedMetaobjectTypes((current) =>
                            current.includes(item.type)
                              ? current.filter((value) => value !== item.type)
                              : [...current, item.type],
                          )
                        }
                        disabled={isExporting}
                        aria-label={`Select ${item.name}`}
                      />
                    </div>
                    <div className="em-cell-stack">
                      <span className="em-body em-strong em-truncate">
                        {item.name}
                      </span>
                      <span
                        className="em-code em-truncate"
                        style={{ color: "var(--em-secondary)" }}
                      >
                        {item.type}
                      </span>
                    </div>
                    <div className="em-cell-center">
                      <Pill tone="outline">METAOBJECT</Pill>
                    </div>
                    <div className="em-cell-right">
                      <span className="em-body-sm">
                        {`${String(item.fieldCount)} field(s)`}
                      </span>
                    </div>
                  </label>
                );
              })}
            </>
          ) : null}

          {visibleMetafields.length > 0 ? (
            <>
              <div className="em-group-row">
                <span className="em-label-caps">Metafield definitions</span>
                <LinkButton
                  onClick={() =>
                    setSelectedMetafieldKeys(
                      selectedMetafieldKeys.length === metafields.length
                        ? []
                        : metafields.map((item) => item.identifier),
                    )
                  }
                  disabled={isExporting}
                >
                  {selectedMetafieldKeys.length === metafields.length
                    ? "Clear all"
                    : "Select all"}
                </LinkButton>
              </div>
              {visibleMetafields.map((item) => {
                const checked = selectedMetafieldKeys.includes(item.identifier);

                return (
                  <label
                    key={item.identifier}
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
                          setSelectedMetafieldKeys((current) =>
                            current.includes(item.identifier)
                              ? current.filter((value) => value !== item.identifier)
                              : [...current, item.identifier],
                          )
                        }
                        disabled={isExporting}
                        aria-label={`Select ${item.name}`}
                      />
                    </div>
                    <div className="em-cell-stack">
                      <span className="em-body em-strong em-truncate">
                        {item.name}
                      </span>
                      <span
                        className="em-code em-truncate"
                        style={{ color: "var(--em-secondary)" }}
                      >
                        {`${item.namespace}.${item.key}`}
                      </span>
                    </div>
                    <div className="em-cell-center">
                      <Pill tone="outline">{item.ownerType}</Pill>
                    </div>
                    <div className="em-cell-right">
                      <span className="em-body-sm">{item.type}</span>
                    </div>
                  </label>
                );
              })}
            </>
          ) : null}

          {visibleMetaobjects.length === 0 && visibleMetafields.length === 0 ? (
            <EmptyState
              compact
              icon="search_off"
              title="No definitions match your filters"
              body="Try a different term, or clear the filters to see everything in this store."
              action={<Button onClick={clearFilters}>Clear filters</Button>}
            />
          ) : null}
        </div>
      </div>

      <div className="em-actionbar">
        <div className="em-row-inline">
          <span className="em-actionbar__label">
            {`${String(totalSelected)} definitions selected`}
          </span>
          <span className="em-body-sm">
            {`(from ${String(totalAvailable)} in this store)`}
          </span>
        </div>
        <div className="em-row-inline">
          <Button
            variant="primary"
            icon="download"
            onClick={handleExport}
            loading={isExporting}
            disabled={totalSelected === 0}
          >
            Download CSV
          </Button>
        </div>
      </div>
    </>
  );
}

function ImportTab() {
  const navigate = useNavigate();
  const scanFetcher = useFetcher<ScanCsvResponse>();
  const syncFetcher = useFetcher<SyncCsvResponse>();

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [selection, setSelection] = useState<DefinitionSelection>({
    metaobjectTypes: [],
    metafieldKeys: [],
  });
  // The scan result is held locally rather than read straight off the fetcher,
  // so a finished import can clear it along with the file it came from.
  const [preview, setPreview] = useState<DefinitionScanPreview | null>(null);
  const [csvMeta, setCsvMeta] = useState<CsvMeta | null>(null);
  const [showSyncResult, setShowSyncResult] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);

  const isScanning = scanFetcher.state !== "idle";
  const isSyncing = syncFetcher.state !== "idle";
  const isBusy = isScanning || isSyncing;

  const scanData = scanFetcher.data;
  const scanError = scanData && !scanData.ok ? scanData.error : null;
  const parseErrors = scanData && !scanData.ok ? (scanData.parseErrors ?? []) : [];
  const parseWarnings = scanData ? (scanData.parseWarnings ?? []) : [];

  const syncData = syncFetcher.data;
  const syncError = syncData && !syncData.ok ? syncData.error : null;
  const completedSync = syncData?.ok ? syncData : null;
  const syncResult = showSyncResult ? completedSync : null;

  useEffect(() => {
    if (!scanData) {
      return;
    }

    setPreview(scanData.ok ? scanData.preview : null);
    setCsvMeta(scanData.ok ? scanData.meta : null);
    // A fresh scan supersedes whatever the previous import reported.
    setShowSyncResult(false);
  }, [scanData]);

  useEffect(() => {
    setSelection({ metaobjectTypes: [], metafieldKeys: [] });
  }, [preview]);

  useEffect(() => {
    if (!completedSync) {
      return;
    }

    setShowSyncResult(true);

    // Only a clean run consumes the file. If items failed, the file and the
    // scan stay put so the selection can be adjusted and retried.
    if (completedSync.failedCount === 0) {
      clearChosenFile();
      setPreview(null);
      setCsvMeta(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedSync]);

  function clearChosenFile() {
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    setCsvText("");
    setFileName("");
    setFileError(null);
  }

  /** Clear button: drop the file and every result derived from it. */
  function handleClear() {
    clearChosenFile();
    setPreview(null);
    setCsvMeta(null);
    setSelection({ metaobjectTypes: [], metafieldKeys: [] });
    setShowSyncResult(false);
    setIsDragging(false);
  }

  async function acceptFile(file: File) {
    // A newly chosen file invalidates the previous scan and import result.
    setShowSyncResult(false);
    setPreview(null);
    setCsvMeta(null);

    function reject(message: string) {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }

      setCsvText("");
      setFileName("");
      setFileError(message);
    }

    // Drag and drop accepts anything, so the file is checked here rather than
    // relying on the input's accept attribute.
    if (!/\.csv$/i.test(file.name) && !file.type.includes("csv")) {
      reject(`${file.name} is not a .csv file.`);
      return;
    }

    if (file.size > MAX_CSV_BYTES) {
      reject("That file is larger than 10 MB. Split it into smaller exports.");
      return;
    }

    setFileError(null);
    setFileName(file.name);
    setCsvText(await file.text());
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (file) {
      await acceptFile(file);
    }
  }

  function handleDragEnter(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();

    if (!isBusy) {
      dragDepthRef.current += 1;
      setIsDragging(true);
    }
  }

  function handleDragOver(event: DragEvent<HTMLLabelElement>) {
    // Without this the browser navigates to the dropped file instead.
    event.preventDefault();

    if (!isBusy) {
      event.dataTransfer.dropEffect = "copy";
    }
  }

  // Dragging across a child element fires leave on the parent, so leaves are
  // counted against enters rather than clearing the state on the first one.
  function handleDragLeave(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);

    if (dragDepthRef.current === 0) {
      setIsDragging(false);
    }
  }

  async function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragging(false);

    if (isBusy) {
      return;
    }

    const file = event.dataTransfer.files?.[0];

    if (file) {
      await acceptFile(file);
    }
  }

  function handleScan() {
    scanFetcher.submit({ intent: "scan_csv", csvText, fileName }, { method: "post" });
  }

  function handleImport() {
    syncFetcher.submit(
      {
        intent: "sync_csv",
        csvText,
        fileName,
        selectedMetaobjectTypes: JSON.stringify(selection.metaobjectTypes),
        selectedMetafieldKeys: JSON.stringify(selection.metafieldKeys),
      },
      { method: "post" },
    );
  }

  const selectable = getSelectableDefinitions(preview, false);
  const allSelectableCount = countSelection(selectable);
  const totalSelectedCount = countSelection(selection);
  const totalConflicts = preview
    ? preview.summary.conflictingMetafieldDefinitions +
      preview.summary.conflictingMetaobjectFields
    : 0;

  return (
    <>
      <div className="em-card">
        <div className="em-card__body">
          <div className="em-row-between">
            <div>
              <h3 className="em-section-heading">Upload a definitions CSV</h3>
              <p className="em-body-sm" style={{ marginTop: 4 }}>
                Use a CSV exported from another store&apos;s Export tab. This store is
                then scanned so you can see what is missing before anything is
                created.
              </p>
            </div>
          </div>

          {fileName && !fileError ? (
            <div className="em-file-chip">
              <span className="em-file-chip__icon">
                <Icon name="description" size={20} />
              </span>
              <span className="em-file-chip__body">
                <span className="em-file-chip__name" title={fileName}>
                  {fileName}
                </span>
                <span className="em-file-chip__meta">
                  {`${formatFileSize(csvText.length)} · ready to scan`}
                </span>
              </span>
              <span className="em-file-chip__actions">
                <Button
                  size="sm"
                  icon="close"
                  onClick={handleClear}
                  disabled={isScanning || isSyncing}
                >
                  Clear
                </Button>
              </span>
            </div>
          ) : (
            <label
              className={[
                "em-dropzone",
                isDragging ? "em-dropzone--dragging" : "",
                fileError ? "em-dropzone--invalid" : "",
                isBusy ? "em-dropzone--disabled" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onDragEnter={handleDragEnter}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <input
                ref={fileInputRef}
                className="em-dropzone__input"
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileChange}
                disabled={isBusy}
                aria-label="Definitions CSV file"
              />
              <span className="em-dropzone__icon">
                <Icon name={isDragging ? "file_download" : "upload_file"} size={24} />
              </span>
              <p className="em-dropzone__title">
                {isDragging ? "Drop to load the file" : "Drag a CSV here"}
              </p>
              <p className="em-dropzone__hint">
                or <span className="em-dropzone__link">browse your files</span> · .csv
                up to 10 MB
              </p>
            </label>
          )}

          {fileError ? (
            <Banner tone="critical" title="Couldn't read that file">
              {fileError}
            </Banner>
          ) : null}

          <div className="em-row-inline">
            <Button
              variant="primary"
              icon="search"
              onClick={handleScan}
              loading={isScanning}
              disabled={!csvText || isSyncing}
            >
              {preview ? "Re-scan this store" : "Scan this store"}
            </Button>
            {/* When a file is loaded its own chip carries the Clear button;
                this one is for dismissing a leftover scan or import result. */}
            {!fileName && (preview || syncResult) ? (
              <Button onClick={handleClear} disabled={isBusy}>
                Clear results
              </Button>
            ) : null}
          </div>

          {isScanning ? (
            <>
              <div className="em-progress">
                <div className="em-progress__fill em-progress__fill--indeterminate" />
              </div>
              <p className="em-body-sm">
                Comparing the file against this store&apos;s definitions…
              </p>
            </>
          ) : null}
        </div>
      </div>

      {parseErrors.length > 0 ? (
        <Banner tone="critical" title="This CSV can't be imported yet">
          <p className="em-body-sm">
            Fix the rows below and upload the file again.
          </p>
          <ul className="em-body-sm" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {parseErrors.slice(0, 20).map((issue, index) => (
              <li key={`${String(issue.row)}-${String(index)}`}>
                {issue.row === null ? issue.message : `Row ${String(issue.row)}: ${issue.message}`}
              </li>
            ))}
          </ul>
          {parseErrors.length > 20 ? (
            <p className="em-body-sm">
              {`…and ${String(parseErrors.length - 20)} more.`}
            </p>
          ) : null}
        </Banner>
      ) : scanError ? (
        <Banner tone="critical" title="Scan failed">
          {scanError}
        </Banner>
      ) : null}

      {parseWarnings.map((warning) => (
        <Banner key={warning} tone="warning" title="Check before importing">
          {warning}
        </Banner>
      ))}

      {syncError ? (
        <Banner tone="critical" title="Import failed">
          {syncError}
        </Banner>
      ) : null}

      {syncResult ? (
        <Banner
          tone={
            syncResult.failedCount > 0 || syncResult.recordingError
              ? "warning"
              : "success"
          }
          title={
            syncResult.failedCount > 0
              ? `Import finished with ${String(syncResult.failedCount)} failure(s)`
              : "Import completed"
          }
        >
          <p className="em-body-sm">
            {`Created ${String(syncResult.createdMetaobjectDefinitions)} metaobject and ${String(
              syncResult.createdMetafieldDefinitions,
            )} metafield definition(s), added ${String(
              syncResult.addedMetaobjectFields,
            )} field(s), updated ${String(
              syncResult.updatedMetaobjectDefinitions +
                syncResult.updatedMetafieldDefinitions,
            )} definition(s) and ${String(syncResult.updatedMetaobjectFields)} field(s).`}
            {syncResult.conflictCount > 0
              ? ` ${String(syncResult.conflictCount)} item(s) were skipped as conflicts.`
              : ""}
          </p>

          {syncResult.recordingError ? (
            <p className="em-body-sm">
              {`The changes above were applied to this store, but the run couldn't be saved to the history: ${syncResult.recordingError}`}
            </p>
          ) : null}

          {syncResult.failures.length > 0 ? (
            <ul
              className="em-body-sm"
              style={{ margin: "8px 0 0", paddingLeft: 18 }}
            >
              {syncResult.failures.map((failure) => (
                <li key={`${failure.itemType}-${failure.itemKey}`}>
                  <code className="em-code-chip">{failure.itemKey}</code>
                  {` — ${failure.message}`}
                </li>
              ))}
            </ul>
          ) : null}

          {syncResult.failedCount > syncResult.failures.length ? (
            <p className="em-body-sm">
              {`…and ${String(
                syncResult.failedCount - syncResult.failures.length,
              )} more. Open the full log to see everything.`}
            </p>
          ) : null}

          <div className="em-row-inline">
            <Button
              size="sm"
              icon="description"
              onClick={() =>
                navigate(`/app/history?tab=metaobjects&jobId=${syncResult.jobId}`)
              }
            >
              View full log
            </Button>
          </div>
        </Banner>
      ) : null}

      {preview ? (
        <>
          {preview.ownerTypeWarnings.length > 0 ? (
            <Banner tone="warning" title="Scan warnings and limits">
              {preview.ownerTypeWarnings.join(" ")}
            </Banner>
          ) : null}

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
                  label="Fields to add"
                  value={preview.summary.missingMetaobjectFields}
                />
                <StatTile
                  label="To update"
                  value={
                    preview.summary.updatableMetaobjectDefinitions +
                    preview.summary.changedMetafieldDefinitions
                  }
                />
                <StatTile label="Conflicts" value={totalConflicts} tone="critical" />
              </StatGrid>
              <p className="em-body-sm">
                {csvMeta?.sourceShop
                  ? `Exported from ${csvMeta.sourceShop}${
                      csvMeta.exportedAt ? ` on ${csvMeta.exportedAt}` : ""
                    }`
                  : `Read from ${fileName}`}
              </p>
            </div>
          </div>

          {totalConflicts > 0 ? (
            <Banner
              tone="critical"
              title={`${String(totalConflicts)} Conflicts Detected`}
            >
              Some definitions already exist in this store with a different type.
              Easy Migrate skips them so nothing is overwritten.
            </Banner>
          ) : null}

          {isSyncing ? (
            <Banner tone="info" title="Import running">
              Keep this page open. Closing it stops the import after the current
              item.
            </Banner>
          ) : null}

          {allSelectableCount > 0 ? (
            <DefinitionSelectionList
              preview={preview}
              selection={selection}
              onChange={setSelection}
              disabled={isSyncing}
              title="Select what to import"
            />
          ) : (
            <Banner tone="success" title="Everything in the file is already here">
              Every definition in the CSV already exists in this store.
            </Banner>
          )}

          {allSelectableCount > 0 ? (
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
                  onClick={() =>
                    setSelection({ metaobjectTypes: [], metafieldKeys: [] })
                  }
                  disabled={isSyncing || totalSelectedCount === 0}
                >
                  Clear selection
                </LinkButton>
                <Button
                  variant="primary"
                  icon="sync"
                  onClick={handleImport}
                  loading={isSyncing}
                  disabled={totalSelectedCount === 0}
                >
                  {`Import ${String(totalSelectedCount)} definitions`}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
