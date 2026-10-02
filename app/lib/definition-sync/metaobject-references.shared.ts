import type { DefinitionScanPreview, ValidationRule } from "./types.shared";

/**
 * Metaobject reference validations store raw Shopify GIDs, which are only
 * meaningful inside the store that issued them. Every path that moves a
 * definition between stores — the live token sync and the CSV import — has to
 * translate them, so the primitives live here and are shared.
 */
export const METAOBJECT_REFERENCE_VALIDATION_NAMES = new Set([
  "metaobject_definition_id",
  "metaobject_definition_ids",
]);

export function parseMetaobjectDefinitionValidationValue(validation: ValidationRule) {
  if (!validation.value) {
    return [];
  }

  if (validation.name === "metaobject_definition_id") {
    return [validation.value];
  }

  if (validation.name === "metaobject_definition_ids") {
    try {
      const parsed = JSON.parse(validation.value);
      return Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string")
        : [];
    } catch {
      return [];
    }
  }

  return [];
}

export function getReferencedMetaobjectTypes(
  validations: ValidationRule[],
  sourceMetaobjectTypeById: Map<string, string>,
) {
  const referencedTypes = new Set<string>();

  for (const validation of validations) {
    if (!METAOBJECT_REFERENCE_VALIDATION_NAMES.has(validation.name)) {
      continue;
    }

    for (const definitionId of parseMetaobjectDefinitionValidationValue(validation)) {
      const type = sourceMetaobjectTypeById.get(definitionId);
      if (type) {
        referencedTypes.add(type);
      }
    }
  }

  return [...referencedTypes];
}

export function hasMetaobjectReferenceValidation(validations: ValidationRule[]) {
  return validations.some((validation) =>
    METAOBJECT_REFERENCE_VALIDATION_NAMES.has(validation.name),
  );
}

/**
 * Metaobject types that the selection points at (directly or through other
 * selected metaobjects) which are missing from the destination store and are
 * not selected themselves. Their reference fields fail to sync until they are
 * included. Types the destination already has are fine: references to them
 * are remapped.
 */
export function findMissingReferencedMetaobjectTypes({
  preview,
  selectedMetaobjectTypes,
  selectedMetafieldKeys,
}: {
  preview: DefinitionScanPreview;
  selectedMetaobjectTypes: string[];
  selectedMetafieldKeys: string[];
}) {
  const sourceMetaobjectTypeById = new Map<string, string>();
  for (const definition of [
    ...preview.metaobjects.missing,
    ...preview.metaobjects.existing.map((item) => item.source),
  ]) {
    if (definition.id) {
      sourceMetaobjectTypeById.set(definition.id, definition.type);
    }
  }

  const missingMetaobjectByType = new Map(
    preview.metaobjects.missing.map((definition) => [definition.type, definition]),
  );
  const selectedTypes = new Set(selectedMetaobjectTypes);
  const selectedKeys = new Set(selectedMetafieldKeys);

  const queue = [
    ...preview.metafields.missing
      .filter((definition) =>
        selectedKeys.has(
          `${definition.ownerType}:${definition.namespace}:${definition.key}`,
        ),
      )
      .flatMap((definition) =>
        getReferencedMetaobjectTypes(definition.validations, sourceMetaobjectTypeById),
      ),
    ...selectedMetaobjectTypes,
  ];
  const visited = new Set<string>();
  const required = new Set<string>();

  while (queue.length > 0) {
    const type = queue.shift() as string;

    if (visited.has(type)) {
      continue;
    }

    visited.add(type);

    const definition = missingMetaobjectByType.get(type);
    if (!definition) {
      continue;
    }

    if (!selectedTypes.has(type)) {
      required.add(type);
    }

    queue.push(
      ...definition.fieldDefinitions.flatMap((field) =>
        getReferencedMetaobjectTypes(field.validations, sourceMetaobjectTypeById),
      ),
    );
  }

  return [...required];
}
