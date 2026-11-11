'use client'

import { useMemo } from 'react'

import { ClientPermissions } from '@platform/core/auth'

import type { StockOfLine } from '../../components/orders/order-line-row'
import { useStore } from '../../components/providers/store-context'
import { useWarehousesOfStore } from '../inventory/use-inventory'

import type { DraftLine } from './order-form'
import { stockRulesOf } from './order-form'
import { useLineStocks, useStockSwitches } from './use-create-order'

// What each line of an order form knows of its stock: the warehouses of the store with what each holds of the item, and the
// two switches that decide how a line may be served. Only a member with `inventory:view` and `settings:view` has them (the
// switches live behind `settings:view`); the others get lines with no stock block and the server plans the warehouses.
export function useStockOfLines(lines: readonly DraftLine[]): (line: DraftLine) => StockOfLine {
  const { storeId, can } = useStore()
  const mayShowStock = can(ClientPermissions.INVENTORY_VIEW) && can(ClientPermissions.SETTINGS_VIEW)
  const productIds = useMemo(() => [...new Set(lines.map(line => line.productId))], [lines])
  const warehouses = useWarehousesOfStore(storeId, mayShowStock)
  const switches = useStockSwitches(storeId, mayShowStock)
  const stocks = useLineStocks(storeId, productIds, mayShowStock)
  const names = useMemo(
    () => new Map((warehouses.data ?? []).map(warehouse => [warehouse.id, warehouse.name])),
    [warehouses.data]
  )

  return (line: DraftLine): StockOfLine => {
    const none: StockOfLine = {
      rules: null,
      isLoading: false,
      isFailed: false,
      names,
      canChoose: false
    }
    if (!mayShowStock) return none
    const inventory = stocks.byProduct.get(line.productId)
    if (stocks.failed.has(line.productId) || warehouses.isError || switches.isError) {
      return { ...none, isFailed: true }
    }
    if (inventory === undefined || warehouses.data === undefined || switches.data === undefined) {
      return { ...none, isLoading: true }
    }
    // A product that does not count its stock has no warehouse to choose
    if (!inventory.trackInventory) return none
    const rules = stockRulesOf({
      storeId,
      variantId: line.variantId,
      warehouses: warehouses.data,
      levels: inventory.levels,
      allowSplitFulfillment: switches.data.allowSplitFulfillment,
      allowNegativeStock: switches.data.allowNegativeStock
    })
    return { ...none, rules, canChoose: true }
  }
}
