import { AppPaths } from '@platform/api-client'
import { type Permission, ClientPermissions } from '@platform/core/auth'

import { mayOpenExports } from './exports/export-state'
import { mayOpenFinance } from './finance/area'
import { mayOpenStoreSettings } from './settings/may-open-settings'

// Where a person starts in a store: the first screen of the navigation (`StoreNav`, in its order) that they may open, so a role with no
// inbox does not land on a screen that reads what it cannot see (QA VERIF-31 WEB-2). The inbox stays first for who has it. `null` when the
// person may open no screen of the store at all.
export function storeLandingPath(
  storeId: string,
  can: (permission: Permission) => boolean
): string | null {
  const screens: [boolean, string][] = [
    [can(ClientPermissions.CONVERSATIONS_VIEW), AppPaths.store.inbox(storeId)],
    [can(ClientPermissions.CUSTOMERS_VIEW), AppPaths.store.customers(storeId)],
    [can(ClientPermissions.PRODUCTS_VIEW), AppPaths.store.products(storeId)],
    [can(ClientPermissions.ORDERS_VIEW), AppPaths.store.orders(storeId)],
    [can(ClientPermissions.SHIPPING_VIEW), AppPaths.store.shipments(storeId)],
    [can(ClientPermissions.RETURNS_VIEW), AppPaths.store.returns(storeId)],
    [can(ClientPermissions.REMITTANCES_VIEW), AppPaths.store.remittances(storeId)],
    [can(ClientPermissions.INVENTORY_VIEW), AppPaths.store.inventory(storeId)],
    [can(ClientPermissions.ANALYTICS_VIEW), AppPaths.store.analytics(storeId)],
    [mayOpenExports(can), AppPaths.store.exports(storeId)],
    [mayOpenFinance(can), AppPaths.finance.home],
    // The settings open their first allowed page
    [mayOpenStoreSettings(can), AppPaths.store.settings(storeId)]
  ]
  return screens.find(([isOpen]) => isOpen)?.[1] ?? null
}
