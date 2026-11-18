import type { RlsExemption } from './lib/rls'

// The phases of the RLS step (docs/IMPLEMENTATION_PLAN.md, Step 7.1): 1 configuration, catalogs and audit, 2 conversations and
// customers, 3 orders, inventory and shipping, 4 finance and fiscal. Each phase is a migration that calls rls_apply_policy for its
// tables and deletes their lines from this list in the same change. The four phases have landed, so no table is pending now: a new
// table that is neither covered nor global fails validate:rls. A `pending(phase, reason)` helper comes back with the next phase.
export const RLS_PHASES: readonly number[] = [1, 2, 3, 4]

const neverPolicy = (reason: string): RlsExemption => ({ kind: 'global', reason })

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
  permissions: neverPolicy(`${GUARD_READS}, with its role`)
}
