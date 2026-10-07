-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_CallRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "callId" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '[]',
    "summarySource" TEXT NOT NULL DEFAULT 'model',
    "hook" TEXT NOT NULL DEFAULT '',
    "objections" TEXT NOT NULL DEFAULT '[]',
    "sentiment" TEXT NOT NULL DEFAULT 'unknown',
    "sentimentTrace" TEXT NOT NULL DEFAULT '[]',
    "attentionLostAtSec" INTEGER,
    "windows" TEXT NOT NULL DEFAULT '[]',
    "timezone" TEXT,
    "attendees" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "followUp" TEXT NOT NULL DEFAULT '[]',
    "followedUpAt" DATETIME,
    "smsSentAt" DATETIME,
    "voicemailDraftedAt" DATETIME,
    CONSTRAINT "CallRecord_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_CallRecord" ("attendees", "attentionLostAtSec", "callId", "createdAt", "hook", "id", "objections", "sentiment", "sentimentTrace", "summary", "summarySource", "timezone", "windows") SELECT "attendees", "attentionLostAtSec", "callId", "createdAt", "hook", "id", "objections", "sentiment", "sentimentTrace", "summary", "summarySource", "timezone", "windows" FROM "CallRecord";
DROP TABLE "CallRecord";
ALTER TABLE "new_CallRecord" RENAME TO "CallRecord";
CREATE UNIQUE INDEX "CallRecord_callId_key" ON "CallRecord"("callId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
