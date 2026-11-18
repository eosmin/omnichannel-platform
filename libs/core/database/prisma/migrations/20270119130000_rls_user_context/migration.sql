-- The person of a unit of work, for the policies of the rows that belong to a person and not to a store (an avatar upload that
-- has no store, a notification of several stores). Set by PrismaService with set_config('app.user_id', ..., true), transaction-local
-- like the stores and the organizations. An empty context answers NULL, and a policy that compares with NULL matches nothing:
-- it fails closed. Nothing changes for the application by running this file: no policy calls it yet.
CREATE OR REPLACE FUNCTION public.app_user_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$
    SELECT nullif(current_setting('app.user_id', true), '')
  $$;

GRANT EXECUTE ON FUNCTION app_user_id() TO platform_app, platform_worker;
