-- Step 7.2-H1: the data subject request flow (TDD_05 §10.2). The permission that reviews the requests goes to the Admin roles
-- that exist (RolePresets gives it to the ones made from now on); the table gets the columns of the review and the hash of the
-- address that asked, so the limit per address and the duplicate check never read an address.
-- Rollback: rollbacks/20270125100000_dsr_flow.rollback.sql
INSERT INTO "permissions" ("id", "name", "role_id")
SELECT gen_random_uuid()::text, 'customers:dsr_review', r."id"
FROM "roles" r
WHERE r."is_system" AND r."name" = 'Admin'
ON CONFLICT ("role_id", "name") DO NOTHING;

ALTER TABLE "data_subject_requests"
  ADD COLUMN "subject_email_hash" TEXT,
  ADD COLUMN "reviewed_by" TEXT,
  ADD COLUMN "reviewed_at" TIMESTAMP(3),
  ADD COLUMN "subject_customer_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "notify_to_encrypted" BYTEA,
  ADD COLUMN "approvals" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "erasure_due_at" TIMESTAMP(3);

-- The key a store gives to its public form (128 random bits); NULL = the store takes no public requests
ALTER TABLE "stores" ADD COLUMN "dsr_public_key" TEXT;
CREATE UNIQUE INDEX "stores_dsr_public_key_key" ON "stores" ("dsr_public_key");
CREATE INDEX "ix_dsr_erasure_due" ON "data_subject_requests" ("erasure_due_at") WHERE "status" = 'in_progress';

CREATE INDEX "ix_dsr_open_by_subject" ON "data_subject_requests" ("store_id", "subject_email_hash", "type")
  WHERE "status" IN ('pending_verification', 'manual_review', 'in_progress');

-- The two lookups of the public flow, which run before there is a tenant context (the pattern of rls_phase1, section 5): the public key
-- a store gave to its form, and the verification token of a request. Each answers ONE row for an exact key with the ids that open the
-- context and nothing else. A token is found only while it is unused and not expired, and its request still waits for it.
CREATE FUNCTION resolve_dsr_store(p_public_key text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT s.id, s.id, s.organization_id
    FROM stores s
    WHERE s.dsr_public_key = p_public_key
    LIMIT 1
  $$;

CREATE FUNCTION resolve_dsr_verification(p_token_hash text)
  RETURNS TABLE (id text, store_id text, organization_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT r.id, r.store_id, r.organization_id
    FROM verification_tokens t
    JOIN data_subject_requests r ON r.id = t.subject
    WHERE t.token_hash = p_token_hash
      AND t.type = 'dsr_verification'
      AND t.used_at IS NULL
      AND t.expires_at > now()
      AND r.status = 'pending_verification'
      AND r.store_id IS NOT NULL
    LIMIT 1
  $$;

REVOKE ALL ON FUNCTION resolve_dsr_store(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_dsr_verification(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_dsr_store(text) TO platform_app, platform_worker;
GRANT EXECUTE ON FUNCTION resolve_dsr_verification(text) TO platform_app, platform_worker;
