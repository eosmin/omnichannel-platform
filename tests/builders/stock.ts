import type { OwnerClient } from '@platform/core/database-testing'

import { createProduct } from './product'
import { createInventoryLevel, createInventoryMovement } from './warehouse'

// Remembers which product and warehouse each row of stock is of: the routes that read stock name the item, not the row
export const itemOfStockRow = new Map<string, { productId: string; warehouseId: string }>()

// The warehouse the store sells from first (every store of the suites has at least one)
async function firstWarehouseOf(owner: OwnerClient, storeId: string): Promise<string> {
  const link = await owner.storeWarehouse.findFirstOrThrow({
    where: { storeId },
    orderBy: { priority: 'asc' },
    select: { warehouseId: true }
  })
  return link.warehouseId
}

// A level of a new product of the store, in the first warehouse of the store
export async function createLevelOf(
  owner: OwnerClient,
  input: { storeId: string }
): Promise<{ id: string }> {
  const product = await createProduct(owner, { storeId: input.storeId })
  const warehouseId = await firstWarehouseOf(owner, input.storeId)
  const level = await createInventoryLevel(owner, {
    storeId: input.storeId,
    productId: product.id,
    warehouseId,
    onHand: 5
  })
  itemOfStockRow.set(level.id, { productId: product.id, warehouseId })
  return level
}

// A movement of a new product of the store, in the first warehouse of the store
export async function createMovementOf(
  owner: OwnerClient,
  input: { storeId: string }
): Promise<{ id: string }> {
  const product = await createProduct(owner, { storeId: input.storeId })
  const warehouseId = await firstWarehouseOf(owner, input.storeId)
  const movement = await createInventoryMovement(owner, {
    storeId: input.storeId,
    productId: product.id,
    warehouseId,
    quantity: 5
  })
  itemOfStockRow.set(movement.id, { productId: product.id, warehouseId })
  return movement
}
