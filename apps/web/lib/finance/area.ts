import { type Permission, ClientPermissions } from '@platform/core/auth'

// Who opens the finance area: the permissions that open at least one page of it. Each step of 4B.9 adds its own (the journal for
// `finance:view_journal`, the transactions for `finance:manage_transactions`, ...) together with its page, so the link of the area
// never leads to an area with nothing in it.
export const FINANCE_AREA_PERMISSIONS = [
  ClientPermissions.FINANCE_VIEW
] as const satisfies readonly Permission[]

export const mayOpenFinance = (can: (permission: Permission) => boolean): boolean =>
  FINANCE_AREA_PERMISSIONS.some(permission => can(permission))

// The membership the books are asked of the api through: the books are the organization's, but the permissions are the store's, so of
// the stores of the person the one that holds most of the finance permissions comes first (the one that can change them over the one
// that can only read), and the first of them wins a tie.
export function bestFinanceMembership<T extends { permissions: readonly string[] }>(
  memberships: readonly T[]
): T | undefined {
  const opens = (membership: T): boolean =>
    FINANCE_AREA_PERMISSIONS.some(permission => membership.permissions.includes(permission))
  const score = (membership: T): number =>
    FINANCE_AREA_PERMISSIONS.filter(permission => membership.permissions.includes(permission))
      .length + (membership.permissions.includes(ClientPermissions.FINANCE_MANAGE_ACCOUNTS) ? 1 : 0)
  let best: T | undefined
  for (const membership of memberships) {
    // A store where the area opens nothing (only the permission to change, not to read) is never the one the books are asked through
    if (!opens(membership)) continue
    if (best === undefined || score(membership) > score(best)) best = membership
  }
  return best
}
