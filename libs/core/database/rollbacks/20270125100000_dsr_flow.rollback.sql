-- Rolls back 20270125100000_dsr_flow: drops the review columns and the index, and takes customers:dsr_review from every role.
-- Run it before the code that reads the columns or guards a route with the permission is brought back. Safe to run twice.
BEGIN;
DROP FUNCTION IF EXISTS resolve_dsr_verification(text);
DROP FUNCTION IF EXISTS resolve_dsr_store(text);
DROP INDEX IF EXISTS "ix_dsr_erasure_due";
DROP INDEX IF EXISTS "stores_dsr_public_key_key";
ALTER TABLE "stores" DROP COLUMN IF EXISTS "dsr_public_key";
DROP INDEX IF EXISTS "ix_dsr_open_by_subject";
ALTER TABLE "data_subject_requests"
  DROP COLUMN IF EXISTS "subject_email_hash",
  DROP COLUMN IF EXISTS "reviewed_by",
  DROP COLUMN IF EXISTS "reviewed_at",
  DROP COLUMN IF EXISTS "subject_customer_ids",
  DROP COLUMN IF EXISTS "notify_to_encrypted",
  DROP COLUMN IF EXISTS "approvals",
  DROP COLUMN IF EXISTS "erasure_due_at";
DELETE FROM "permissions" WHERE "name" = 'customers:dsr_review';
COMMIT;
