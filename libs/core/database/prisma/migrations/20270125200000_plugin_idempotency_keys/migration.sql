-- Step 7.3 S4: the idempotency key of the writes a plugin makes through /api/v1/plugin-api/*. One row per (installation, key): claimed
-- before the write, closed with the answer the route gave, and removed when the write fails. The same installation with the same key
-- gets that answer back instead of a second write, for 24 hours (expires_at); the platform cleanup deletes the expired rows. The row
-- holds the answer, which can carry customer data, so it is a tenant table: the policy below keeps a store from reading another's.
-- Rollback: rollbacks/20270125200000_plugin_idempotency_keys.rollback.sql
CREATE TABLE "plugin_idempotency_keys" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "response_omitted" BOOLEAN NOT NULL DEFAULT false,
    "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plugin_idempotency_keys_pkey" PRIMARY KEY ("id"),
    -- What the header allows (visible ASCII, 1 to 255) and the two states: the database refuses what the code would never write
    CONSTRAINT "plugin_idempotency_keys_key_check" CHECK ("key" ~ '^[\x21-\x7e]{1,255}$'),
    CONSTRAINT "plugin_idempotency_keys_state_check" CHECK ("state" IN ('in_progress', 'completed'))
);

CREATE UNIQUE INDEX "plugin_idempotency_keys_installation_id_key_key" ON "plugin_idempotency_keys"("installation_id", "key");
CREATE INDEX "plugin_idempotency_keys_store_id_expires_at_idx" ON "plugin_idempotency_keys"("store_id", "expires_at");

ALTER TABLE "plugin_idempotency_keys" ADD CONSTRAINT "plugin_idempotency_keys_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plugin_idempotency_keys" ADD CONSTRAINT "plugin_idempotency_keys_installation_id_fkey"
    FOREIGN KEY ("installation_id") REFERENCES "plugin_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The policy of a table of a store (TDD_01 section 3.2, layer 3), declared here; it binds nobody until the owner turns enforcement on
SELECT rls_apply_policy('plugin_idempotency_keys', 'store');
