-- Saying that the accountant vouched for the layout of a legal book (`accountantConfirmed`) is a permission of its own (QA FIS-426):
-- anybody who managed the settings could make a draft look validated. The Admin role of every store holds every permission
-- (RolePresets), so the stores that exist get the new one as the ones made from now on do. No other role holds it.
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, 'finance:confirm_books', r."id"
FROM "roles" r
WHERE r."is_system" AND r."name" = 'Admin'
ON CONFLICT ("role_id", "name") DO NOTHING;
