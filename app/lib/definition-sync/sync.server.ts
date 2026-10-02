import {
  compareMetafieldDefinitions,
  compareMetaobjectDefinitions,
} from "./compare.server";
import { syncMetaobjectContent } from "./content-sync.server";
import {
  createSyncJob,
  createSyncLog,
  getFailedSyncLogs,
  updateSyncJob,
} from "./logger.server";
import {
  METAOBJECT_REFERENCE_VALIDATION_NAMES,
  getReferencedMetaobjectTypes,
  hasMetaobjectReferenceValidation,
  parseMetaobjectDefinitionValidationValue,
} from "./metaobject-references.server";
import {
  getMetaobjectTypeLogicalKey,
  isAppReservedMetaobjectType,
} from "./metaobject-type.server";
import {
  createMetafieldDefinition,
  fetchMetafieldDefinitions,
  updateMetafieldDefinition,
} from "./metafield-definitions.server";
import {
  addMissingMetaobjectFields,
  createMetaobjectDefinition,
  fetchMetaobjectDefinitions,
  reconcileMetaobjectDefinition,
} from "./metaobject-definitions.server";
import {
  silentSyncProgress,
  type SyncProgressItem,
  type SyncProgressPhase,
  type SyncProgressReporter,
} from "./progress.server";
import { hasApplicableUpdates } from "./types.server";
import type {
  DefinitionScanPreview,
  DefinitionSourceKind,
  MetafieldDefinitionFetchResult,
  MetaobjectDefinitionFetchResult,
  MetaobjectDefinitionRecord,
  MetaobjectFieldDefinitionRecord,
  ValidationRule,
} from "./types.server";

type AdminGraphqlClient = Parameters<typeof fetchMetafieldDefinitions>[0]["admin"];

function buildSourceMetaobjectTypeById(preview: DefinitionScanPreview) {
  const sourceMetaobjectTypeById = new Map<string, string>();

  for (const definition of [
    ...preview.metaobjects.missing,
    ...preview.metaobjects.existing.map((item) => item.source),
  ]) {
    if (definition.id) {
      sourceMetaobjectTypeById.set(definition.id, definition.type);
    }
  }

  return sourceMetaobjectTypeById;
}

function buildTargetMetaobjectIdByType(
  definitions: MetaobjectDefinitionRecord[],
  existingTypes?: Map<string, string>,
) {
  const targetMetaobjectIdByType = new Map(existingTypes ?? []);

  for (const definition of definitions) {
    if (definition.id) {
      targetMetaobjectIdByType.set(definition.type, definition.id);
    }
  }

  return targetMetaobjectIdByType;
}

function buildTargetMetaobjectTypeBySourceType(
  preview: DefinitionScanPreview,
  targetDefinitions: MetaobjectDefinitionRecord[],
) {
  const targetAppReservedTypeByLogicalKey = new Map(
    targetDefinitions
      .filter((definition) => isAppReservedMetaobjectType(definition.type))
      .map((definition) => [
        getMetaobjectTypeLogicalKey(definition.type),
        definition.type,
      ]),
  );
  const targetTypeByExactType = new Map(
    targetDefinitions.map((definition) => [definition.type, definition.type]),
  );

  const targetTypeBySourceType = new Map<string, string>();

  for (const definition of [
    ...preview.metaobjects.missing,
    ...preview.metaobjects.existing.map((item) => item.source),
  ]) {
    const targetType = isAppReservedMetaobjectType(definition.type)
      ? targetAppReservedTypeByLogicalKey.get(
          getMetaobjectTypeLogicalKey(definition.type),
        )
      : targetTypeByExactType.get(definition.type);

    if (targetType) {
      targetTypeBySourceType.set(definition.type, targetType);
      if (isAppReservedMetaobjectType(definition.type)) {
        targetTypeBySourceType.set(
          getMetaobjectTypeLogicalKey(definition.type),
          targetType,
        );
      }
    }
  }

  return targetTypeBySourceType;
}

function remapMetaobjectReferenceValidations(
  validations: ValidationRule[],
  sourceMetaobjectTypeById: Map<string, string>,
  targetMetaobjectIdByType: Map<string, string>,
) {
  return validations.map((validation) => {
    if (!METAOBJECT_REFERENCE_VALIDATION_NAMES.has(validation.name)) {
      return validation;
    }

    const targetIds = parseMetaobjectDefinitionValidationValue(validation).map(
      (definitionId) => {
        const type = sourceMetaobjectTypeById.get(definitionId);

        if (!type) {
          throw new Error(
            `Couldn't match source metaobject definition ${definitionId} to a metaobject type.`,
          );
        }

        const targetId = targetMetaobjectIdByType.get(type);

        if (!targetId) {
          throw new Error(
            `Target metaobject definition for type ${type} is not available yet.`,
          );
        }

        return targetId;
      },
    );

    return {
      ...validation,
      value:
        validation.name === "metaobject_definition_id"
          ? targetIds[0] ?? null
          : JSON.stringify(targetIds),
    };
  });
}

function prepareMetaobjectField(
  field: MetaobjectFieldDefinitionRecord,
  sourceMetaobjectTypeById: Map<string, string>,
  targetMetaobjectIdByType: Map<string, string>,
): MetaobjectFieldDefinitionRecord {
  return {
    ...field,
    validations: remapMetaobjectReferenceValidations(
      field.validations,
      sourceMetaobjectTypeById,
      targetMetaobjectIdByType,
    ),
  };
}

function prepareMetaobjectDefinition(
  definition: MetaobjectDefinitionRecord,
  fields: MetaobjectFieldDefinitionRecord[],
  sourceMetaobjectTypeById: Map<string, string>,
  targetMetaobjectIdByType: Map<string, string>,
): MetaobjectDefinitionRecord {
  const includedFieldKeys = new Set(fields.map((field) => field.key));

  return {
    ...definition,
    displayNameKey:
      definition.displayNameKey && includedFieldKeys.has(definition.displayNameKey)
        ? definition.displayNameKey
        : null,
    fieldDefinitions: fields.map((field) =>
      prepareMetaobjectField(
        field,
        sourceMetaobjectTypeById,
        targetMetaobjectIdByType,
      ),
    ),
  };
}

function partitionFieldsByResolvedDependencies(
  fields: MetaobjectFieldDefinitionRecord[],
  sourceMetaobjectTypeById: Map<string, string>,
  targetMetaobjectIdByType: Map<string, string>,
) {
  const ready: MetaobjectFieldDefinitionRecord[] = [];
  const blocked: Array<{
    field: MetaobjectFieldDefinitionRecord;
    missingTypes: string[];
  }> = [];

  for (const field of fields) {
    const missingTypes = getReferencedMetaobjectTypes(
      field.validations,
      sourceMetaobjectTypeById,
    ).filter((type) => !targetMetaobjectIdByType.has(type));

    if (missingTypes.length) {
      blocked.push({ field, missingTypes });
      continue;
    }

    ready.push(field);
  }

  return { ready, blocked };
}

async function syncMetaobjectsWithDependencies({
  admin,
  jobId,
  preview,
  progress,
}: {
  admin: NonNullable<AdminGraphqlClient>;
  jobId: string;
  preview: DefinitionScanPreview;
  progress: SyncProgressReporter;
}) {
  let createdMetaobjectDefinitions = 0;
  let addedMetaobjectFields = 0;
  let updatedMetaobjectDefinitions = 0;
  let updatedMetaobjectFields = 0;
  let failedCount = 0;

  const sourceMetaobjectDefinitions = [
    ...preview.metaobjects.missing,
    ...preview.metaobjects.existing.map((item) => item.source),
  ];
  const sourceMetaobjectTypeById = new Map<string, string>();
  for (const definition of sourceMetaobjectDefinitions) {
    if (definition.id) {
      sourceMetaobjectTypeById.set(definition.id, definition.type);
    }
  }

  const targetMetaobjectIdByType = new Map<string, string>();
  for (const item of preview.metaobjects.existing) {
    if (item.target?.id) {
      targetMetaobjectIdByType.set(item.type, item.target.id);
    }
  }

  const metaobjectNameByType = new Map(
    sourceMetaobjectDefinitions.map((definition) => [definition.type, definition.name]),
  );
  const metaobjectItem = (type: string): SyncProgressItem => ({
    kind: "metaobject",
    key: type,
    name: metaobjectNameByType.get(type) ?? type,
  });
  const fieldItem = (
    type: string,
    field: MetaobjectFieldDefinitionRecord,
  ): SyncProgressItem => ({
    kind: "metaobject_field",
    key: `${type}.${field.key}`,
    name: `${metaobjectNameByType.get(type) ?? type} › ${field.name}`,
  });
  // Existing metaobjects only count as done after their last step (field adds
  // and updates both run late), so remember how those went.
  const typesWithAddedFields = new Set<string>();
  const typesWithFailedFields = new Set<string>();

  const pendingFieldAdds = new Map<
    string,
    {
      definitionId: string;
      fields: MetaobjectFieldDefinitionRecord[];
      displayNameKey?: string | null;
    }
  >();

  for (const item of preview.metaobjects.existing) {
    await createSyncLog({
      jobId,
      itemType: "metaobject_definition",
      itemKey: item.type,
      status: "exists",
      message: "Metaobject definition already exists.",
    });

    for (const fieldConflict of item.fieldConflicts) {
      await createSyncLog({
        jobId,
        itemType: "metaobject_field",
        itemKey: fieldConflict.key,
        status: "conflict",
        message: fieldConflict.message,
      });
    }

    // Reported so the divergence is visible; never deleted.
    for (const extraField of item.extraFields) {
      await createSyncLog({
        jobId,
        itemType: "metaobject_field",
        itemKey: `${item.type}.${extraField.key}`,
        status: "skipped",
        message: "Exists in this store but not in the source. Left untouched.",
      });
    }

    if (item.missingFields.length && item.target?.id) {
      pendingFieldAdds.set(item.type, {
        definitionId: item.target.id,
        fields: [...item.missingFields],
        displayNameKey: item.source.displayNameKey,
      });
    }
  }

  const pendingDefinitions = new Map(
    preview.metaobjects.missing.map((definition) => [definition.type, definition]),
  );

  while (pendingDefinitions.size > 0) {
    let madeProgress = false;

    for (const [type, definition] of [...pendingDefinitions.entries()]) {
      const { ready, blocked } = partitionFieldsByResolvedDependencies(
        definition.fieldDefinitions,
        sourceMetaobjectTypeById,
        targetMetaobjectIdByType,
      );

      if (!ready.length && blocked.length) {
        continue;
      }

      progress.working({ ...metaobjectItem(type), action: "create" });

      try {
        const createdDefinition = await createMetaobjectDefinition(
          admin,
          prepareMetaobjectDefinition(
            definition,
            ready,
            sourceMetaobjectTypeById,
            targetMetaobjectIdByType,
          ),
        );

        createdMetaobjectDefinitions += 1;
        targetMetaobjectIdByType.set(type, createdDefinition.id);
        pendingDefinitions.delete(type);
        madeProgress = true;

        await createSyncLog({
          jobId,
          itemType: "metaobject_definition",
          itemKey: definition.type,
          status: "created",
          message:
            ready.length === definition.fieldDefinitions.length
              ? "Created missing metaobject definition."
              : "Created missing metaobject definition and deferred dependent reference fields.",
        });
        progress.record(metaobjectItem(type), "created", { tick: true });

        if (blocked.length) {
          pendingFieldAdds.set(type, {
            definitionId: createdDefinition.id,
            fields: blocked.map((item) => item.field),
            displayNameKey: definition.displayNameKey,
          });
        }
      } catch (error) {
        failedCount += 1;
        pendingDefinitions.delete(type);

        await createSyncLog({
          jobId,
          itemType: "metaobject_definition",
          itemKey: definition.type,
          status: "failed",
          message: error instanceof Error ? error.message : "Creation failed.",
        });
        progress.record(metaobjectItem(type), "failed", { tick: true });
      }
    }

    if (madeProgress) {
      continue;
    }

    for (const [type, definition] of [...pendingDefinitions.entries()]) {
      progress.working({ ...metaobjectItem(type), action: "create" });

      try {
        const createdDefinition = await createMetaobjectDefinition(
          admin,
          {
            ...definition,
            displayNameKey: null,
            fieldDefinitions: [],
          },
        );

        createdMetaobjectDefinitions += 1;
        targetMetaobjectIdByType.set(type, createdDefinition.id);
        pendingDefinitions.delete(type);
        madeProgress = true;

        await createSyncLog({
          jobId,
          itemType: "metaobject_definition",
          itemKey: definition.type,
          status: "created",
          message:
            "Created missing metaobject definition shell so dependent reference fields can be added later.",
        });
        progress.record(metaobjectItem(type), "created", { tick: true });

        pendingFieldAdds.set(type, {
          definitionId: createdDefinition.id,
          fields: [...definition.fieldDefinitions],
          displayNameKey: definition.displayNameKey,
        });
      } catch (error) {
        failedCount += 1;
        pendingDefinitions.delete(type);

        await createSyncLog({
          jobId,
          itemType: "metaobject_definition",
          itemKey: definition.type,
          status: "failed",
          message: error instanceof Error ? error.message : "Creation failed.",
        });
        progress.record(metaobjectItem(type), "failed", { tick: true });
      }
    }

    if (!madeProgress) {
      break;
    }
  }

  while (pendingFieldAdds.size > 0) {
    let madeProgress = false;

    for (const [type, pending] of [...pendingFieldAdds.entries()]) {
      const { ready, blocked } = partitionFieldsByResolvedDependencies(
        pending.fields,
        sourceMetaobjectTypeById,
        targetMetaobjectIdByType,
      );

      if (!ready.length) {
        continue;
      }

      progress.working({ ...metaobjectItem(type), action: "add_fields" });

      try {
        const displayNameKey =
          pending.displayNameKey &&
          ready.some((field) => field.key === pending.displayNameKey)
            ? pending.displayNameKey
            : null;

        await addMissingMetaobjectFields(
          admin,
          pending.definitionId,
          ready.map((field) =>
            prepareMetaobjectField(
              field,
              sourceMetaobjectTypeById,
              targetMetaobjectIdByType,
            ),
          ),
          displayNameKey,
        );

        addedMetaobjectFields += ready.length;
        madeProgress = true;
        typesWithAddedFields.add(type);

        for (const field of ready) {
          await createSyncLog({
            jobId,
            itemType: "metaobject_field",
            itemKey: `${type}.${field.key}`,
            status: "created",
            message: "Added missing metaobject field.",
          });
          progress.record(fieldItem(type, field), "created");
        }

        if (blocked.length) {
          pendingFieldAdds.set(type, {
            ...pending,
            fields: blocked.map((item) => item.field),
            displayNameKey:
              displayNameKey && pending.displayNameKey === displayNameKey
                ? null
                : pending.displayNameKey,
          });
        } else {
          pendingFieldAdds.delete(type);
        }
      } catch (error) {
        failedCount += ready.length;
        pendingFieldAdds.delete(type);
        typesWithFailedFields.add(type);

        for (const field of ready) {
          await createSyncLog({
            jobId,
            itemType: "metaobject_field",
            itemKey: `${type}.${field.key}`,
            status: "failed",
            message:
              error instanceof Error ? error.message : "Failed to add field.",
          });
          progress.record(fieldItem(type, field), "failed");
        }
      }
    }

    if (madeProgress) {
      continue;
    }

    for (const [type, pending] of pendingFieldAdds.entries()) {
      const unresolvedTypes = new Set(
        pending.fields.flatMap((field) =>
          getReferencedMetaobjectTypes(field.validations, sourceMetaobjectTypeById).filter(
            (referencedType) => !targetMetaobjectIdByType.has(referencedType),
          ),
        ),
      );

      failedCount += pending.fields.length;
      typesWithFailedFields.add(type);

      for (const field of pending.fields) {
        await createSyncLog({
          jobId,
          itemType: "metaobject_field",
          itemKey: `${type}.${field.key}`,
          status: "failed",
          message: unresolvedTypes.size
            ? `Referenced metaobject definitions are still missing in target: ${[
                ...unresolvedTypes,
              ].join(", ")}.`
            : "Failed to add field.",
        });
        progress.record(fieldItem(type, field), "failed");
      }
    }

    pendingFieldAdds.clear();
  }

  // Updates run last, once every definition exists and
  // `targetMetaobjectIdByType` can resolve any reference validations.
  for (const item of preview.metaobjects.existing) {
    const definitionId = item.target?.id;

    if (!definitionId || (!item.changedFields.length && !item.definitionChanges.length)) {
      progress.record(
        metaobjectItem(item.type),
        typesWithFailedFields.has(item.type)
          ? "failed"
          : typesWithAddedFields.has(item.type)
            ? "updated"
            : "exists",
        { tick: true },
      );
      continue;
    }

    const changedProperties = new Set(
      item.definitionChanges.map((change) => change.property),
    );

    progress.working({ ...metaobjectItem(item.type), action: "update" });

    try {
      await reconcileMetaobjectDefinition(admin, definitionId, {
        updateFields: item.changedFields.map((difference) =>
          prepareMetaobjectField(
            difference.source,
            sourceMetaobjectTypeById,
            targetMetaobjectIdByType,
          ),
        ),
        ...(changedProperties.has("name") ? { name: item.source.name } : {}),
        ...(changedProperties.has("description")
          ? { description: item.source.description ?? null }
          : {}),
        ...(changedProperties.has("displayNameKey")
          ? { displayNameKey: item.source.displayNameKey ?? null }
          : {}),
        ...(changedProperties.has("publishable")
          ? { publishable: item.source.capabilities?.publishable?.enabled ?? false }
          : {}),
      });

      updatedMetaobjectFields += item.changedFields.length;

      for (const difference of item.changedFields) {
        await createSyncLog({
          jobId,
          itemType: "metaobject_field",
          itemKey: difference.key,
          status: "updated",
          message: `Updated ${difference.changes
            .map((change) => change.property)
            .join(", ")} to match the source.`,
        });
      }

      if (changedProperties.size) {
        updatedMetaobjectDefinitions += 1;
        await createSyncLog({
          jobId,
          itemType: "metaobject_definition",
          itemKey: item.type,
          status: "updated",
          message: `Updated ${[...changedProperties].join(", ")} to match the source.`,
        });
      }

      progress.record(
        metaobjectItem(item.type),
        typesWithFailedFields.has(item.type) ? "failed" : "updated",
        { tick: true },
      );
    } catch (error) {
      failedCount += 1;
      await createSyncLog({
        jobId,
        itemType: "metaobject_definition",
        itemKey: item.type,
        status: "failed",
        message: `Couldn't apply updates: ${
          error instanceof Error ? error.message : "update failed."
        }`,
      });
      progress.record(metaobjectItem(item.type), "failed", { tick: true });
    }
  }

  return {
    createdMetaobjectDefinitions,
    addedMetaobjectFields,
    updatedMetaobjectDefinitions,
    updatedMetaobjectFields,
    failedCount,
    targetMetaobjectIdByType,
  };
}

export async function buildDefinitionScanPreview({
  sourceShop,
  sourceToken,
  targetShop,
  admin,
}: {
  sourceShop: string;
  sourceToken: string;
  targetShop: string;
  admin: NonNullable<AdminGraphqlClient>;
}): Promise<DefinitionScanPreview> {
  // Passed unawaited so the source and target reads still run concurrently.
  return buildDefinitionScanPreviewFromDefinitions({
    sourceShop,
    targetShop,
    admin,
    sourceMetafields: fetchMetafieldDefinitions({
      source: { shop: sourceShop, token: sourceToken },
    }),
    sourceMetaobjects: fetchMetaobjectDefinitions({
      source: { shop: sourceShop, token: sourceToken },
    }),
  });
}

/**
 * The comparison half of a scan, with the source side supplied rather than
 * fetched. The live token flow hands in in-flight fetches against the source
 * store; the CSV import hands in definitions parsed out of an uploaded file.
 */
export async function buildDefinitionScanPreviewFromDefinitions({
  sourceShop,
  targetShop,
  admin,
  sourceMetafields: sourceMetafieldsInput,
  sourceMetaobjects: sourceMetaobjectsInput,
  sourceKind = "store",
}: {
  sourceShop: string;
  targetShop: string;
  admin: NonNullable<AdminGraphqlClient>;
  sourceMetafields: MetafieldDefinitionFetchResult | Promise<MetafieldDefinitionFetchResult>;
  sourceMetaobjects:
    | MetaobjectDefinitionFetchResult
    | Promise<MetaobjectDefinitionFetchResult>;
  sourceKind?: DefinitionSourceKind;
}): Promise<DefinitionScanPreview> {
  const [
    sourceMetafields,
    targetMetafields,
    sourceMetaobjects,
    targetMetaobjects,
  ] = await Promise.all([
    Promise.resolve(sourceMetafieldsInput),
    fetchMetafieldDefinitions({ admin }),
    Promise.resolve(sourceMetaobjectsInput),
    fetchMetaobjectDefinitions({ admin }),
  ]);

  const sourceAccessibleOwnerTypes = new Set(
    sourceMetafields.ownerTypeAccess
      .filter((item) => item.accessible)
      .map((item) => item.ownerType),
  );
  const targetAccessibleOwnerTypes = new Set(
    targetMetafields.ownerTypeAccess
      .filter((item) => item.accessible)
      .map((item) => item.ownerType),
  );

  const comparableSourceMetafields = sourceMetafields.definitions.filter((definition) =>
    targetAccessibleOwnerTypes.has(definition.ownerType),
  );
  const comparableTargetMetafields = targetMetafields.definitions.filter((definition) =>
    sourceAccessibleOwnerTypes.has(definition.ownerType),
  );

  const metafieldComparison = compareMetafieldDefinitions(
    comparableSourceMetafields,
    comparableTargetMetafields,
  );
  const metaobjectComparison = compareMetaobjectDefinitions(
    sourceMetaobjects.definitions,
    targetMetaobjects.definitions,
  );

  const ownerTypeWarnings = [
    ...sourceMetafields.ownerTypeAccess
      .filter((item) => !item.accessible)
      .map((item) =>
        sourceKind === "csv"
          ? `The CSV contains no ${item.ownerType} metafield definitions because the store it was exported from couldn't read them.`
          : `Source token can't read ${item.ownerType} metafield definitions with the current source custom-app scopes.`,
      ),
    ...targetMetafields.ownerTypeAccess
      .filter((item) => !item.accessible)
      .map(
        (item) =>
          `Target app can't read or write ${item.ownerType} metafield definitions with the current installed app scopes.`,
      ),
  ];

  if (
    sourceMetafields.definitions.length > 0 ||
    targetMetafields.definitions.length > 0
  ) {
    ownerTypeWarnings.push(
      "Shopify won't expose app-owned metafield definitions that belong to a different app, even if they are visible in the Shopify admin.",
    );
  }

  const missingCountByOwnerType = new Map<string, number>();
  const existingCountByOwnerType = new Map<string, number>();
  const conflictCountByOwnerType = new Map<string, number>();

  for (const definition of metafieldComparison.missing) {
    missingCountByOwnerType.set(
      definition.ownerType,
      (missingCountByOwnerType.get(definition.ownerType) ?? 0) + 1,
    );
  }

  for (const definition of metafieldComparison.existing) {
    existingCountByOwnerType.set(
      definition.ownerType,
      (existingCountByOwnerType.get(definition.ownerType) ?? 0) + 1,
    );
  }

  for (const definition of metafieldComparison.conflicts) {
    conflictCountByOwnerType.set(
      definition.source.ownerType,
      (conflictCountByOwnerType.get(definition.source.ownerType) ?? 0) + 1,
    );
  }

  const sourceAccessByOwnerType = new Map(
    sourceMetafields.ownerTypeAccess.map((item) => [item.ownerType, item.accessible]),
  );
  const targetAccessByOwnerType = new Map(
    targetMetafields.ownerTypeAccess.map((item) => [item.ownerType, item.accessible]),
  );
  const ownerTypeStatus = [...new Set([
    ...sourceMetafields.ownerTypeAccess.map((item) => item.ownerType),
    ...targetMetafields.ownerTypeAccess.map((item) => item.ownerType),
  ])].map((ownerType) => ({
    ownerType,
    sourceAccessible: sourceAccessByOwnerType.get(ownerType) ?? false,
    targetAccessible: targetAccessByOwnerType.get(ownerType) ?? false,
    missingCount: missingCountByOwnerType.get(ownerType) ?? 0,
    existingCount: existingCountByOwnerType.get(ownerType) ?? 0,
    conflictCount: conflictCountByOwnerType.get(ownerType) ?? 0,
  }));

  return {
    sourceShop,
    targetShop,
    summary: {
      totalSourceMetafieldDefinitions: comparableSourceMetafields.length,
      totalTargetMetafieldDefinitions: comparableTargetMetafields.length,
      missingMetafieldDefinitions: metafieldComparison.missing.length,
      existingMetafieldDefinitions: metafieldComparison.existing.length,
      conflictingMetafieldDefinitions: metafieldComparison.conflicts.length,
      totalSourceMetaobjectDefinitions: sourceMetaobjects.definitions.length,
      totalTargetMetaobjectDefinitions: targetMetaobjects.definitions.length,
      missingMetaobjectDefinitions: metaobjectComparison.missing.length,
      existingMetaobjectDefinitions: metaobjectComparison.existing.length,
      missingMetaobjectFields: metaobjectComparison.existing.reduce(
        (total, item) => total + item.missingFields.length,
        0,
      ),
      conflictingMetaobjectFields: metaobjectComparison.existing.reduce(
        (total, item) => total + item.fieldConflicts.length,
        0,
      ),
      changedMetafieldDefinitions: metafieldComparison.changed.length,
      changedMetaobjectFields: metaobjectComparison.existing.reduce(
        (total, item) => total + item.changedFields.length,
        0,
      ),
      updatableMetaobjectDefinitions: metaobjectComparison.existing.filter(
        hasApplicableUpdates,
      ).length,
      extraMetaobjectFields: metaobjectComparison.existing.reduce(
        (total, item) => total + item.extraFields.length,
        0,
      ),
    },
    metafields: metafieldComparison,
    metaobjects: metaobjectComparison,
    ownerTypeStatus,
    ownerTypeWarnings,
  };
}

export async function runDefinitionSync({
  sourceShop,
  sourceToken,
  targetShop,
  admin,
  selectedMetaobjectTypes,
  selectedMetafieldKeys,
  copyContent = false,
  progress = silentSyncProgress,
}: {
  sourceShop: string;
  sourceToken: string;
  targetShop: string;
  admin: NonNullable<AdminGraphqlClient>;
  selectedMetaobjectTypes?: string[];
  selectedMetafieldKeys?: string[];
  copyContent?: boolean;
  progress?: SyncProgressReporter;
}) {
  const preview = await buildDefinitionScanPreview({
    sourceShop,
    sourceToken,
    targetShop,
    admin,
  });

  return runDefinitionSyncFromPreview({
    preview,
    sourceShop,
    sourceToken,
    targetShop,
    admin,
    selectedMetaobjectTypes,
    selectedMetafieldKeys,
    copyContent,
    progress,
  });
}

/**
 * Applies a scan preview to the destination store. Split out of
 * `runDefinitionSync` so the CSV import can reuse the whole engine —
 * dependency ordering, deferred reference fields and retries included — with a
 * preview built from a file instead of a live source store.
 */
export async function runDefinitionSyncFromPreview({
  preview,
  sourceShop,
  sourceToken,
  targetShop,
  admin,
  selectedMetaobjectTypes,
  selectedMetafieldKeys,
  copyContent = false,
  sourceKind = "store",
  sourceFileName,
  progress = silentSyncProgress,
}: {
  preview: DefinitionScanPreview;
  sourceShop: string;
  sourceToken?: string;
  targetShop: string;
  admin: NonNullable<AdminGraphqlClient>;
  selectedMetaobjectTypes?: string[];
  selectedMetafieldKeys?: string[];
  copyContent?: boolean;
  sourceKind?: DefinitionSourceKind;
  sourceFileName?: string | null;
  /** Live progress for the page; see progress.server.ts. */
  progress?: SyncProgressReporter;
}) {
  if (copyContent && !sourceToken) {
    throw new Error(
      "Copying metaobject entries needs a live source store connection. A definitions CSV carries no entry values.",
    );
  }

  const selectedMetaobjectTypeSet = new Set(selectedMetaobjectTypes ?? []);
  const selectedMetafieldKeySet = new Set(selectedMetafieldKeys ?? []);
  const hasAnySelections =
    selectedMetaobjectTypeSet.size > 0 || selectedMetafieldKeySet.size > 0;
  const shouldIncludeMetaobjects = selectedMetaobjectTypeSet.size > 0;
  const shouldIncludeMetafields = selectedMetafieldKeySet.size > 0;

  const filteredPreview: DefinitionScanPreview = {
    ...preview,
    summary: {
      ...preview.summary,
      totalSourceMetafieldDefinitions: hasAnySelections
        ? preview.metafields.missing.filter((definition) =>
            selectedMetafieldKeySet.has(
              `${definition.ownerType}:${definition.namespace}:${definition.key}`,
            ),
          ).length
        : preview.summary.totalSourceMetafieldDefinitions,
      missingMetafieldDefinitions: hasAnySelections
        ? preview.metafields.missing.filter((definition) =>
            selectedMetafieldKeySet.has(
              `${definition.ownerType}:${definition.namespace}:${definition.key}`,
            ),
          ).length
        : preview.summary.missingMetafieldDefinitions,
      totalSourceMetaobjectDefinitions: hasAnySelections
        ? preview.metaobjects.missing.filter((definition) =>
            selectedMetaobjectTypeSet.has(definition.type),
          ).length
        : preview.summary.totalSourceMetaobjectDefinitions,
      missingMetaobjectDefinitions: hasAnySelections
        ? preview.metaobjects.missing.filter((definition) =>
            selectedMetaobjectTypeSet.has(definition.type),
          ).length
        : preview.summary.missingMetaobjectDefinitions,
    },
    metafields: {
      ...preview.metafields,
      missing: hasAnySelections
        ? preview.metafields.missing.filter((definition) =>
            selectedMetafieldKeySet.has(
              `${definition.ownerType}:${definition.namespace}:${definition.key}`,
            ),
          )
        : preview.metafields.missing,
      existing: hasAnySelections
        ? preview.metafields.existing.filter((definition) =>
            selectedMetafieldKeySet.has(
              `${definition.ownerType}:${definition.namespace}:${definition.key}`,
            ),
          )
        : preview.metafields.existing,
      changed: hasAnySelections
        ? preview.metafields.changed.filter((difference) =>
            selectedMetafieldKeySet.has(difference.key),
          )
        : preview.metafields.changed,
      conflicts: hasAnySelections
        ? preview.metafields.conflicts.filter((conflict) =>
            selectedMetafieldKeySet.has(conflict.key),
          )
        : preview.metafields.conflicts,
    },
    metaobjects: {
      ...preview.metaobjects,
      missing: hasAnySelections
        ? preview.metaobjects.missing.filter((definition) =>
            selectedMetaobjectTypeSet.has(definition.type),
          )
        : preview.metaobjects.missing,
      existing: hasAnySelections
        ? preview.metaobjects.existing.filter((item) =>
            selectedMetaobjectTypeSet.has(item.type),
          )
        : preview.metaobjects.existing,
      conflicts: hasAnySelections
        ? preview.metaobjects.conflicts.filter((item) =>
            selectedMetaobjectTypeSet.has(item.type),
          )
        : preview.metaobjects.conflicts,
    },
  };

  // One unit per selected definition. Each ticks once, when its main step
  // ends, so the bar never runs past the end or goes backwards.
  const metafieldKey = (definition: {
    ownerType: string;
    namespace: string;
    key: string;
  }) => `${definition.ownerType}:${definition.namespace}:${definition.key}`;
  const metaobjectUnitTypes = new Set([
    ...filteredPreview.metaobjects.missing.map((definition) => definition.type),
    ...filteredPreview.metaobjects.existing.map((item) => item.type),
  ]);
  const metafieldUnitKeys = new Set([
    ...filteredPreview.metafields.missing.map(metafieldKey),
    ...filteredPreview.metafields.existing.map(metafieldKey),
    ...filteredPreview.metafields.conflicts.map((conflict) => conflict.key),
  ]);
  const contentTypeCount = copyContent ? metaobjectUnitTypes.size : 0;
  const phases: SyncProgressPhase[] = ["preparing"];
  if (metaobjectUnitTypes.size) phases.push("metaobjects");
  if (metafieldUnitKeys.size) phases.push("metafields");
  if (contentTypeCount) phases.push("content");

  progress.plan({
    total: metaobjectUnitTypes.size + metafieldUnitKeys.size,
    contentTotal: contentTypeCount,
    phases,
  });

  const metafieldItem = (definition: {
    ownerType: string;
    namespace: string;
    key: string;
    name: string;
  }): SyncProgressItem => ({
    kind: "metafield",
    key: metafieldKey(definition),
    name: definition.name,
  });

  const job = await createSyncJob({
    sourceShop,
    targetShop,
    status: "syncing",
    sourceKind,
    sourceFileName,
  });

  let createdMetafieldDefinitions = 0;
  let createdMetaobjectDefinitions = 0;
  let addedMetaobjectFields = 0;
  let updatedMetafieldDefinitions = 0;
  let updatedMetaobjectDefinitions = 0;
  let updatedMetaobjectFields = 0;
  let copiedMetaobjectEntries = 0;
  let skippedMetaobjectEntries = 0;
  let failedMetaobjectEntries = 0;
  const conflictCount =
    preview.summary.conflictingMetafieldDefinitions +
    preview.summary.conflictingMetaobjectFields;
  let failedCount = 0;

  await updateSyncJob(job.id, {
    totalMetafieldDefinitions: filteredPreview.summary.totalSourceMetafieldDefinitions,
    totalMetaobjectDefinitions: filteredPreview.summary.totalSourceMetaobjectDefinitions,
    existingMetafieldDefinitions: filteredPreview.summary.existingMetafieldDefinitions,
    existingMetaobjectDefinitions: filteredPreview.summary.existingMetaobjectDefinitions,
    missingMetafieldDefinitions: filteredPreview.summary.missingMetafieldDefinitions,
    missingMetaobjectDefinitions: filteredPreview.summary.missingMetaobjectDefinitions,
    conflictCount,
  });

  try {
    for (const warning of preview.ownerTypeWarnings) {
      await createSyncLog({
        jobId: job.id,
        itemType: "metafield_definition",
        itemKey: "scope-warning",
        status: "skipped",
        message: warning,
      });
    }

    if (metaobjectUnitTypes.size) {
      progress.phase("metaobjects");
    }

    const {
      createdMetaobjectDefinitions: createdMetaobjectCount,
      addedMetaobjectFields: addedMetaobjectFieldCount,
      updatedMetaobjectDefinitions: updatedMetaobjectCount,
      updatedMetaobjectFields: updatedMetaobjectFieldCount,
      failedCount: metaobjectFailedCount,
      targetMetaobjectIdByType: syncedTargetMetaobjectIdByType,
    } = await syncMetaobjectsWithDependencies({
      admin,
      jobId: job.id,
      preview: filteredPreview,
      progress,
    });

    createdMetaobjectDefinitions += createdMetaobjectCount;
    addedMetaobjectFields += addedMetaobjectFieldCount;
    updatedMetaobjectDefinitions += updatedMetaobjectCount;
    updatedMetaobjectFields += updatedMetaobjectFieldCount;
    failedCount += metaobjectFailedCount;

    if (metafieldUnitKeys.size) {
      progress.phase("metafields");
    }

    const refreshedTargetMetaobjects = await fetchMetaobjectDefinitions({ admin });
    let targetMetaobjectIdByType = buildTargetMetaobjectIdByType(
      refreshedTargetMetaobjects.definitions,
      syncedTargetMetaobjectIdByType,
    );

    const metafieldChangesByKey = new Map(
      filteredPreview.metafields.changed.map((difference) => [
        difference.key,
        difference,
      ]),
    );

    for (const definition of filteredPreview.metafields.existing) {
      const itemKey = `${definition.ownerType}:${definition.namespace}:${definition.key}`;
      const difference = metafieldChangesByKey.get(itemKey);

      if (!difference) {
        await createSyncLog({
          jobId: job.id,
          itemType: "metafield_definition",
          itemKey,
          status: "exists",
          message: "Definition already exists with the same type.",
        });
        progress.record(metafieldItem(definition), "exists", { tick: true });
        continue;
      }

      progress.working({ ...metafieldItem(definition), action: "update" });

      try {
        await updateMetafieldDefinition(admin, definition);
        updatedMetafieldDefinitions += 1;
        await createSyncLog({
          jobId: job.id,
          itemType: "metafield_definition",
          itemKey,
          status: "updated",
          message: `Updated ${difference.changes
            .map((change) => change.property)
            .join(", ")} to match the source.`,
        });
        progress.record(metafieldItem(definition), "updated", { tick: true });
      } catch (error) {
        failedCount += 1;
        await createSyncLog({
          jobId: job.id,
          itemType: "metafield_definition",
          itemKey,
          status: "failed",
          message: `Couldn't apply updates: ${
            error instanceof Error ? error.message : "update failed."
          }`,
        });
        progress.record(metafieldItem(definition), "failed", { tick: true });
      }
    }

    for (const conflict of filteredPreview.metafields.conflicts) {
      await createSyncLog({
        jobId: job.id,
        itemType: "metafield_definition",
        itemKey: conflict.key,
        status: "conflict",
        message: conflict.message,
      });
      progress.record(metafieldItem(conflict.source), "conflict", { tick: true });
    }

    const sourceMetaobjectTypeById = buildSourceMetaobjectTypeById(filteredPreview);
    const deferredMetafields: typeof filteredPreview.metafields.missing = [];

    for (const definition of filteredPreview.metafields.missing) {
      const itemKey = `${definition.ownerType}:${definition.namespace}:${definition.key}`;

      progress.working({ ...metafieldItem(definition), action: "create" });

      try {
        const preparedDefinition = {
          ...definition,
          validations: remapMetaobjectReferenceValidations(
            definition.validations,
            sourceMetaobjectTypeById,
            targetMetaobjectIdByType,
          ),
        };

        await createMetafieldDefinition(admin, preparedDefinition);
        createdMetafieldDefinitions += 1;
        await createSyncLog({
          jobId: job.id,
          itemType: "metafield_definition",
          itemKey,
          status: "created",
          message: "Created missing metafield definition.",
        });
        progress.record(metafieldItem(definition), "created", { tick: true });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Creation failed.";

        if (hasMetaobjectReferenceValidation(definition.validations)) {
          deferredMetafields.push(definition);
          await createSyncLog({
            jobId: job.id,
            itemType: "metafield_definition",
            itemKey,
            status: "skipped",
            message: `Deferred metafield definition for one retry after metaobject sync settles. Original error: ${message}`,
          });
          continue;
        }

        failedCount += 1;
        await createSyncLog({
          jobId: job.id,
          itemType: "metafield_definition",
          itemKey,
          status: "failed",
          message,
        });
        progress.record(metafieldItem(definition), "failed", { tick: true });
      }
    }

    if (deferredMetafields.length) {
      const retryTargetMetaobjects = await fetchMetaobjectDefinitions({ admin });
      targetMetaobjectIdByType = buildTargetMetaobjectIdByType(
        retryTargetMetaobjects.definitions,
        targetMetaobjectIdByType,
      );

      for (const definition of deferredMetafields) {
        const itemKey = `${definition.ownerType}:${definition.namespace}:${definition.key}`;

        progress.working({ ...metafieldItem(definition), action: "retry" });

        try {
          const preparedDefinition = {
            ...definition,
            validations: remapMetaobjectReferenceValidations(
              definition.validations,
              sourceMetaobjectTypeById,
              targetMetaobjectIdByType,
            ),
          };

          await createMetafieldDefinition(admin, preparedDefinition);
          createdMetafieldDefinitions += 1;
          await createSyncLog({
            jobId: job.id,
            itemType: "metafield_definition",
            itemKey,
            status: "created",
            message: "Created missing metafield definition after retry.",
          });
          progress.record(metafieldItem(definition), "created", { tick: true });
        } catch (error) {
          failedCount += 1;
          await createSyncLog({
            jobId: job.id,
            itemType: "metafield_definition",
            itemKey,
            status: "failed",
            message:
              error instanceof Error ? error.message : "Creation failed.",
          });
          progress.record(metafieldItem(definition), "failed", { tick: true });
        }
      }
    }

    if (copyContent) {
      const allMetaobjectTypes = [
        ...filteredPreview.metaobjects.missing.map((d) => d.type),
        ...filteredPreview.metaobjects.existing.map((d) => d.type),
      ];

      if (allMetaobjectTypes.length > 0) {
        const targetTypeBySourceType = buildTargetMetaobjectTypeBySourceType(
          filteredPreview,
          refreshedTargetMetaobjects.definitions,
        );

        progress.phase("content");

        const contentResult = await syncMetaobjectContent({
          sourceShop,
          // Guarded at the top of this function: copyContent requires a token.
          sourceToken: sourceToken as string,
          admin,
          jobId: job.id,
          metaobjectTypes: allMetaobjectTypes,
          targetTypeBySourceType,
          progress,
          metaobjectNameByType: new Map(
            [
              ...filteredPreview.metaobjects.missing,
              ...filteredPreview.metaobjects.existing.map((item) => item.source),
            ].map((definition) => [definition.type, definition.name]),
          ),
        });

        copiedMetaobjectEntries = contentResult.copiedEntries;
        skippedMetaobjectEntries = contentResult.skippedEntries;
        failedMetaobjectEntries = contentResult.failedEntries;
        failedCount += contentResult.failedEntries;
      }
    }

  } catch (error) {
    await updateSyncJob(job.id, {
      status: "failed",
      createdMetafieldDefinitions,
      createdMetaobjectDefinitions,
      addedMetaobjectFields,
      conflictCount,
      failedCount,
      errorMessage: error instanceof Error ? error.message : "Sync failed.",
    });
    throw error;
  }

  const status = failedCount > 0 ? "completed_with_errors" : "completed";

  // Shopify has already been changed by this point. Recording the run is
  // bookkeeping: if it fails, say so, but never report it as a failed import —
  // that would send someone off to re-run work that actually succeeded.
  let recordingError: string | null = null;
  let failures: Awaited<ReturnType<typeof getFailedSyncLogs>> = [];

  try {
    await updateSyncJob(job.id, {
      status,
      createdMetafieldDefinitions,
      createdMetaobjectDefinitions,
      addedMetaobjectFields,
      updatedMetafieldDefinitions,
      updatedMetaobjectDefinitions,
      updatedMetaobjectFields,
      copiedMetaobjectEntries,
      skippedMetaobjectEntries,
      failedMetaobjectEntries,
      conflictCount,
      failedCount,
    });

    failures = await getFailedSyncLogs(job.id);
  } catch (error) {
    recordingError =
      error instanceof Error ? error.message : "Couldn't record this run.";
  }

  // The outcome travels back with the job id: individual items fail without
  // throwing, so a caller that only sees a job id cannot tell a clean run
  // from one where every definition failed.
  return {
    jobId: job.id,
    preview: filteredPreview,
    status,
    createdMetafieldDefinitions,
    createdMetaobjectDefinitions,
    addedMetaobjectFields,
    updatedMetafieldDefinitions,
    updatedMetaobjectDefinitions,
    updatedMetaobjectFields,
    copiedMetaobjectEntries,
    skippedMetaobjectEntries,
    failedMetaobjectEntries,
    conflictCount,
    failedCount,
    failures,
    recordingError,
  };
}
