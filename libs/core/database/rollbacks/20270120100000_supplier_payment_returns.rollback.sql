-- Rolls back 20270120100000_supplier_payment_returns. DESTRUCTIVE: every return of a supplier payment is DROPPED with its rows (the journal entries
-- they posted stay: the journal is append-only, so those entries have no operational header after this). The sets of types and sources of the
-- journal go back to what they were; the posting failures recorded for a return are deleted (they name a source that no longer exists); if an entry
-- of the type `supplier_payment_return` exists the check cannot be added again and the whole
-- script stops (nothing is changed): the journal is never rewritten here, so a database that posted a return cannot go back past this
-- migration without the accountant's decision about those entries. Returns refuse deletes, so their triggers go first. Run it before the code
-- that reads the table is brought back. Safe to run twice.
BEGIN;

DROP TRIGGER IF EXISTS trg_supplier_payments_returned ON supplier_payments;
DROP TRIGGER IF EXISTS trg_supplier_payment_returns_no_truncate ON supplier_payment_returns;
DROP TRIGGER IF EXISTS trg_supplier_payment_returns_no_delete ON supplier_payment_returns;
DROP TRIGGER IF EXISTS trg_supplier_payment_returns_check ON supplier_payment_returns;
DROP FUNCTION IF EXISTS forbid_void_of_returned_payment();
DROP FUNCTION IF EXISTS check_supplier_payment_return_row();

DROP TABLE IF EXISTS "supplier_payment_returns";

ALTER TABLE journal_entries
  DROP CONSTRAINT IF EXISTS chk_journal_entries_type,
  DROP CONSTRAINT IF EXISTS chk_journal_entries_source_type;
ALTER TABLE journal_entries
  ADD CONSTRAINT chk_journal_entries_type CHECK (type IN (
    'manual', 'opening_balance', 'expense', 'income', 'transfer', 'sale', 'sale_shipment', 'sale_return', 'cod_remittance',
    'cod_write_off', 'purchase_receipt', 'supplier_payment', 'inventory_adjustment', 'reversal'
  )),
  ADD CONSTRAINT chk_journal_entries_source_type CHECK (source_type IS NULL OR source_type IN (
    'order', 'shipment', 'remittance', 'return', 'inventory_movement', 'purchase_receipt', 'supplier_payment',
    'finance_transaction', 'manual'
  ));
DELETE FROM finance_posting_failures WHERE source_type = 'supplier_payment_return';
ALTER TABLE finance_posting_failures
  DROP CONSTRAINT IF EXISTS chk_finance_posting_failures_source_type;
ALTER TABLE finance_posting_failures
  ADD CONSTRAINT chk_finance_posting_failures_source_type CHECK (source_type IN (
    'order', 'shipment', 'remittance', 'return', 'inventory_movement', 'purchase_receipt', 'supplier_payment',
    'finance_transaction', 'manual'
  ));

COMMIT;
