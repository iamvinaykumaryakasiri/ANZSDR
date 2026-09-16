-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Contact" (
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
    "kind" TEXT NOT NULL DEFAULT 'prospect',
    "source" TEXT NOT NULL DEFAULT 'apollo',
    "lawfulBasis" TEXT NOT NULL DEFAULT 'legitimate business interest - B2B professional capacity',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Contact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Contact_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Contact" ("accountId", "apolloId", "campaignId", "createdAt", "firstName", "icpScore", "id", "jurisdiction", "lastName", "lawfulBasis", "linkedinUrl", "phoneE164", "phoneLine", "seniority", "source", "status", "timezone", "title", "updatedAt") SELECT "accountId", "apolloId", "campaignId", "createdAt", "firstName", "icpScore", "id", "jurisdiction", "lastName", "lawfulBasis", "linkedinUrl", "phoneE164", "phoneLine", "seniority", "source", "status", "timezone", "title", "updatedAt" FROM "Contact";
DROP TABLE "Contact";
ALTER TABLE "new_Contact" RENAME TO "Contact";
CREATE UNIQUE INDEX "Contact_apolloId_key" ON "Contact"("apolloId");
CREATE INDEX "Contact_accountId_idx" ON "Contact"("accountId");
CREATE INDEX "Contact_campaignId_status_idx" ON "Contact"("campaignId", "status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
