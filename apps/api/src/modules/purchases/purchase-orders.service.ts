import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  PurchaseConflicts,
  PurchaseLimits,
  PurchaseOrderStatus,
  PurchaseResourceTypes
} from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'
import { canTransition, dayToDate, PurchaseRule } from '@platform/core/finance'

import { encodeCursor } from '../customers/list-cursor'
import { lockScope, requireSettings } from '../finance/finance.support'
import type { Actor } from '../tenancy'

import { onlyVisible, seesEveryLine, visibleStoreIds } from './purchases.reach'
import type {
  ClosePurchaseOrderBody,
  CreatePurchaseOrderBody,
  ListPurchaseOrdersQuery,
  UpdatePurchaseOrderBody
} from './purchases.schemas'
import { invalidPurchase, invalidTransition, today } from './purchases.support'
import {
  ORDER_LINE_SELECT,
  ORDER_SELECT,
  type OrderLineRow,
  type OrderPage,
  type OrderRow,
  type OrderView,
  orderView,
  RECEIPT_LINE_SELECT,
  RECEIPT_SELECT,
  type ReceiptLineRow,
  type ReceiptRow,
  receiptView
} from './purchases.views'

type OrderLineInput = CreatePurchaseOrderBody['lines'][number]

interface ResolvedLine extends OrderLineInput {
  storeId: string
}

const lineNotVisible = () =>
  resourceConflict('a line of the order is of a store the caller does not see', {
    conflict: PurchaseConflicts.LINE_STORE_NOT_VISIBLE
  })

// The purchase orders of the organization (TDD_18 §2.7): created, edited while a draft, ordered, closed and cancelled here; received in
// PurchaseReceivingService. The header is the organization's; a line is read and written by the members of ITS store only (§2.1). The
// status moves along `PurchaseOrderStatusTransitions` only, and the transition is decided under the lock of the order.
@Injectable()
export class PurchaseOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(
    organizationId: string,
    query: ListPurchaseOrdersQuery,
    actor: Actor
  ): Promise<OrderPage> {
    const visible = await visibleStoreIds(this.prisma, organizationId, actor.userId)
    const { cursor } = query
    const rows = await this.prisma.client.purchaseOrder.findMany({
      where: {
        organizationId,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.supplierId === undefined ? {} : { supplierId: query.supplierId }),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: ORDER_SELECT,
      take: query.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const ids = page.map(row => row.id)
    const lines = await this.prisma.client.purchaseOrderLine.findMany({
      where: { organizationId, purchaseOrderId: { in: ids }, storeId: { in: visible } },
      select: { ...ORDER_LINE_SELECT, purchaseOrderId: true },
      orderBy: { lineNo: 'asc' }
    })
    const last = page.at(-1)
    return {
      data: page.map(row =>
        orderView(
          row,
          lines.filter(line => line.purchaseOrderId === row.id),
          []
        )
      ),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  async get(organizationId: string, id: string, actor: Actor): Promise<OrderView> {
    const visible = await visibleStoreIds(this.prisma, organizationId, actor.userId)
    return this.read(this.prisma.client, organizationId, id, visible)
  }

  async create(
    organizationId: string,
    body: CreatePurchaseOrderBody,
    actor: Actor
  ): Promise<OrderView> {
    const visible = await visibleStoreIds(this.prisma, organizationId, actor.userId)
    const created = await this.prisma.transaction(async tx => {
      await lockScope(tx, `${organizationId}:purchase_order:${body.idempotencyKey}`)
      const earlier = await tx.purchaseOrder.findUnique({
        where: { organizationId_clientKey: { organizationId, clientKey: body.idempotencyKey } },
        select: { ...ORDER_SELECT }
      })
      if (earlier !== null) {
        if (!(await this.sameCreate(tx, organizationId, earlier, body))) {
          throw resourceConflict('the key of the request belongs to another purchase order', {
            conflict: PurchaseConflicts.KEY_REUSED
          })
        }
        return { id: earlier.id, replayed: true }
      }
      await requireSettings(tx, organizationId)
      await this.requireSupplier(tx, organizationId, body.supplierId)
      await this.requireWarehouse(tx, organizationId, body.warehouseId)
      const lines = await this.resolveLines(tx, organizationId, body.lines, visible)
      await this.requireWarehouseLinks(tx, body.warehouseId, lines)
      const settings = await tx.financeSettings.update({
        where: { organizationId },
        data: { nextPurchaseNumber: { increment: 1 } },
        select: { nextPurchaseNumber: true }
      })
      const id = randomUUID()
      await tx.purchaseOrder.create({
        data: {
          id,
          organizationId,
          number: formatPurchaseNumber(settings.nextPurchaseNumber - 1n),
          supplierId: body.supplierId,
          warehouseId: body.warehouseId,
          status: PurchaseOrderStatus.DRAFT,
          expectedOn: body.expectedOn === undefined ? null : dayToDate(body.expectedOn),
          notes: body.notes ?? null,
          clientKey: body.idempotencyKey,
          createdBy: actor.userId
        }
      })
      await this.writeLines(tx, organizationId, id, lines)
      return { id, replayed: false }
    })
    if (!created.replayed) {
      this.auditOrder(AuditAction.PURCHASE_ORDER_CREATED, organizationId, created.id, actor, {
        supplierId: body.supplierId,
        lines: body.lines.length
      })
    }
    return this.get(organizationId, created.id, actor)
  }

  // Only a draft is changed; the lines, when sent, replace the ones it had
  async update(
    organizationId: string,
    id: string,
    body: UpdatePurchaseOrderBody,
    actor: Actor
  ): Promise<OrderView> {
    const visible = await visibleStoreIds(this.prisma, organizationId, actor.userId)
    await this.prisma.transaction(async tx => {
      await lockScope(tx, `${organizationId}:purchase:${id}`)
      const order = await this.row(tx, organizationId, id)
      if ((order.status as PurchaseOrderStatus) !== PurchaseOrderStatus.DRAFT) {
        throw resourceConflict('only a draft is changed', {
          conflict: PurchaseConflicts.ORDER_NOT_DRAFT
        })
      }
      const supplierId = body.supplierId ?? order.supplierId
      const warehouseId = body.warehouseId ?? order.warehouseId
      if (body.supplierId !== undefined) await this.requireSupplier(tx, organizationId, supplierId)
      if (body.warehouseId !== undefined) {
        await this.requireWarehouse(tx, organizationId, warehouseId)
      }
      const existing = await tx.purchaseOrderLine.findMany({
        where: { organizationId, purchaseOrderId: id },
        select: ORDER_LINE_SELECT
      })
      if (body.lines !== undefined || body.warehouseId !== undefined) {
        // What is replaced (or re-checked against another warehouse) must be wholly the caller's
        if (!seesEveryLine(existing, visible)) throw lineNotVisible()
      }
      if (body.lines !== undefined) {
        const lines = await this.resolveLines(tx, organizationId, body.lines, visible)
        await this.requireWarehouseLinks(tx, warehouseId, lines)
        await tx.purchaseOrderLine.deleteMany({ where: { organizationId, purchaseOrderId: id } })
        await this.writeLines(tx, organizationId, id, lines)
      } else if (body.warehouseId !== undefined) {
        await this.requireWarehouseLinks(tx, warehouseId, existing)
      }
      await tx.purchaseOrder.update({
        where: { id },
        data: {
          supplierId,
          warehouseId,
          ...(body.expectedOn === undefined
            ? {}
            : { expectedOn: body.expectedOn === null ? null : dayToDate(body.expectedOn) }),
          ...(body.notes === undefined ? {} : { notes: body.notes })
        }
      })
    })
    this.auditOrder(AuditAction.PURCHASE_ORDER_UPDATED, organizationId, id, actor, {
      changed: Object.keys(body)
    })
    return this.get(organizationId, id, actor)
  }

  // DRAFT -> ORDERED: the purchase is placed with the supplier. It needs a supplier that is on and at least one line.
  async order(organizationId: string, id: string, actor: Actor): Promise<OrderView> {
    await this.prisma.transaction(async tx => {
      await lockScope(tx, `${organizationId}:purchase:${id}`)
      const order = await this.row(tx, organizationId, id)
      this.requireTransition(order.status, PurchaseOrderStatus.ORDERED)
      await this.requireSupplier(tx, organizationId, order.supplierId)
      const lines = await tx.purchaseOrderLine.count({
        where: { organizationId, purchaseOrderId: id }
      })
      if (lines === 0) {
        throw resourceConflict('an order with no lines is not placed', {
          conflict: PurchaseConflicts.ORDER_NEEDS_LINES
        })
      }
      await tx.purchaseOrder.update({
        where: { id },
        data: { status: PurchaseOrderStatus.ORDERED, orderedOn: dayToDate(today()) }
      })
    })
    this.auditOrder(AuditAction.PURCHASE_ORDER_ORDERED, organizationId, id, actor, {})
    return this.get(organizationId, id, actor)
  }

  // A purchase with a receipt cannot be cancelled, only closed (its status is not on the way to CANCELLED, so the table says it)
  async cancel(
    organizationId: string,
    id: string,
    body: ClosePurchaseOrderBody,
    actor: Actor
  ): Promise<OrderView> {
    await this.finish(organizationId, id, PurchaseOrderStatus.CANCELLED, actor)
    this.auditOrder(AuditAction.PURCHASE_ORDER_CANCELLED, organizationId, id, actor, {
      reason: body.reason ?? null
    })
    return this.get(organizationId, id, actor)
  }

  // Closes a purchase that arrived short (or one already received): nothing more is expected of it
  async close(
    organizationId: string,
    id: string,
    body: ClosePurchaseOrderBody,
    actor: Actor
  ): Promise<OrderView> {
    await this.finish(organizationId, id, PurchaseOrderStatus.CLOSED, actor)
    this.auditOrder(AuditAction.PURCHASE_ORDER_CLOSED, organizationId, id, actor, {
      reason: body.reason ?? null
    })
    return this.get(organizationId, id, actor)
  }

  private async finish(
    organizationId: string,
    id: string,
    to: PurchaseOrderStatus.CANCELLED | PurchaseOrderStatus.CLOSED,
    actor: Actor
  ): Promise<void> {
    const visible = await visibleStoreIds(this.prisma, organizationId, actor.userId)
    await this.prisma.transaction(async tx => {
      await lockScope(tx, `${organizationId}:purchase:${id}`)
      const order = await this.row(tx, organizationId, id)
      this.requireTransition(order.status, to)
      // Ending an order gives up every line that was still to arrive, so it must be wholly the caller's, like an edit or a receipt of
      // its lines: a person who does not see the lines of another store cannot end them for the people who do (N-AA-03)
      const lines = await tx.purchaseOrderLine.findMany({
        where: { organizationId, purchaseOrderId: id },
        select: { storeId: true }
      })
      if (!seesEveryLine(lines, visible)) throw lineNotVisible()
      await tx.purchaseOrder.update({ where: { id }, data: { status: to } })
    })
  }

  private requireTransition(from: string, to: PurchaseOrderStatus): void {
    if (!canTransition(from as PurchaseOrderStatus, to)) throw invalidTransition(from, to)
  }

  private async row(
    db: Pick<PrismaTransaction, 'purchaseOrder'>,
    organizationId: string,
    id: string
  ): Promise<OrderRow> {
    const row = await db.purchaseOrder.findFirst({
      where: { id, organizationId },
      select: ORDER_SELECT
    })
    if (row === null) throw resourceNotFound('purchase order')
    return row
  }

  // The order with the lines and receipts the caller sees
  async read(
    db: Pick<
      PrismaTransaction,
      'purchaseOrder' | 'purchaseOrderLine' | 'purchaseReceipt' | 'purchaseReceiptLine'
    >,
    organizationId: string,
    id: string,
    visible: readonly string[]
  ): Promise<OrderView> {
    const order = await this.row(db, organizationId, id)
    const [lines, receipts] = await Promise.all([
      db.purchaseOrderLine.findMany({
        where: { organizationId, purchaseOrderId: id },
        select: ORDER_LINE_SELECT,
        orderBy: { lineNo: 'asc' }
      }),
      db.purchaseReceipt.findMany({
        where: { organizationId, purchaseOrderId: id },
        select: RECEIPT_SELECT,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      })
    ])
    const receiptLines = await db.purchaseReceiptLine.findMany({
      where: { organizationId, receiptId: { in: receipts.map(receipt => receipt.id) } },
      select: RECEIPT_LINE_SELECT,
      orderBy: { id: 'asc' }
    })
    return orderView(
      order,
      onlyVisible<OrderLineRow>(lines, visible),
      receipts.map((receipt: ReceiptRow) =>
        receiptView(
          receipt,
          onlyVisible<ReceiptLineRow>(
            receiptLines.filter(line => line.receiptId === receipt.id),
            visible
          )
        )
      )
    )
  }

  private async requireSupplier(
    tx: PrismaTransaction,
    organizationId: string,
    supplierId: string
  ): Promise<void> {
    const supplier = await tx.supplier.findFirst({
      where: { id: supplierId, organizationId },
      select: { active: true }
    })
    if (supplier === null) throw resourceNotFound('supplier')
    if (!supplier.active) {
      throw resourceConflict('the supplier is switched off', {
        conflict: PurchaseConflicts.SUPPLIER_INACTIVE
      })
    }
  }

  private async requireWarehouse(
    tx: PrismaTransaction,
    organizationId: string,
    warehouseId: string
  ): Promise<void> {
    const warehouse = await tx.warehouse.findFirst({
      where: { id: warehouseId, organizationId },
      select: { active: true }
    })
    if (warehouse === null) throw resourceNotFound('warehouse')
    if (!warehouse.active) {
      throw resourceConflict('the warehouse is switched off', {
        conflict: PurchaseConflicts.LINE_REFERENCE_INVALID
      })
    }
  }

  // The stock a line raises is its store's, and a store sells from the warehouses it is linked to: a line for a store that is not linked
  // to the warehouse could never be received
  private async requireWarehouseLinks(
    tx: PrismaTransaction,
    warehouseId: string,
    lines: readonly { storeId: string }[]
  ): Promise<void> {
    const stores = [...new Set(lines.map(line => line.storeId))]
    if (stores.length === 0) return
    const linked = await tx.storeWarehouse.count({
      where: { warehouseId, storeId: { in: stores } }
    })
    if (linked !== stores.length) {
      throw resourceConflict('a store of the lines is not linked to the warehouse', {
        conflict: PurchaseConflicts.LINE_REFERENCE_INVALID
      })
    }
  }

  // What every line names, looked up INSIDE the organization (an id of another organization is an id that does not exist), the store it
  // belongs to (the product's) and the rules of the item: stocked, on, and the variant the item needs
  private async resolveLines(
    tx: PrismaTransaction,
    organizationId: string,
    lines: readonly OrderLineInput[],
    visible: readonly string[]
  ): Promise<ResolvedLine[]> {
    if (lines.length === 0) return []
    const productIds = [...new Set(lines.map(line => line.productId))]
    const products = await tx.product.findMany({
      where: { id: { in: productIds }, store: { organizationId } },
      select: {
        id: true,
        storeId: true,
        active: true,
        trackInventory: true,
        variants: { where: { active: true }, select: { id: true } }
      }
    })
    if (products.length !== productIds.length) throw resourceNotFound('product')
    const byId = new Map(products.map(product => [product.id, product]))
    const rateIds = [
      ...new Set(lines.flatMap(line => (line.taxRateId === undefined ? [] : [line.taxRateId])))
    ]
    const rates =
      rateIds.length === 0
        ? []
        : await tx.taxRate.findMany({
            where: { id: { in: rateIds }, organizationId },
            select: { id: true, active: true }
          })
    if (rates.length !== rateIds.length) throw resourceNotFound('tax rate')
    if (rates.some(rate => !rate.active)) throw invalidPurchase([PurchaseRule.TAX_RATE_INACTIVE])
    const resolved: ResolvedLine[] = []
    for (const line of lines) {
      const product = byId.get(line.productId)
      if (product === undefined) throw resourceNotFound('product')
      if (!visible.includes(product.storeId)) throw lineNotVisible()
      if (!product.active || !product.trackInventory) {
        throw resourceConflict('a purchase receives units of a product that is on and stocked', {
          conflict: PurchaseConflicts.PRODUCT_NOT_TRACKED
        })
      }
      if (line.variantId !== undefined) {
        if (!product.variants.some(variant => variant.id === line.variantId)) {
          throw resourceNotFound('variant')
        }
      } else if (product.variants.length > 0) {
        throw resourceConflict('the product is bought by variant', {
          conflict: PurchaseConflicts.LINE_REFERENCE_INVALID
        })
      }
      resolved.push({ ...line, storeId: product.storeId })
    }
    return resolved
  }

  private async writeLines(
    tx: PrismaTransaction,
    organizationId: string,
    purchaseOrderId: string,
    lines: readonly ResolvedLine[]
  ): Promise<void> {
    if (lines.length === 0) return
    await tx.purchaseOrderLine.createMany({
      data: lines.map((line, index) => ({
        organizationId,
        storeId: line.storeId,
        purchaseOrderId,
        lineNo: index + 1,
        productId: line.productId,
        variantId: line.variantId ?? null,
        quantity: line.quantity,
        unitCostCents: line.unitCostCents,
        taxRateId: line.taxRateId ?? null
      }))
    })
  }

  // The same key with the same content is the same request; with another content it is a mistake of the client
  private async sameCreate(
    tx: PrismaTransaction,
    organizationId: string,
    found: OrderRow,
    body: CreatePurchaseOrderBody
  ): Promise<boolean> {
    const lines = await tx.purchaseOrderLine.findMany({
      where: { organizationId, purchaseOrderId: found.id },
      select: ORDER_LINE_SELECT,
      orderBy: { lineNo: 'asc' }
    })
    return (
      found.supplierId === body.supplierId &&
      found.warehouseId === body.warehouseId &&
      (found.expectedOn === null ? undefined : found.expectedOn.toISOString().slice(0, 10)) ===
        body.expectedOn &&
      (found.notes ?? undefined) === body.notes &&
      lines.length === body.lines.length &&
      lines.every((line, index) => {
        const sent = body.lines[index]
        return (
          sent !== undefined &&
          line.productId === sent.productId &&
          line.variantId === (sent.variantId ?? null) &&
          line.quantity === sent.quantity &&
          line.unitCostCents === sent.unitCostCents &&
          line.taxRateId === (sent.taxRateId ?? null)
        )
      })
    )
  }

  private auditOrder(
    action: (typeof AuditAction)[keyof typeof AuditAction],
    organizationId: string,
    id: string,
    actor: Actor,
    metadata: Record<string, unknown>
  ): void {
    this.audit.log({
      action,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: PurchaseResourceTypes.PURCHASE_ORDER,
      resourceId: id,
      metadata,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}

// `PO-000001`: the organization's sequence, padded so that the list sorts as it reads
export const formatPurchaseNumber = (sequence: bigint): string =>
  `${PurchaseLimits.NUMBER_PREFIX}${sequence.toString().padStart(PurchaseLimits.NUMBER_PAD, '0')}`
