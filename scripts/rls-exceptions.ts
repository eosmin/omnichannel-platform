import type { RlsExemption } from './lib/rls'

// The phases of the RLS step (docs/IMPLEMENTATION_PLAN.md, Step 7.1): 1 configuration, catalogs and audit, 2 conversations and
// customers, 3 orders, inventory and shipping, 4 finance and fiscal. Each phase is a migration that calls rls_apply_policy for its
// tables and deletes their lines from RLS_PENDING in the same change. The list only shrinks; it ends empty.
export const RLS_PHASES: readonly number[] = [1, 2, 3, 4]

const pending = (phase: number, reason: string): RlsExemption => ({
  kind: 'pending',
  phase,
  reason
})
const neverPolicy = (reason: string): RlsExemption => ({ kind: 'global', reason })

const BY_PARENT =
  'No store column: its policy goes through its parent (EXISTS on the parent, whose own policy applies)'
const GUARD_READS = 'Read by a guard or a public flow before any tenant context exists'
const OF_A_PERSON = 'A row of a person, not of a store: the id always comes from the token'

export const RLS_EXEMPTIONS: Readonly<Record<string, RlsExemption>> = {
  // Never get a tenant policy
  organizations: neverPolicy(GUARD_READS),
  users: neverPolicy(GUARD_READS),
  sessions: neverPolicy(GUARD_READS),
  verification_tokens: neverPolicy('Magic-link tokens, read before anybody is authenticated'),
  stores: neverPolicy(
    `${GUARD_READS}: the TenantGuard resolves the store and its organization from it`
  ),
  memberships: neverPolicy(`${GUARD_READS}: the TenantGuard lists the stores of a user from it`),
  invitations: neverPolicy('Invitation preview and accept are public and carry only the token'),
  cookie_consents: neverPolicy('Recorded before login, by visitor'),
  processed_webhook_events: neverPolicy(
    'Webhook idempotency keyed by the provider event id, written before the store is known'
  ),
  user_notification_settings: neverPolicy(OF_A_PERSON),
  push_subscriptions: neverPolicy(OF_A_PERSON),

  // Phase 1 (configuration, catalogs, audit, analytics) has its policies: migration 20270121110000_rls_phase1. These two stay global.
  roles: neverPolicy(
    `${GUARD_READS}: the permissions of a member are resolved from it before the context is set`
  ),
  permissions: neverPolicy(`${GUARD_READS}, with its role`),

  // Phase 2: conversations, customers, media
  conversations: pending(2, 'Inbox'),
  conversation_origins: pending(2, 'Inbox'),
  messages: pending(2, 'Inbox'),
  message_reactions: pending(2, 'Inbox'),
  message_revisions: pending(2, 'Inbox'),
  channel_connections: pending(2, 'Channels; inbound webhooks run in the worker'),
  customers: pending(2, 'Customers'),
  customer_identities: pending(2, 'Customers'),
  customer_merges: pending(2, 'Customers'),
  customer_fiscal_data: pending(2, 'Customers'),
  customer_notes: pending(2, BY_PARENT),
  addresses: pending(2, BY_PARENT),
  media: pending(2, 'Files of a store'),
  notifications: pending(2, 'Inbox')
}
