-- Rolls back 20261026120000_role_name_unique: the index goes back to comparing the name as written.
DROP INDEX IF EXISTS uq_roles_store_name;
CREATE UNIQUE INDEX uq_roles_store_name ON roles (store_id, name) WHERE store_id IS NOT NULL;
