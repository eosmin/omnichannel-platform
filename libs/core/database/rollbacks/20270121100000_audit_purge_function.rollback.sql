-- Rolls back 20270121100000_audit_purge_function: drops the triggers and the purge function and gives platform_worker the
-- DELETE it had on audit_logs, so that the cold export of the previous release (which deletes directly) works again. It
-- REOPENS a known hole (a job of the worker can erase an audit entry): use it only to unblock a deploy and run the migration
-- again after. platform_worker never got UPDATE or TRUNCATE back by this rollback (20270110100000 took them away). Safe to run twice.
BEGIN;

DROP TRIGGER IF EXISTS trg_audit_logs_no_update ON audit_logs;
DROP TRIGGER IF EXISTS trg_audit_logs_no_truncate ON audit_logs;
DROP TRIGGER IF EXISTS trg_audit_logs_purge_entry ON audit_logs;
DROP FUNCTION IF EXISTS forbid_forged_purge_entry();
DROP FUNCTION IF EXISTS forbid_audit_log_change();
DROP FUNCTION IF EXISTS purge_audit_logs(text[], text, text, integer, integer);
GRANT DELETE ON TABLE audit_logs TO platform_worker;

COMMIT;
