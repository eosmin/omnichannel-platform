-- Rolls back 20270207100000_purchase_receipt_fiscal_document: the data of the supplier's documents of the receipts goes with its table.
-- The receipts themselves are never touched. Safe to run twice.
BEGIN;
DROP TABLE IF EXISTS "purchase_receipt_documents";
COMMIT;
