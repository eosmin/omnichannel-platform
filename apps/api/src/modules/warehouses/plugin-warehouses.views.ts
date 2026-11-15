import type { WarehousePage, WarehouseView } from './warehouses.views'

// A warehouse belongs to the organization and may serve several of its stores, but the key of a plugin is bound to ONE store:
// the links to the other stores (their ids and names) are not the plugin's to read, so only the link of its own store is shown.
// A warehouse that serves other stores and not this one shows no links at all.
export function pluginWarehouseView(warehouse: WarehouseView, storeId: string): WarehouseView {
  return { ...warehouse, stores: warehouse.stores.filter(link => link.storeId === storeId) }
}

export function pluginWarehousePage(page: WarehousePage, storeId: string): WarehousePage {
  return { ...page, data: page.data.map(warehouse => pluginWarehouseView(warehouse, storeId)) }
}
