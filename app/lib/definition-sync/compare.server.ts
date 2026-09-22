import type {
  DefinitionScanPreview,
  MetafieldConflict,
  MetafieldDefinitionRecord,
  MetafieldDifference,
  MetaobjectComparisonItem,
  MetaobjectDefinitionRecord,
  MetaobjectFieldDefinitionRecord,
  MetaobjectFieldDifference,
  PropertyDifference,
  ValidationRule,
} from "./types.server";
import {
  getMetaobjectTypeLogicalKey,
  isAppReservedMetaobjectType,
} from "./metaobject-type.server";

function metafieldIdentifier(definition: MetafieldDefinitionRecord) {
  return `${definition.ownerType}:${definition.namespace}:${definition.key}`;
}

function metaobjectFieldIdentifier(metaobjectType: string, fieldKey: string) {
  return `${metaobjectType}.${fieldKey}`;
}

/** Null and "" mean the same thing to Shopify; whitespace is significant. */
function text(value: string | null | undefined) {
  return value ?? "";
}

/**
 * Validations compare by name and value only. Order is not meaningful, and the
 * internal `type` field never leaves this app.
 */
function canonicalValidations(validations: ValidationRule[]) {
  return JSON.stringify(
    [...validations]
      .map((validation) => [validation.name, text(validation.value)])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
}

function diffProperty(
  property: string,
  sourceValue: string,
  targetValue: string,
): PropertyDifference | null {
  return sourceValue === targetValue
    ? null
    : { property, sourceValue, targetValue };
}

function diffMetaobjectField(
  source: MetaobjectFieldDefinitionRecord,
  target: MetaobjectFieldDefinitionRecord,
): PropertyDifference[] {
  return [
    diffProperty("name", source.name, target.name),
    diffProperty("description", text(source.description), text(target.description)),
    diffProperty("required", String(source.required), String(target.required)),
    diffProperty(
      "validations",
      canonicalValidations(source.validations),
      canonicalValidations(target.validations),
    ),
  ].filter((change): change is PropertyDifference => change !== null);
}

function diffMetaobjectDefinition(
  source: MetaobjectDefinitionRecord,
  target: MetaobjectDefinitionRecord,
): PropertyDifference[] {
  return [
    diffProperty("name", source.name, target.name),
    diffProperty("description", text(source.description), text(target.description)),
    diffProperty(
      "displayNameKey",
      text(source.displayNameKey),
      text(target.displayNameKey),
    ),
    diffProperty(
      "publishable",
      String(source.capabilities?.publishable?.enabled ?? false),
      String(target.capabilities?.publishable?.enabled ?? false),
    ),
  ].filter((change): change is PropertyDifference => change !== null);
}

function diffMetafieldDefinition(
  source: MetafieldDefinitionRecord,
  target: MetafieldDefinitionRecord,
): PropertyDifference[] {
  return [
    diffProperty("name", source.name, target.name),
    diffProperty("description", text(source.description), text(target.description)),
    diffProperty(
      "validations",
      canonicalValidations(source.validations),
      canonicalValidations(target.validations),
    ),
  ].filter((change): change is PropertyDifference => change !== null);
}

export function compareMetafieldDefinitions(
  sourceDefinitions: MetafieldDefinitionRecord[],
  targetDefinitions: MetafieldDefinitionRecord[],
) {
  const targetByIdentifier = new Map(
    targetDefinitions.map((definition) => [
      metafieldIdentifier(definition),
      definition,
    ]),
  );

  const missing: MetafieldDefinitionRecord[] = [];
  const existing: MetafieldDefinitionRecord[] = [];
  const changed: MetafieldDifference[] = [];
  const conflicts: MetafieldConflict[] = [];

  for (const sourceDefinition of sourceDefinitions) {
    const targetDefinition = targetByIdentifier.get(
      metafieldIdentifier(sourceDefinition),
    );

    if (!targetDefinition) {
      missing.push(sourceDefinition);
      continue;
    }

    if (targetDefinition.type !== sourceDefinition.type) {
      conflicts.push({
        key: metafieldIdentifier(sourceDefinition),
        source: sourceDefinition,
        target: targetDefinition,
        message: `Type mismatch: source is ${sourceDefinition.type}, target is ${targetDefinition.type}.`,
      });
      continue;
    }

    existing.push(sourceDefinition);

    const propertyChanges = diffMetafieldDefinition(
      sourceDefinition,
      targetDefinition,
    );

    if (propertyChanges.length) {
      changed.push({
        key: metafieldIdentifier(sourceDefinition),
        source: sourceDefinition,
        target: targetDefinition,
        changes: propertyChanges,
      });
    }
  }

  return { missing, existing, changed, conflicts };
}

export function compareMetaobjectDefinitions(
  sourceDefinitions: MetaobjectDefinitionRecord[],
  targetDefinitions: MetaobjectDefinitionRecord[],
) {
  const targetAppReservedByLogicalType = new Map(
    targetDefinitions
      .filter((definition) => isAppReservedMetaobjectType(definition.type))
      .map((definition) => [getMetaobjectTypeLogicalKey(definition.type), definition]),
  );
  const targetByExactType = new Map(
    targetDefinitions.map((definition) => [definition.type, definition]),
  );

  const missing: MetaobjectDefinitionRecord[] = [];
  const existing: MetaobjectComparisonItem[] = [];
  const conflicts: MetaobjectComparisonItem[] = [];

  for (const sourceDefinition of sourceDefinitions) {
    const targetDefinition = isAppReservedMetaobjectType(sourceDefinition.type)
      ? targetAppReservedByLogicalType.get(
          getMetaobjectTypeLogicalKey(sourceDefinition.type),
        )
      : targetByExactType.get(sourceDefinition.type);

    if (!targetDefinition) {
      missing.push(sourceDefinition);
      continue;
    }

    const targetFields = new Map(
      targetDefinition.fieldDefinitions.map((field) => [field.key, field]),
    );

    const missingFields = [];
    const fieldConflicts = [];
    const changedFields: MetaobjectFieldDifference[] = [];

    for (const sourceField of sourceDefinition.fieldDefinitions) {
      const targetField = targetFields.get(sourceField.key);

      if (!targetField) {
        missingFields.push(sourceField);
        continue;
      }

      if (targetField.type !== sourceField.type) {
        fieldConflicts.push({
          key: metaobjectFieldIdentifier(sourceDefinition.type, sourceField.key),
          source: sourceField,
          target: targetField,
          message: `Field type mismatch: source is ${sourceField.type}, target is ${targetField.type}.`,
        });
        continue;
      }

      const propertyChanges = diffMetaobjectField(sourceField, targetField);

      if (propertyChanges.length) {
        changedFields.push({
          key: metaobjectFieldIdentifier(sourceDefinition.type, sourceField.key),
          fieldKey: sourceField.key,
          source: sourceField,
          target: targetField,
          changes: propertyChanges,
        });
      }
    }

    const sourceFieldKeys = new Set(
      sourceDefinition.fieldDefinitions.map((field) => field.key),
    );
    const extraFields = targetDefinition.fieldDefinitions.filter(
      (field) => !sourceFieldKeys.has(field.key),
    );

    const item = {
      type: sourceDefinition.type,
      source: sourceDefinition,
      target: targetDefinition,
      missingFields,
      fieldConflicts,
      changedFields,
      extraFields,
      definitionChanges: diffMetaobjectDefinition(sourceDefinition, targetDefinition),
    };

    existing.push(item);

    if (fieldConflicts.length > 0) {
      conflicts.push(item);
    }
  }

  return { missing, existing, conflicts };
}

export function detectMissingDefinitions(preview: DefinitionScanPreview) {
  return {
    metafields: preview.metafields.missing,
    metaobjects: preview.metaobjects.missing,
    metaobjectFields: preview.metaobjects.existing.flatMap((item) =>
      item.missingFields.map((field) => ({
        metaobjectType: item.type,
        field,
      })),
    ),
  };
}

export function detectConflicts(preview: DefinitionScanPreview) {
  return {
    metafields: preview.metafields.conflicts,
    metaobjects: preview.metaobjects.conflicts,
  };
}
