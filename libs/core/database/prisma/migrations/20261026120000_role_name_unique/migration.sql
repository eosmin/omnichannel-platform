-- A store has one custom role per name, whatever the case (Step 1.4). The index of the first
-- migration compared the name as written, so "Support" and "support" could both exist. The service
-- checks the name to answer politely; this index is what holds when two requests ask for the same
-- name at the same moment. System roles have no store and keep their own index (uq_roles_system_name).
DROP INDEX IF EXISTS uq_roles_store_name;
CREATE UNIQUE INDEX uq_roles_store_name ON roles (store_id, lower(name)) WHERE store_id IS NOT NULL;
