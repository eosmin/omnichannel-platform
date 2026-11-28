-- Rolls back 20270215100000_excluded_subject_purchases: the purchases from excluded subjects and their concepts go with their tables, and so do
-- their triggers. Nothing else refers to them. Safe to run twice. WARNING: the sealed personal data of the sellers goes with the tables: in
-- production take a backup of both tables first.
BEGIN;
DROP TABLE IF EXISTS "excluded_subject_purchase_lines";
DROP TABLE IF EXISTS "excluded_subject_purchases";
DROP FUNCTION IF EXISTS check_excluded_subject_purchase_total();
DROP FUNCTION IF EXISTS check_excluded_subject_purchase_lines_total();
DROP FUNCTION IF EXISTS fiscal_reseal_excluded_subject(text, text, bytea, bytea);
DROP FUNCTION IF EXISTS guard_excluded_subject_purchase();
DROP FUNCTION IF EXISTS forbid_excluded_subject_purchase_change();
COMMIT;
