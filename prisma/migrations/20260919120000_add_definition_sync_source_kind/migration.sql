-- Record where a definition sync job read its source definitions from:
-- a live source store ("store") or an uploaded definitions CSV ("csv").
ALTER TABLE "DefinitionSyncJob" ADD COLUMN "sourceKind" TEXT NOT NULL DEFAULT 'store';
ALTER TABLE "DefinitionSyncJob" ADD COLUMN "sourceFileName" TEXT;
