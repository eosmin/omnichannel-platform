-- Rolls back 20261026140000_tag_name_unique_ci: the name is compared as written again.
DROP INDEX IF EXISTS uq_tags_store_name_ci;
