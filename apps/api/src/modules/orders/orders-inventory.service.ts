import { Injectable } from '@nestjs/common'

import { lockStoreScope, type PrismaTransaction } from '@platform/core/database'
import {
  InventoryMovementType,
  InventoryReferenceType,
  OrderLockScopes,
  orderMovementKey,
  OrderStockEffects,
  type OrderStockEffect,
  planLineAllocation,
  type WarehouseAvailability
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { InventoryService, type MovementInput } from '@platform/core/inventory'

// The stock side of an order (TDD_16 §4.1). OrdersService calls this inside its own transaction and nothing else writes
// a level: every movement goes through InventoryService, which locks the level, checks the rules and writes the ledger.
// Each effect is applied PER ALLOCATION, and each one carries a deterministic idempotency key
// (`order:{orderId}:{itemId}:{warehouseId}:{effect}`), so a retried request or a job never applies a movement twice.

export interface LineToAllocate {
  itemId: string
  productId: string
  variantId: string | null
  quantity: number
  trackInventory: boolean
}

const Effects = OrderStockEffects
type Effect = OrderStockEffect

const MOVEMENT_OF_EFFECT: Record<Effect, InventoryMovementType> = {
  [Effects.RESERVE]: InventoryMovementType.RESERVE,
  [Effects.RELEASE]: InventoryMovementType.RELEASE,
  [Effects.ISSUE]: InventoryMovementType.ISSUE,
  [Effects.RETURN]: InventoryMovementType.RETURN_IN
}

@Injectable()
export class OrderInventoryService {
  constructor(private readonly inventory: InventoryService) {}

  // Allocates every tracked line to warehouses and reserves each allocation. The allocation reads the stock and the
  // reservations write it, so two orders of the same store take turns: the second one plans on what the first one
  // really left. A line no warehouse can serve is a 409 that names the stock of each warehouse.
  async allocateAndReserve(
    tx: PrismaTransaction,
    input: {
      storeId: string
      orderId: string
      lines: readonly LineToAllocate[]
      createdBy: string
    }
  ): Promise<void> {
    const { storeId, orderId, createdBy } = input
    const tracked = input.lines.filter(line => line.trackInventory)
    if (tracked.length === 0) return

    await lockStoreScope(tx, storeId, OrderLockScopes.ALLOCATION)
    const settings = await tx.storeSettings.findUnique({
      where: { storeId },
      select: { allowNegativeStock: true, allowSplitFulfillment: true }
    })
    // The warehouses the store sells from, switched on, highest priority first (priority 1 is reserved first)
    const links = await tx.storeWarehouse.findMany({
      where: { storeId, warehouse: { active: true } },
      select: { warehouseId: true },
      orderBy: { priority: 'asc' }
    })
    const warehouseIds = links.map(link => link.warehouseId)
    const levels = await tx.inventoryLevel.findMany({
      where: {
        storeId,
        productId: { in: tracked.map(line => line.productId) },
        warehouseId: { in: warehouseIds }
      },
      select: { productId: true, variantId: true, warehouseId: true, onHand: true, reserved: true }
    })

    const movements: MovementInput[] = []
    const rows: { storeId: string; orderItemId: string; warehouseId: string; quantity: number }[] =
      []
    for (const line of tracked) {
      const availability: WarehouseAvailability[] = warehouseIds.map(warehouseId => {
        const level = levels.find(
          row =>
            row.productId === line.productId &&
            row.variantId === line.variantId &&
            row.warehouseId === warehouseId
        )
        return { warehouseId, available: level === undefined ? 0 : level.onHand - level.reserved }
      })
      const plan = planLineAllocation({
        quantity: line.quantity,
        warehouses: availability,
        allowSplitFulfillment: settings?.allowSplitFulfillment ?? false,
        allowNegativeStock: settings?.allowNegativeStock ?? false
      })
      if (!plan.ok) {
        throw new PlatformException(
          ErrorCodes.INSUFFICIENT_INVENTORY,
          'no warehouse of the store can serve the line',
          HttpStatusCodes.CONFLICT,
          {
            productId: line.productId,
            variantId: line.variantId,
            requested: line.quantity,
            // The stock of each warehouse, so the agent can lower the quantity or ask for a split
            availableByWarehouse: plan.availableByWarehouse
          }
        )
      }
      for (const allocation of plan.allocations) {
        rows.push({
          storeId,
          orderItemId: line.itemId,
          warehouseId: allocation.warehouseId,
          quantity: allocation.quantity
        })
        movements.push(
          this.movement(Effects.RESERVE, {
            storeId,
            orderId,
            itemId: line.itemId,
            productId: line.productId,
            variantId: line.variantId,
            warehouseId: allocation.warehouseId,
            quantity: allocation.quantity,
            createdBy
          })
        )
      }
    }
    await tx.orderItemAllocation.createMany({ data: rows })
    // One call, in the order every caller shares, so two orders never wait on each other's levels for ever
    await this.inventory.moveMany(movements, tx)
  }

  // The reservations of the order go back (items edited, or the order cancelled before it shipped)
  release(
    tx: PrismaTransaction,
    storeId: string,
    orderId: string,
    createdBy: string
  ): Promise<void> {
    return this.applyToAllocations(tx, storeId, orderId, Effects.RELEASE, createdBy)
  }

  // The order shipped: the stock leaves and its reservation is consumed
  issue(tx: PrismaTransaction, storeId: string, orderId: string, createdBy: string): Promise<void> {
    return this.applyToAllocations(tx, storeId, orderId, Effects.ISSUE, createdBy)
  }

  // A returned order, when the agent chose to put it back on the shelf: into the warehouse it left from
  restock(
    tx: PrismaTransaction,
    storeId: string,
    orderId: string,
    createdBy: string
  ): Promise<void> {
    return this.applyToAllocations(tx, storeId, orderId, Effects.RETURN, createdBy)
  }

  private async applyToAllocations(
    tx: PrismaTransaction,
    storeId: string,
    orderId: string,
    effect: Effect,
    createdBy: string
  ): Promise<void> {
    const allocations = await tx.orderItemAllocation.findMany({
      where: { storeId, orderItem: { orderId } },
      select: {
        warehouseId: true,
        quantity: true,
        orderItem: { select: { id: true, productId: true, variantId: true } }
      }
    })
    const movements = allocations.map(allocation =>
      this.movement(effect, {
        storeId,
        orderId,
        itemId: allocation.orderItem.id,
        productId: allocation.orderItem.productId,
        variantId: allocation.orderItem.variantId,
        warehouseId: allocation.warehouseId,
        quantity: allocation.quantity,
        createdBy
      })
    )
    if (movements.length > 0) await this.inventory.moveMany(movements, tx)
  }

  private movement(
    effect: Effect,
    item: {
      storeId: string
      orderId: string
      itemId: string
      productId: string
      variantId: string | null
      warehouseId: string
      quantity: number
      createdBy: string
    }
  ): MovementInput {
    return {
      storeId: item.storeId,
      productId: item.productId,
      variantId: item.variantId,
      warehouseId: item.warehouseId,
      type: MOVEMENT_OF_EFFECT[effect],
      quantity: item.quantity,
      idempotencyKey: orderMovementKey(item.orderId, item.itemId, item.warehouseId, effect),
      reference: { type: InventoryReferenceType.ORDER, id: item.orderId },
      createdBy: item.createdBy
    }
  }
}
