-- Rolls back 20270121400000_rls_phase4_finance_fiscal: drops the policies of the books of an organization and turns row security
-- off on those tables, in the inverse order of the migration. The REVOKEs and the SECURITY DEFINER triggers were never touched.
-- Safe to run twice. It opens nothing that was closed before the phase: until enforcement is on, no policy bound anybody.
BEGIN;

SELECT rls_drop_policy('fiscal_contingencies');
SELECT rls_drop_policy('fiscal_documents');
SELECT rls_drop_policy('fiscal_sequences');
SELECT rls_drop_policy('fiscal_issuers');
SELECT rls_drop_policy('fiscal_periods');
SELECT rls_drop_policy('supplier_payment_returns');
SELECT rls_drop_policy('supplier_payments');
SELECT rls_drop_policy('purchase_receipt_lines');
SELECT rls_drop_policy('purchase_receipts');
SELECT rls_drop_policy('purchase_order_lines');
SELECT rls_drop_policy('purchase_orders');
SELECT rls_drop_policy('suppliers');
SELECT rls_drop_policy('reconciliation_matches');
SELECT rls_drop_policy('bank_statement_lines');
SELECT rls_drop_policy('bank_statement_imports');
SELECT rls_drop_policy('bank_import_profiles');
SELECT rls_drop_policy('tax_rates');
SELECT rls_drop_policy('finance_book_snapshots');
SELECT rls_drop_policy('finance_book_layouts');
SELECT rls_drop_policy('finance_chain_incidents');
SELECT rls_drop_policy('finance_posting_failures');
SELECT rls_drop_policy('finance_transactions');
SELECT rls_drop_policy('finance_settings');
SELECT rls_drop_policy('journal_lines');
SELECT rls_drop_policy('journal_entries');
SELECT rls_drop_policy('payment_method_accounts');
SELECT rls_drop_policy('ledger_accounts');
SELECT rls_drop_policy('account_role_mappings');
SELECT rls_drop_policy('account_period_balances');

COMMIT;
