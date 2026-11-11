-- Step 4.9, PR C1: the first routes guarded by settings:manage_order_templates (write, delete and preview a template of
-- Settings → Order messages) exist. The Admin roles of the stores that exist get it as the ones made from now on do
-- (RolePresets); reading the templates is orders:view, which the roles already have.
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, 'settings:manage_order_templates', r."id"
FROM "roles" r
WHERE r."is_system" AND r."name" = 'Admin'
ON CONFLICT ("role_id", "name") DO NOTHING;
