-- Rolls back 20261213110000_finance_ledger. DESTRUCTIVE: the finance settings, the chart of accounts, the role maps, the
-- fiscal periods, the whole journal with its lines, the period balances and the posting failures are DROPPED with their rows
-- (the books are lost; take a copy of the tables or of the journal CSV first if their rows matter), and the finance:* and
-- fiscal:* permissions are taken from the roles. The journal is append-only, so its triggers are dropped before its rows
-- go. Run it before the code that reads these tables is brought back. Safe to run twice.
BEGIN;

DELETE FROM "permissions" WHERE "name" LIKE 'finance:%' OR "name" LIKE 'fiscal:%';

DROP TRIGGER IF EXISTS trg_journal_lines_balance ON journal_lines;
DROP TRIGGER IF EXISTS trg_fiscal_periods_guard ON fiscal_periods;
DROP TRIGGER IF EXISTS trg_ledger_accounts_guard ON ledger_accounts;
DROP TRIGGER IF EXISTS trg_finance_settings_head ON finance_settings;
DROP TRIGGER IF EXISTS trg_journal_lines_balanced ON journal_lines;
DROP TRIGGER IF EXISTS trg_journal_entries_balanced ON journal_entries;
DROP TRIGGER IF EXISTS trg_journal_lines_insert ON journal_lines;
DROP TRIGGER IF EXISTS trg_journal_entries_advance ON journal_entries;
DROP TRIGGER IF EXISTS trg_journal_entries_insert ON journal_entries;
DROP TRIGGER IF EXISTS trg_journal_lines_no_truncate ON journal_lines;
DROP TRIGGER IF EXISTS trg_journal_lines_append_only ON journal_lines;
DROP TRIGGER IF EXISTS trg_journal_entries_no_truncate ON journal_entries;
DROP TRIGGER IF EXISTS trg_journal_entries_append_only ON journal_entries;
DROP FUNCTION IF EXISTS apply_journal_line_to_balance();
DROP FUNCTION IF EXISTS guard_fiscal_period_change();
DROP FUNCTION IF EXISTS guard_ledger_account_change();
DROP FUNCTION IF EXISTS guard_finance_head();
DROP FUNCTION IF EXISTS check_journal_entry_balanced();
DROP FUNCTION IF EXISTS check_journal_line_insert();
DROP FUNCTION IF EXISTS advance_finance_head();
DROP FUNCTION IF EXISTS check_journal_entry_insert();
DROP FUNCTION IF EXISTS forbid_journal_change();

-- Back to what the default privileges gave (no TRUNCATE: the roles never held it)
DO $$
BEGIN
  IF to_regclass('journal_entries') IS NOT NULL AND to_regclass('journal_lines') IS NOT NULL THEN
    GRANT UPDATE, DELETE ON TABLE journal_entries, journal_lines TO platform_app, platform_worker;
  END IF;
END $$;

-- Children first: lines refer to entries, entries to periods, and everything to accounts and to the organization
DROP TABLE IF EXISTS journal_lines;
DROP TABLE IF EXISTS journal_entries;
DROP TABLE IF EXISTS account_period_balances;
DROP TABLE IF EXISTS finance_posting_failures;
DROP TABLE IF EXISTS account_role_mappings;
DROP TABLE IF EXISTS payment_method_accounts;
DROP TABLE IF EXISTS finance_settings;
DROP TABLE IF EXISTS fiscal_periods;
DROP TABLE IF EXISTS ledger_accounts;

COMMIT;
