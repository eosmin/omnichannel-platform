-- Step 7.2-B: the erasure of the personal data of a customer (POST /customers/:id/erasure) is guarded by customers:erase.
-- The Admin role of every store that exists gets it, as the ones made from now on do (RolePresets: the Admin holds every
-- permission). No other role gets it: the erasure cannot be undone.
-- Rollback: rollbacks/20270124100000_customer_erase_permission.rollback.sql
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, 'customers:erase', r."id"
FROM "roles" r
WHERE r."is_system" AND r."name" = 'Admin'
ON CONFLICT ("role_id", "name") DO NOTHING;
