-- Rolls back 20270125300000_consent_records_append_only: drops the two triggers and their function, so that consent_records can be
-- updated, deleted and truncated again by anything with the privilege. It REOPENS the hole the migration closed (a row of what a person
-- said can be rewritten): use it only to unblock a deploy, and apply the migration again after. The policy and the grants of the table
-- were never touched. Safe to run twice.
BEGIN;
DROP TRIGGER IF EXISTS trg_consent_records_append_only ON consent_records;
DROP TRIGGER IF EXISTS trg_consent_records_no_truncate ON consent_records;
DROP FUNCTION IF EXISTS forbid_consent_record_change();
COMMIT;
