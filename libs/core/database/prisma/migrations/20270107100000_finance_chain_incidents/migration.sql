-- CreateTable
CREATE TABLE "finance_chain_incidents" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "entry_number" TEXT,
    "entries_checked" INTEGER NOT NULL,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "resolved_at" TIMESTAMP(3),

    CONSTRAINT "finance_chain_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "finance_chain_incidents_organization_id_resolved_at_idx" ON "finance_chain_incidents"("organization_id", "resolved_at");

-- At most one open incident per organization: two replicas that find the same break at once cannot open two
CREATE UNIQUE INDEX "uq_finance_chain_incidents_open" ON "finance_chain_incidents" ("organization_id") WHERE resolved_at IS NULL;

-- The reason is one of the codes of the check, never free text
ALTER TABLE "finance_chain_incidents" ADD CONSTRAINT "chk_finance_chain_incidents_reason" CHECK ("reason" IN ('prev_hash_mismatch', 'hash_mismatch', 'number_gap', 'head_mismatch', 'frozen_head_missing'));

-- AddForeignKey
ALTER TABLE "finance_chain_incidents" ADD CONSTRAINT "finance_chain_incidents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The record of an alteration is not erased by the application: no delete, and no truncate; an update may move only what a check moves
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE finance_chain_incidents FROM platform_app, platform_worker;
GRANT UPDATE (reason, entry_number, entries_checked, last_seen_at, resolved_at) ON TABLE finance_chain_incidents TO platform_app, platform_worker;
