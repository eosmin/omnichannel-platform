-- The worker no longer learns the store of a file, an export or a report from its id (RLS phase 5, PR C). Every job of these three
-- carries the store (or, for an avatar, the person) that opens its context, and a job without it fails instead of being resolved in
-- silence. With the functions gone, no role can ask which store owns an arbitrary id.
DROP FUNCTION IF EXISTS rls_store_of_scheduled_report(text);
DROP FUNCTION IF EXISTS rls_store_of_export(text);
DROP FUNCTION IF EXISTS rls_store_of_media(text);
