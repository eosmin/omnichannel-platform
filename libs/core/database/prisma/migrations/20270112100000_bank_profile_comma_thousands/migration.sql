-- Bank import profiles (TDD_18 §4.4): a thousands separator may be the delimiter. A bank that sends a comma file prints 1,234.50 inside
-- quotes; the cell is cut by the delimiter before its amount is read, so the quoted cell is read whole and an unquoted one breaks the
-- row into more cells than the file has (a visible error, never a wrong amount). The rule of the application (`bankProfileProblem`) lost
-- the same clause in the same change. The other separator collisions stay.
ALTER TABLE bank_import_profiles DROP CONSTRAINT chk_bank_profiles_separators;
ALTER TABLE bank_import_profiles
  ADD CONSTRAINT chk_bank_profiles_separators CHECK (
    delimiter <> decimal_separator
    AND NOT (thousands_separator = 'comma' AND decimal_separator = ',')
    AND NOT (thousands_separator = 'dot' AND decimal_separator = '.')
  );
