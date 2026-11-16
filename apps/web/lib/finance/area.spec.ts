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

  it('shows the pages of the books to who holds finance:view, and none to who holds only another permission', () => {
    expect(
      visibleEntries(FINANCE_SETTINGS_ENTRIES, holding(Permissions.FINANCE_VIEW)).map(
        entry => entry.id
      )
    ).toEqual(['accounts', 'taxes', 'periods', 'settings'])
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
