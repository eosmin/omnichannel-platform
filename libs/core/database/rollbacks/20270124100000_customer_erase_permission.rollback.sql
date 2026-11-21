-- Rolls back 20270124100000_customer_erase_permission: takes customers:erase from every role, the Admin roles the migration
-- changed and the ones the stores made since got from RolePresets (a custom role may also have been given it by hand).
-- Run it before the code that guards the route with it is brought back. Safe to run twice.
BEGIN;
DELETE FROM "permissions" WHERE "name" = 'customers:erase';
COMMIT;
