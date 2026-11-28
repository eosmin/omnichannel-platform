-- Rolls back 20270218100000_fiscal_annex_export_constancy: the constancia of the exported annexes goes with its tables, its triggers and its
-- function (the documents and the receipts are untouched). It keeps no data the rest of the platform reads: the audit rows of the exports stay.
-- Safe to run twice. A table of the append-only kind refuses DELETE and TRUNCATE, never DROP.
BEGIN;
DROP TABLE IF EXISTS "fiscal_annex_export_items";
DROP TABLE IF EXISTS "fiscal_annex_exports";
DROP FUNCTION IF EXISTS forbid_fiscal_annex_export_change();
COMMIT;
