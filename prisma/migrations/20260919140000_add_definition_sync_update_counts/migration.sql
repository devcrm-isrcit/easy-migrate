-- Counts for definitions updated in place (as opposed to created) when an
-- import reconciles an existing definition with the source.
ALTER TABLE "DefinitionSyncJob" ADD COLUMN "updatedMetafieldDefinitions" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DefinitionSyncJob" ADD COLUMN "updatedMetaobjectDefinitions" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DefinitionSyncJob" ADD COLUMN "updatedMetaobjectFields" INTEGER NOT NULL DEFAULT 0;
