-- CreateTable
CREATE TABLE "Edition" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "date" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "editionId" INTEGER,
    "section" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "dek" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "heroImagePath" TEXT,
    "heroPrompt" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'QUEUED',
    "startedAt" DATETIME,
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Article_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "Edition" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Source" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "articleId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "url" TEXT,
    "kind" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Source_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "articleId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "note" TEXT NOT NULL DEFAULT 'Needs fact-checking or primary confirmation',
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Claim_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Dossier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "articleId" TEXT NOT NULL,
    "research" TEXT NOT NULL,
    "graphNodeIds" TEXT NOT NULL DEFAULT '[]',
    "tokens" INTEGER,
    CONSTRAINT "Dossier_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DaemonRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "kind" TEXT NOT NULL,
    "articleId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "detail" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "DaemonState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'STOPPED',
    "masthead" TEXT NOT NULL DEFAULT 'The Understory',
    "startedAt" DATETIME,
    "lastDiscoveryAt" DATETIME,
    "nextCheckAt" DATETIME,
    "cadenceMin" INTEGER NOT NULL DEFAULT 60,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Edition_date_key" ON "Edition"("date");

-- CreateIndex
CREATE INDEX "Article_stage_idx" ON "Article"("stage");

-- CreateIndex
CREATE INDEX "Article_section_idx" ON "Article"("section");

-- CreateIndex
CREATE UNIQUE INDEX "Article_date_slug_key" ON "Article"("date", "slug");

-- CreateIndex
CREATE INDEX "Source_articleId_idx" ON "Source"("articleId");

-- CreateIndex
CREATE INDEX "Claim_articleId_idx" ON "Claim"("articleId");

-- CreateIndex
CREATE UNIQUE INDEX "Dossier_articleId_key" ON "Dossier"("articleId");

-- CreateIndex
CREATE INDEX "DaemonRun_kind_idx" ON "DaemonRun"("kind");

-- CreateIndex
CREATE INDEX "DaemonRun_startedAt_idx" ON "DaemonRun"("startedAt");
