-- A store has one tag per name, whatever the case (Step 2.3). The index of the first migration
-- (tags_store_id_name_key) compares the name as written, so "VIP" and "vip" could both exist. The
-- service checks the name to answer politely; this index is what holds when two requests ask for
-- the same name at the same moment.
--
-- A database that already holds two tags of one store that differ only in case cannot take the index:
-- the migration stops with the list instead of failing halfway. Rename one of each pair, then run
-- `prisma migrate resolve --rolled-back 20261026140000_tag_name_unique_ci` and migrate again: Prisma
-- records a migration that raised as failed and refuses to go on until it is resolved.
-- The table is locked against writes from the check to the index, so a writer cannot slip a clash in.
LOCK TABLE tags IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  clashes text;
BEGIN
  SELECT string_agg(store_id || ': ' || names, E'\n') INTO clashes
  FROM (
    SELECT store_id, string_agg(name, ' / ') AS names
    FROM tags
    GROUP BY store_id, lower(name)
    HAVING count(*) > 1
  ) AS pairs;
  IF clashes IS NOT NULL THEN
    RAISE EXCEPTION E'tags that differ only in case, rename one of each pair first:\n%', clashes;
  END IF;
END $$;

CREATE UNIQUE INDEX uq_tags_store_name_ci ON tags (store_id, lower(name));
