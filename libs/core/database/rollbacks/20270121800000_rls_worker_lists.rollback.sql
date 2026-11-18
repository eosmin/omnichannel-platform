-- Rollback of 20270121800000_rls_worker_lists: the lists of the worker. Nothing that depends on them is in the database; the code
-- that calls them (WorkerLists) goes first (revert the commit), then this runs. Idempotent.
DROP FUNCTION IF EXISTS rls_list_users_with_pending_email(text, integer);
DROP FUNCTION IF EXISTS rls_list_active_channel_connections(text[], text, text, text, integer);
DROP FUNCTION IF EXISTS rls_list_pickup_targets(text, text, integer);
DROP FUNCTION IF EXISTS rls_list_benefit_close_targets(text, text, integer);
DROP FUNCTION IF EXISTS rls_list_shipment_poll_targets(text, text[], text, text, integer);
DROP FUNCTION IF EXISTS rls_list_enabled_scheduled_reports(text, integer);
DROP FUNCTION IF EXISTS rls_check_page_limit(integer);
