import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { lockStoreScope, type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  InventoryConflicts,
  InventoryLimits,
  InventoryManualMovements,
  InventoryMovementEffects,
  InventoryMovementType,
  InventoryMovementsThatBringUnitsIn,
  ProductLimits
} from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import {
  invalidMovement,
  productNotTracked,
  reasonRequired,
  stockRefused,
  warehouseInactive,
  warehouseNotLinked
} from './inventory-errors'
import type { MovementInput, MovementRecord, MovementResult } from './inventory.types'
import { planMovement } from './movement-math'
import { isSameRequest } from './same-request'

// The movements that add stock or promise it need a warehouse the store sells from and that is on; the ones that take
// stock out do not, so that what is stranded in a warehouse a store was unlinked from (TDD_16 §4.7 allows it with stock
// on hand) can still be written off or moved.
const NEEDS_ACTIVE_LINKED_WAREHOUSE: readonly InventoryMovementType[] = [
  InventoryMovementType.RESERVE,
  ...InventoryMovementsThatBringUnitsIn
]

interface LockedLevel {
  id: string
  on_hand: number
  reserved: number
  value_cents: bigint
}

// The ONLY writer of stock levels and of the ledger (TDD_16 §8: a lint rule keeps everything else out). Each movement
// is one transaction: the level row is locked, the rules of the movement are checked (movement-math), the level and
// the ledger change together, and the event leaves after the commit. A caller that has a transaction of its own (an
// order and its reservations) passes it, so that everything commits or fails together.
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(InventoryService.name)
  }

  // Applies one movement. The same key twice applies it once and answers the original (`replayed`); the same key with
  // another request is a 409.
  async move(input: MovementInput, tx?: PrismaTransaction): Promise<MovementResult> {
    this.validate(input)
    return tx === undefined
      ? this.prisma.transaction(inner => this.apply(inner, input))
      : this.apply(tx, input)
  }

  // Several movements in one transaction, in an order every caller shares (warehouse, product, variant), so that two
  // orders that touch the same levels in different orders never wait on each other for ever
  async moveMany(
    inputs: readonly MovementInput[],
    tx?: PrismaTransaction
  ): Promise<MovementResult[]> {
    for (const input of inputs) this.validate(input)
    const ordered = inputs
      .map((input, index) => ({ input, index }))
      .sort(
        (a, b) =>
          a.input.warehouseId.localeCompare(b.input.warehouseId) ||
          a.input.productId.localeCompare(b.input.productId) ||
          (a.input.variantId ?? '').localeCompare(b.input.variantId ?? '')
      )
    const run = async (db: PrismaTransaction): Promise<MovementResult[]> => {
      const results = new Array<MovementResult>(inputs.length)
      for (const { input, index } of ordered) results[index] = await this.apply(db, input)
      return results
    }
    return tx === undefined ? this.prisma.transaction(run) : run(tx)
  }

  reserve(input: Omit<MovementInput, 'type'>, tx?: PrismaTransaction): Promise<MovementResult> {
    return this.move({ ...input, type: InventoryMovementType.RESERVE }, tx)
  }

  release(input: Omit<MovementInput, 'type'>, tx?: PrismaTransaction): Promise<MovementResult> {
    return this.move({ ...input, type: InventoryMovementType.RELEASE }, tx)
  }

  // The stock leaves and its reservation is consumed (an order shipped)
  issue(input: Omit<MovementInput, 'type'>, tx?: PrismaTransaction): Promise<MovementResult> {
    return this.move({ ...input, type: InventoryMovementType.ISSUE }, tx)
  }

  // A returned order put back on the shelf
  restock(input: Omit<MovementInput, 'type'>, tx?: PrismaTransaction): Promise<MovementResult> {
    return this.move({ ...input, type: InventoryMovementType.RETURN_IN }, tx)
  }

  private validate(input: MovementInput): void {
    if (
      !Number.isInteger(input.quantity) ||
      input.quantity < 1 ||
      input.quantity > InventoryLimits.MAX_MOVEMENT_QUANTITY
    ) {
      throw invalidMovement('the quantity of a movement is a whole number above zero')
    }
    const key = input.idempotencyKey
    if (key.trim() === '' || key.length > InventoryLimits.IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw invalidMovement('a movement needs an idempotency key')
    }
    if (input.unitCostCents !== undefined && input.unitCostCents !== null) {
      if (!InventoryMovementsThatBringUnitsIn.includes(input.type)) {
        throw invalidMovement('only a movement that brings units in carries a cost')
      }
      if (
        !Number.isInteger(input.unitCostCents) ||
        input.unitCostCents < 0 ||
        input.unitCostCents > ProductLimits.MAX_AMOUNT_CENTS
      ) {
        throw invalidMovement('the cost of a unit is whole cents')
      }
    }
    const hasReason = input.reason !== undefined && input.reason !== null
    const hasNote = input.note !== undefined && input.note !== null && input.note.trim() !== ''
    if (InventoryManualMovements.includes(input.type) && !hasReason) {
      throw reasonRequired('a manual adjustment needs a reason')
    }
    if (input.type === InventoryMovementType.RECEIPT && !hasReason && !hasNote) {
      throw reasonRequired('a receipt needs a reason or a note')
    }
  }

  private async apply(tx: PrismaTransaction, input: MovementInput): Promise<MovementResult> {
    const { storeId, productId, warehouseId, type, quantity } = input
    const variantId = input.variantId ?? null

    // One request at a time per key and store: a retry that arrives while the first is still running waits for it,
    // and then finds its movement instead of racing it to the unique index
    await lockStoreScope(tx, storeId, `inventory-key:${input.idempotencyKey}`)
    const existing = await tx.inventoryMovement.findUnique({
      where: { storeId_idempotencyKey: { storeId, idempotencyKey: input.idempotencyKey } }
    })
    if (existing !== null) {
      const stored = recordOf(existing)
      if (!isSameRequest(stored, input)) {
        throw resourceConflict('the idempotency key was used by another movement', {
          conflict: InventoryConflicts.IDEMPOTENCY_KEY_REUSED
        })
      }
      return { movement: stored, replayed: true }
    }

    const product = await tx.product.findFirst({
      where: { id: productId, storeId },
      select: { trackInventory: true, lowStockThreshold: true }
    })
    if (product === null) throw resourceNotFound('product')
    if (!product.trackInventory) throw productNotTracked(productId)
    if (variantId !== null) {
      const variant = await tx.productVariant.findFirst({
        where: { id: variantId, productId },
        select: { id: true }
      })
      if (variant === null) throw resourceNotFound('variant')
    }
    // A warehouse of the organization of the store: another organization's is a warehouse that does not exist
    const warehouse = await tx.warehouse.findFirst({
      where: { id: warehouseId, organization: { stores: { some: { id: storeId } } } },
      select: { active: true }
    })
    if (warehouse === null) throw resourceNotFound('warehouse')
    if (NEEDS_ACTIVE_LINKED_WAREHOUSE.includes(type)) {
      if (!warehouse.active) throw warehouseInactive(warehouseId)
      const link = await tx.storeWarehouse.findUnique({
        where: { storeId_warehouseId: { storeId, warehouseId } },
        select: { id: true }
      })
      if (link === null) throw warehouseNotLinked(warehouseId)
    }
    const settings = await tx.storeSettings.findUnique({
      where: { storeId },
      select: { allowNegativeStock: true }
    })

    const level = await this.lockLevel(tx, { storeId, productId, variantId, warehouseId })
    const plan = planMovement(
      { onHand: level.on_hand, reserved: level.reserved, valueCents: level.value_cents },
      type,
      quantity,
      {
        allowNegativeStock: settings?.allowNegativeStock ?? false,
        unitCostCents: input.unitCostCents ?? null
      }
    )
    if (!plan.ok) throw stockRefused(plan.refusal, { warehouseId, requested: quantity })

    await tx.inventoryLevel.update({
      where: { id: level.id },
      data: {
        onHand: plan.next.onHand,
        reserved: plan.next.reserved,
        valueCents: plan.next.valueCents
      }
    })
    const created = await tx.inventoryMovement.create({
      data: {
        storeId,
        productId,
        variantId,
        warehouseId,
        type,
        quantity,
        reason: input.reason ?? null,
        note: input.note?.trim() === '' ? null : (input.note ?? null),
        referenceType: input.reference?.type ?? null,
        referenceId: input.reference?.id ?? null,
        idempotencyKey: input.idempotencyKey,
        unitCostCents: plan.unitCostCents,
        onHandAfter: plan.next.onHand,
        reservedAfter: plan.next.reserved,
        createdBy: input.createdBy ?? null
      }
    })

    this.events.publish(tx, Events.INVENTORY_MOVED, {
      storeId,
      productId,
      variantId,
      warehouseId,
      type,
      quantity
    })
    await this.warnIfLow(tx, { storeId, productId, type, quantity }, product.lowStockThreshold)
    return { movement: recordOf(created), replayed: false }
  }

  // The level of the item in the warehouse, made if it is missing, and locked until the transaction ends
  private async lockLevel(
    tx: PrismaTransaction,
    item: { storeId: string; productId: string; variantId: string | null; warehouseId: string }
  ): Promise<LockedLevel> {
    // Two partial unique indexes keep one level per item and warehouse: a level that exists is left as it is
    await tx.$executeRaw`
      INSERT INTO inventory_levels (id, store_id, product_id, variant_id, warehouse_id, on_hand, reserved, value_cents, updated_at)
      VALUES (gen_random_uuid()::text, ${item.storeId}, ${item.productId}, ${item.variantId}::text, ${item.warehouseId}, 0, 0, 0, now())
      ON CONFLICT DO NOTHING`
    const rows = await tx.$queryRaw<LockedLevel[]>`
      SELECT id, on_hand, reserved, value_cents
      FROM inventory_levels
      WHERE store_id = ${item.storeId} AND product_id = ${item.productId}
        AND warehouse_id = ${item.warehouseId} AND variant_id IS NOT DISTINCT FROM ${item.variantId}::text
      FOR UPDATE`
    const row = rows[0]
    if (row === undefined) throw new Error('the stock level of an item could not be locked')
    return row
  }

  // TDD_16 §4.4: after a movement that lowers what is available, compare the available stock of the product (all its
  // items, all the warehouses of the store) with its threshold. Crossing it downwards is announced once; going back
  // above re-arms it, because the next crossing finds the stock above again.
  private async warnIfLow(
    tx: PrismaTransaction,
    movement: { storeId: string; productId: string; type: InventoryMovementType; quantity: number },
    threshold: number | null
  ): Promise<void> {
    if (threshold === null) return
    const effect = InventoryMovementEffects[movement.type]
    const change = (effect.onHand - effect.reserved) * movement.quantity
    if (change >= 0) return
    const sums = await tx.inventoryLevel.aggregate({
      where: { storeId: movement.storeId, productId: movement.productId },
      _sum: { onHand: true, reserved: true }
    })
    const available = (sums._sum.onHand ?? 0) - (sums._sum.reserved ?? 0)
    if (available - change > threshold && available <= threshold) {
      this.events.publish(tx, Events.INVENTORY_LOW, {
        storeId: movement.storeId,
        productId: movement.productId,
        available,
        threshold
      })
      this.logger.info(
        { storeId: movement.storeId, productId: movement.productId, available, threshold },
        'a product fell to its low-stock threshold'
      )
    }
  }
}

function recordOf(row: {
  id: string
  storeId: string
  productId: string
  variantId: string | null
  warehouseId: string
  type: string
  quantity: number
  reason: string | null
  note: string | null
  referenceType: string | null
  referenceId: string | null
  idempotencyKey: string
  unitCostCents: number | null
  onHandAfter: number
  reservedAfter: number
  createdBy: string | null
  createdAt: Date
}): MovementRecord {
  // What the columns hold is written only by this service, from the enums
  return row as MovementRecord
}
