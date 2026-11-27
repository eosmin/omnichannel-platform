-- The day the supplier issued the document (D4b-2): the column A of the annex of purchases of the return is the day of issue, not the day the goods
-- arrived (`purchase_receipts.received_on`), and the annex cannot declare one for the other. Null on the rows written before: the annex refuses
-- a month with such a row and names it, and the staff completes it; no day is made up. It is always written with the rest of a document (the API
-- asks for it), and a row that is the mark "left out of the annex" has none.
ALTER TABLE "purchase_receipt_documents" ADD COLUMN "issued_on" DATE;

ALTER TABLE "purchase_receipt_documents" ADD CONSTRAINT "chk_purchase_receipt_documents_issued_on" CHECK (
  annex_exclusion IS NULL OR issued_on IS NULL
);

-- The month of an annex reads the receipts of an organization by the day they arrived
CREATE INDEX "purchase_receipts_organization_id_received_on_idx" ON "purchase_receipts"("organization_id", "received_on");
