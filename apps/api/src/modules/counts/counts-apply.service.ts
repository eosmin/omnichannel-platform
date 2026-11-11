import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import {
  CountConflicts,
  CountResourceTypes,
  CountStatus,
  InventoryMovementType,
  InventoryReferenceType
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { InventoryService } from '@platform/core/inventory'

import type { Actor } from '../tenancy'

import { countMovementKey, movementOf } from './counts.rules'
import { CountsService } from './counts.service'
import { assertTransition, lockCount, storesOf } from './counts.support'
import type { CountView } from './counts.views'

interface ShortLine {
  lineId: string
  storeId: string
  productId: string
  variantId: string | null
  requested: number
  onHand: unknown
}

// Applying a count (TDD_16 §4.6, step 5). For every line with a variance the stock moves by the VARIANCE (counted minus
// the snapshot of the start), never by "counted minus what is there now": the sales and transfers that happened while the
// count was open already moved the level, and stay. It is one transaction: either every line is applied and the count is
// APPLIED, or nothing is and the count is still in review.
@Injectable()
export class CountsApplyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    private readonly counts: CountsService
  ) {}

  async apply(organizationId: string, countId: string, actor: Actor): Promise<CountView> {
    const summary = await this.prisma.transaction(async tx => {
      const count = await lockCount(tx, organizationId, countId)
      assertTransition(count.status, CountStatus.APPLIED)

      const lines = await tx.stockCountLine.findMany({
        where: { countId, countedQuantity: { not: null } },
        select: {
          id: true,
          storeId: true,
          productId: true,
          variantId: true,
          expectedQuantity: true,
          countedQuantity: true
        },
        orderBy: { id: 'asc' }
      })
      // The order every writer of levels shares (InventoryService.moveMany: warehouse, product, variant; the warehouse is
      // one here), so that an apply and an order that touch the same levels never wait on each other for ever
      const moves = lines
        .flatMap(line => {
          const movement = movementOf(line)
          return movement === null ? [] : [{ line, movement }]
        })
        .sort(
          (a, b) =>
            a.line.productId.localeCompare(b.line.productId) ||
            (a.line.variantId ?? '').localeCompare(b.line.variantId ?? '')
        )

      // Applying changes the stock of the stores of the lines: the person must hold the permission in each of them
      const allowed = new Set(
        await storesOf(tx, organizationId, actor.userId, Permissions.INVENTORY_APPLY_COUNTS)
      )
      const foreign = new Set(moves.map(move => move.line.storeId).filter(id => !allowed.has(id)))
      if (foreign.size > 0) {
        throw new PlatformException(
          ErrorCodes.INVENTORY_COUNT_STORES_NOT_ALLOWED,
          'the count has variances in stores where the caller may not apply counts',
          HttpStatusCodes.FORBIDDEN,
          { stores: foreign.size }
        )
      }

      const short: ShortLine[] = []
      const refused: { lineId: string; code: string }[] = []
      let unitsIn = 0
      let unitsOut = 0
      for (const { line, movement } of moves) {
        try {
          await this.inventory.move(
            {
              storeId: line.storeId,
              productId: line.productId,
              variantId: line.variantId,
              warehouseId: count.warehouseId,
              type: movement.type,
              quantity: movement.quantity,
              idempotencyKey: countMovementKey(countId, line.id),
              reference: { type: InventoryReferenceType.COUNT, id: countId },
              createdBy: actor.userId
            },
            tx
          )
          if (movement.type === InventoryMovementType.COUNT_IN) unitsIn += movement.quantity
          else unitsOut += movement.quantity
        } catch (error) {
          // The engine refuses before it writes, so the transaction is still sound: the other lines are tried, and every
          // line the stock cannot cover is reported together
          if (
            error instanceof PlatformException &&
            error.code === ErrorCodes.INSUFFICIENT_INVENTORY
          ) {
            short.push({
              lineId: line.id,
              storeId: line.storeId,
              productId: line.productId,
              variantId: line.variantId,
              requested: movement.quantity,
              onHand: error.metadata?.['onHand'] ?? null
            })
            continue
          }
          // Any other refusal of the engine is about the line, and is decided before it writes (a product no longer
          // tracked, the warehouse switched off or unlinked since the start, a variance over the ceiling of a movement):
          // every line is tried and the approver is told which ones and why
          if (error instanceof PlatformException) {
            refused.push({ lineId: line.id, code: error.code })
            continue
          }
          throw error
        }
      }
      if (refused.length > 0) {
        throw new PlatformException(
          ErrorCodes.INVENTORY_COUNT_LINES_REFUSED,
          'the stock engine refused some lines of the count',
          HttpStatusCodes.CONFLICT,
          { conflict: CountConflicts.LINES_REFUSED, lines: refused }
        )
      }
      if (short.length > 0) {
        // Nothing is kept: the throw rolls back the lines that did apply. The approver sends the count back to counting
        // to recount these lines.
        throw new PlatformException(
          ErrorCodes.INSUFFICIENT_INVENTORY,
          'applying the count would take the stock of some lines below zero',
          HttpStatusCodes.CONFLICT,
          { conflict: CountConflicts.SHORT_STOCK, lines: short }
        )
      }
      await tx.stockCount.update({
        where: { id: countId },
        data: { status: CountStatus.APPLIED, appliedBy: actor.userId, appliedAt: new Date() }
      })
      return { number: count.number, lines: moves.length, unitsIn, unitsOut }
    })
    this.audit.log({
      action: AuditAction.COUNT_APPLIED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: CountResourceTypes.COUNT,
      resourceId: countId,
      metadata: summary,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.counts.header(organizationId, countId)
  }
}
