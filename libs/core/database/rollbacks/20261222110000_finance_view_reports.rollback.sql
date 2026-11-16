-- Rolls back 20261222110000_finance_view_reports: the permission is removed from every role that holds it. Nothing else is touched.
-- DESTRUCTIVE only for the grants (a role that was given it by hand loses it). Safe to run twice.
BEGIN;
DELETE FROM "permissions" WHERE "name" = 'finance:view_reports';
COMMIT;
