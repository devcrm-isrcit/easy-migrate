import {
  getReferencedMetaobjectTypes,
} from "../definition-sync/metaobject-references.server";
import type {
  MetafieldDefinitionFetchResult,
  MetafieldDefinitionRecord,
  MetaobjectDefinitionFetchResult,
  MetaobjectDefinitionRecord,
} from "../definition-sync/types.shared";
import { toCsv } from "./csv";
import {
  CSV_FORMAT_VERSION,
  META_KEYS,
  encodeBoolean,
  encodeValidations,
  headerRow,
  serializeRow,
  type CsvRow,
} from "./schema";

export function metafieldIdentifier(definition: MetafieldDefinitionRecord) {
  return `${definition.ownerType}:${definition.namespace}:${definition.key}`;
}

function buildTypeById(definitions: MetaobjectDefinitionRecord[]) {
  const typeById = new Map<string, string>();

  for (const definition of definitions) {
    if (definition.id) {
      typeById.set(definition.id, definition.type);
    }
  }

  return typeById;
}

/**
 * A selected definition whose validations point at a metaobject definition that
 * is not itself in the file cannot be recreated on import — the importer has no
 * way to translate the reference. Returns the extra metaobject types that have
 * to travel with the current selection, following references transitively.
 */
export function resolveMetaobjectDependencies({
  metafields,
  metaobjects,
  selectedMetafieldKeys,
  selectedMetaobjectTypes,
}: {
  metafields: MetafieldDefinitionRecord[];
  metaobjects: MetaobjectDefinitionRecord[];
  selectedMetafieldKeys: string[];
  selectedMetaobjectTypes: string[];
}): { requiredMetaobjectTypes: string[] } {
  const typeById = buildTypeById(metaobjects);
  const definitionByType = new Map(
    metaobjects.map((definition) => [definition.type, definition]),
  );

  const selectedTypes = new Set(selectedMetaobjectTypes);
  const selectedMetafieldKeySet = new Set(selectedMetafieldKeys);
  const required = new Set<string>();

  const queue: string[] = [];

  for (const definition of metafields) {
    if (!selectedMetafieldKeySet.has(metafieldIdentifier(definition))) {
      continue;
    }

    queue.push(...getReferencedMetaobjectTypes(definition.validations, typeById));
  }

  for (const type of selectedTypes) {
    queue.push(type);
  }

  const visited = new Set<string>();

  while (queue.length > 0) {
    const type = queue.shift() as string;

    if (visited.has(type)) {
      continue;
    }

    visited.add(type);

    if (!selectedTypes.has(type)) {
      required.add(type);
    }

    const definition = definitionByType.get(type);

    if (!definition) {
      continue;
    }

    for (const field of definition.fieldDefinitions) {
      queue.push(...getReferencedMetaobjectTypes(field.validations, typeById));
    }
  }

  return { requiredMetaobjectTypes: [...required].sort() };
}

export interface DefinitionCsvExportResult {
  csv: string;
  counts: {
    metafieldDefinitions: number;
    metaobjectDefinitions: number;
    metaobjectFields: number;
  };
  warnings: string[];
}

export function buildDefinitionCsv({
  sourceShop,
  exportedAt,
  metafields,
  metaobjects,
  selectedMetafieldKeys,
  selectedMetaobjectTypes,
}: {
  sourceShop: string;
  exportedAt: string;
  metafields: MetafieldDefinitionFetchResult;
  metaobjects: MetaobjectDefinitionFetchResult;
  selectedMetafieldKeys: string[];
  selectedMetaobjectTypes: string[];
}): DefinitionCsvExportResult {
  const selectedMetafieldKeySet = new Set(selectedMetafieldKeys);
  const selectedMetaobjectTypeSet = new Set(selectedMetaobjectTypes);

  const includedMetafields = metafields.definitions
    .filter((definition) =>
      selectedMetafieldKeySet.has(metafieldIdentifier(definition)),
    )
    .sort((a, b) => metafieldIdentifier(a).localeCompare(metafieldIdentifier(b)));

  const includedMetaobjects = metaobjects.definitions
    .filter((definition) => selectedMetaobjectTypeSet.has(definition.type))
    .sort((a, b) => a.type.localeCompare(b.type));

  const rows: CsvRow[] = [
    {
      record_type: "export_meta",
      key: META_KEYS.formatVersion,
      value: CSV_FORMAT_VERSION,
    },
    { record_type: "export_meta", key: META_KEYS.sourceShop, value: sourceShop },
    { record_type: "export_meta", key: META_KEYS.exportedAt, value: exportedAt },
  ];

  for (const access of metafields.ownerTypeAccess) {
    rows.push({
      record_type: "owner_type_access",
      owner_type: access.ownerType,
      value: encodeBoolean(access.accessible),
    });
  }

  for (const definition of includedMetafields) {
    rows.push({
      record_type: "metafield_definition",
      owner_type: definition.ownerType,
      namespace: definition.namespace,
      key: definition.key,
      name: definition.name,
      type: definition.type,
      description: definition.description ?? "",
      source_id: definition.id ?? "",
      validations: encodeValidations(definition.validations),
    });
  }

  let metaobjectFieldCount = 0;

  for (const definition of includedMetaobjects) {
    rows.push({
      record_type: "metaobject_definition",
      metaobject_type: definition.type,
      name: definition.name,
      description: definition.description ?? "",
      display_name_key: definition.displayNameKey ?? "",
      admin_access: definition.access?.admin ?? "",
      storefront_access: definition.access?.storefront ?? "",
      publishable: encodeBoolean(
        definition.capabilities?.publishable?.enabled ?? false,
      ),
      source_id: definition.id ?? "",
    });

    for (const field of definition.fieldDefinitions) {
      metaobjectFieldCount += 1;
      rows.push({
        record_type: "metaobject_field",
        metaobject_type: definition.type,
        key: field.key,
        name: field.name,
        type: field.type,
        required: encodeBoolean(field.required),
        description: field.description ?? "",
        validations: encodeValidations(field.validations),
      });
    }
  }

  const { requiredMetaobjectTypes } = resolveMetaobjectDependencies({
    metafields: metafields.definitions,
    metaobjects: metaobjects.definitions,
    selectedMetafieldKeys,
    selectedMetaobjectTypes,
  });

  const warnings: string[] = [];

  if (requiredMetaobjectTypes.length > 0) {
    warnings.push(
      `Some selected definitions reference metaobject definitions that are not in this export: ${requiredMetaobjectTypes.join(
        ", ",
      )}. Those reference fields will fail on import unless you include them.`,
    );
  }

  return {
    csv: toCsv([headerRow(), ...rows.map(serializeRow)]),
    counts: {
      metafieldDefinitions: includedMetafields.length,
      metaobjectDefinitions: includedMetaobjects.length,
      metaobjectFields: metaobjectFieldCount,
    },
    warnings,
  };
}

export function buildDefinitionCsvFileName(shop: string, exportedAt: string) {
  const stamp = exportedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const slug = shop.replace(/\.myshopify\.com$/i, "").replace(/[^a-z0-9-]/gi, "-");
  return `easy-migrate-definitions-${slug}-${stamp}.csv`;
}
