CREATE TABLE "FileSyncJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceShop" TEXT NOT NULL,
    "targetShop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "totalSourceFiles" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "FileSyncLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FileSyncLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "FileSyncJob" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "StoreConnectionHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetShop" TEXT NOT NULL,
    "sourceShop" TEXT,
    "status" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "FileSyncLog_jobId_createdAt_idx" ON "FileSyncLog"("jobId", "createdAt");
CREATE INDEX "StoreConnectionHistory_targetShop_createdAt_idx" ON "StoreConnectionHistory"("targetShop", "createdAt");
