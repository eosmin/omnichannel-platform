import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  InventoryConflicts,
  InventoryMovementType,
  InventoryReferenceType,
  TransferLimits,
  TransferMovementKeys,
  TransferResourceTypes,
  TransferShortageAction,
  TransferStatus
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import {
  canMoveTransfer,
  InventoryService,
  type MovementInput,
  pendingOf,
  planClose,
  planReceipt,
  type ReceiptRefusal,
  transferMovementKey
} from '@platform/core/inventory'

import { encodeCursor } from '../customers/list-cursor'
import type { Actor } from '../tenancy'

import type {
  CloseTransferBody,
  CreateTransferBody,
  ListTransfersQuery,
  ReceiveTransferBody,
  UpdateTransferBody
} from './transfers.schemas'
import {
  assertSeesEveryLine,
  checkItems,
  checkWarehouses,
  invalidTransition,
  type LockedTransfer,
  lockTransfer,
  nextTransferNumber,
  reachableTransfer,
  type TransferItem,
  visibleStoreIds
} from './transfers.support'
import {
  LINE_SELECT,
  TRANSFER_SELECT,
  type TransferPage,
  type TransferView,
  transferSummaryView,
  transferView
} from './transfers.views'

const TRANSACTION = { timeout: TransferLimits.TRANSACTION_TIMEOUT_MS }

interface LineRow {
  id: string
  storeId: string
  productId: string
  variantId: string | null
  quantity: number
  receivedQuantity: number
}

const LINE_FIELDS = {
  id: true,
  storeId: true,
  productId: true,
  variantId: true,
  quantity: true,
  receivedQuantity: true
} as const

interface Settled {
  storeIds: string[]
  lineCount: number
}

// The transfers of an organization between its warehouses (TDD_16 §4.5). `organizationId` comes from TenantGuard and is
// the only one read here, never one from the body or the query string (CLAUDE.md rule 2). Stock is written through
// InventoryService only, inside the transaction that changes the status, under the lock of the transfer row: two
// requests on one transfer take turns, and what a retry sends again is the same movement (deterministic keys).
//
// The permission is the organization's (TDD_16 §1), and what the caller SEES and WRITES is limited to the stores they
// belong to and hold a transfer permission in: the answers (and the counts in them) never include another store's line,
// and what moves the stock of every line (dispatch, cancelling in transit) needs sight of every line.
@Injectable()
export class TransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents
  ) {}

  async list(
    organizationId: string,
    actor: Actor,
    query: ListTransfersQuery
  ): Promise<TransferPage> {
    const { cursor } = query
    const visible = await visibleStoreIds(this.prisma, organizationId, actor.userId)
    const rows = await this.prisma.client.stockTransfer.findMany({
      where: {
        organizationId,
        ...(query.status === undefined ? {} : { status: query.status }),
        AND: [
          reachableTransfer(actor.userId, visible),
          ...(query.warehouseId === undefined
            ? []
            : [
                {
                  OR: [{ fromWarehouseId: query.warehouseId }, { toWarehouseId: query.warehouseId }]
                }
              ]),
          ...(cursor === undefined
            ? []
            : [
                {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } }
                  ]
                }
              ])
        ]
      },
      select: TRANSFER_SELECT,
      take: query.limit + 1,
      // The newest first
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const counts = await this.prisma.client.stockTransferLine.groupBy({
      by: ['transferId'],
      where: { transferId: { in: page.map(row => row.id) }, storeId: { in: visible } },
      _count: { _all: true }
    })
    const countOf = new Map(counts.map(row => [row.transferId, row._count._all]))
    const last = page.at(-1)
    return {
      data: page.map(row => transferSummaryView(row, countOf.get(row.id) ?? 0)),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  async get(organizationId: string, actor: Actor, transferId: string): Promise<TransferView> {
    const visible = await visibleStoreIds(this.prisma, organizationId, actor.userId)
    return this.read(this.prisma.client, organizationId, transferId, actor.userId, visible)
  }

  async create(
    organizationId: string,
    body: CreateTransferBody,
    actor: Actor
  ): Promise<TransferView> {
    const visible = await visibleStoreIds(this.prisma, organizationId, actor.userId)
    const id = await this.prisma.transaction(async tx => {
      await checkWarehouses(tx, organizationId, body.fromWarehouseId, body.toWarehouseId)
      const items = await this.resolveItems(tx, body.lines, visible)
      await checkItems(tx, items, [body.fromWarehouseId, body.toWarehouseId])
      const number = await nextTransferNumber(tx, organizationId)
      const created = await tx.stockTransfer.create({
        data: {
          organizationId,
          number,
          fromWarehouseId: body.fromWarehouseId,
          toWarehouseId: body.toWarehouseId,
          note: body.note ?? null,
          createdBy: actor.userId,
          lines: {
            create: items.map(item => ({
              storeId: item.storeId,
              productId: item.productId,
              variantId: item.variantId,
              quantity: item.quantity
            }))
          }
        },
        select: { id: true, number: true }
      })
      return created
    })
    this.audit.log({
      action: AuditAction.TRANSFER_CREATED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: TransferResourceTypes.TRANSFER,
      resourceId: id.id,
      metadata: {
        number: id.number,
        fromWarehouseId: body.fromWarehouseId,
        toWarehouseId: body.toWarehouseId,
        lineCount: body.lines.length
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.get(organizationId, actor, id.id)
  }

  async update(
    organizationId: string,
    transferId: string,
    body: UpdateTransferBody,
    actor: Actor
  ): Promise<TransferView> {
    const visible = await visibleStoreIds(this.prisma, organizationId, actor.userId)
    const changes = await this.prisma.transaction(async tx => {
      const locked = await lockTransfer(tx, organizationId, transferId)
      // A transfer made only of other stores' lines is not one the caller knows
      const reachable = await tx.stockTransfer.findFirst({
        where: { id: transferId, ...reachableTransfer(actor.userId, visible) },
        select: { id: true }
      })
      if (reachable === null) throw resourceNotFound('transfer')
      if (locked.status !== TransferStatus.DRAFT) {
        throw invalidTransition(locked.status, TransferStatus.DRAFT)
      }
      const fromWarehouseId = body.fromWarehouseId ?? locked.fromWarehouseId
      const toWarehouseId = body.toWarehouseId ?? locked.toWarehouseId
      const existing = await tx.stockTransferLine.findMany({
        where: { transferId },
        select: LINE_FIELDS
      })
      // The lines of the stores the caller does not belong to are not theirs to change: they stay as they are
      const kept = existing.filter(line => !visible.includes(line.storeId))
      const replacement =
        body.lines === undefined ? undefined : await this.resolveItems(tx, body.lines, visible)
      const lineCount = (replacement === undefined ? existing : [...kept, ...replacement]).length
      // Moving the transfer to other warehouses re-targets EVERY line, so the caller must see every line of it
      if (fromWarehouseId !== locked.fromWarehouseId || toWarehouseId !== locked.toWarehouseId) {
        assertSeesEveryLine(existing, visible)
      }
      // What is checked is what the caller writes or may see: the lines of the other stores are theirs to check
      const checked: TransferItem[] = (
        replacement === undefined
          ? existing.filter(line => visible.includes(line.storeId))
          : replacement
      ).map(line => ({
        storeId: line.storeId,
        productId: line.productId,
        variantId: line.variantId
      }))
      if (lineCount > TransferLimits.MAX_LINES) {
        throw new PlatformException(
          ErrorCodes.VALIDATION_FAILED,
          `a transfer holds at most ${TransferLimits.MAX_LINES} lines`,
          HttpStatusCodes.BAD_REQUEST
        )
      }
      await checkWarehouses(tx, organizationId, fromWarehouseId, toWarehouseId)
      await checkItems(tx, checked, [fromWarehouseId, toWarehouseId])
      if (replacement !== undefined) {
        await tx.stockTransferLine.deleteMany({
          where: { transferId, storeId: { in: visible } }
        })
        await tx.stockTransferLine.createMany({
          data: replacement.map(item => ({
            transferId,
            storeId: item.storeId,
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity
          }))
        })
      }
      await tx.stockTransfer.update({
        where: { id: transferId },
        data: {
          fromWarehouseId,
          toWarehouseId,
          ...(body.note === undefined ? {} : { note: body.note })
        }
      })
      return {
        number: locked.number,
        fields: [
          ...(fromWarehouseId === locked.fromWarehouseId ? [] : ['fromWarehouseId']),
          ...(toWarehouseId === locked.toWarehouseId ? [] : ['toWarehouseId']),
          ...(body.note === undefined ? [] : ['note']),
          ...(replacement === undefined ? [] : ['lines'])
        ]
      }
    })
    this.audit.log({
      action: AuditAction.TRANSFER_UPDATED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: TransferResourceTypes.TRANSFER,
      resourceId: transferId,
      metadata: { number: changes.number, fields: changes.fields },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.get(organizationId, actor, transferId)
  }

  // DRAFT → IN_TRANSIT: every line leaves the source (TRANSFER_OUT needs real available stock, never reserved stock,
  // whatever the negative-stock setting says: a physical shipment cannot exceed what is on the shelf). All or nothing.
  async dispatch(organizationId: string, transferId: string, actor: Actor): Promise<TransferView> {
    const visible = await visibleStoreIds(this.prisma, organizationId, actor.userId)
    const settled = await this.prisma.transaction(async tx => {
      const locked = await lockTransfer(tx, organizationId, transferId)
      this.assertMove(locked, TransferStatus.IN_TRANSIT)
      const lines = await this.linesOf(tx, transferId)
      // The stock of every line leaves: the caller must belong to every store whose units travel
      assertSeesEveryLine(lines, visible)
      if (lines.length === 0) {
        throw new PlatformException(
          ErrorCodes.INVENTORY_TRANSFER_EMPTY,
          'a transfer with no line cannot be dispatched',
          HttpStatusCodes.CONFLICT
        )
      }
      // The warehouses and the links are read again: they may have changed since the draft was made
      await checkWarehouses(tx, organizationId, locked.fromWarehouseId, locked.toWarehouseId)
      await checkItems(tx, lines, [locked.fromWarehouseId, locked.toWarehouseId])
      await this.inventory.moveMany(
        lines.map(line =>
          this.movement(locked, line, {
            warehouseId: locked.fromWarehouseId,
            type: InventoryMovementType.TRANSFER_OUT,
            quantity: line.quantity,
            key: transferMovementKey(transferId, line.id, TransferMovementKeys.DISPATCH),
            actor
          })
        ),
        tx
      )
      await tx.stockTransfer.update({
        where: { id: transferId },
        data: {
          status: TransferStatus.IN_TRANSIT,
          dispatchedBy: actor.userId,
          dispatchedAt: new Date()
        }
      })
      const settledNow = this.settled(lines)
      this.events.publish(tx, Events.TRANSFER_DISPATCHED, {
        ...this.payload(organizationId, locked, TransferStatus.IN_TRANSIT, settledNow)
      })
      return { ...settledNow, number: locked.number }
    }, TRANSACTION)
    this.audit.log({
      action: AuditAction.TRANSFER_DISPATCHED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: TransferResourceTypes.TRANSFER,
      resourceId: transferId,
      metadata: { number: settled.number, lineCount: settled.lineCount },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.get(organizationId, actor, transferId)
  }

  // IN_TRANSIT: the units that arrive are written at the destination with TRANSFER_IN, a part of a line at a time.
  // The client's receipt key makes the request safe to send again: the same key and the same request answer the
  // transfer as it is; the same key for another request is a 409. When every line has all its units the transfer is
  // RECEIVED.
  async receive(
    organizationId: string,
    transferId: string,
    body: ReceiveTransferBody,
    actor: Actor
  ): Promise<TransferView> {
    const visible = await visibleStoreIds(this.prisma, organizationId, actor.userId)
    const outcome = await this.prisma.transaction(async tx => {
      const locked = await lockTransfer(tx, organizationId, transferId)
      const lines = await this.linesOf(tx, transferId)
      // What the caller does not see does not exist for them
      const seen = new Set(
        lines.filter(line => visible.includes(line.storeId)).map(line => line.id)
      )
      for (const entry of body.lines) {
        if (!seen.has(entry.lineId)) throw resourceNotFound('transfer line')
      }
      const keyOf = (lineId: string): string =>
        transferMovementKey(transferId, lineId, TransferMovementKeys.RECEIVE, body.receiptKey)
      // The keys this receipt key may have written for ANY line of the transfer (the unique index of the ledger is
      // what is read): another set of lines under the same key is another request
      const already = await tx.inventoryMovement.findMany({
        where: {
          storeId: { in: [...new Set(lines.map(line => line.storeId))] },
          idempotencyKey: { in: lines.map(line => keyOf(line.id)) }
        },
        select: { idempotencyKey: true, quantity: true }
      })
      if (already.length > 0) {
        const sameRequest =
          already.length === body.lines.length &&
          body.lines.every(entry =>
            already.some(
              movement =>
                movement.idempotencyKey === keyOf(entry.lineId) &&
                movement.quantity === entry.quantity
            )
          )
        if (!sameRequest) {
          throw resourceConflict('the receipt key was used by another receipt', {
            conflict: InventoryConflicts.IDEMPOTENCY_KEY_REUSED
          })
        }
        return null
      }
      this.assertMove(locked, TransferStatus.RECEIVED)
      const plan = planReceipt(lines, body.lines)
      if (!plan.ok) throw receiptRefused(plan.refusal)
      const costs = await this.dispatchCosts(tx, transferId, lines)
      await this.inventory.moveMany(
        plan.receipts.map(receipt => {
          const line = lines.find(candidate => candidate.id === receipt.lineId)
          if (line === undefined) throw resourceNotFound('transfer line')
          return this.movement(locked, line, {
            warehouseId: locked.toWarehouseId,
            type: InventoryMovementType.TRANSFER_IN,
            quantity: receipt.quantity,
            key: keyOf(receipt.lineId),
            cost: costs.get(line.id),
            actor
          })
        }),
        tx
      )
      for (const receipt of plan.receipts) {
        await tx.stockTransferLine.update({
          where: { id: receipt.lineId },
          data: { receivedQuantity: receipt.receivedAfter }
        })
      }
      const status = plan.completes ? TransferStatus.RECEIVED : TransferStatus.IN_TRANSIT
      await tx.stockTransfer.update({
        where: { id: transferId },
        data: plan.completes ? { status, closedAt: new Date() } : {}
      })
      const settledNow = this.settled(lines)
      this.events.publish(tx, Events.TRANSFER_RECEIVED, {
        ...this.payload(organizationId, locked, status, settledNow)
      })
      return {
        number: locked.number,
        completes: plan.completes,
        lines: plan.receipts.map(receipt => ({
          lineId: receipt.lineId,
          quantity: receipt.quantity
        }))
      }
    }, TRANSACTION)
    if (outcome !== null) {
      this.audit.log({
        action: AuditAction.TRANSFER_RECEIVED,
        actor: { userId: actor.userId },
        organizationId,
        storeId: actor.storeId,
        resourceType: TransferResourceTypes.TRANSFER,
        resourceId: transferId,
        metadata: {
          number: outcome.number,
          complete: outcome.completes,
          receiptKey: body.receiptKey,
          lines: outcome.lines
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return this.get(organizationId, actor, transferId)
  }

  // IN_TRANSIT → RECEIVED with units that will not arrive: each line that is short says whether the units are written
  // off (they are lost; they left the source at dispatch and nothing more is written) or sent back to the source
  // (TRANSFER_IN there). The caller must see every line that is short: they cannot decide for a store's lines they
  // cannot see, and closing would leave those units with no answer.
  async close(
    organizationId: string,
    transferId: string,
    body: CloseTransferBody,
    actor: Actor
  ): Promise<TransferView> {
    const visible = await visibleStoreIds(this.prisma, organizationId, actor.userId)
    const outcome = await this.prisma.transaction(async tx => {
      const locked = await lockTransfer(tx, organizationId, transferId)
      this.assertMove(locked, TransferStatus.RECEIVED)
      const lines = await this.linesOf(tx, transferId)
      const seen = new Set(
        lines.filter(line => visible.includes(line.storeId)).map(line => line.id)
      )
      for (const entry of body.lines) {
        if (!seen.has(entry.lineId)) throw resourceNotFound('transfer line')
      }
      if (lines.some(line => pendingOf(line) > 0 && !seen.has(line.id))) {
        throw new PlatformException(
          ErrorCodes.INVENTORY_TRANSFER_LINES_OUT_OF_REACH,
          'the transfer has units that did not arrive in stores the caller does not belong to',
          HttpStatusCodes.CONFLICT
        )
      }
      const plan = planClose(lines, body.lines)
      if (!plan.ok) {
        throw new PlatformException(
          plan.refusal.kind === 'unknown_line'
            ? ErrorCodes.RESOURCE_NOT_FOUND
            : ErrorCodes.INVENTORY_TRANSFER_SHORTAGE_ACTION_INVALID,
          `the close of the transfer is refused: ${plan.refusal.kind}`,
          plan.refusal.kind === 'unknown_line'
            ? HttpStatusCodes.NOT_FOUND
            : HttpStatusCodes.BAD_REQUEST,
          { lineId: plan.refusal.lineId, reason: plan.refusal.kind }
        )
      }
      const costs = await this.dispatchCosts(tx, transferId, lines)
      const returns = plan.shortages.filter(
        shortage => shortage.action === TransferShortageAction.RETURN_TO_SOURCE
      )
      await this.inventory.moveMany(
        returns.map(shortage => {
          const line = lines.find(candidate => candidate.id === shortage.lineId)
          if (line === undefined) throw resourceNotFound('transfer line')
          return this.movement(locked, line, {
            warehouseId: locked.fromWarehouseId,
            type: InventoryMovementType.TRANSFER_IN,
            quantity: shortage.missing,
            key: transferMovementKey(transferId, line.id, TransferMovementKeys.SHORTAGE_RETURN),
            cost: costs.get(line.id),
            actor
          })
        }),
        tx
      )
      for (const shortage of plan.shortages) {
        await tx.stockTransferLine.update({
          where: { id: shortage.lineId },
          data: { shortageAction: shortage.action }
        })
      }
      await tx.stockTransfer.update({
        where: { id: transferId },
        data: { status: TransferStatus.RECEIVED, closedAt: new Date() }
      })
      this.events.publish(tx, Events.TRANSFER_RECEIVED, {
        ...this.payload(organizationId, locked, TransferStatus.RECEIVED, this.settled(lines))
      })
      return {
        number: locked.number,
        shortages: plan.shortages.map(shortage => ({
          lineId: shortage.lineId,
          missing: shortage.missing,
          action: shortage.action
        }))
      }
    }, TRANSACTION)
    this.audit.log({
      action: AuditAction.TRANSFER_CLOSED_WITH_SHORTAGE,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: TransferResourceTypes.TRANSFER,
      resourceId: transferId,
      metadata: { number: outcome.number, shortages: outcome.shortages },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.get(organizationId, actor, transferId)
  }

  // DRAFT → CANCELLED (nothing to undo), or IN_TRANSIT → CANCELLED: the units that have not arrived return to the
  // source with TRANSFER_IN (all of the dispatched quantity when nothing was received; a part that was already
  // received stays where it arrived: returning it too would make stock out of nothing)
  async cancel(organizationId: string, transferId: string, actor: Actor): Promise<TransferView> {
    const visible = await visibleStoreIds(this.prisma, organizationId, actor.userId)
    const outcome = await this.prisma.transaction(async tx => {
      const locked = await lockTransfer(tx, organizationId, transferId)
      this.assertMove(locked, TransferStatus.CANCELLED)
      const lines = await this.linesOf(tx, transferId)
      const wasInTransit = locked.status === TransferStatus.IN_TRANSIT
      if (wasInTransit) {
        // The units go back to stores' levels: the caller must belong to every store whose units travel
        assertSeesEveryLine(lines, visible)
        const costs = await this.dispatchCosts(tx, transferId, lines)
        await this.inventory.moveMany(
          lines
            .filter(line => pendingOf(line) > 0)
            .map(line =>
              this.movement(locked, line, {
                warehouseId: locked.fromWarehouseId,
                type: InventoryMovementType.TRANSFER_IN,
                quantity: pendingOf(line),
                key: transferMovementKey(transferId, line.id, TransferMovementKeys.CANCEL_RETURN),
                cost: costs.get(line.id),
                actor
              })
            ),
          tx
        )
      }
      await tx.stockTransfer.update({
        where: { id: transferId },
        data: { status: TransferStatus.CANCELLED, closedAt: new Date() }
      })
      this.events.publish(tx, Events.TRANSFER_CANCELLED, {
        ...this.payload(organizationId, locked, TransferStatus.CANCELLED, this.settled(lines))
      })
      return {
        number: locked.number,
        wasInTransit,
        returnedUnits: wasInTransit ? lines.reduce((sum, line) => sum + pendingOf(line), 0) : 0
      }
    }, TRANSACTION)
    this.audit.log({
      action: AuditAction.TRANSFER_CANCELLED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: TransferResourceTypes.TRANSFER,
      resourceId: transferId,
      metadata: outcome,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.get(organizationId, actor, transferId)
  }

  private assertMove(locked: LockedTransfer, to: TransferStatus): void {
    if (!canMoveTransfer(locked.status, to)) throw invalidTransition(locked.status, to)
  }

  private async read(
    db: PrismaService['client'],
    organizationId: string,
    transferId: string,
    userId: string,
    visible: readonly string[]
  ): Promise<TransferView> {
    const header = await db.stockTransfer.findFirst({
      where: { id: transferId, organizationId, ...reachableTransfer(userId, visible) },
      select: TRANSFER_SELECT
    })
    if (header === null) throw resourceNotFound('transfer')
    const lines = await db.stockTransferLine.findMany({
      where: { transferId, storeId: { in: [...visible] } },
      select: LINE_SELECT,
      orderBy: [{ product: { name: 'asc' } }, { id: 'asc' }]
    })
    return transferView(header, lines)
  }

  private linesOf(tx: PrismaTransaction, transferId: string): Promise<LineRow[]> {
    return tx.stockTransferLine.findMany({
      where: { transferId },
      select: LINE_FIELDS,
      orderBy: { id: 'asc' }
    })
  }

  // The products the caller names, read under the stores they belong to: a product of another store (or of another
  // organization) is a product that does not exist, and the line takes the store of the product
  private async resolveItems(
    tx: PrismaTransaction,
    lines: CreateTransferBody['lines'],
    visible: readonly string[]
  ): Promise<(TransferItem & { quantity: number })[]> {
    if (lines.length === 0) return []
    const products = await tx.product.findMany({
      where: { id: { in: lines.map(line => line.productId) }, storeId: { in: [...visible] } },
      select: { id: true, storeId: true }
    })
    const storeOf = new Map(products.map(product => [product.id, product.storeId]))
    return lines.map(line => {
      const storeId = storeOf.get(line.productId)
      if (storeId === undefined) throw resourceNotFound('product')
      return {
        storeId,
        productId: line.productId,
        variantId: line.variantId ?? null,
        quantity: line.quantity
      }
    })
  }

  // What one unit of each line was worth when it left the source: the units that come in at the destination (or back to
  // the source) bring that cost with them. The cost of a unit is whole cents, so the value of a level that took the
  // units out at a fraction of a cent differs from what they bring back by less than a cent a unit (a debt of the
  // costing, in the plan). Read by the unique key of the ledger (store, key), never by a scan.
  private async dispatchCosts(
    tx: PrismaTransaction,
    transferId: string,
    lines: readonly LineRow[]
  ): Promise<Map<string, number | null>> {
    const rows = await tx.inventoryMovement.findMany({
      where: {
        storeId: { in: [...new Set(lines.map(line => line.storeId))] },
        idempotencyKey: {
          in: lines.map(line =>
            transferMovementKey(transferId, line.id, TransferMovementKeys.DISPATCH)
          )
        }
      },
      select: { idempotencyKey: true, unitCostCents: true }
    })
    const costs = new Map<string, number | null>()
    for (const row of rows) {
      // transfer:{transferId}:{lineId}:dispatch
      const lineId = row.idempotencyKey.split(':')[2]
      if (lineId !== undefined) costs.set(lineId, row.unitCostCents)
    }
    return costs
  }

  private movement(
    locked: LockedTransfer,
    line: LineRow,
    step: {
      warehouseId: string
      type: InventoryMovementType
      quantity: number
      key: string
      cost?: number | null | undefined
      actor: Actor
    }
  ): MovementInput {
    return {
      storeId: line.storeId,
      productId: line.productId,
      variantId: line.variantId,
      warehouseId: step.warehouseId,
      type: step.type,
      quantity: step.quantity,
      idempotencyKey: step.key,
      ...(step.cost === undefined || step.cost === null ? {} : { unitCostCents: step.cost }),
      note: locked.number,
      reference: { type: InventoryReferenceType.TRANSFER, id: locked.id },
      createdBy: step.actor.userId
    }
  }

  private settled(lines: readonly LineRow[]): Settled {
    return { storeIds: [...new Set(lines.map(line => line.storeId))], lineCount: lines.length }
  }

  private payload(
    organizationId: string,
    locked: LockedTransfer,
    status: TransferStatus,
    settled: Settled
  ): {
    organizationId: string
    transferId: string
    number: string
    status: TransferStatus
    fromWarehouseId: string
    toWarehouseId: string
    storeIds: string[]
  } {
    return {
      organizationId,
      transferId: locked.id,
      number: locked.number,
      status,
      fromWarehouseId: locked.fromWarehouseId,
      toWarehouseId: locked.toWarehouseId,
      storeIds: settled.storeIds
    }
  }
}

function receiptRefused(refusal: ReceiptRefusal): PlatformException {
  switch (refusal.kind) {
    case 'exceeds_dispatched':
      return new PlatformException(
        ErrorCodes.INVENTORY_TRANSFER_RECEIVE_EXCEEDS_DISPATCHED,
        'more units than are pending of the line',
        HttpStatusCodes.CONFLICT,
        { lineId: refusal.lineId, pending: refusal.pending }
      )
    case 'unknown_line':
      return resourceNotFound('transfer line')
    case 'empty':
    case 'duplicate_line':
    case 'invalid_quantity':
      return new PlatformException(
        ErrorCodes.VALIDATION_FAILED,
        `the receipt is refused: ${refusal.kind}`,
        HttpStatusCodes.BAD_REQUEST
      )
  }
}
