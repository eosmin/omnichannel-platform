import { pluginWarehousePage, pluginWarehouseView } from './plugin-warehouses.views'
import type { WarehouseView } from './warehouses.views'

const warehouse = (over: Partial<WarehouseView> = {}): WarehouseView => ({
  id: 'w-1',
  name: 'Main',
  code: 'MAIN',
  address: null,
  active: true,
  stores: [
    { storeId: 's-mine', storeName: 'Mine', priority: 1 },
    { storeId: 's-other', storeName: 'Sibling store', priority: 1 }
  ],
  createdAt: new Date('2026-11-15T00:00:00Z'),
  updatedAt: new Date('2026-11-15T00:00:00Z'),
  ...over
})

describe('pluginWarehouseView', () => {
  it('shows only the link of the store of the key', () => {
    const view = pluginWarehouseView(warehouse(), 's-mine')

    expect(view.stores).toEqual([{ storeId: 's-mine', storeName: 'Mine', priority: 1 }])
    expect(JSON.stringify(view)).not.toContain('Sibling store')
  })

  it('shows no link for a warehouse that serves only other stores', () => {
    const view = pluginWarehouseView(
      warehouse({ stores: [{ storeId: 's-other', storeName: 'Sibling store', priority: 1 }] }),
      's-mine'
    )

    expect(view.stores).toEqual([])
  })

  it('keeps the rest of the warehouse', () => {
    expect(pluginWarehouseView(warehouse(), 's-mine')).toMatchObject({
      id: 'w-1',
      code: 'MAIN',
      active: true
    })
  })
})

describe('pluginWarehousePage', () => {
  it('filters the links of every row and keeps the cursor', () => {
    const page = pluginWarehousePage(
      { data: [warehouse(), warehouse({ id: 'w-2' })], nextCursor: null, hasMore: false },
      's-mine'
    )

    expect(page.data.map(row => row.stores.length)).toEqual([1, 1])
    expect(page.hasMore).toBe(false)
  })
})
