-- finance:view_reports (Step 4B.8b): the statements and the lists with age of the books. The Admin role of every store holds every
-- permission (RolePresets), so the stores that exist get it as the ones made from now on do. No other role holds it (TDD_18 §9.1).
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, 'finance:view_reports', r."id"
FROM "roles" r
WHERE r."is_system" AND r."name" = 'Admin'
ON CONFLICT ("role_id", "name") DO NOTHING;
