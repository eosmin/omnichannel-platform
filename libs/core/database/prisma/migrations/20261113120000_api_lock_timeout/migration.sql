-- A request of the api that waits for a lock another transaction holds (a migration, a long write, a
-- blocked table) waited for as long as the lock lasted: the connection pool filled with waiting requests
-- and the whole api stopped answering. The role the api connects as now gives up after 5 seconds, which
-- is under the 15 s limit of a tenant transaction (libs/core/database/src/prisma.service.ts), so the
-- caller gets a clear error instead of an expired transaction. Set on the role and not with SET on the
-- connection: through PgBouncer in transaction mode a session setting leaks to other clients (TDD_01).
-- Only for this database, so another one on the same server is not touched. Only the api role: the worker
-- has long jobs of its own and retries them (a decision of its own, in the plan, Step 7.1). The value
-- is ApiLockTimeout.SQL in libs/core/domain/errors/database-errors.ts; a test keeps both equal.
-- Needs the privilege to alter that role, which the migration that created it had: if it is refused here
-- the deploy fails with Postgres's own message, on purpose, instead of leaving the api unprotected.
DO $$
BEGIN
  EXECUTE format('ALTER ROLE platform_app IN DATABASE %I SET lock_timeout = %L', current_database(), '5s');
END
$$;
