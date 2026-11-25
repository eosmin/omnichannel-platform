-- Rolls back 20270130100000_dsr_export_download: drops the lookup of the public download. Tokens already written stay in `verification_tokens` and
-- expire by their own date; with no lookup nothing can use them. Safe to run twice.
BEGIN;
DROP FUNCTION IF EXISTS resolve_dsr_export_download(text);
DELETE FROM "verification_tokens" WHERE "type" = 'dsr_export_download';
COMMIT;
