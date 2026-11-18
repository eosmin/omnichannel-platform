-- Rolls back 20270121200000_rls_phase2_inbox: removes the policies of the tables of the phase (and turns row security off on
-- them). Safe to run twice.
-- To stop the policies binding anybody while the code stays, turn enforcement off instead (`pnpm db:rls:enforce off`).
BEGIN;

SELECT rls_drop_policy('conversations');
SELECT rls_drop_policy('conversation_origins');
SELECT rls_drop_policy('messages');
SELECT rls_drop_policy('message_reactions');
SELECT rls_drop_policy('message_revisions');
SELECT rls_drop_policy('customers');
SELECT rls_drop_policy('customer_identities');
SELECT rls_drop_policy('customer_merges');
SELECT rls_drop_policy('customer_fiscal_data');
SELECT rls_drop_policy('notifications');
SELECT rls_drop_policy('channel_connections');
SELECT rls_drop_policy('customer_notes');
SELECT rls_drop_policy('addresses');
SELECT rls_drop_policy('"_ConversationTags"');
SELECT rls_drop_policy('"_CustomerTags"');
SELECT rls_drop_policy('media');

COMMIT;
