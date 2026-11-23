import { type Permission, ClientPermissions } from '@platform/core/auth'
import { FinanceAreaFamily } from '@platform/core/domain'

import { type SettingsEntry, visibleEntries } from '../settings/entries'

import { FINANCE_WORKING_PERMISSIONS } from './area'

// The family of each finance page and the store each family is asked through. Kept out of `area.ts` on purpose: that file is read by
// the navigation of every store screen, and this one pulls the settings entries with it, so only the finance shell may import it.

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
