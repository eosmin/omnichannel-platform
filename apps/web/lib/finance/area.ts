import { type Permission, ClientPermissions } from '@platform/core/auth'
import { FinanceAreaFamily } from '@platform/core/domain'

import { type SettingsEntry, visibleEntries } from '../settings/entries'

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
  ClientPermissions.FISCAL_MANAGE,
  ClientPermissions.FINANCE_VIEW_REPORTS
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

// What opens a family and what else weighs in choosing its store. A permission may sit in two families (`finance:move_money` moves
// money between accounts in the books and pays a supplier in the purchases): the person's store is chosen for each family on its own.
const FAMILY_OPENING: Record<FinanceAreaFamily, readonly Permission[]> = {
  [FinanceAreaFamily.BOOKS]: [ClientPermissions.FINANCE_VIEW],
  [FinanceAreaFamily.PURCHASES]: [
    ClientPermissions.FINANCE_MANAGE_PURCHASES,
    ClientPermissions.FINANCE_MOVE_MONEY
  ],
  [FinanceAreaFamily.FISCAL]: [ClientPermissions.FISCAL_VIEW]
}
const FAMILY_WORKING: Record<FinanceAreaFamily, readonly Permission[]> = {
  [FinanceAreaFamily.BOOKS]: FINANCE_WORKING_PERMISSIONS,
  // The purchase pages read the chart and offer to pay through `finance:view` and `finance:move_money` of THEIR store, so the store that
  // holds them wins a tie over one that only manages purchases
  [FinanceAreaFamily.PURCHASES]: [ClientPermissions.FINANCE_VIEW],
  [FinanceAreaFamily.FISCAL]: [ClientPermissions.FISCAL_MANAGE]
}

// The page of the area each entry belongs to, by the id of `FINANCE_SETTINGS_ENTRIES` (a spec fails when an entry has none)
export const FINANCE_ENTRY_FAMILY: Record<string, FinanceAreaFamily> = {
  accounts: FinanceAreaFamily.BOOKS,
  journal: FinanceAreaFamily.BOOKS,
  transactions: FinanceAreaFamily.BOOKS,
  taxes: FinanceAreaFamily.BOOKS,
  periods: FinanceAreaFamily.BOOKS,
  reports: FinanceAreaFamily.BOOKS,
  reconciliation: FinanceAreaFamily.BOOKS,
  settings: FinanceAreaFamily.BOOKS,
  suppliers: FinanceAreaFamily.PURCHASES,
  purchases: FinanceAreaFamily.PURCHASES,
  payables: FinanceAreaFamily.PURCHASES,
  fiscal: FinanceAreaFamily.FISCAL,
  fiscalIssuer: FinanceAreaFamily.FISCAL,
  statements: FinanceAreaFamily.BOOKS,
  aging: FinanceAreaFamily.BOOKS,
  books: FinanceAreaFamily.BOOKS,
  vat: FinanceAreaFamily.BOOKS,
  margin: FinanceAreaFamily.BOOKS
}

// The family of the page at a path: the entry whose address is the longest start of it (`/finance/purchases/abc` is the purchases), and
// the books for a path that no entry names
export function financeFamilyOfPath(
  pathname: string,
  entries: readonly { id: string; href: string }[]
): FinanceAreaFamily {
  let best: { id: string; href: string } | undefined
  for (const entry of entries) {
    const matches = pathname === entry.href || pathname.startsWith(`${entry.href}/`)
    if (matches && (best === undefined || entry.href.length > best.href.length)) best = entry
  }
  return (best === undefined ? undefined : FINANCE_ENTRY_FAMILY[best.id]) ?? FinanceAreaFamily.BOOKS
}

// The membership a family is asked of the api through: of the stores that open the family, the one that holds most of its permissions
// (the first wins a tie). Undefined when no store opens it: the page then says "no access" with the store of the area.
export function financeMembershipOfFamily<T extends { permissions: readonly string[] }>(
  family: FinanceAreaFamily,
  memberships: readonly T[]
): T | undefined {
  const opening = FAMILY_OPENING[family]
  const weighing = [...opening, ...FAMILY_WORKING[family]]
  const score = (membership: T): number =>
    weighing.filter(permission => membership.permissions.includes(permission)).length
  let best: T | undefined
  for (const membership of memberships) {
    if (!opening.some(permission => membership.permissions.includes(permission))) continue
    if (best === undefined || score(membership) > score(best)) best = membership
  }
  return best
}

// The entries of the navigation the person may open, each judged by the store its own family is asked through
export function visibleFinanceEntries<T extends { permissions: readonly string[] }>(
  entries: readonly SettingsEntry[],
  memberships: readonly T[]
): SettingsEntry[] {
  return entries.filter(entry => {
    const membership = financeMembershipOfFamily(
      FINANCE_ENTRY_FAMILY[entry.id] ?? FinanceAreaFamily.BOOKS,
      memberships
    )
    return (
      membership !== undefined &&
      visibleEntries([entry], permission => membership.permissions.includes(permission)).length > 0
    )
  })
}
