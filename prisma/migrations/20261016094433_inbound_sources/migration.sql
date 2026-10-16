-- CreateTable
CREATE TABLE "InboundSource" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'nucrm',
    "secret" TEXT NOT NULL,
    "secretPrefix" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastEventAt" DATETIME,
    "lastEventName" TEXT,
    "receivedEvents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "InboundSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "InboundSource_workspaceId_idx" ON "InboundSource"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "InboundSource_workspaceId_name_key" ON "InboundSource"("workspaceId", "name");
