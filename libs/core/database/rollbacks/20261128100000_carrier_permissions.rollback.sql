-- Rolls back 20261128100000_carrier_permissions: takes settings:manage_carriers and shipping:view from every role, the ones
-- the migration gave to the roles that existed and the ones the stores made since got from the presets. Nothing else changes.
-- Run it before the code that guards a route with them is brought back; the stores made after this script would then
-- get them again from RolePresets, so the code that reads them must go first. Safe to run twice.
BEGIN;

DELETE FROM "permissions" WHERE "name" IN ('settings:manage_carriers', 'shipping:view');

COMMIT;
