-- Row-Level Security, phase 4: the books of an organization (finance and fiscal), the last phase by risk. Every table here belongs
-- to an ORGANIZATION (TDD_16 section 1): organization_id is NOT NULL on all of them and is the whole predicate. store_id, where a
-- table has one, is NOT the predicate: a row with a NULL store_id (an organization-level row) is seen through its organization,
-- and the permission by store of the fiscal documents stays in the application.
-- What this migration does NOT touch, on purpose:
--  - the SECURITY DEFINER triggers (advance_finance_head, apply_journal_line_to_balance) write as the owner of the tables, which
--    the `<table>_owner` policy lets through, and the REVOKE of INSERT/UPDATE/DELETE on account_period_balances stays: the
--    policy adds a condition, it never opens a privilege;
--  - the append-only triggers (journal, ledger chain, fiscal evidence) keep seeing the rows they check as long as the context
--    carries the organization of the write: they read finance_settings, ledger_accounts, fiscal_periods and journal_entries (all
--    of this phase, by organization) with the role that writes. The few tables of other phases they read (media, orders,
--    order_returns, by store) are covered by the context of the store of the request: see the debt noted for phase 2 and 3;
--  - FORCE: rls_set_enforcement decides it, never this file. The policies bind nobody until the owner turns enforcement on.
-- DROP POLICY takes ACCESS EXCLUSIVE on each table and the locks last until the file commits: give up instead of queueing every
-- query of the ledger behind a long transaction (the deploy is retried)
SET LOCAL lock_timeout = '5s';

SELECT rls_apply_policy('account_period_balances', 'organization');
SELECT rls_apply_policy('account_role_mappings', 'organization');
SELECT rls_apply_policy('ledger_accounts', 'organization');
SELECT rls_apply_policy('payment_method_accounts', 'organization');
SELECT rls_apply_policy('journal_entries', 'organization');
SELECT rls_apply_policy('journal_lines', 'organization');
SELECT rls_apply_policy('finance_settings', 'organization');
SELECT rls_apply_policy('finance_transactions', 'organization');
SELECT rls_apply_policy('finance_posting_failures', 'organization');
SELECT rls_apply_policy('finance_chain_incidents', 'organization');
SELECT rls_apply_policy('finance_book_layouts', 'organization');
SELECT rls_apply_policy('finance_book_snapshots', 'organization');
SELECT rls_apply_policy('tax_rates', 'organization');
SELECT rls_apply_policy('bank_import_profiles', 'organization');
SELECT rls_apply_policy('bank_statement_imports', 'organization');
SELECT rls_apply_policy('bank_statement_lines', 'organization');
SELECT rls_apply_policy('reconciliation_matches', 'organization');
SELECT rls_apply_policy('suppliers', 'organization');
SELECT rls_apply_policy('purchase_orders', 'organization');
SELECT rls_apply_policy('purchase_order_lines', 'organization');
SELECT rls_apply_policy('purchase_receipts', 'organization');
SELECT rls_apply_policy('purchase_receipt_lines', 'organization');
SELECT rls_apply_policy('supplier_payments', 'organization');
SELECT rls_apply_policy('supplier_payment_returns', 'organization');
SELECT rls_apply_policy('fiscal_periods', 'organization');
SELECT rls_apply_policy('fiscal_issuers', 'organization');
SELECT rls_apply_policy('fiscal_sequences', 'organization');
SELECT rls_apply_policy('fiscal_documents', 'organization');
SELECT rls_apply_policy('fiscal_contingencies', 'organization');
