import type { StockLevelFilter } from '@platform/api-client'
import {
  INVENTORY_SEARCH_MAX_LENGTH,
  InventoryLevelFilters,
  type InventoryLevelSort,
  InventoryLevelSorts
} from '@platform/core/domain'

// What the stock screen of the store shows and the address that holds it. The names are the keys of the query of
// GET /inventory/levels, so what is in the address is what the list asks. An address written by hand or kept in an old
// bookmark can hold anything: what does not fit is left out, never sent.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SORTS: ReadonlySet<string> = new Set(Object.values(InventoryLevelSorts))

export interface StockListState {
  q: string
  lowStock: boolean
  warehouseId: string | null
  sort: InventoryLevelSort
}

// By product name: the order a person looks for an item in. "Recently changed" is the other.
export const DEFAULT_STOCK_SORT = InventoryLevelSorts.NAME

export const EMPTY_STOCK_STATE: StockListState = {
  q: '',
  lowStock: false,
  warehouseId: null,
  sort: DEFAULT_STOCK_SORT
}

// Every key the page owns in the address: the others (a future one of the shell) are left alone
export const STOCK_PARAMS: readonly string[] = Object.values(InventoryLevelFilters)

export function stockStateFromParams(params: Pick<URLSearchParams, 'get'>): StockListState {
  const q = params.get(InventoryLevelFilters.Q)?.trim().slice(0, INVENTORY_SEARCH_MAX_LENGTH) ?? ''
  const warehouseId = params.get(InventoryLevelFilters.WAREHOUSE_ID)
  const sort = params.get(InventoryLevelFilters.SORT)
  return {
    q,
    lowStock: params.get(InventoryLevelFilters.LOW_STOCK) === 'true',
    warehouseId: warehouseId !== null && ID.test(warehouseId) ? warehouseId.toLowerCase() : null,
    sort: sort !== null && SORTS.has(sort) ? (sort as InventoryLevelSort) : DEFAULT_STOCK_SORT
  }
}

// Only what differs from the default is written, so the plain screen has a plain address
export function stockParamsFromState(state: StockListState): [string, string][] {
  const out: [string, string][] = []
  const q = state.q.trim()
  if (q !== '') out.push([InventoryLevelFilters.Q, q])
  if (state.lowStock) out.push([InventoryLevelFilters.LOW_STOCK, 'true'])
  if (state.warehouseId !== null) out.push([InventoryLevelFilters.WAREHOUSE_ID, state.warehouseId])
  if (state.sort !== DEFAULT_STOCK_SORT) out.push([InventoryLevelFilters.SORT, state.sort])
  return out
}

// The query of the api for the state: the sort always, since the api's own default is the other one
export function stockFilterOf(state: StockListState): StockLevelFilter {
  const q = state.q.trim()
  return {
    sort: state.sort,
    ...(q === '' ? {} : { q }),
    ...(state.lowStock ? { lowStock: true } : {}),
    ...(state.warehouseId === null ? {} : { warehouseId: state.warehouseId })
  }
}

export function hasStockFilters(state: StockListState): boolean {
  return state.q.trim() !== '' || state.lowStock || state.warehouseId !== null
}
