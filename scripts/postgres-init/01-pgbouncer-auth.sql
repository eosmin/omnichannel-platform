-- PgBouncer authenticates every role through auth_user + auth_query instead of a fixed DB_USER,
-- because the api and the worker connect as different roles (Step 0.4). The lookup function is
-- SECURITY DEFINER so the pgbouncer role never needs access to pg_authid itself.
-- Runs once, when the postgres_data volume is first created.
\getenv pgb_password PGBOUNCER_AUTH_PASSWORD

CREATE ROLE pgbouncer LOGIN PASSWORD :'pgb_password';
CREATE SCHEMA pgbouncer AUTHORIZATION pgbouncer;

CREATE FUNCTION pgbouncer.user_lookup(IN i_username text, OUT uname text, OUT phash text)
RETURNS record AS $$
BEGIN
  SELECT rolname, CASE WHEN rolvaliduntil < now() THEN NULL ELSE rolpassword END
  FROM pg_authid
  WHERE rolname = i_username AND rolcanlogin
  INTO uname, phash;
  RETURN;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp;

REVOKE ALL ON FUNCTION pgbouncer.user_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer.user_lookup(text) TO pgbouncer;
