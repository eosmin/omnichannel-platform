-- Rolls back 20261216100000_finance_transactions. DESTRUCTIVE: every expense, income and transfer registered by hand is DROPPED
-- with its row (the journal entries they posted stay: the journal is append-only and is not touched here, so after this the
-- entries have no operational header; take a copy of the table first if the rows matter). The table refuses deletes, so its
-- triggers go first. Run it before the code that reads this table is brought back. Safe to run twice.
BEGIN;

DROP TRIGGER IF EXISTS trg_finance_transactions_no_truncate ON finance_transactions;
DROP TRIGGER IF EXISTS trg_finance_transactions_no_delete ON finance_transactions;
DROP TRIGGER IF EXISTS trg_finance_transactions_check ON finance_transactions;
DROP FUNCTION IF EXISTS forbid_finance_transaction_removal();
DROP FUNCTION IF EXISTS check_finance_transaction_row();

DROP TABLE IF EXISTS "finance_transactions";

COMMIT;
