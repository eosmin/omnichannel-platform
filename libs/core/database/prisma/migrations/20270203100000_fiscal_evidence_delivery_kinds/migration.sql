-- Step 4B.7d (TDD_18 §8.3): two more kinds of evidence of a fiscal document, the two files the receiver is given with the document: the
-- document as the authority defines it (`dte_file`: the structure, the signature and the seal) and its graphic representation (`representation`,
-- a PDF). Like the others they are made by the platform from the row of the document, scanned, never deleted, one of each kind at most (the
-- unique index and the triggers of 20270106100000_fiscal_evidence already say it). Only the list of kinds of the check changes.
ALTER TABLE media DROP CONSTRAINT chk_media_fiscal_evidence;
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
