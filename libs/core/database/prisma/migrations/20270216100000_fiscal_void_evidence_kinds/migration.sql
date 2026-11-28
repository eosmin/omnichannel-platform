-- D13b-2b-2 (A): two more kinds of evidence of a fiscal document, the two files the receiver is owed when the document is voided (Normativa DTE
-- v2.0, apartado 11, page 23): the event of the invalidation as the issuer signed it, with the seal of the authority (`void_dte_file`), and its
-- graphic representation (`void_representation`, a PDF). Like the others they are made by the platform from the row of the document (the sealed
-- event of 20270213100000_fiscal_void_event), scanned, never deleted, one of each kind at most (the unique index and the triggers of
-- 20270106100000_fiscal_evidence already say it). Only the list of kinds of the check changes.
ALTER TABLE media DROP CONSTRAINT chk_media_fiscal_evidence;
ALTER TABLE media
  ADD CONSTRAINT chk_media_fiscal_evidence CHECK (
    ((purpose = 'fiscal_evidence') = (fiscal_document_id IS NOT NULL))
    AND ((fiscal_document_id IS NULL) = (fiscal_evidence_kind IS NULL))
    AND (fiscal_evidence_kind IS NULL
         OR fiscal_evidence_kind IN ('document', 'response', 'void_response', 'dte_file', 'representation', 'void_dte_file', 'void_representation'))
    AND (purpose <> 'fiscal_evidence'
         OR (store_id IS NOT NULL AND product_id IS NULL AND order_id IS NULL AND message_id IS NULL AND origin_id IS NULL
             AND customer_id IS NULL AND finance_transaction_id IS NULL AND origin_slot IS NULL))
  );
