-- Step 4.8, PR B2: the first routes guarded by settings:manage_carriers (connect, edit, test and disconnect a carrier)
-- and by shipping:view (read the connections) exist. The roles of the stores that exist get the two as the ones made from
-- now on do (RolePresets): settings:manage_carriers is for the Admin; shipping:view for the four system roles. The rest of
-- the shipping:* permissions (manage, manage_pickups) come with the first route they guard (Step 4.8, PR C1).
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, 'settings:manage_carriers', r."id"
FROM "roles" r
WHERE r."is_system" AND r."name" = 'Admin'
ON CONFLICT ("role_id", "name") DO NOTHING;

INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, 'shipping:view', r."id"
FROM "roles" r
WHERE r."is_system" AND r."name" IN ('Admin', 'Supervisor', 'Agent', 'Viewer')
ON CONFLICT ("role_id", "name") DO NOTHING;
