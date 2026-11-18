-- Row-Level Security, phase 2: conversations, messages, customers, files of a store and the channel connections (TDD_01
-- section 3.2, layer 3; Step 7.1). It DECLARES the policies and turns nothing on: no policy binds anybody until the owner runs
-- rls_set_enforcement (rls_foundation). RLS is the isolation of tenants only, never the visibility by agent (assigned_to).
--
-- 1. Tables with their own store_id: the standard policy.
SELECT rls_apply_policy('conversations', 'store');
SELECT rls_apply_policy('conversation_origins', 'store');
SELECT rls_apply_policy('messages', 'store');
SELECT rls_apply_policy('message_reactions', 'store');
SELECT rls_apply_policy('message_revisions', 'store');
SELECT rls_apply_policy('customers', 'store');
SELECT rls_apply_policy('customer_identities', 'store');
SELECT rls_apply_policy('customer_merges', 'store');
SELECT rls_apply_policy('customer_fiscal_data', 'store');
SELECT rls_apply_policy('notifications', 'store');
SELECT rls_apply_policy('channel_connections', 'store');

-- 2. Tables with no store_id (they hang from a row of a store) and the implicit join tables of Prisma. Each policy asks the
-- store of the parent row in its own predicate, so it isolates even while the policy of the parent table is not enforced yet.
-- The same shape as rls_apply_policy: <table>_tenant for the application roles (USING and WITH CHECK alike) and <table>_owner for
-- the role of the migrations, which owns the tables and which FORCE would otherwise leave with no rows. Written out, not
-- generated, so that validate:rls reads every policy from the file.
DROP POLICY IF EXISTS "customer_notes_tenant" ON customer_notes;
CREATE POLICY "customer_notes_tenant" ON customer_notes AS PERMISSIVE FOR ALL TO platform_app, platform_worker
  USING (
    EXISTS (SELECT 1 FROM customers c WHERE c.id = customer_notes.customer_id
            AND c.store_id = ANY ((SELECT app_store_ids())::text[]))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM customers c WHERE c.id = customer_notes.customer_id
            AND c.store_id = ANY ((SELECT app_store_ids())::text[]))
  );
DROP POLICY IF EXISTS "customer_notes_owner" ON customer_notes;
CREATE POLICY "customer_notes_owner" ON customer_notes AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "addresses_tenant" ON addresses;
CREATE POLICY "addresses_tenant" ON addresses AS PERMISSIVE FOR ALL TO platform_app, platform_worker
  USING (
    EXISTS (SELECT 1 FROM customers c WHERE c.id = addresses.customer_id
            AND c.store_id = ANY ((SELECT app_store_ids())::text[]))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM customers c WHERE c.id = addresses.customer_id
            AND c.store_id = ANY ((SELECT app_store_ids())::text[]))
  );
DROP POLICY IF EXISTS "addresses_owner" ON addresses;
CREATE POLICY "addresses_owner" ON addresses AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

-- Tags of a conversation and of a customer: A is the conversation (or the customer), B the tag. Both are of the SAME store, and
-- that store is in the context (a multi-store context must not link a row of one store to a tag of another)
DROP POLICY IF EXISTS "_ConversationTags_tenant" ON "_ConversationTags";
CREATE POLICY "_ConversationTags_tenant" ON "_ConversationTags" AS PERMISSIVE FOR ALL TO platform_app, platform_worker
  USING (
    EXISTS (SELECT 1 FROM conversations c JOIN tags t ON t.store_id = c.store_id
            WHERE c.id = "_ConversationTags"."A" AND t.id = "_ConversationTags"."B"
              AND c.store_id = ANY ((SELECT app_store_ids())::text[]))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM conversations c JOIN tags t ON t.store_id = c.store_id
            WHERE c.id = "_ConversationTags"."A" AND t.id = "_ConversationTags"."B"
              AND c.store_id = ANY ((SELECT app_store_ids())::text[]))
  );
DROP POLICY IF EXISTS "_ConversationTags_owner" ON "_ConversationTags";
CREATE POLICY "_ConversationTags_owner" ON "_ConversationTags" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "_CustomerTags_tenant" ON "_CustomerTags";
CREATE POLICY "_CustomerTags_tenant" ON "_CustomerTags" AS PERMISSIVE FOR ALL TO platform_app, platform_worker
  USING (
    EXISTS (SELECT 1 FROM customers c JOIN tags t ON t.store_id = c.store_id
            WHERE c.id = "_CustomerTags"."A" AND t.id = "_CustomerTags"."B"
              AND c.store_id = ANY ((SELECT app_store_ids())::text[]))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM customers c JOIN tags t ON t.store_id = c.store_id
            WHERE c.id = "_CustomerTags"."A" AND t.id = "_CustomerTags"."B"
              AND c.store_id = ANY ((SELECT app_store_ids())::text[]))
  );
DROP POLICY IF EXISTS "_CustomerTags_owner" ON "_CustomerTags";
CREATE POLICY "_CustomerTags_owner" ON "_CustomerTags" AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);

-- 3. media: the row of a store, or the avatar of a person (no store, purpose avatar, uploaded_by = the person of the context: the
-- schema says that only an avatar has no store, so a file of a store cannot be turned into one by an UPDATE). One predicate for
-- the four commands. A row with no store and no uploader is never shown nor written by an application role.
DROP POLICY IF EXISTS media_tenant ON media;
CREATE POLICY media_tenant ON media AS PERMISSIVE FOR ALL TO platform_app, platform_worker
  USING (
    store_id = ANY ((SELECT app_store_ids())::text[])
    OR (store_id IS NULL AND purpose = 'avatar' AND uploaded_by = (SELECT app_user_id()))
  )
  WITH CHECK (
    store_id = ANY ((SELECT app_store_ids())::text[])
    OR (store_id IS NULL AND purpose = 'avatar' AND uploaded_by = (SELECT app_user_id()))
  );
DROP POLICY IF EXISTS media_owner ON media;
CREATE POLICY media_owner ON media AS PERMISSIVE FOR ALL TO CURRENT_USER USING (true) WITH CHECK (true);
