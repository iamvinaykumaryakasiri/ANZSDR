-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "icp" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL,
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Account_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "seniority" TEXT NOT NULL DEFAULT 'unknown',
    "linkedinUrl" TEXT,
    "apolloId" TEXT,
    "phoneE164" TEXT,
    "phoneLine" TEXT,
    "jurisdiction" TEXT,
    "timezone" TEXT,
    "icpScore" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'apollo',
    "lawfulBasis" TEXT NOT NULL DEFAULT 'legitimate business interest - B2B professional capacity',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Contact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Contact_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContactEmail" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContactEmail_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Dossier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "hypothesis" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "person" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "hooks" TEXT NOT NULL,
    "landmines" TEXT NOT NULL,
    "unverified" TEXT NOT NULL,
    "sources" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Dossier_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Call" (
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
    CONSTRAINT "Call_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Call_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DialAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "at" DATETIME NOT NULL,
    "hadConversation" BOOLEAN NOT NULL DEFAULT false,
    "callId" TEXT,
    CONSTRAINT "DialAttempt_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "DialAttempt_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Suppression" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "DncWash" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "e164" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "washedAt" DATETIME NOT NULL,
    "register" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "AuditRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL,
    "kind" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "data" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 3,
    "campaignId" TEXT,
    "accountId" TEXT,
    "contactId" TEXT,
    "payload" TEXT NOT NULL,
    "result" TEXT,
    "dependsOn" TEXT NOT NULL DEFAULT '[]',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "runAfter" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "Task_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "agent" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "output" TEXT,
    "error" TEXT,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "tokensIn" INTEGER NOT NULL DEFAULT 0,
    "tokensOut" INTEGER NOT NULL DEFAULT 0,
    "usd" REAL NOT NULL DEFAULT 0,
    "wallClockMs" INTEGER NOT NULL DEFAULT 0,
    "validationFailures" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "AgentRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TraceEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "taskId" TEXT,
    "agentRunId" TEXT,
    "actor" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '{}',
    "usd" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "TraceEvent_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "TraceEvent_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Escalation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "level" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL,
    "taskId" TEXT,
    "contactId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME
);

-- CreateTable
CREATE TABLE "SpendRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "category" TEXT NOT NULL,
    "usd" REAL NOT NULL,
    "taskId" TEXT,
    "note" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "Memory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Playbook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slot" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "rationale" TEXT NOT NULL DEFAULT '',
    "evidence" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "Account_campaignId_status_idx" ON "Account"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Account_campaignId_domain_key" ON "Account"("campaignId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_apolloId_key" ON "Contact"("apolloId");

-- CreateIndex
CREATE INDEX "Contact_accountId_idx" ON "Contact"("accountId");

-- CreateIndex
CREATE INDEX "Contact_campaignId_status_idx" ON "Contact"("campaignId", "status");

-- CreateIndex
CREATE INDEX "ContactEmail_address_idx" ON "ContactEmail"("address");

-- CreateIndex
CREATE UNIQUE INDEX "ContactEmail_contactId_kind_key" ON "ContactEmail"("contactId", "kind");

-- CreateIndex
CREATE INDEX "Dossier_contactId_idx" ON "Dossier"("contactId");

-- CreateIndex
CREATE INDEX "Call_contactId_idx" ON "Call"("contactId");

-- CreateIndex
CREATE INDEX "Call_campaignId_startedAt_idx" ON "Call"("campaignId", "startedAt");

-- CreateIndex
CREATE INDEX "DialAttempt_contactId_idx" ON "DialAttempt"("contactId");

-- CreateIndex
CREATE INDEX "DialAttempt_accountId_at_idx" ON "DialAttempt"("accountId", "at");

-- CreateIndex
CREATE INDEX "DialAttempt_at_idx" ON "DialAttempt"("at");

-- CreateIndex
CREATE INDEX "DialAttempt_e164_at_idx" ON "DialAttempt"("e164", "at");

-- CreateIndex
CREATE INDEX "Suppression_scope_key_idx" ON "Suppression"("scope", "key");

-- CreateIndex
CREATE INDEX "DncWash_e164_washedAt_idx" ON "DncWash"("e164", "washedAt");

-- CreateIndex
CREATE INDEX "AuditRecord_at_idx" ON "AuditRecord"("at");

-- CreateIndex
CREATE INDEX "AuditRecord_kind_at_idx" ON "AuditRecord"("kind", "at");

-- CreateIndex
CREATE INDEX "Task_status_priority_idx" ON "Task"("status", "priority");

-- CreateIndex
CREATE INDEX "Task_campaignId_status_idx" ON "Task"("campaignId", "status");

-- CreateIndex
CREATE INDEX "AgentRun_taskId_idx" ON "AgentRun"("taskId");

-- CreateIndex
CREATE INDEX "AgentRun_agent_startedAt_idx" ON "AgentRun"("agent", "startedAt");

-- CreateIndex
CREATE INDEX "TraceEvent_at_idx" ON "TraceEvent"("at");

-- CreateIndex
CREATE INDEX "TraceEvent_taskId_at_idx" ON "TraceEvent"("taskId", "at");

-- CreateIndex
CREATE INDEX "Escalation_status_createdAt_idx" ON "Escalation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SpendRecord_at_idx" ON "SpendRecord"("at");

-- CreateIndex
CREATE INDEX "SpendRecord_category_at_idx" ON "SpendRecord"("category", "at");

-- CreateIndex
CREATE INDEX "Memory_scope_key_idx" ON "Memory"("scope", "key");

-- CreateIndex
CREATE INDEX "Playbook_slot_status_idx" ON "Playbook"("slot", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Playbook_slot_version_key" ON "Playbook"("slot", "version");
