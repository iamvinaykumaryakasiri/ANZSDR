-- CreateTable
CREATE TABLE "CallRecord" (
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
    CONSTRAINT "CallRecord_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MeetingRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "callId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emailSentAt" DATETIME,
    "nudgedAt" DATETIME,
    "decidedAt" DATETIME,
    "decisionNote" TEXT NOT NULL DEFAULT '',
    "decidedVia" TEXT,
    CONSTRAINT "MeetingRequest_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MeetingRequest_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CallRecord_callId_key" ON "CallRecord"("callId");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingRequest_callId_key" ON "MeetingRequest"("callId");

-- CreateIndex
CREATE INDEX "MeetingRequest_status_idx" ON "MeetingRequest"("status");

-- CreateIndex
CREATE INDEX "MeetingRequest_contactId_idx" ON "MeetingRequest"("contactId");
