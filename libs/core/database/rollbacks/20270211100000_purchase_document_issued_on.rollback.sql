-- Rolls back 20270211100000_purchase_document_issued_on: the day of issue of the supplier documents goes with its column. Safe to run twice.
BEGIN;
DROP INDEX IF EXISTS "purchase_receipts_organization_id_received_on_idx";
ALTER TABLE "purchase_receipt_documents" DROP CONSTRAINT IF EXISTS "chk_purchase_receipt_documents_issued_on";
ALTER TABLE "purchase_receipt_documents" DROP COLUMN IF EXISTS "issued_on";
COMMIT;
