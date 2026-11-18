-- Step 4B.6b-4 (HC-101), the purchase of guides in the books: a purchase of guides of a prepaid connection grows the advance (E15) and its
-- void gives it back (E16). The movement of the ledger of guides is a new kind of source, and its entries a new type of entry.
--
-- carrier_guide_movements.paid_from_account_id: the cash, bank or wallet account the money left. Not a foreign key (the ledger of guides is
-- per store and the account per organization); the books check it when they post and the default bank role is used when it is null.
ALTER TABLE carrier_guide_movements ADD COLUMN paid_from_account_id TEXT;

-- The sets that are hashed and frozen with an entry list the new type and the new source (finance-schema.spec.ts compares them)
ALTER TABLE journal_entries DROP CONSTRAINT chk_journal_entries_type;
ALTER TABLE journal_entries
  ADD CONSTRAINT chk_journal_entries_type CHECK (type IN (
    'manual', 'opening_balance', 'expense', 'income', 'transfer', 'sale', 'sale_shipment', 'sale_return', 'cod_remittance',
    'cod_write_off', 'purchase_receipt', 'supplier_payment', 'carrier_guides', 'inventory_adjustment', 'reversal'
  ));
ALTER TABLE journal_entries DROP CONSTRAINT chk_journal_entries_source_type;
ALTER TABLE journal_entries
  ADD CONSTRAINT chk_journal_entries_source_type CHECK (source_type IS NULL OR source_type IN (
    'order', 'shipment', 'remittance', 'return', 'inventory_movement', 'purchase_receipt', 'supplier_payment',
    'carrier_guide_movement', 'finance_transaction', 'manual'
  ));
ALTER TABLE finance_posting_failures DROP CONSTRAINT chk_finance_posting_failures_source_type;
ALTER TABLE finance_posting_failures
  ADD CONSTRAINT chk_finance_posting_failures_source_type CHECK (source_type IN (
    'order', 'shipment', 'remittance', 'return', 'inventory_movement', 'purchase_receipt', 'supplier_payment',
    'carrier_guide_movement', 'finance_transaction', 'manual'
  ));
