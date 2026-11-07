-- Rolls back 20261114120000_push_default_rows: nothing to do, on purpose, and only together with the
-- code of before it (revert both: with the new code a missing row reads as push on). The migration only removed rows
-- that held exactly the old default of their type, and a missing row is read as the default of the code
-- that runs. With the code of before this migration, the missing row resolves to the old default, which
-- is the very value the row had: nobody's effective setting changes. Deleted rows are not recreated
-- (they carried no information); rows that people saved after the migration are left as they are.
BEGIN;
-- (no statements)
COMMIT;
