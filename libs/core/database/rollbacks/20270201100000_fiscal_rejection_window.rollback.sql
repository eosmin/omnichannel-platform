-- Rolls back 20270201100000_fiscal_rejection_window: drops the moment a refusal was communicated and the moment the person was warned.
-- Safe to run twice. The window of a document that is refused then reads as unknown (no deadline is shown); nothing else changes.
BEGIN;
ALTER TABLE fiscal_documents DROP COLUMN IF EXISTS rejection_warned_at, DROP COLUMN IF EXISTS rejected_at;
COMMIT;
