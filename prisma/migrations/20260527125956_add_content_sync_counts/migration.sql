-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DefinitionSyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceShop" TEXT NOT NULL,
    "targetShop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalMetafieldDefinitions" INTEGER NOT NULL DEFAULT 0,
    "totalMetaobjectDefinitions" INTEGER NOT NULL DEFAULT 0,
    "existingMetafieldDefinitions" INTEGER NOT NULL DEFAULT 0,
    "existingMetaobjectDefinitions" INTEGER NOT NULL DEFAULT 0,
    "missingMetafieldDefinitions" INTEGER NOT NULL DEFAULT 0,
    "missingMetaobjectDefinitions" INTEGER NOT NULL DEFAULT 0,
    "createdMetafieldDefinitions" INTEGER NOT NULL DEFAULT 0,
    "createdMetaobjectDefinitions" INTEGER NOT NULL DEFAULT 0,
    "addedMetaobjectFields" INTEGER NOT NULL DEFAULT 0,
    "copiedMetaobjectEntries" INTEGER NOT NULL DEFAULT 0,
    "skippedMetaobjectEntries" INTEGER NOT NULL DEFAULT 0,
    "failedMetaobjectEntries" INTEGER NOT NULL DEFAULT 0,
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_DefinitionSyncJob" ("addedMetaobjectFields", "conflictCount", "createdAt", "createdMetafieldDefinitions", "createdMetaobjectDefinitions", "errorMessage", "existingMetafieldDefinitions", "existingMetaobjectDefinitions", "failedCount", "id", "missingMetafieldDefinitions", "missingMetaobjectDefinitions", "sourceShop", "status", "targetShop", "totalMetafieldDefinitions", "totalMetaobjectDefinitions", "updatedAt") SELECT "addedMetaobjectFields", "conflictCount", "createdAt", "createdMetafieldDefinitions", "createdMetaobjectDefinitions", "errorMessage", "existingMetafieldDefinitions", "existingMetaobjectDefinitions", "failedCount", "id", "missingMetafieldDefinitions", "missingMetaobjectDefinitions", "sourceShop", "status", "targetShop", "totalMetafieldDefinitions", "totalMetaobjectDefinitions", "updatedAt" FROM "DefinitionSyncJob";
DROP TABLE "DefinitionSyncJob";
ALTER TABLE "new_DefinitionSyncJob" RENAME TO "DefinitionSyncJob";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
