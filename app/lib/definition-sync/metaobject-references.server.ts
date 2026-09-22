import type { ValidationRule } from "./types.server";

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
