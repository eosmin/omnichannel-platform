-- Rolls back 20261113120000_api_lock_timeout: the api role waits for a lock as long as it lasts again
-- (a new connection picks the change up; the ones already open keep the old setting until they close).
BEGIN;

DO $$
BEGIN
  EXECUTE format('ALTER ROLE platform_app IN DATABASE %I RESET lock_timeout', current_database());
END
$$;

COMMIT;
