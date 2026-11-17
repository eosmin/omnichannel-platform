-- Bank import profiles (TDD_18 §4.4): the records a profile skips at the start of a file. Some banks print a lead of report lines (titles,
-- the opening and closing balances, the product) before the row of column titles and the movements; the profile says how many records
-- to leave out (a record is a row that is not blank, a quoted line break is inside one). Existing profiles skip none.
ALTER TABLE bank_import_profiles ADD COLUMN skip_rows integer NOT NULL DEFAULT 0;
ALTER TABLE bank_import_profiles
  ADD CONSTRAINT chk_bank_profiles_skip_rows CHECK (skip_rows BETWEEN 0 AND 50);
