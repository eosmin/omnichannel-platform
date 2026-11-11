import { AppPaths } from '@platform/api-client'
import { InventoryLevelFilters, InventoryLevelSorts } from '@platform/core/domain'

import {
  DEFAULT_STOCK_SORT,
  EMPTY_STOCK_STATE,
  hasStockFilters,
  stockFilterOf,
  stockParamsFromState,
  stockStateFromParams
} from './stock-filters'

const WAREHOUSE = '0b9a7c1e-2d3f-4a5b-8c6d-7e8f9a0b1c2d'
const from = (query: string) => stockStateFromParams(new URLSearchParams(query))

describe('stockStateFromParams', () => {
  it('starts from the plain screen: every item, by name', () => {
    expect(from('')).toEqual(EMPTY_STOCK_STATE)
    expect(DEFAULT_STOCK_SORT).toBe(InventoryLevelSorts.NAME)
  })

  it('reads the filters of the address', () => {
    expect(
      from(`q=%20shoe%20&lowStock=true&warehouseId=${WAREHOUSE.toUpperCase()}&sort=recent`)
    ).toEqual({ q: 'shoe', lowStock: true, warehouseId: WAREHOUSE, sort: 'recent' })
  })

  it('leaves out what does not fit', () => {
    expect(from('lowStock=yes&warehouseId=x&sort=price')).toEqual(EMPTY_STOCK_STATE)
    expect(from(`q=${'x'.repeat(300)}`).q).toHaveLength(100)
  })

  it('opens from the link of the low-stock notice', () => {
    const [, query = ''] = AppPaths.store.inventoryLow('s1').split('?')
    expect(from(query)).toEqual({ ...EMPTY_STOCK_STATE, lowStock: true })
    expect(query).toBe(`${InventoryLevelFilters.LOW_STOCK}=true`)
  })
})

describe('stockParamsFromState', () => {
  it('writes only what differs from the default, and reads back what it wrote', () => {
    expect(stockParamsFromState(EMPTY_STOCK_STATE)).toEqual([])
    const state = { q: 'mug', lowStock: true, warehouseId: WAREHOUSE, sort: 'recent' as const }
    expect(from(new URLSearchParams(stockParamsFromState(state)).toString())).toEqual(state)
  })

  it('leaves out a blank search', () => {
    expect(stockParamsFromState({ ...EMPTY_STOCK_STATE, q: '   ' })).toEqual([])
  })
})

describe('stockFilterOf', () => {
  it('always sends the sort, and the filters that are on', () => {
    expect(stockFilterOf(EMPTY_STOCK_STATE)).toEqual({ sort: 'name' })
    expect(
      stockFilterOf({ q: ' mug ', lowStock: true, warehouseId: WAREHOUSE, sort: 'recent' })
    ).toEqual({ sort: 'recent', q: 'mug', lowStock: true, warehouseId: WAREHOUSE })
  })

  it('tells whether anything narrows the list', () => {
    expect(hasStockFilters(EMPTY_STOCK_STATE)).toBe(false)
    expect(hasStockFilters({ ...EMPTY_STOCK_STATE, lowStock: true })).toBe(true)
    expect(hasStockFilters({ ...EMPTY_STOCK_STATE, q: ' a ' })).toBe(true)
  })
})
