-- Three SECURITY DEFINER functions kept a search_path older than the convention of the project (`pg_catalog, public, pg_temp`: the catalog
-- named first, pg_temp last). None was exploitable (pg_temp was already last, and the catalog is searched first when it is not named), so this
-- only makes the three read the same as the other 43 and lets one test say "every definer" without a list of exceptions (QA B5, SEG-195).
-- Nothing else about the functions changes: owner, body, grants and volatility stay.
ALTER FUNCTION advance_finance_head() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION apply_journal_line_to_balance() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION purge_audit_logs(text[], text, text, integer, integer) SET search_path = pg_catalog, public, pg_temp;
