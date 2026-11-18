// The models whose tables never get a Row-Level Security policy, because a guard or a public flow reads them before any tenant
// context exists (identity, the stores of a user, the invitation token) or because the row is a person's and not a store's. The
// reason of each is in scripts/rls-exceptions.ts; `pnpm validate:rls` fails when this list and the global tables of that file
// differ. Every other model needs a tenant context to be queried once RLS_CONTEXT is on (PrismaService.requireContext).
export const RlsGlobalModels: readonly string[] = [
  'Organization',
  'User',
  'Session',
  'VerificationToken',
  'Store',
  'Membership',
  'Invitation',
  'CookieConsent',
  'ProcessedWebhookEvent',
  'UserNotificationSettings',
  'PushSubscription',
  'Role',
  'Permission'
]
