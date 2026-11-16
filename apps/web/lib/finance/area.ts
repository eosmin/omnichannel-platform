import { type Permission, ClientPermissions } from '@platform/core/auth'

// Who opens the finance area: the permissions that open at least one page of it. Each step of 4B.9 adds its own (the journal for
// `finance:view_journal`, the transactions for `finance:manage_transactions`, ...) together with its page, so the link of the area
// never leads to an area with nothing in it. The bank reconciliation (`finance:reconcile`) is not one of them on its own: its page also
// reads the chart to offer the accounts (`finance:view`), so it is listed for who holds both.
export const FINANCE_AREA_PERMISSIONS = [
  ClientPermissions.FINANCE_VIEW,
  // The purchases open for these, with no need to read the books (Step 4B.9a-4)
  ClientPermissions.FINANCE_MANAGE_PURCHASES,
  ClientPermissions.FINANCE_MOVE_MONEY,
  // The fiscal documents open for this, with no need to read the books (Step 4B.9b-2)
  ClientPermissions.FISCAL_VIEW
] as const satisfies readonly Permission[]

// What else the books give a person to do once the area is open: the pages and the writes of the later steps of 4B.9 add theirs here.
// They do not open the area (reading the books is `finance:view`); they only weigh in choosing the store the books are asked through.
const FINANCE_WORKING_PERMISSIONS = [
  ClientPermissions.FINANCE_MANAGE_ACCOUNTS,
  ClientPermissions.FINANCE_VIEW_JOURNAL,
  ClientPermissions.FINANCE_MANAGE_TRANSACTIONS,
  ClientPermissions.FINANCE_MOVE_MONEY,
  ClientPermissions.FINANCE_POST_MANUAL,
  ClientPermissions.FISCAL_MANAGE
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
    [...FINANCE_AREA_PERMISSIONS, ...FINANCE_WORKING_PERMISSIONS].filter(permission =>
      membership.permissions.includes(permission)
    ).length
  let best: T | undefined
  for (const membership of memberships) {
    // A store where the area opens nothing (only the permission to change, not to read) is never the one the books are asked through
    if (!opens(membership)) continue
    if (best === undefined || score(membership) > score(best)) best = membership
  }
  return best
}
