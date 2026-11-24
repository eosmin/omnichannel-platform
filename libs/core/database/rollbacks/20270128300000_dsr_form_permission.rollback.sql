-- Rolls back 20270128300000_dsr_form_permission: takes customers:dsr_manage_form from every role, the Admin roles the migration changed and
-- the ones the stores made since got from RolePresets (a custom role may also have been given it by hand). The keys already made stay in
-- stores.dsr_public_key. Run it before the code that guards the routes with it is brought back. Safe to run twice.
BEGIN;
DELETE FROM "permissions" WHERE "name" = 'customers:dsr_manage_form';
COMMIT;
