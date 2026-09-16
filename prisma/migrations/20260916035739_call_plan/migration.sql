-- CreateTable
CREATE TABLE "CallPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "planDate" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" DATETIME,
    "decidedAt" DATETIME,
    "decidedBy" TEXT,
    "note" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "CallPlanEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "planId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "e164" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL DEFAULT '',
    "gateAllowed" BOOLEAN NOT NULL,
    "gateReasons" TEXT NOT NULL DEFAULT '[]',
    "earliestAt" DATETIME,
    CONSTRAINT "CallPlanEntry_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CallPlan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "CallPlan_campaignId_planDate_status_idx" ON "CallPlan"("campaignId", "planDate", "status");

-- CreateIndex
CREATE INDEX "CallPlan_status_planDate_idx" ON "CallPlan"("status", "planDate");

-- CreateIndex
CREATE INDEX "CallPlanEntry_planId_position_idx" ON "CallPlanEntry"("planId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "CallPlanEntry_planId_contactId_key" ON "CallPlanEntry"("planId", "contactId");
