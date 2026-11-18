-- Whoever registers a transaction must be able to see it (QA decision of the owner, 2026-11-18): a role that holds
-- finance:manage_transactions, finance:move_money or finance:post_manual gets finance:view_journal if it lacks it. The server and the
-- role editor now keep the pair together (PermissionRequires); this brings the roles that exist up to the same rule. Idempotent.
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, 'finance:view_journal', r."role_id"
FROM (
  SELECT DISTINCT p."role_id"
  FROM "permissions" p
  WHERE p."name" IN ('finance:manage_transactions', 'finance:move_money', 'finance:post_manual')
) r
WHERE NOT EXISTS (
  SELECT 1 FROM "permissions" j WHERE j."role_id" = r."role_id" AND j."name" = 'finance:view_journal'
)
ON CONFLICT ("role_id", "name") DO NOTHING;
