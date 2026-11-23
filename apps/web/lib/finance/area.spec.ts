import { type Permission, Permissions } from '@platform/core/auth'
import { FinanceAreaFamily } from '@platform/core/domain'

import { FINANCE_SETTINGS_ENTRIES, firstVisibleHref, visibleEntries } from '../settings/entries'

import {
  bestFinanceMembership,
  FINANCE_AREA_PERMISSIONS,
  FINANCE_ENTRY_FAMILY,
  financeFamilyOfPath,
  financeMembershipOfFamily,
  mayOpenFinance,
  visibleFinanceEntries
} from './area'

const holding =
  (...held: Permission[]) =>
  (permission: Permission): boolean =>
    held.includes(permission)

describe('the finance area', () => {
  it('opens for the permissions that open a page of it, and for nothing else', () => {
    for (const permission of FINANCE_AREA_PERMISSIONS) {
      expect(mayOpenFinance(holding(permission))).toBe(true)
    }
    expect(mayOpenFinance(holding(Permissions.ORDERS_VIEW, Permissions.SETTINGS_VIEW))).toBe(false)
    // Holding only the permission to export or to post by hand opens no page yet: the link would lead nowhere
    expect(
      mayOpenFinance(holding(Permissions.FINANCE_EXPORT, Permissions.FINANCE_POST_MANUAL))
    ).toBe(false)
    expect(mayOpenFinance(holding())).toBe(false)
  })

  it('opens an area where every page that its permissions open exists', () => {
    for (const permission of FINANCE_AREA_PERMISSIONS) {
      expect(visibleEntries(FINANCE_SETTINGS_ENTRIES, holding(permission)).length).toBeGreaterThan(
        0
      )
    }
  })

  it('shows the journal and the transactions to who may read the journal, and only to them', () => {
    expect(
      visibleEntries(
        FINANCE_SETTINGS_ENTRIES,
        holding(Permissions.FINANCE_VIEW, Permissions.FINANCE_VIEW_JOURNAL)
      ).map(entry => entry.id)
    ).toEqual([
      'accounts',
      'journal',
      'transactions',
      'taxes',
      'periods',
      'reports',
      'settings',
      'vat'
    ])
  })

  it('lists the journal for the journal permission alone, while the area itself still needs finance:view', () => {
    // The area guard (the link and the store the books are asked through) is finance:view; the navigation only shows what each page needs
    expect(mayOpenFinance(holding(Permissions.FINANCE_VIEW_JOURNAL))).toBe(false)
    expect(
      bestFinanceMembership([{ id: 's', permissions: [Permissions.FINANCE_VIEW_JOURNAL] }])
    ).toBeUndefined()
  })

  it('opens the area for fiscal:view alone, with only the two fiscal pages', () => {
    expect(mayOpenFinance(holding(Permissions.FISCAL_VIEW))).toBe(true)
    expect(
      visibleEntries(FINANCE_SETTINGS_ENTRIES, holding(Permissions.FISCAL_VIEW)).map(
        entry => entry.id
      )
    ).toEqual(['fiscal', 'fiscalIssuer'])
    expect(firstVisibleHref(FINANCE_SETTINGS_ENTRIES, holding(Permissions.FISCAL_VIEW))).toBe(
      '/finance/fiscal'
    )
    // Managing without reading opens nothing: the pages read first
    expect(mayOpenFinance(holding(Permissions.FISCAL_MANAGE))).toBe(false)
  })

  it('adds the bank reconciliation for who also holds finance:reconcile, and never for who holds only that', () => {
    expect(
      visibleEntries(
        FINANCE_SETTINGS_ENTRIES,
        holding(Permissions.FINANCE_VIEW, Permissions.FINANCE_RECONCILE)
      ).map(entry => entry.id)
    ).toEqual(['accounts', 'taxes', 'periods', 'reports', 'reconciliation', 'settings', 'vat'])
    // finance:reconcile alone opens no area: the page reads the chart to offer its accounts, which is finance:view
    expect(mayOpenFinance(holding(Permissions.FINANCE_RECONCILE))).toBe(false)
  })

  it('shows the pages of the books to who holds finance:view, and none to who holds only another permission', () => {
    expect(
      visibleEntries(FINANCE_SETTINGS_ENTRIES, holding(Permissions.FINANCE_VIEW)).map(
        entry => entry.id
      )
    ).toEqual(['accounts', 'taxes', 'periods', 'reports', 'settings', 'vat'])
    // Paying opens the payables and nothing of the books; managing purchases opens the three pages of purchases and nothing of the books
    expect(
      visibleEntries(FINANCE_SETTINGS_ENTRIES, holding(Permissions.FINANCE_MOVE_MONEY)).map(
        entry => entry.id
      )
    ).toEqual(['payables'])
    expect(
      visibleEntries(FINANCE_SETTINGS_ENTRIES, holding(Permissions.FINANCE_MANAGE_PURCHASES)).map(
        entry => entry.id
      )
    ).toEqual(['suppliers', 'purchases', 'payables'])
    expect(
      firstVisibleHref(FINANCE_SETTINGS_ENTRIES, holding(Permissions.FINANCE_MANAGE_PURCHASES))
    ).toBe('/finance/suppliers')
    expect(firstVisibleHref(FINANCE_SETTINGS_ENTRIES, holding())).toBeNull()
    expect(firstVisibleHref(FINANCE_SETTINGS_ENTRIES, holding(Permissions.FINANCE_VIEW))).toBe(
      '/finance/accounts'
    )
  })

  it('shows the statements, the lists with age and the legal books to who holds finance:view_reports, and to nobody else', () => {
    expect(
      visibleEntries(FINANCE_SETTINGS_ENTRIES, holding(Permissions.FINANCE_VIEW_REPORTS)).map(
        entry => entry.id
      )
    ).toEqual(['statements', 'aging', 'books', 'margin'])
    expect(
      visibleEntries(FINANCE_SETTINGS_ENTRIES, holding(Permissions.FINANCE_EXPORT)).map(
        entry => entry.id
      )
    ).toEqual([])
    // finance:view_reports alone opens no area: every page reads the setup first, which is finance:view
    expect(mayOpenFinance(holding(Permissions.FINANCE_VIEW_REPORTS))).toBe(false)
  })

  it('counts the reports among what a store gives, so the books are asked through the store that holds them', () => {
    const store = (id: string, ...permissions: string[]) => ({ id, permissions })
    expect(
      bestFinanceMembership([
        store('reader', Permissions.FINANCE_VIEW),
        store('accountant', Permissions.FINANCE_VIEW, Permissions.FINANCE_VIEW_REPORTS)
      ])?.id
    ).toBe('accountant')
  })
})

describe('bestFinanceMembership', () => {
  const store = (id: string, ...permissions: string[]) => ({ id, permissions })

  it('prefers the store where the person can change the books over the one where they only read', () => {
    const best = bestFinanceMembership([
      store('reader', Permissions.FINANCE_VIEW),
      store('manager', Permissions.FINANCE_VIEW, Permissions.FINANCE_MANAGE_ACCOUNTS)
    ])
    expect(best?.id).toBe('manager')
  })

  it('counts the journal and the registering of transactions among what a store gives', () => {
    const best = bestFinanceMembership([
      store('manager', Permissions.FINANCE_VIEW, Permissions.FINANCE_MANAGE_ACCOUNTS),
      store(
        'bookkeeper',
        Permissions.FINANCE_VIEW,
        Permissions.FINANCE_VIEW_JOURNAL,
        Permissions.FINANCE_MANAGE_TRANSACTIONS
      )
    ])
    expect(best?.id).toBe('bookkeeper')
  })

  it('takes a store where the person manages purchases even when they cannot read the books', () => {
    expect(bestFinanceMembership([store('buys', Permissions.FINANCE_MANAGE_PURCHASES)])?.id).toBe(
      'buys'
    )
  })

  it('never takes a store where the person can change the books but not read them', () => {
    const best = bestFinanceMembership([
      store('writes', Permissions.FINANCE_MANAGE_ACCOUNTS),
      store('reads', Permissions.FINANCE_VIEW)
    ])
    expect(best?.id).toBe('reads')
    expect(
      bestFinanceMembership([store('writes', Permissions.FINANCE_MANAGE_ACCOUNTS)])
    ).toBeUndefined()
  })

  it('keeps the first store on a tie, skips the ones with no finance permission, and is none when no store has one', () => {
    expect(
      bestFinanceMembership([
        store('none', Permissions.ORDERS_VIEW),
        store('first', Permissions.FINANCE_VIEW),
        store('second', Permissions.FINANCE_VIEW)
      ])?.id
    ).toBe('first')
    expect(bestFinanceMembership([store('none', Permissions.ORDERS_VIEW)])).toBeUndefined()
    expect(bestFinanceMembership([])).toBeUndefined()
  })
})

describe('the family of each finance page', () => {
  it('gives every entry of the navigation a family', () => {
    for (const entry of FINANCE_SETTINGS_ENTRIES) {
      expect(FINANCE_ENTRY_FAMILY[entry.id]).toBeDefined()
    }
  })

  it('reads the family of a path from the longest entry that starts it', () => {
    const family = (path: string): FinanceAreaFamily =>
      financeFamilyOfPath(path, FINANCE_SETTINGS_ENTRIES)
    expect(family('/finance/fiscal')).toBe(FinanceAreaFamily.FISCAL)
    expect(family('/finance/fiscal/issuer')).toBe(FinanceAreaFamily.FISCAL)
    expect(family('/finance/purchases/abc')).toBe(FinanceAreaFamily.PURCHASES)
    expect(family('/finance/payables')).toBe(FinanceAreaFamily.PURCHASES)
    expect(family('/finance/journal')).toBe(FinanceAreaFamily.BOOKS)
    // A path that no entry names is the books
    expect(family('/finance')).toBe(FinanceAreaFamily.BOOKS)
    // A prefix that is not a whole segment is not the entry
    expect(family('/finance/fiscalx')).toBe(FinanceAreaFamily.BOOKS)
  })
})

describe('the store each family is asked through', () => {
  const books = { id: 'books', permissions: [Permissions.FINANCE_VIEW] }
  const fiscal = { id: 'fiscal', permissions: [Permissions.FISCAL_VIEW] }
  const both = { id: 'both', permissions: [Permissions.FINANCE_VIEW, Permissions.FISCAL_VIEW] }
  const buyer = { id: 'buyer', permissions: [Permissions.FINANCE_MANAGE_PURCHASES] }

  it('asks each family through the store that holds its own permissions', () => {
    const stores = [books, fiscal, buyer]
    expect(financeMembershipOfFamily(FinanceAreaFamily.BOOKS, stores)).toBe(books)
    expect(financeMembershipOfFamily(FinanceAreaFamily.FISCAL, stores)).toBe(fiscal)
    expect(financeMembershipOfFamily(FinanceAreaFamily.PURCHASES, stores)).toBe(buyer)
  })

  it('has no store for a family that none opens, and keeps the first of a tie', () => {
    expect(financeMembershipOfFamily(FinanceAreaFamily.FISCAL, [books, buyer])).toBeUndefined()
    expect(financeMembershipOfFamily(FinanceAreaFamily.BOOKS, [books, both])).toBe(books)
  })

  it('prefers the store that holds more of the permissions of the family', () => {
    const manager = {
      id: 'manager',
      permissions: [Permissions.FISCAL_VIEW, Permissions.FISCAL_MANAGE]
    }
    expect(financeMembershipOfFamily(FinanceAreaFamily.FISCAL, [fiscal, manager])).toBe(manager)
  })

  it('lists the fiscal pages for fiscal:view held in another store than finance:view', () => {
    // The page of the fiscal documents is asked of the api through `fiscal`, where the permission is, and the books through `books`
    expect(
      visibleFinanceEntries(FINANCE_SETTINGS_ENTRIES, [books, fiscal]).map(entry => entry.id)
    ).toEqual(expect.arrayContaining(['accounts', 'fiscal', 'fiscalIssuer']))
  })

  it('does not list the books for a person who holds only fiscal permissions', () => {
    expect(
      visibleFinanceEntries(FINANCE_SETTINGS_ENTRIES, [fiscal]).map(entry => entry.id)
    ).toEqual(['fiscal', 'fiscalIssuer'])
  })

  it('judges a page by the permissions of its own family store, not by the sum of the stores', () => {
    // The journal needs finance:view_journal IN the store the books are asked through: a store that only reads the books does not give it
    const journalElsewhere = { id: 'j', permissions: [Permissions.FINANCE_VIEW_JOURNAL] }
    expect(
      visibleFinanceEntries(FINANCE_SETTINGS_ENTRIES, [books, journalElsewhere]).map(
        entry => entry.id
      )
    ).not.toContain('journal')
  })

  it('picks, for the purchases, the store that also reads the chart over one that only manages purchases', () => {
    const a = { id: 'a', permissions: [Permissions.FINANCE_MANAGE_PURCHASES] }
    const b = {
      id: 'b',
      permissions: [Permissions.FINANCE_MANAGE_PURCHASES, Permissions.FINANCE_VIEW]
    }
    expect(financeMembershipOfFamily(FinanceAreaFamily.PURCHASES, [a, b])).toBe(b)
    expect(financeMembershipOfFamily(FinanceAreaFamily.PURCHASES, [b, a])).toBe(b)
  })

  it('opens the purchases for a store that holds only finance:move_money', () => {
    const payer = { id: 'p', permissions: [Permissions.FINANCE_MOVE_MONEY] }
    expect(financeMembershipOfFamily(FinanceAreaFamily.PURCHASES, [payer])).toBe(payer)
  })

  it('weighs fiscal:manage over a store that only reads the fiscal documents', () => {
    const reader = { id: 'r', permissions: [Permissions.FISCAL_VIEW] }
    const manager = {
      id: 'm',
      permissions: [Permissions.FISCAL_VIEW, Permissions.FISCAL_MANAGE]
    }
    expect(financeMembershipOfFamily(FinanceAreaFamily.FISCAL, [reader, manager])).toBe(manager)
  })
})

describe('the exact family of every entry', () => {
  it('is the table below, no more and no less', () => {
    expect(FINANCE_ENTRY_FAMILY).toEqual({
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
    })
  })

  it('lists for each lone permission exactly the pages it opens', () => {
    const ids = (...held: string[]): string[] =>
      visibleFinanceEntries(FINANCE_SETTINGS_ENTRIES, [{ id: 's', permissions: held }]).map(
        entry => entry.id
      )
    expect(ids(Permissions.FINANCE_MANAGE_PURCHASES)).toEqual([
      'suppliers',
      'purchases',
      'payables'
    ])
    expect(ids(Permissions.FINANCE_MOVE_MONEY)).toEqual(['payables'])
    expect(ids(Permissions.FINANCE_VIEW_REPORTS)).toEqual([])
    expect(ids(Permissions.FINANCE_VIEW_JOURNAL)).toEqual([])
  })
})
