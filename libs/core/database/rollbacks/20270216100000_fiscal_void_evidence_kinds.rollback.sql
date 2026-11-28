-- Rolls back 20270216100000_fiscal_void_evidence_kinds: the check goes back to the five kinds of 20270203100000. The evidence is never deleted (a
-- trigger says it), so this FAILS, on purpose and with nothing changed, while a file of the new kinds exists: those files are what a receiver was
-- owed and must be kept. Safe to run twice.
BEGIN;
ALTER TABLE media DROP CONSTRAINT IF EXISTS chk_media_fiscal_evidence;
ALTER TABLE media
  ADD CONSTRAINT chk_media_fiscal_evidence CHECK (
    ((purpose = 'fiscal_evidence') = (fiscal_document_id IS NOT NULL))
    AND ((fiscal_document_id IS NULL) = (fiscal_evidence_kind IS NULL))
    AND (fiscal_evidence_kind IS NULL
         OR fiscal_evidence_kind IN ('document', 'response', 'void_response', 'dte_file', 'representation'))
    AND (purpose <> 'fiscal_evidence'
         OR (store_id IS NOT NULL AND product_id IS NULL AND order_id IS NULL AND message_id IS NULL AND origin_id IS NULL
             AND customer_id IS NULL AND finance_transaction_id IS NULL AND origin_slot IS NULL))
  );
COMMIT;
