-- Rolls back 20270120110000_carrier_guide_purchase_posting: the old lists of entry types and sources, and the account of a purchase.
-- The journal is never rewritten, so this FAILS (and changes nothing) while an entry of type 'carrier_guides' or of source
-- 'carrier_guide_movement' exists: reverse and stop posting them first. The open failures of that source are deleted (they are alarms,
-- not books). Idempotent.
BEGIN;

DELETE FROM finance_posting_failures WHERE source_type = 'carrier_guide_movement';
ALTER TABLE finance_posting_failures DROP CONSTRAINT IF EXISTS chk_finance_posting_failures_source_type;
ALTER TABLE finance_posting_failures
  ADD CONSTRAINT chk_finance_posting_failures_source_type CHECK (source_type IN (
    'order', 'shipment', 'remittance', 'return', 'inventory_movement', 'purchase_receipt', 'supplier_payment',
    'finance_transaction', 'manual', 'transfer_line'
  ));
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS chk_journal_entries_source_type;
ALTER TABLE journal_entries
  ADD CONSTRAINT chk_journal_entries_source_type CHECK (source_type IS NULL OR source_type IN (
    'order', 'shipment', 'remittance', 'return', 'inventory_movement', 'purchase_receipt', 'supplier_payment',
    'finance_transaction', 'manual', 'transfer_line'
  ));
ALTER TABLE journal_entries DROP CONSTRAINT IF EXISTS chk_journal_entries_type;
ALTER TABLE journal_entries
  ADD CONSTRAINT chk_journal_entries_type CHECK (type IN (
    'manual', 'opening_balance', 'expense', 'income', 'transfer', 'sale', 'sale_shipment', 'sale_return', 'cod_remittance',
    'cod_write_off', 'purchase_receipt', 'supplier_payment', 'inventory_adjustment', 'reversal'
  ));
ALTER TABLE carrier_guide_movements DROP COLUMN IF EXISTS paid_from_account_id;

COMMIT;
