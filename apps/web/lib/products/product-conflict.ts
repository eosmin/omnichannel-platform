import { ApiError } from '@platform/api-client'
import { ProductConflicts, ProductHistoryTables, type ProductConflict } from '@platform/core/domain'
import { ClientErrorCodes } from '@platform/core/errors'

const CONFLICTS: readonly string[] = Object.values(ProductConflicts)

// Which of the catalog's refusals an error is (`metadata.conflict` of a 409), or null for anything else.
// The api sends the code RESOURCE_CONFLICT for all of them; the reason is the metadata.
export function conflictOf(error: unknown): ProductConflict | null {
  if (!(error instanceof ApiError) || error.code !== ClientErrorCodes.RESOURCE_CONFLICT) return null
  const conflict = error.metadata['conflict']
  return typeof conflict === 'string' && CONFLICTS.includes(conflict)
    ? (conflict as ProductConflict)
    : null
}

export interface HistoryCounts {
  orderItems: number
  inventoryMovements: number
  media: number
}

// What a refused delete says holds the product: the number of order lines, stock movements and files
export function historyCountsOf(error: unknown): HistoryCounts {
  const metadata = error instanceof ApiError ? error.metadata : {}
  const count = (key: string): number => {
    const value = metadata[key]
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
  }
  return {
    orderItems: count(ProductHistoryTables.ORDER_ITEMS),
    inventoryMovements: count(ProductHistoryTables.INVENTORY_MOVEMENTS),
    media: count(ProductHistoryTables.MEDIA)
  }
}
