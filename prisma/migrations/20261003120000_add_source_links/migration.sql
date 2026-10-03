-- CreateTable
CREATE TABLE "SourceLink" (
    "targetShop" TEXT NOT NULL PRIMARY KEY,
    "sourceShop" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ConnectionCode" (
    "code" TEXT NOT NULL PRIMARY KEY,
    "sourceShop" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "SourceLink_sourceShop_idx" ON "SourceLink"("sourceShop");

-- CreateIndex
CREATE INDEX "ConnectionCode_sourceShop_idx" ON "ConnectionCode"("sourceShop");
