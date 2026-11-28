-- D16: contingency by batch. After the authority took the event of a contingency, the documents it lists are sent in lots (the authority takes at most
-- 100 documents a lot, Manual Tecnologico V2.0 3.2.1 and 3.4), each lot answered with a code that is asked about until every document has its
-- verdict. The lots are rows of their own: what was sent, when, under which code, and what is left to decide.
--  * `fiscal_contingency_batches`: one row per lot of one contingency, tenant-scoped (organization) and under row-level security, never deleted,
--    only moving forward (pending, received, processed); the identifier of the send (`send_id`) and the code the authority gave never change.
--  * `fiscal_documents.batch_id`: the lot a document of a contingency was put in, NULL for every document that exists. It is written while the
--    document is held (QUEUED) and is part of what no longer changes once the document is accepted or voided (the guard below). A refused
--    document that is made again leaves its contingency but keeps its lot (the lot is the record of what was sent), so no check ties the two.
-- Rollback: rollbacks/20270214100000_fiscal_contingency_batch.rollback.sql

CREATE TABLE "fiscal_contingency_batches" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "contingency_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "send_id" TEXT NOT NULL,
    "batch_code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "document_count" INTEGER NOT NULL,
    "send_attempts" INTEGER NOT NULL DEFAULT 0,
    "consult_attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3),
    "consulted_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "last_error" TEXT,
    "response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT (now() AT TIME ZONE 'UTC'),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_contingency_batches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fiscal_contingency_batches_contingency_id_sequence_key" ON "fiscal_contingency_batches"("contingency_id", "sequence");
CREATE UNIQUE INDEX "fiscal_contingency_batches_send_id_key" ON "fiscal_contingency_batches"("send_id");
CREATE INDEX "fiscal_contingency_batches_organization_id_status_idx" ON "fiscal_contingency_batches"("organization_id", "status");

ALTER TABLE "fiscal_contingency_batches" ADD CONSTRAINT "fiscal_contingency_batches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fiscal_contingency_batches" ADD CONSTRAINT "fiscal_contingency_batches_contingency_id_fkey" FOREIGN KEY ("contingency_id") REFERENCES "fiscal_contingencies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- What each state has: a pending lot has no code yet; a received one has the code and the instant it was sent; a processed one has them and the instant
-- the last verdict was read
ALTER TABLE "fiscal_contingency_batches" ADD CONSTRAINT "chk_fiscal_contingency_batches_state" CHECK (
  ("status" = 'pending' AND "batch_code" IS NULL AND "processed_at" IS NULL)
  OR ("status" = 'received' AND "batch_code" IS NOT NULL AND "sent_at" IS NOT NULL AND "processed_at" IS NULL)
  OR ("status" = 'processed' AND "batch_code" IS NOT NULL AND "sent_at" IS NOT NULL AND "processed_at" IS NOT NULL)
);
ALTER TABLE "fiscal_contingency_batches" ADD CONSTRAINT "chk_fiscal_contingency_batches_counts" CHECK (
  "sequence" >= 1 AND "document_count" >= 1 AND "send_attempts" >= 0 AND "consult_attempts" >= 0
);

-- A lot is never deleted and only moves forward; what identifies it never changes, and a code the authority gave stays
CREATE FUNCTION fiscal_contingency_batch_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a fiscal contingency batch is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.contingency_id IS DISTINCT FROM OLD.contingency_id
     OR NEW.sequence IS DISTINCT FROM OLD.sequence
     OR NEW.send_id IS DISTINCT FROM OLD.send_id
     OR NEW.document_count IS DISTINCT FROM OLD.document_count THEN
    RAISE EXCEPTION 'a fiscal contingency batch keeps what it was made with' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.batch_code IS NOT NULL AND NEW.batch_code IS DISTINCT FROM OLD.batch_code THEN
    RAISE EXCEPTION 'the code the authority gave a batch does not change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (OLD.status = 'received' AND NEW.status = 'pending')
     OR (OLD.status = 'processed' AND NEW.status <> 'processed')
     OR (OLD.status = 'pending' AND NEW.status = 'processed') THEN
    RAISE EXCEPTION 'a fiscal contingency batch only moves forward' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_fiscal_contingency_batches_guard
BEFORE UPDATE OR DELETE ON fiscal_contingency_batches
FOR EACH ROW EXECUTE FUNCTION fiscal_contingency_batch_guard();

REVOKE DELETE, TRUNCATE ON TABLE fiscal_contingency_batches FROM platform_app, platform_worker;

SELECT rls_apply_policy('fiscal_contingency_batches', 'organization');

-- The lot a document was put in. The foreign key never lets a lot go while a document points at it.
ALTER TABLE "fiscal_documents" ADD COLUMN "batch_id" TEXT;
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "fiscal_contingency_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "fiscal_documents_batch_id_idx" ON "fiscal_documents"("batch_id");

-- The guard of a decided document: the whole function as it stood in 20270213100000, with ONE change: `batch_id` joins the list of what a
-- voided row may not change. The accepted branch and the re-seal door compare the whole row (minus an explicit list that does not have it), so
-- `batch_id` is immutable there already; only the voiding statement compares column by column, and a column that is not named in it was free
-- to change at that moment. A document that is held (QUEUED, SUBMITTED, REJECTED) is not guarded here: the lot is written while it is held.
CREATE OR REPLACE FUNCTION fiscal_document_guard() RETURNS trigger
SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a fiscal document is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IN ('accepted', 'voided') AND NEW.claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'a decided fiscal document holds no claim token' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status IN ('accepted', 'voided') THEN
    -- The re-seal of a rotation of the key (Step 7.3-S11b): the one door that lets a DECIDED document (accepted or voided) change, and it
    -- changes the three sealed columns and the three masked ones, and nothing else. The door is open only for a statement that runs as the owner of the function that
    -- opens it (fiscal_reseal_document, a SECURITY DEFINER callable by the worker): another role that sets the same setting by hand still
    -- runs as itself, so the whole row is compared as before. The row is compared whole, so a column added later is never forgotten.
    IF fiscal_reseal_door_open() THEN
      IF NEW.status IS DISTINCT FROM OLD.status
         OR (to_jsonb(NEW) - 'receiver_encrypted' - 'built_payload_encrypted' - 'void_event_encrypted' - 'receiver_name_masked' - 'receiver_tax_id_masked' - 'receiver_masked_at' - 'updated_at')
            IS DISTINCT FROM (to_jsonb(OLD) - 'receiver_encrypted' - 'built_payload_encrypted' - 'void_event_encrypted' - 'receiver_name_masked' - 'receiver_tax_id_masked' - 'receiver_masked_at' - 'updated_at') THEN
        RAISE EXCEPTION 'a re-seal changes only the sealed and masked columns' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF OLD.status = 'voided' THEN
      RAISE EXCEPTION 'a voided fiscal document does not change' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- An accepted row stays accepted only to carry the state of the invalidation of the document, and nothing else. The columns it may change
    -- are listed here, ONE LIST for both sides of the comparison (add a column of the invalidation to it, never to a second place):
    --   void_claim_key, void_claim_until          the claim of the invalidation in flight (D14b)
    --   void_rejected_at, void_rejection_warned_at  the moment the authority refused it and the moment the person was told (D14b)
    --   void_event_code, void_event_at            the generation code and the moment of the event, fixed at its first attempt (D14c)
    --   updated_at
    -- The whole row is compared, so a column that is added later is never forgotten (it is immutable until it is listed).
    IF NEW.status = 'accepted' THEN
      IF (to_jsonb(NEW) - 'void_claim_key' - 'void_claim_until' - 'void_rejected_at' - 'void_rejection_warned_at' - 'void_event_code' - 'void_event_at' - 'updated_at')
         IS DISTINCT FROM (to_jsonb(OLD) - 'void_claim_key' - 'void_claim_until' - 'void_rejected_at' - 'void_rejection_warned_at' - 'void_event_code' - 'void_event_at' - 'updated_at') THEN
        RAISE EXCEPTION 'an accepted fiscal document is immutable' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.status <> 'voided'
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.store_id IS DISTINCT FROM OLD.store_id
       OR NEW.order_id IS DISTINCT FROM OLD.order_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.return_id IS DISTINCT FROM OLD.return_id
       OR NEW.parent_document_id IS DISTINCT FROM OLD.parent_document_id
       OR NEW.replaces_document_id IS DISTINCT FROM OLD.replaces_document_id
       OR NEW.shipment_id IS DISTINCT FROM OLD.shipment_id
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
       OR NEW.sequence_number IS DISTINCT FROM OLD.sequence_number
       OR NEW.correlative IS DISTINCT FROM OLD.correlative
       OR NEW.correlative_scope_key IS DISTINCT FROM OLD.correlative_scope_key
       OR NEW.document_type IS DISTINCT FROM OLD.document_type
       OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
       OR NEW.environment IS DISTINCT FROM OLD.environment
       OR NEW.external_number IS DISTINCT FROM OLD.external_number
       OR NEW.provider_data IS DISTINCT FROM OLD.provider_data
       OR NEW.issuer_snapshot IS DISTINCT FROM OLD.issuer_snapshot
       OR NEW.lines_snapshot IS DISTINCT FROM OLD.lines_snapshot
       OR NEW.receiver_encrypted IS DISTINCT FROM OLD.receiver_encrypted
       OR NEW.built_payload_encrypted IS DISTINCT FROM OLD.built_payload_encrypted
       OR NEW.receiver_name_masked IS DISTINCT FROM OLD.receiver_name_masked
       OR NEW.receiver_tax_id_masked IS DISTINCT FROM OLD.receiver_tax_id_masked
       OR NEW.receiver_masked_at IS DISTINCT FROM OLD.receiver_masked_at
       OR NEW.response IS DISTINCT FROM OLD.response
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.total_cents IS DISTINCT FROM OLD.total_cents
       OR NEW.tax_cents IS DISTINCT FROM OLD.tax_cents
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
       OR NEW.submission IS DISTINCT FROM OLD.submission
       OR NEW.attempts IS DISTINCT FROM OLD.attempts
       OR NEW.contingency_id IS DISTINCT FROM OLD.contingency_id
       OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
      RAISE EXCEPTION 'an accepted fiscal document is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
