-- Rolls back 20270120100000_finance_transfer_line_source: the two lists of source types lose `transfer_line`. The journal is append-only, so
-- an entry already posted from a transfer line stays; the constraints come back NOT VALID so that those rows are not checked again (new
-- rows still are). Run it before the code that posts transfer write-offs is brought back out. Safe to run twice.
BEGIN;

ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS chk_journal_entries_source_type;
ALTER TABLE journal_entries
  ADD CONSTRAINT chk_journal_entries_source_type CHECK (source_type IS NULL OR source_type IN (
    'order', 'shipment', 'remittance', 'return', 'inventory_movement', 'purchase_receipt', 'supplier_payment',
    'finance_transaction', 'manual'
  )) NOT VALID;
ALTER TABLE finance_posting_failures DROP CONSTRAINT IF EXISTS chk_finance_posting_failures_source_type;
ALTER TABLE finance_posting_failures
  ADD CONSTRAINT chk_finance_posting_failures_source_type CHECK (source_type IN (
    'order', 'shipment', 'remittance', 'return', 'inventory_movement', 'purchase_receipt', 'supplier_payment',
    'finance_transaction', 'manual'
  )) NOT VALID;

COMMIT;
