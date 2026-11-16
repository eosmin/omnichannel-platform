-- The audit log is append-only for the whole application (TDD_05 §9.3). The first raw SQL migration took UPDATE and DELETE from
-- platform_app only, and left platform_worker with the blanket grant of `GRANT ... ON ALL TABLES`, so a job of the worker (or
-- anything that runs as that role) could rewrite an entry. The worker keeps what it uses: INSERT and SELECT, and DELETE for the
-- cold export of a month it has already copied and verified (retention, Step 5.4). Nothing in the application updates or
-- truncates this table. The database suite checks both roles, so a later grant that gives the privileges back fails the build.
REVOKE UPDATE, TRUNCATE ON TABLE audit_logs FROM platform_app, platform_worker;
