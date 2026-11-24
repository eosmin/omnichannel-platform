-- Rolls back 20270129200000_definer_search_path_convention: the three functions go back to the search_path they had (the one of their own
-- migrations). Nothing else changed, so nothing else is undone. Safe to run twice.
BEGIN;

ALTER FUNCTION advance_finance_head() SET search_path = public, pg_temp;
ALTER FUNCTION apply_journal_line_to_balance() SET search_path = public, pg_temp;
ALTER FUNCTION purge_audit_logs(text[], text, text, integer, integer) SET search_path = pg_catalog, pg_temp;

COMMIT;
