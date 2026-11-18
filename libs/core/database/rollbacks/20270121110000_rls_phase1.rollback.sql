-- Rolls back 20270121110000_rls_phase1: drops the lookups and the policies of the tables of phase 1 (rls_drop_policy also turns row
-- security off on each table, so nothing stays enforced without its policy). The tables of later phases are not touched: roll
-- those back first (newest first), then this one, then 20270119100000_rls_foundation. Safe to run twice.
BEGIN;

DROP FUNCTION IF EXISTS resolve_carrier_connection(text);
DROP FUNCTION IF EXISTS resolve_api_key(text);
DROP FUNCTION IF EXISTS resolve_plugin_installation(text);
DROP FUNCTION IF EXISTS resolve_widget_site(text, text);

DROP POLICY IF EXISTS plugins_catalog_ins ON plugins;
DROP POLICY IF EXISTS plugins_catalog_upd ON plugins;
DROP POLICY IF EXISTS audit_logs_insert_unowned ON audit_logs;

SELECT rls_drop_policy('webhook_deliveries');
SELECT rls_drop_policy('audit_logs');
SELECT rls_drop_policy('plugins');
SELECT rls_drop_policy('data_subject_requests');
SELECT rls_drop_policy('consent_records');
SELECT rls_drop_policy('exports');
SELECT rls_drop_policy('metrics_hourly');
SELECT rls_drop_policy('metrics_daily');
SELECT rls_drop_policy('analytics_events');
SELECT rls_drop_policy('scheduled_reports');
SELECT rls_drop_policy('plugin_installations');
SELECT rls_drop_policy('webhooks');
SELECT rls_drop_policy('api_keys');
SELECT rls_drop_policy('notification_preferences');
SELECT rls_drop_policy('retention_settings');
SELECT rls_drop_policy('store_settings');
SELECT rls_drop_policy('routing_rules');
SELECT rls_drop_policy('business_hours');
SELECT rls_drop_policy('snippets');
SELECT rls_drop_policy('tags');

COMMIT;
