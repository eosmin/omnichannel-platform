-- Rolls back 20261218100000_finance_bank_reconciliation. DESTRUCTIVE: the saved bank profiles, the imported statements with their lines
-- and every reconciliation decision (confirmed, rejected, undone) are DROPPED (the journal is not touched: no match ever edited it, so
-- the books are the same after this; the CSV files stay in their bucket and their media rows stay, as finance files of a store, but
-- nothing says which import they were: take a copy of the four tables first if that matters). The immutable tables refuse deletes, so
-- their triggers go first. Run it before the code that reads these tables is brought back. Safe to run twice.
BEGIN;

DROP TRIGGER IF EXISTS trg_journal_entries_reconciled ON journal_entries;
DROP FUNCTION IF EXISTS forbid_reversal_of_reconciled_entry();
DROP TRIGGER IF EXISTS trg_reconciliation_matches_no_truncate ON reconciliation_matches;
DROP TRIGGER IF EXISTS trg_reconciliation_matches_no_delete ON reconciliation_matches;
DROP TRIGGER IF EXISTS trg_reconciliation_matches_check ON reconciliation_matches;
DROP TRIGGER IF EXISTS trg_bank_lines_no_truncate ON bank_statement_lines;
DROP TRIGGER IF EXISTS trg_bank_lines_immutable ON bank_statement_lines;
DROP TRIGGER IF EXISTS trg_bank_lines_check ON bank_statement_lines;
DROP TRIGGER IF EXISTS trg_bank_imports_no_truncate ON bank_statement_imports;
DROP TRIGGER IF EXISTS trg_bank_imports_immutable ON bank_statement_imports;
DROP TRIGGER IF EXISTS trg_bank_imports_check ON bank_statement_imports;
DROP TRIGGER IF EXISTS trg_bank_profiles_check ON bank_import_profiles;

DROP FUNCTION IF EXISTS forbid_reconciliation_match_removal();
DROP FUNCTION IF EXISTS check_reconciliation_match_row();
DROP FUNCTION IF EXISTS forbid_bank_statement_change();
DROP FUNCTION IF EXISTS check_bank_line_row();
DROP FUNCTION IF EXISTS check_bank_import_row();
DROP FUNCTION IF EXISTS check_bank_profile_row();

DROP TABLE IF EXISTS "reconciliation_matches";
DROP TABLE IF EXISTS "bank_statement_lines";
DROP TABLE IF EXISTS "bank_statement_imports";
DROP TABLE IF EXISTS "bank_import_profiles";

COMMIT;
