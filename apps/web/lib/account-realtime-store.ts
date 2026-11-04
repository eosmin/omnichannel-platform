import type { AccountMembership } from '@platform/api-client'

// The account pages belong to no store, yet the bell in their top bar counts the unread
// notifications of the last store, and only the socket of that store tells it a new one arrived.
// The remembered id comes from localStorage, so it may be stale: the socket opens only for a store
// the person belongs to now. A removed member, a suspended one or a person with no remembered store
// get none (the profile lists the suspended stores apart from the memberships).
export function accountRealtimeStoreId(
  profile: { memberships: ReadonlyArray<Pick<AccountMembership, 'storeId'>> },
  lastStoreId: string | null
): string | null {
  if (lastStoreId === null) return null
  return profile.memberships.some(item => item.storeId === lastStoreId) ? lastStoreId : null
}
