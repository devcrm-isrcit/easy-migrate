import { useEffect, useState } from "react";
import { findMissingReferencedMetaobjectTypes } from "../lib/definition-sync/metaobject-references.shared";
import {
  hasApplicableUpdates,
  type DefinitionScanPreview,
  type MetaobjectComparisonItem,
} from "../lib/definition-sync/types.shared";
import {
  Banner,
  Button,
  EmptyState,
  Icon,
  LinkButton,
  Pill,
  StatusText,
  useExpandableCard,
  useRowFlash,
} from "./easy-migrate-ui";

export interface DefinitionSelection {
  metaobjectTypes: string[];
  metafieldKeys: string[];
}

export function metafieldIdentifier(definition: {
  ownerType: string;
  namespace: string;
  key: string;
}) {
  return `${definition.ownerType}:${definition.namespace}:${definition.key}`;
}

/** Short description of what selecting an existing metaobject would apply. */
export function describeMetaobjectUpdates(item: MetaobjectComparisonItem) {
  const parts: string[] = [];

  if (item.missingFields.length) {
    parts.push(`+${String(item.missingFields.length)} field(s)`);
  }

  if (item.changedFields.length) {
    parts.push(`${String(item.changedFields.length)} field(s) changed`);
  }

  if (item.definitionChanges.length) {
    parts.push(item.definitionChanges.map((change) => change.property).join(", "));
  }

  return parts.join(" · ");
}

/**
 * Everything a scan offers to apply. A definition that is missing here gets
 * created; one that exists but differs gets updated. Both are driven by the
 * same checkbox, so this list mixes the two.
 */
export function getSelectableDefinitions(
  preview: DefinitionScanPreview | null,
  copyContent: boolean,
): DefinitionSelection {
  if (!preview) {
    return { metaobjectTypes: [], metafieldKeys: [] };
  }

  const metaobjectTypes = new Set<string>([
    ...preview.metaobjects.missing.map((item) => item.type),
    ...preview.metaobjects.existing
      .filter(hasApplicableUpdates)
      .map((item) => item.type),
    // Copying entries needs the type selected even when its definition matches.
    ...(copyContent ? preview.metaobjects.existing.map((item) => item.source.type) : []),
  ]);

  const metafieldKeys = new Set<string>([
    ...preview.metafields.missing.map(metafieldIdentifier),
    ...preview.metafields.changed.map((difference) => difference.key),
  ]);

  return {
    metaobjectTypes: [...metaobjectTypes],
    metafieldKeys: [...metafieldKeys],
  };
}

export function countSelection(selection: DefinitionSelection) {
  return selection.metaobjectTypes.length + selection.metafieldKeys.length;
}

interface MetaobjectRow {
  type: string;
  name: string;
  action: "create" | "update" | "entries";
  detail: string;
  isConflict: boolean;
  searchText: string;
}

interface MetafieldRow {
  identifier: string;
  name: string;
  namespace: string;
  key: string;
  ownerType: string;
  action: "create" | "update";
  detail: string;
  isConflict: boolean;
  searchText: string;
}

interface DefinitionSelectionListProps {
  preview: DefinitionScanPreview;
  selection: DefinitionSelection;
  onChange: (next: DefinitionSelection) => void;
  disabled?: boolean;
  title?: string;
  /** Omit to hide the entry-copy option entirely (a definitions CSV has none). */
  copyContent?: boolean;
  onCopyContentChange?: (value: boolean) => void;
  /**
   * Adds a button that grows the list into a large dialog. One per page: the
   * dialog's animation is keyed to a single view-transition name.
   */
  expandable?: boolean;
}

export function DefinitionSelectionList({
  preview,
  selection,
  onChange,
  disabled = false,
  title = "Select what to copy",
  copyContent,
  onCopyContentChange,
  expandable = false,
}: DefinitionSelectionListProps) {
  const [selectionQuery, setSelectionQuery] = useState("");
  const [selectionView, setSelectionView] = useState<
    "all" | "metaobjects" | "metafields"
  >("all");
  const [metafieldOwnerFilter, setMetafieldOwnerFilter] = useState("all");
  const {
    containerRef: listScrollRef,
    flashKeys: flashedMetaobjectTypes,
    flashRows,
  } = useRowFlash<HTMLDivElement>();
  const expandCard = useExpandableCard();
  const expanded = expandable && expandCard.expanded;

  useEffect(() => {
    setSelectionQuery("");
    setSelectionView("all");
    setMetafieldOwnerFilter("all");
  }, [preview]);

  const supportsCopyContent = copyContent !== undefined;
  const isCopyingContent = copyContent === true;

  const { metaobjectTypes: selectedMetaobjectTypes, metafieldKeys: selectedMetafieldKeys } =
    selection;

  const conflictingMetaobjectTypes = new Set<string>(
    preview.metaobjects.conflicts.map((item) => item.type),
  );
  const conflictKeys = new Set<string>(
    preview.metafields.conflicts.map((conflict) =>
      metafieldIdentifier(conflict.source),
    ),
  );

  const updatableMetaobjects = preview.metaobjects.existing.filter(hasApplicableUpdates);
  const updatableTypes = new Set(updatableMetaobjects.map((item) => item.type));

  const metaobjectRows: MetaobjectRow[] = [
    ...preview.metaobjects.missing.map((item) => ({
      type: item.type,
      name: item.name,
      action: "create" as const,
      detail: `${String(item.fieldDefinitions.length)} field(s)`,
      isConflict: conflictingMetaobjectTypes.has(item.type),
      searchText: [
        item.name,
        item.type,
        ...item.fieldDefinitions.map((field) => `${field.name} ${field.key}`),
      ]
        .join(" ")
        .toLowerCase(),
    })),
    ...updatableMetaobjects.map((item) => ({
      type: item.type,
      name: item.source.name,
      action: "update" as const,
      detail: describeMetaobjectUpdates(item),
      isConflict: conflictingMetaobjectTypes.has(item.type),
      searchText: [
        item.source.name,
        item.source.type,
        ...item.source.fieldDefinitions.map((field) => `${field.name} ${field.key}`),
      ]
        .join(" ")
        .toLowerCase(),
    })),
    // Definitions that already match, offered only so their entries can be copied.
    ...(isCopyingContent
      ? preview.metaobjects.existing
          .filter((item) => !updatableTypes.has(item.type))
          .map((item) => ({
            type: item.type,
            name: item.source.name,
            action: "entries" as const,
            detail: "Definition already matches",
            isConflict: false,
            searchText: [item.source.name, item.source.type].join(" ").toLowerCase(),
          }))
      : []),
  ];

  const metafieldRows: MetafieldRow[] = [
    ...preview.metafields.missing.map((item) => ({
      identifier: metafieldIdentifier(item),
      name: item.name,
      namespace: item.namespace,
      key: item.key,
      ownerType: item.ownerType,
      action: "create" as const,
      detail: item.type,
      isConflict: conflictKeys.has(metafieldIdentifier(item)),
      searchText: [item.name, item.namespace, item.key, item.type, item.ownerType]
        .join(" ")
        .toLowerCase(),
    })),
    ...preview.metafields.changed.map((difference) => ({
      identifier: difference.key,
      name: difference.source.name,
      namespace: difference.source.namespace,
      key: difference.source.key,
      ownerType: difference.source.ownerType,
      action: "update" as const,
      detail: difference.changes.map((change) => change.property).join(", "),
      isConflict: false,
      searchText: [
        difference.source.name,
        difference.source.namespace,
        difference.source.key,
        difference.source.type,
        difference.source.ownerType,
      ]
        .join(" ")
        .toLowerCase(),
    })),
  ];

  const normalizedSelectionQuery = selectionQuery.trim().toLowerCase();
  const selectable = getSelectableDefinitions(preview, isCopyingContent);
  const totalSelectedCount = countSelection(selection);

  const allMetaobjectTypes = selectable.metaobjectTypes;
  const allMetafieldIdentifiers = selectable.metafieldKeys;
  const allMetaobjectsSelected =
    allMetaobjectTypes.length > 0 &&
    allMetaobjectTypes.every((type) => selectedMetaobjectTypes.includes(type));
  const allMetafieldsSelected =
    allMetafieldIdentifiers.length > 0 &&
    allMetafieldIdentifiers.every((id) => selectedMetafieldKeys.includes(id));

  const metafieldCountByOwnerType = metafieldRows.reduce<Map<string, number>>(
    (counts, row) => counts.set(row.ownerType, (counts.get(row.ownerType) ?? 0) + 1),
    new Map(),
  );
  const metafieldOwnerOptions = [
    { label: "All owner types", value: "all" },
    ...[...metafieldCountByOwnerType.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ownerType, count]) => ({
        label: `${ownerType} (${String(count)})`,
        value: ownerType,
      })),
  ];

  const visibleMetaobjectRows = metaobjectRows.filter(
    (row) =>
      selectionView !== "metafields" &&
      (!normalizedSelectionQuery || row.searchText.includes(normalizedSelectionQuery)),
  );
  const visibleMetafieldRows = metafieldRows.filter((row) => {
    if (selectionView === "metaobjects") {
      return false;
    }

    if (metafieldOwnerFilter !== "all" && row.ownerType !== metafieldOwnerFilter) {
      return false;
    }

    return !normalizedSelectionQuery || row.searchText.includes(normalizedSelectionQuery);
  });
  const visibleItemCount = visibleMetaobjectRows.length + visibleMetafieldRows.length;

  // The header checkbox works on the rows the filters leave on screen, like
  // the export list; rows hidden by a filter keep whatever ticks they had.
  const visibleSelectableTypes = visibleMetaobjectRows
    .map((row) => row.type)
    .filter((type) => allMetaobjectTypes.includes(type));
  const visibleSelectableKeys = visibleMetafieldRows
    .map((row) => row.identifier)
    .filter((id) => allMetafieldIdentifiers.includes(id));
  const allVisibleSelected =
    visibleSelectableTypes.length + visibleSelectableKeys.length > 0 &&
    visibleSelectableTypes.every((type) => selectedMetaobjectTypes.includes(type)) &&
    visibleSelectableKeys.every((id) => selectedMetafieldKeys.includes(id));

  function setMetaobjectTypes(metaobjectTypes: string[]) {
    onChange({ ...selection, metaobjectTypes });
  }

  function setMetafieldKeys(metafieldKeys: string[]) {
    onChange({ ...selection, metafieldKeys });
  }

  function toggleMetaobjectSelection(type: string) {
    setMetaobjectTypes(
      selectedMetaobjectTypes.includes(type)
        ? selectedMetaobjectTypes.filter((value) => value !== type)
        : [...selectedMetaobjectTypes, type],
    );
  }

  function toggleMetafieldSelection(id: string) {
    setMetafieldKeys(
      selectedMetafieldKeys.includes(id)
        ? selectedMetafieldKeys.filter((value) => value !== id)
        : [...selectedMetafieldKeys, id],
    );
  }

  // The type and owner dropdowns untick the rows they hide, so what is ticked
  // on screen is exactly what gets copied. Search only hides rows.
  function changeFilters(
    view: "all" | "metaobjects" | "metafields",
    ownerFilter: string,
  ) {
    setSelectionView(view);
    setMetafieldOwnerFilter(ownerFilter);

    const keysInView = new Set(
      metafieldRows
        .filter(
          (row) =>
            view !== "metaobjects" &&
            (ownerFilter === "all" || row.ownerType === ownerFilter),
        )
        .map((row) => row.identifier),
    );
    const keptTypes = view === "metafields" ? [] : selectedMetaobjectTypes;
    const keptKeys = selectedMetafieldKeys.filter((id) => keysInView.has(id));

    if (
      keptTypes.length !== selectedMetaobjectTypes.length ||
      keptKeys.length !== selectedMetafieldKeys.length
    ) {
      onChange({ metaobjectTypes: keptTypes, metafieldKeys: keptKeys });
    }
  }

  function toggleSelectAll() {
    if (allVisibleSelected) {
      onChange({
        metaobjectTypes: selectedMetaobjectTypes.filter(
          (type) => !visibleSelectableTypes.includes(type),
        ),
        metafieldKeys: selectedMetafieldKeys.filter(
          (id) => !visibleSelectableKeys.includes(id),
        ),
      });
      return;
    }

    onChange({
      metaobjectTypes: [
        ...new Set([...selectedMetaobjectTypes, ...visibleSelectableTypes]),
      ],
      metafieldKeys: [...new Set([...selectedMetafieldKeys, ...visibleSelectableKeys])],
    });
  }

  function toggleMetaobjectsSelectAll() {
    setMetaobjectTypes(allMetaobjectsSelected ? [] : allMetaobjectTypes);
  }

  function toggleMetafieldsSelectAll() {
    setMetafieldKeys(allMetafieldsSelected ? [] : allMetafieldIdentifiers);
  }

  const missingReferencedMetaobjectTypes = findMissingReferencedMetaobjectTypes({
    preview,
    selectedMetaobjectTypes,
    selectedMetafieldKeys,
  });

  // Ticks the referenced metaobjects, then makes sure the rows are on screen
  // so the new ticks are visible: the "Metafields only" view and the search
  // can hide them.
  function includeMissingReferencedTypes() {
    const types = missingReferencedMetaobjectTypes;

    setMetaobjectTypes([...new Set([...selectedMetaobjectTypes, ...types])]);

    if (selectionView === "metafields") {
      setSelectionView("all");
    }

    const hiddenBySearch = metaobjectRows.some(
      (row) =>
        types.includes(row.type) &&
        Boolean(normalizedSelectionQuery) &&
        !row.searchText.includes(normalizedSelectionQuery),
    );

    if (hiddenBySearch) {
      setSelectionQuery("");
    }

    flashRows(types);
  }

  function statusFor(action: "create" | "update" | "entries", isConflict: boolean) {
    if (isConflict) {
      return { tone: "critical" as const, label: "Conflict" };
    }

    if (action === "create") {
      return { tone: "warning" as const, label: "Missing" };
    }

    if (action === "update") {
      return { tone: "warning" as const, label: "Update" };
    }

    return { tone: "secondary" as const, label: "In target" };
  }

  return (
    <>
      {missingReferencedMetaobjectTypes.length > 0 ? (
        <Banner
          tone="warning"
          title="Missing referenced definitions"
          action={
            <Button
              size="sm"
              onClick={includeMissingReferencedTypes}
              disabled={disabled}
            >
              Include them
            </Button>
          }
        >
          {`Selected definitions reference metaobject definitions that aren't on the destination store and aren't selected: ${missingReferencedMetaobjectTypes.join(
            ", ",
          )}. Their reference fields will fail unless you include them.`}
        </Banner>
      ) : null}

      {expanded ? (
        <>
          {/* Holds the card's place while it is out of the flow. */}
          <div style={{ height: expandCard.placeholderHeight }} aria-hidden="true" />
          <div
            className="em-expand-backdrop"
            onClick={() => expandCard.setExpanded(false)}
            aria-hidden="true"
          />
        </>
      ) : null}

      <div
        ref={expandable ? expandCard.cardRef : undefined}
        className={[
          "em-card em-card--flush em-list-card",
          expandable ? "em-expandable" : "",
          expanded ? "em-expandable--expanded" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={expandable ? expandCard.cardStyle : undefined}
        role={expanded ? "dialog" : undefined}
        aria-modal={expanded || undefined}
        aria-label={expanded ? title : undefined}
      >
        <div className="em-list-toolbar">
          <div className="em-row-between">
            <h3 className="em-section-heading">{title}</h3>
            <div className="em-row-inline">
              <span className="em-label-caps">
                {`Showing ${String(visibleItemCount)} items`}
              </span>
              {expandable ? (
                <button
                  type="button"
                  className="em-icon-btn"
                  onClick={() => expandCard.setExpanded(!expanded)}
                  aria-label={expanded ? "Collapse list" : "Expand list"}
                  title={expanded ? "Collapse list" : "Expand list"}
                >
                  <Icon name={expanded ? "close_fullscreen" : "open_in_full"} />
                </button>
              ) : null}
            </div>
          </div>
          <div className="em-list-toolbar__row">
            <div className="em-search">
              <Icon name="search" className="em-search__icon" />
              <input
                className="em-input"
                type="text"
                value={selectionQuery}
                onChange={(event) => setSelectionQuery(event.target.value)}
                placeholder="Search namespaces, keys..."
                aria-label="Search definitions"
              />
            </div>
            <select
              className="em-select"
              style={{ width: 170 }}
              value={selectionView}
              onChange={(event) =>
                changeFilters(
                  event.target.value as "all" | "metaobjects" | "metafields",
                  metafieldOwnerFilter,
                )
              }
              disabled={disabled}
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
              onChange={(event) => changeFilters(selectionView, event.target.value)}
              disabled={disabled || selectionView === "metaobjects"}
              aria-label="Filter by metafield owner type"
            >
              {metafieldOwnerOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          {supportsCopyContent ? (
            <label className="em-checkbox-label">
              <input
                className="em-checkbox"
                type="checkbox"
                checked={isCopyingContent}
                onChange={(event) => onCopyContentChange?.(event.target.checked)}
                disabled={disabled}
              />
              Copy metaobject entries (content and values)
            </label>
          ) : null}
        </div>

        <div className="em-list-head em-grid-definitions">
          <div className="em-cell-center">
            <input
              className="em-checkbox"
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAll}
              disabled={
                disabled ||
                visibleSelectableTypes.length + visibleSelectableKeys.length === 0
              }
              aria-label="Select every definition shown"
            />
          </div>
          <div>Definition Name</div>
          <div style={{ textAlign: "center" }}>Owner</div>
          <div className="em-cell-right">Status</div>
        </div>

        <div className="em-list-scroll" ref={listScrollRef}>
          {visibleMetaobjectRows.length > 0 ? (
            <>
              <div className="em-group-row">
                <span className="em-label-caps">Metaobject definitions</span>
                <LinkButton onClick={toggleMetaobjectsSelectAll} disabled={disabled}>
                  {allMetaobjectsSelected ? "Clear all" : "Select all"}
                </LinkButton>
              </div>
              {visibleMetaobjectRows.map((row) => {
                const checked = selectedMetaobjectTypes.includes(row.type);
                const status = statusFor(row.action, row.isConflict);

                return (
                  <label
                    key={row.type}
                    data-flash-key={row.type}
                    className={[
                      "em-list-row em-grid-definitions",
                      checked ? "em-list-row--selected" : "",
                      row.isConflict ? "em-list-row--conflict" : "",
                      flashedMetaobjectTypes.includes(row.type) ? "em-list-row--flash" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <div className="em-cell-center">
                      <input
                        className="em-checkbox"
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleMetaobjectSelection(row.type)}
                        disabled={disabled}
                        aria-label={`Select ${row.name}`}
                      />
                    </div>
                    <div className="em-cell-stack">
                      <span className="em-body em-strong em-truncate">{row.name}</span>
                      <span
                        className="em-code em-truncate"
                        style={{ color: "var(--em-secondary)" }}
                      >
                        {row.type}
                      </span>
                    </div>
                    <div className="em-cell-center">
                      <Pill tone="outline">METAOBJECT</Pill>
                    </div>
                    <div className="em-cell-right em-cell-stack">
                      <StatusText tone={status.tone}>{status.label}</StatusText>
                      {row.detail ? (
                        <span className="em-body-sm em-truncate">{row.detail}</span>
                      ) : null}
                    </div>
                  </label>
                );
              })}
            </>
          ) : null}

          {visibleMetafieldRows.length > 0 ? (
            <>
              <div className="em-group-row">
                <span className="em-label-caps">Metafield definitions</span>
                <LinkButton onClick={toggleMetafieldsSelectAll} disabled={disabled}>
                  {allMetafieldsSelected ? "Clear all" : "Select all"}
                </LinkButton>
              </div>
              {visibleMetafieldRows.map((row) => {
                const checked = selectedMetafieldKeys.includes(row.identifier);
                const status = statusFor(row.action, row.isConflict);

                return (
                  <label
                    key={row.identifier}
                    className={[
                      "em-list-row em-grid-definitions",
                      checked ? "em-list-row--selected" : "",
                      row.isConflict ? "em-list-row--conflict" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <div className="em-cell-center">
                      <input
                        className="em-checkbox"
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleMetafieldSelection(row.identifier)}
                        disabled={disabled}
                        aria-label={`Select ${row.name}`}
                      />
                    </div>
                    <div className="em-cell-stack">
                      <span className="em-body em-strong em-truncate">{row.name}</span>
                      <span
                        className="em-code em-truncate"
                        style={{ color: "var(--em-secondary)" }}
                      >
                        {`${row.namespace}.${row.key}`}
                      </span>
                    </div>
                    <div className="em-cell-center">
                      <Pill tone="outline">{row.ownerType}</Pill>
                    </div>
                    <div className="em-cell-right em-cell-stack">
                      <StatusText tone={status.tone}>{status.label}</StatusText>
                      {row.detail ? (
                        <span className="em-body-sm em-truncate">{row.detail}</span>
                      ) : null}
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

        {expanded ? (
          <div className="em-expandable__footer">
            <span className="em-body-sm">
              {`${String(totalSelectedCount)} definitions selected`}
            </span>
            <Button variant="primary" onClick={() => expandCard.setExpanded(false)}>
              Done
            </Button>
          </div>
        ) : null}
      </div>
    </>
  );
}
