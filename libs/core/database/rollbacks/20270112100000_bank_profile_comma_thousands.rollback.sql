-- Rolls back 20270112100000_bank_profile_comma_thousands: puts the clause back that refuses a comma as thousands separator in a profile
-- whose delimiter is a comma. A profile saved meanwhile with that pair is not rejected by the rollback (NOT VALID: the constraint holds
-- for every later insert and update, and the rows that exist are not checked): change those profiles before running the migration
-- again. Safe to run twice.
BEGIN;

ALTER TABLE bank_import_profiles DROP CONSTRAINT IF EXISTS chk_bank_profiles_separators;
ALTER TABLE bank_import_profiles
  ADD CONSTRAINT chk_bank_profiles_separators CHECK (
    delimiter <> decimal_separator
    AND NOT (thousands_separator = 'comma' AND decimal_separator = ',')
    AND NOT (thousands_separator = 'dot' AND decimal_separator = '.')
    AND NOT (thousands_separator = 'comma' AND delimiter = ',')
  ) NOT VALID;

COMMIT;
