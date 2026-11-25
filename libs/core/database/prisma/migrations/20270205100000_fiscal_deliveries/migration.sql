-- Step 4B.7d (D13b-1, Normativa DTE v2.0 section 11): the delivery of the files of an accepted fiscal document (the DTE file and its graphic
-- representation) to its receiver. One row for each document, written once: SENT when the files went by a channel or by email, NOT_SENT
-- when nothing could carry them and a person must give them by hand. It names no receiver and no address, only the route and a reason code.
-- A table of the organization (like its documents), so the policy below keeps an organization from reading another's.
-- Rollback: rollbacks/20270205100000_fiscal_deliveries.rollback.sql
CREATE TABLE "fiscal_deliveries" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fiscal_deliveries_pkey" PRIMARY KEY ("id"),
    -- A sent delivery has a route and no reason; one that was not sent has no route and says why
    CONSTRAINT "chk_fiscal_deliveries_outcome" CHECK (
      (status = 'sent' AND route IN ('channel', 'email') AND reason IS NULL)
      OR (status = 'not_sent' AND route = 'none'
          AND reason IN ('no_channel', 'files_unavailable', 'too_large', 'customer_erased'))
    )
);

CREATE UNIQUE INDEX "fiscal_deliveries_document_id_key" ON "fiscal_deliveries"("document_id");
CREATE INDEX "fiscal_deliveries_organization_id_store_id_created_at_idx"
    ON "fiscal_deliveries"("organization_id", "store_id", "created_at" DESC);

ALTER TABLE "fiscal_deliveries" ADD CONSTRAINT "fiscal_deliveries_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_deliveries" ADD CONSTRAINT "fiscal_deliveries_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_deliveries" ADD CONSTRAINT "fiscal_deliveries_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "fiscal_documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The policy of a table of an organization (TDD_01 section 3.2, layer 3), declared here; it binds nobody until the owner turns enforcement on
SELECT rls_apply_policy('fiscal_deliveries', 'organization');
