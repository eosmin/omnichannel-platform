-- Step 7.2-H2b, C1a: the key of the public form of data requests (GET /compliance/dsr-form, POST and DELETE /compliance/dsr-form/key) is
-- guarded by customers:dsr_manage_form. The Admin role of every store that exists gets it, as the ones made from now on do (RolePresets: the
-- Admin holds every permission). No other role gets it: changing the key breaks every link of the form already published.
-- Rollback: rollbacks/20270128300000_dsr_form_permission.rollback.sql
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, 'customers:dsr_manage_form', r."id"
FROM "roles" r
WHERE r."is_system" AND r."name" = 'Admin'
ON CONFLICT ("role_id", "name") DO NOTHING;
