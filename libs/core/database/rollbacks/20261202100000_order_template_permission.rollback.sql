-- Rolls back 20261202100000_order_template_permission: takes settings:manage_order_templates from every role, the ones the
-- migration gave to the roles that existed and the ones the stores made since got from the presets. Nothing else changes.
-- Run it before the code that guards a route with it is brought back; the stores made after this script would then get it
-- again from RolePresets, so the code that reads it must go first. Safe to run twice.
BEGIN;

DELETE FROM "permissions" WHERE "name" = 'settings:manage_order_templates';

COMMIT;
