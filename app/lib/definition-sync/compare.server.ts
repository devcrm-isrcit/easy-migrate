import type {
  DefinitionScanPreview,
  MetafieldConflict,
  MetafieldDefinitionRecord,
  MetaobjectComparisonItem,
  MetaobjectDefinitionRecord,
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
  }

  return { missing, existing, conflicts };
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
      }
    }

    const item = {
      type: sourceDefinition.type,
      source: sourceDefinition,
      target: targetDefinition,
      missingFields,
      fieldConflicts,
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
