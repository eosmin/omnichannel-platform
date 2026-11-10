import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'
import {
  InventoryAdjustmentReason,
  InventoryMovementType,
  InventoryReferenceType
} from '@platform/core/domain'

// Builders write as the owner, so that a suite can put a row in any organization or store: the api cannot, and it
// is the very thing the suites are about

export async function createWarehouse(
  owner: OwnerClient,
  input: { organizationId: string; name?: string; code?: string }
): Promise<{ id: string; code: string }> {
  const code = input.code ?? `W${randomUUID().slice(0, 8).toUpperCase()}`
  return owner.warehouse.create({
    data: { organizationId: input.organizationId, name: input.name ?? `warehouse ${code}`, code },
    select: { id: true, code: true }
  })
}

// Links a store to a warehouse of its organization at the next free priority of the store
export async function linkWarehouse(
  owner: OwnerClient,
  input: { organizationId: string; storeId: string; warehouseId: string; priority?: number }
): Promise<{ id: string }> {
  const taken = await owner.storeWarehouse.aggregate({
    where: { storeId: input.storeId },
    _max: { priority: true }
  })
  return owner.storeWarehouse.create({
    data: {
      organizationId: input.organizationId,
      storeId: input.storeId,
      warehouseId: input.warehouseId,
      priority: input.priority ?? (taken._max.priority ?? 0) + 1
    },
    select: { id: true }
  })
}

// A level, and the movement that explains it when units are given
export async function createInventoryLevel(
  owner: OwnerClient,
  input: {
    storeId: string
    productId: string
    variantId?: string | null
    warehouseId: string
    onHand?: number
    reserved?: number
  }
): Promise<{ id: string }> {
  return owner.inventoryLevel.create({
    data: {
      storeId: input.storeId,
      productId: input.productId,
      variantId: input.variantId ?? null,
      warehouseId: input.warehouseId,
      onHand: input.onHand ?? 0,
      reserved: input.reserved ?? 0
    },
    select: { id: true }
  })
}

export async function createInventoryMovement(
  owner: OwnerClient,
  input: {
    storeId: string
    productId: string
    variantId?: string | null
    warehouseId: string
    type?: InventoryMovementType
    quantity?: number
    unitCostCents?: number | null
    onHandAfter?: number
    reservedAfter?: number
    idempotencyKey?: string
  }
): Promise<{ id: string }> {
  const quantity = input.quantity ?? 1
  return owner.inventoryMovement.create({
    data: {
      storeId: input.storeId,
      productId: input.productId,
      variantId: input.variantId ?? null,
      warehouseId: input.warehouseId,
      type: input.type ?? InventoryMovementType.RECEIPT,
      quantity,
      reason: InventoryAdjustmentReason.OPENING_STOCK,
      referenceType: InventoryReferenceType.MANUAL,
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      unitCostCents: input.unitCostCents ?? null,
      onHandAfter: input.onHandAfter ?? quantity,
      reservedAfter: input.reservedAfter ?? 0
    },
    select: { id: true }
  })
}
