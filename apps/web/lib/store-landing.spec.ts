import { ClientPermissions, RoleNames, RolePresets } from '@platform/core/auth'

import { storeLandingPath } from './store-landing'

// QA 2026-11-20/21 (VERIF-31 WEB-2, VERIF-cd WEB-1): "/" and "/s/{S}" took every role to the inbox, and a role with no
// conversations:view landed on a screen that read five things it could not see. Each role lands on the first screen of the
// navigation that it may open.
const canOf =
  (granted: readonly string[]) =>
  (permission: string): boolean =>
    granted.includes(permission)

describe('storeLandingPath', () => {
  it.each([
    ['Viewer', RolePresets[RoleNames.VIEWER], '/s/a/inbox'],
    ['Admin', RolePresets[RoleNames.ADMIN], '/s/a/inbox'],
    ['customers only (p-cus)', [ClientPermissions.CUSTOMERS_VIEW], '/s/a/customers'],
    [
      'orders and remittances (an accountant of the shop)',
      [ClientPermissions.REMITTANCES_VIEW, ClientPermissions.ORDERS_VIEW],
      '/s/a/orders'
    ],
    ['remittances alone', [ClientPermissions.REMITTANCES_VIEW], '/s/a/remittances'],
    ['analytics alone', [ClientPermissions.ANALYTICS_VIEW], '/s/a/analytics']
  ])('%s lands on %s', (_name, granted, expected) => {
    expect(storeLandingPath('a', canOf(granted))).toBe(expected)
  })

  it('has nowhere to land with no permission of any screen', () => {
    expect(storeLandingPath('a', canOf([]))).toBeNull()
  })

  it('lands on the settings, which open their first allowed page, when that is all there is', () => {
    expect(storeLandingPath('a', canOf([ClientPermissions.SETTINGS_VIEW]))).toBe(
      '/s/a/settings/general'
    )
  })

  it('keeps the order of the navigation: the first screen it may open wins', () => {
    const everything = [
      ClientPermissions.ANALYTICS_VIEW,
      ClientPermissions.INVENTORY_VIEW,
      ClientPermissions.REMITTANCES_VIEW,
      ClientPermissions.RETURNS_VIEW,
      ClientPermissions.SHIPPING_VIEW,
      ClientPermissions.ORDERS_VIEW,
      ClientPermissions.PRODUCTS_VIEW
    ]
    expect(storeLandingPath('a', canOf(everything))).toBe('/s/a/products')
    expect(storeLandingPath('a', canOf(everything.slice(0, 5)))).toBe('/s/a/shipments')
  })

  it('lands on the finance area for a role that only holds finance', () => {
    expect(storeLandingPath('a', canOf([ClientPermissions.FINANCE_VIEW]))).toBe('/finance')
  })
})
