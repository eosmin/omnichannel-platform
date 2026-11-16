import { type Permission, Permissions } from '@platform/core/auth'

import { FINANCE_SETTINGS_ENTRIES, firstVisibleHref, visibleEntries } from '../settings/entries'

import { bestFinanceMembership, FINANCE_AREA_PERMISSIONS, mayOpenFinance } from './area'

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
    ).toEqual(['accounts', 'journal', 'transactions', 'taxes', 'periods', 'reports', 'settings'])
  })

  it('lists the journal for the journal permission alone, while the area itself still needs finance:view', () => {
    // The area guard (the link and the store the books are asked through) is finance:view; the navigation only shows what each page needs
    expect(mayOpenFinance(holding(Permissions.FINANCE_VIEW_JOURNAL))).toBe(false)
    expect(
      bestFinanceMembership([{ id: 's', permissions: [Permissions.FINANCE_VIEW_JOURNAL] }])
    ).toBeUndefined()
  })

  it('adds the bank reconciliation for who also holds finance:reconcile, and never for who holds only that', () => {
    expect(
      visibleEntries(
        FINANCE_SETTINGS_ENTRIES,
        holding(Permissions.FINANCE_VIEW, Permissions.FINANCE_RECONCILE)
      ).map(entry => entry.id)
    ).toEqual(['accounts', 'taxes', 'periods', 'reports', 'reconciliation', 'settings'])
    // finance:reconcile alone opens no area: the page reads the chart to offer its accounts, which is finance:view
    expect(mayOpenFinance(holding(Permissions.FINANCE_RECONCILE))).toBe(false)
  })

  it('shows the pages of the books to who holds finance:view, and none to who holds only another permission', () => {
    expect(
      visibleEntries(FINANCE_SETTINGS_ENTRIES, holding(Permissions.FINANCE_VIEW)).map(
        entry => entry.id
      )
    ).toEqual(['accounts', 'taxes', 'periods', 'reports', 'settings'])
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
    ).toEqual(['statements', 'aging', 'books'])
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
