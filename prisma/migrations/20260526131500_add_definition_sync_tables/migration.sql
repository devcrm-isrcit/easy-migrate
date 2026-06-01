-- CreateTable
CREATE TABLE "SourceStoreCredential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetShop" TEXT NOT NULL,
    "sourceShop" TEXT NOT NULL,
    "encryptedToken" TEXT NOT NULL,
    "tokenStatus" TEXT NOT NULL DEFAULT 'unchecked',
    "lastValidatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DefinitionSyncJob" (
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
    "conflictCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "DefinitionSyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "itemType" TEXT NOT NULL,
    "itemKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DefinitionSyncLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "DefinitionSyncJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "SourceStoreCredential_targetShop_key" ON "SourceStoreCredential"("targetShop");

-- CreateIndex
CREATE INDEX "DefinitionSyncLog_jobId_createdAt_idx" ON "DefinitionSyncLog"("jobId", "createdAt");
