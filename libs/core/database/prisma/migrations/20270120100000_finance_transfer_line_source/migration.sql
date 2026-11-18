-- The write-off of a transfer shortage (E9, AUT-911) is posted from the line of the transfer: its source type is `transfer_line`.
-- The two lists that name the kinds of source (the journal entries and the posting failures) must say so, or the entry and its failure
-- would be refused by the database. Constraints only: no row changes.
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS chk_journal_entries_source_type;
ALTER TABLE journal_entries
  ADD CONSTRAINT chk_journal_entries_source_type CHECK (source_type IS NULL OR source_type IN (
    'order', 'shipment', 'remittance', 'return', 'inventory_movement', 'purchase_receipt', 'supplier_payment',
    'finance_transaction', 'manual', 'transfer_line'
  ));
ALTER TABLE finance_posting_failures DROP CONSTRAINT IF EXISTS chk_finance_posting_failures_source_type;
ALTER TABLE finance_posting_failures
  ADD CONSTRAINT chk_finance_posting_failures_source_type CHECK (source_type IN (
    'order', 'shipment', 'remittance', 'return', 'inventory_movement', 'purchase_receipt', 'supplier_payment',
    'finance_transaction', 'manual', 'transfer_line'
  ));
