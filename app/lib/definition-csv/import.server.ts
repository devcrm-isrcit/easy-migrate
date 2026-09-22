import {
  METAOBJECT_REFERENCE_VALIDATION_NAMES,
  parseMetaobjectDefinitionValidationValue,
} from "../definition-sync/metaobject-references.server";
import {
  SUPPORTED_METAFIELD_OWNER_TYPES,
  type MetafieldDefinitionFetchResult,
  type MetafieldDefinitionRecord,
  type MetaobjectDefinitionFetchResult,
  type MetaobjectDefinitionRecord,
  type MetaobjectFieldDefinitionRecord,
  type OwnerTypeAccessResult,
} from "../definition-sync/types.shared";
import { parseCsv } from "./csv";
import {
  CSV_COLUMNS,
  CSV_FORMAT_VERSION,
  CSV_RECORD_TYPES,
  META_KEYS,
  decodeBoolean,
  decodeValidations,
  type CsvColumn,
  type CsvRow,
} from "./schema";

export interface DefinitionCsvIssue {
  row: number | null;
  message: string;
}

export interface DefinitionCsvParseResult {
  meta: {
    formatVersion: string | null;
    sourceShop: string | null;
    exportedAt: string | null;
  };
  sourceMetafields: MetafieldDefinitionFetchResult;
  sourceMetaobjects: MetaobjectDefinitionFetchResult;
  counts: {
    metafieldDefinitions: number;
    metaobjectDefinitions: number;
    metaobjectFields: number;
  };
  errors: DefinitionCsvIssue[];
  warnings: string[];
}

const SUPPORTED_OWNER_TYPE_SET = new Set<string>(SUPPORTED_METAFIELD_OWNER_TYPES);
const KNOWN_COLUMNS = new Set<string>(CSV_COLUMNS);
const KNOWN_RECORD_TYPES = new Set<string>(CSV_RECORD_TYPES);

function emptyResult(errors: DefinitionCsvIssue[]): DefinitionCsvParseResult {
  return {
    meta: { formatVersion: null, sourceShop: null, exportedAt: null },
    sourceMetafields: { definitions: [], ownerTypeAccess: [] },
    sourceMetaobjects: { definitions: [] },
    counts: {
      metafieldDefinitions: 0,
      metaobjectDefinitions: 0,
      metaobjectFields: 0,
    },
    errors,
    warnings: [],
  };
}

export function parseDefinitionCsv(text: string): DefinitionCsvParseResult {
  const rows = parseCsv(text);

  if (rows.length === 0) {
    return emptyResult([{ row: null, message: "The file is empty." }]);
  }

  const header = rows[0].map((value) => value.trim().toLowerCase());
  const columnIndex = new Map<string, number>();

  header.forEach((column, index) => {
    if (!columnIndex.has(column)) {
      columnIndex.set(column, index);
    }
  });

  if (!columnIndex.has("record_type")) {
    return emptyResult([
      {
        row: 1,
        message:
          "The header row has no `record_type` column. Export a CSV from the Export tab to see the expected columns.",
      },
    ]);
  }

  const errors: DefinitionCsvIssue[] = [];
  const warnings: string[] = [];

  const unknownColumns = header.filter(
    (column) => column !== "" && !KNOWN_COLUMNS.has(column),
  );

  if (unknownColumns.length > 0) {
    warnings.push(`Ignoring unrecognised column(s): ${unknownColumns.join(", ")}.`);
  }

  // Structural cells (keys, types, enums, booleans) are trimmed so stray
  // spreadsheet whitespace can't break a lookup.
  function read(row: string[], column: CsvColumn): string {
    const index = columnIndex.get(column);
    return index === undefined ? "" : (row[index] ?? "").trim();
  }

  // Human-facing cells are taken verbatim: a name or description may
  // legitimately start or end with a space, and this app wrote the file.
  function readText(row: string[], column: CsvColumn): string {
    const index = columnIndex.get(column);
    return index === undefined ? "" : (row[index] ?? "");
  }

  const meta: Record<string, string> = {};
  const ownerTypeAccessByType = new Map<string, boolean>();
  const metafieldDefinitions: MetafieldDefinitionRecord[] = [];
  const metaobjectDefinitions: MetaobjectDefinitionRecord[] = [];
  const fieldsByParentType = new Map<string, MetaobjectFieldDefinitionRecord[]>();
  const fieldParentRows = new Map<string, number>();

  const seenMetafieldKeys = new Set<string>();
  const seenMetaobjectTypes = new Set<string>();
  const seenFieldKeys = new Set<string>();

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const rowNumber = index + 1;
    const recordType = read(row, "record_type").toLowerCase();

    if (!recordType) {
      errors.push({ row: rowNumber, message: "`record_type` is empty." });
      continue;
    }

    if (!KNOWN_RECORD_TYPES.has(recordType)) {
      errors.push({
        row: rowNumber,
        message: `Unknown record_type "${recordType}". Expected one of: ${CSV_RECORD_TYPES.join(
          ", ",
        )}.`,
      });
      continue;
    }

    if (recordType === "export_meta") {
      const key = read(row, "key");
      if (key) {
        meta[key] = read(row, "value");
      }
      continue;
    }

    if (recordType === "owner_type_access") {
      const ownerType = read(row, "owner_type").toUpperCase();

      if (!ownerType) {
        errors.push({ row: rowNumber, message: "`owner_type` is required." });
        continue;
      }

      const decoded = decodeBoolean(read(row, "value"));

      if (decoded.error) {
        errors.push({ row: rowNumber, message: `\`value\`: ${decoded.error}` });
        continue;
      }

      ownerTypeAccessByType.set(ownerType, decoded.value);
      continue;
    }

    if (recordType === "metafield_definition") {
      const ownerType = read(row, "owner_type").toUpperCase();
      const namespace = read(row, "namespace");
      const key = read(row, "key");
      const name = readText(row, "name");
      const type = read(row, "type");

      const missing = [
        ownerType ? null : "owner_type",
        namespace ? null : "namespace",
        key ? null : "key",
        name.trim() ? null : "name",
        type ? null : "type",
      ].filter(Boolean);

      if (missing.length > 0) {
        errors.push({
          row: rowNumber,
          message: `Metafield definition is missing required column(s): ${missing.join(", ")}.`,
        });
        continue;
      }

      if (!SUPPORTED_OWNER_TYPE_SET.has(ownerType)) {
        errors.push({
          row: rowNumber,
          message: `Unsupported owner_type "${ownerType}".`,
        });
        continue;
      }

      const identifier = `${ownerType}:${namespace}:${key}`;

      if (seenMetafieldKeys.has(identifier)) {
        errors.push({
          row: rowNumber,
          message: `Duplicate metafield definition ${identifier}.`,
        });
        continue;
      }

      const decoded = decodeValidations(read(row, "validations"));

      if (decoded.error) {
        errors.push({ row: rowNumber, message: decoded.error });
        continue;
      }

      seenMetafieldKeys.add(identifier);
      const sourceId = read(row, "source_id");
      metafieldDefinitions.push({
        ...(sourceId ? { id: sourceId } : {}),
        name,
        namespace,
        key,
        ownerType,
        type,
        description: readText(row, "description") || null,
        validations: decoded.validations,
      });
      continue;
    }

    if (recordType === "metaobject_definition") {
      const metaobjectType = read(row, "metaobject_type");
      const name = readText(row, "name");

      const missing = [
        metaobjectType ? null : "metaobject_type",
        name.trim() ? null : "name",
      ].filter(Boolean);

      if (missing.length > 0) {
        errors.push({
          row: rowNumber,
          message: `Metaobject definition is missing required column(s): ${missing.join(", ")}.`,
        });
        continue;
      }

      if (seenMetaobjectTypes.has(metaobjectType)) {
        errors.push({
          row: rowNumber,
          message: `Duplicate metaobject definition "${metaobjectType}".`,
        });
        continue;
      }

      const publishable = decodeBoolean(read(row, "publishable"));

      if (publishable.error) {
        errors.push({
          row: rowNumber,
          message: `\`publishable\`: ${publishable.error}`,
        });
        continue;
      }

      seenMetaobjectTypes.add(metaobjectType);

      const adminAccess = read(row, "admin_access");
      const storefrontAccess = read(row, "storefront_access");
      const sourceId = read(row, "source_id");

      metaobjectDefinitions.push({
        ...(sourceId ? { id: sourceId } : {}),
        type: metaobjectType,
        name,
        description: readText(row, "description") || null,
        displayNameKey: read(row, "display_name_key") || null,
        ...(adminAccess || storefrontAccess
          ? { access: { admin: adminAccess, storefront: storefrontAccess } }
          : {}),
        ...(publishable.value
          ? { capabilities: { publishable: { enabled: true } } }
          : {}),
        fieldDefinitions: [],
      });
      continue;
    }

    // metaobject_field
    const parentType = read(row, "metaobject_type");
    const key = read(row, "key");
    const name = readText(row, "name");
    const type = read(row, "type");

    const missing = [
      parentType ? null : "metaobject_type",
      key ? null : "key",
      name.trim() ? null : "name",
      type ? null : "type",
    ].filter(Boolean);

    if (missing.length > 0) {
      errors.push({
        row: rowNumber,
        message: `Metaobject field is missing required column(s): ${missing.join(", ")}.`,
      });
      continue;
    }

    const fieldIdentifier = `${parentType}.${key}`;

    if (seenFieldKeys.has(fieldIdentifier)) {
      errors.push({
        row: rowNumber,
        message: `Duplicate metaobject field ${fieldIdentifier}.`,
      });
      continue;
    }

    const required = decodeBoolean(read(row, "required"));

    if (required.error) {
      errors.push({ row: rowNumber, message: `\`required\`: ${required.error}` });
      continue;
    }

    const decoded = decodeValidations(read(row, "validations"));

    if (decoded.error) {
      errors.push({ row: rowNumber, message: decoded.error });
      continue;
    }

    seenFieldKeys.add(fieldIdentifier);

    if (!fieldsByParentType.has(parentType)) {
      fieldsByParentType.set(parentType, []);
      fieldParentRows.set(parentType, rowNumber);
    }

    fieldsByParentType.get(parentType)?.push({
      key,
      name,
      type,
      description: readText(row, "description") || null,
      required: required.value,
      validations: decoded.validations,
    });
  }

  const formatVersion = meta[META_KEYS.formatVersion] || null;

  if (formatVersion && formatVersion !== CSV_FORMAT_VERSION) {
    errors.push({
      row: null,
      message: `This file uses CSV format version ${formatVersion}, but this app reads version ${CSV_FORMAT_VERSION}.`,
    });
  }

  if (!formatVersion) {
    warnings.push(
      "The file has no `format_version` row, so it was not produced by this app's Export tab. It will still be imported if the columns line up.",
    );
  }

  for (const [parentType, rowNumber] of fieldParentRows) {
    if (!seenMetaobjectTypes.has(parentType)) {
      errors.push({
        row: rowNumber,
        message: `Metaobject field rows reference "${parentType}", but the file has no metaobject_definition row for it.`,
      });
    }
  }

  for (const definition of metaobjectDefinitions) {
    definition.fieldDefinitions = fieldsByParentType.get(definition.type) ?? [];
  }

  if (errors.length > 0) {
    return {
      ...emptyResult(errors),
      meta: {
        formatVersion,
        sourceShop: meta[META_KEYS.sourceShop] || null,
        exportedAt: meta[META_KEYS.exportedAt] || null,
      },
      warnings,
    };
  }

  warnings.push(
    ...collectUnresolvableReferenceWarnings(
      metafieldDefinitions,
      metaobjectDefinitions,
    ),
  );

  const ownerTypeAccess: OwnerTypeAccessResult[] =
    SUPPORTED_METAFIELD_OWNER_TYPES.map((ownerType) => ({
      ownerType,
      // A hand-written CSV carries no access rows; assume it is complete for
      // whatever it contains rather than silently excluding owner types.
      accessible: ownerTypeAccessByType.get(ownerType) ?? true,
    }));

  return {
    meta: {
      formatVersion,
      sourceShop: meta[META_KEYS.sourceShop] || null,
      exportedAt: meta[META_KEYS.exportedAt] || null,
    },
    sourceMetafields: { definitions: metafieldDefinitions, ownerTypeAccess },
    sourceMetaobjects: { definitions: metaobjectDefinitions },
    counts: {
      metafieldDefinitions: metafieldDefinitions.length,
      metaobjectDefinitions: metaobjectDefinitions.length,
      metaobjectFields: [...fieldsByParentType.values()].reduce(
        (total, fields) => total + fields.length,
        0,
      ),
    },
    errors,
    warnings,
  };
}

/**
 * Metaobject reference validations are remapped on import by looking their
 * source GID up in the set of definitions that travelled in the same file.
 * Anything that cannot be matched will fail per-field during the sync, so
 * surface it up front instead.
 */
function collectUnresolvableReferenceWarnings(
  metafieldDefinitions: MetafieldDefinitionRecord[],
  metaobjectDefinitions: MetaobjectDefinitionRecord[],
) {
  const knownIds = new Set(
    metaobjectDefinitions
      .map((definition) => definition.id)
      .filter((id): id is string => Boolean(id)),
  );

  const unresolved = new Set<string>();

  function inspect(
    validations: MetafieldDefinitionRecord["validations"],
    owner: string,
  ) {
    for (const validation of validations) {
      if (!METAOBJECT_REFERENCE_VALIDATION_NAMES.has(validation.name)) {
        continue;
      }

      for (const id of parseMetaobjectDefinitionValidationValue(validation)) {
        if (!knownIds.has(id)) {
          unresolved.add(owner);
        }
      }
    }
  }

  for (const definition of metafieldDefinitions) {
    inspect(
      definition.validations,
      `${definition.ownerType}:${definition.namespace}:${definition.key}`,
    );
  }

  for (const definition of metaobjectDefinitions) {
    for (const field of definition.fieldDefinitions) {
      inspect(field.validations, `${definition.type}.${field.key}`);
    }
  }

  if (unresolved.size === 0) {
    return [];
  }

  return [
    `These definitions reference a metaobject definition that is not in the file, so their reference fields will be skipped: ${[
      ...unresolved,
    ]
      .sort()
      .join(", ")}.`,
  ];
}

export type { CsvRow };
