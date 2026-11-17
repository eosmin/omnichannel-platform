-- Rolls back 20270113100000_bank_profile_skip_rows: drops the column that says how many records of a file a bank profile skips. A profile
-- that skipped some would read the lead of its file as data and refuse it (nothing is imported half): set it up again after the migration
-- runs again. Safe to run twice.
BEGIN;

ALTER TABLE bank_import_profiles DROP CONSTRAINT IF EXISTS chk_bank_profiles_skip_rows;
ALTER TABLE bank_import_profiles DROP COLUMN IF EXISTS skip_rows;

COMMIT;
