-- CreateTable
CREATE TABLE "CallEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "callId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "speaker" TEXT,
    "text" TEXT NOT NULL DEFAULT '',
    "atSecond" INTEGER,
    "data" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CallEvent_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Call" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "endedAt" DATETIME,
    "durationSec" INTEGER,
    "outcome" TEXT,
    "playbookVersion" TEXT,
    "sentiment" TEXT,
    "recordingUrl" TEXT,
    "transcriptUrl" TEXT,
    "sectionMarks" TEXT NOT NULL DEFAULT '[]',
    "defects" TEXT NOT NULL DEFAULT '[]',
    "providerCallId" TEXT,
    "endedReason" TEXT,
    "providerMetrics" TEXT NOT NULL DEFAULT '{}',
    CONSTRAINT "Call_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Call_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Call" ("accountId", "campaignId", "contactId", "defects", "durationSec", "endedAt", "id", "outcome", "playbookVersion", "recordingUrl", "sectionMarks", "sentiment", "startedAt", "transcriptUrl") SELECT "accountId", "campaignId", "contactId", "defects", "durationSec", "endedAt", "id", "outcome", "playbookVersion", "recordingUrl", "sectionMarks", "sentiment", "startedAt", "transcriptUrl" FROM "Call";
DROP TABLE "Call";
ALTER TABLE "new_Call" RENAME TO "Call";
CREATE UNIQUE INDEX "Call_providerCallId_key" ON "Call"("providerCallId");
CREATE INDEX "Call_contactId_idx" ON "Call"("contactId");
CREATE INDEX "Call_campaignId_startedAt_idx" ON "Call"("campaignId", "startedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "CallEvent_callId_id_idx" ON "CallEvent"("callId", "id");
