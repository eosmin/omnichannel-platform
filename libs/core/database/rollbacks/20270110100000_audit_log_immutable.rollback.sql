-- Rolls back 20270110100000_audit_log_immutable: gives platform_worker the UPDATE it had on audit_logs again. platform_app never had
-- it (the first raw SQL migration took it away) and nobody had TRUNCATE, so nothing else changes. Safe to run twice. It REOPENS a
-- known hole (a job of the worker can rewrite an audit entry): use it only to unblock a deploy and run the migration again after.
BEGIN;

GRANT UPDATE ON TABLE audit_logs TO platform_worker;

COMMIT;
