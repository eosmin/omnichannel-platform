import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  AccountRole,
  EntryOrigin,
  FinanceSourceType,
  InventoryMovementType,
  InventoryReferenceType,
  JournalEntryType,
  PurchaseConflicts,
  PurchaseIdempotencyKey,
  PurchaseOrderStatus,
  PurchaseResourceTypes,
  type TaxRounding
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
  canTransition,
  dateToDay,
  dayToDate,
  dueDay,
  needsUncreditableTaxAccount,
  PurchaseRule,
  type PurchaseRuleName,
  receiptEntryLines,
  receiptMoney,
  receiptProblems,
  statusAfterReceipt
} from '@platform/core/finance'
import { financeRefusal, LedgerService } from '@platform/core/finance-ledger'
import { InventoryService } from '@platform/core/inventory'

import { lockScope } from '../finance/finance.support'
import type { Actor } from '../tenancy'

import { PurchaseOrdersService } from './purchase-orders.service'
import { seesEveryLine, visibleStoreIds } from './purchases.reach'
import type { ReceivePurchaseOrderBody } from './purchases.schemas'
import { invalidPurchase, invalidTransition, latestDay, roleAccount } from './purchases.support'
import type { OrderView } from './purchases.views'

interface Received {
  receiptId: string
  replayed: boolean
  status: string
  entryNumber: bigint | null
  totalCents: number
}

// Receiving goods against a purchase order (TDD_18 §4.2 E10, Step 4B.5): ONE database transaction raises the stock of every line through
// InventoryService (the unit cost before tax: the weighted average moves), posts ONE balanced entry through LedgerService (stock, input
// tax, and what is owed to the supplier) and writes the receipt, its lines and the order's new status. Either everything happens or
// nothing does. A receipt is never edited or deleted: the goods are taken back by a return to the supplier (after the MVP).
@Injectable()
export class PurchaseReceivingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly inventory: InventoryService,
    private readonly events: DomainEvents,
    private readonly audit: AuditService,
    private readonly orders: PurchaseOrdersService
  ) {}

  async receive(
    organizationId: string,
    orderId: string,
    body: ReceivePurchaseOrderBody,
    actor: Actor
  ): Promise<OrderView> {
    const visible = await visibleStoreIds(this.prisma, organizationId, actor.userId)
    const received = await this.prisma.transaction(tx =>
      this.receiveIn(tx, organizationId, orderId, body, actor, visible)
    )
    if (!received.replayed) {
      this.audit.log({
        action: AuditAction.PURCHASE_ORDER_RECEIVED,
        actor: { userId: actor.userId },
        organizationId,
        storeId: actor.storeId,
        resourceType: PurchaseResourceTypes.PURCHASE_RECEIPT,
        resourceId: received.receiptId,
        metadata: {
          purchaseOrderId: orderId,
          status: received.status,
          totalCents: received.totalCents,
          entryNumber: received.entryNumber?.toString() ?? null
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return this.orders.get(organizationId, orderId, actor)
  }

  private async receiveIn(
    tx: PrismaTransaction,
    organizationId: string,
    orderId: string,
    body: ReceivePurchaseOrderBody,
    actor: Actor,
    visible: readonly string[]
  ): Promise<Received> {
    // Two requests with one key at once do not both pass: the second waits here until the first has committed, then finds it
    await lockScope(tx, `${organizationId}:purchase_receipt:${body.idempotencyKey}`)
    const earlier = await tx.purchaseReceipt.findUnique({
      where: { organizationId_clientKey: { organizationId, clientKey: body.idempotencyKey } },
      select: { id: true, purchaseOrderId: true }
    })
    if (earlier !== null) {
      if (
        earlier.purchaseOrderId !== orderId ||
        !(await this.sameReceive(tx, organizationId, earlier.id, body))
      ) {
        throw resourceConflict('the key of the request belongs to another receipt', {
          conflict: PurchaseConflicts.KEY_REUSED
        })
      }
      return { receiptId: earlier.id, replayed: true, status: '', entryNumber: null, totalCents: 0 }
    }

    // The order is locked until the end: two receipts of one order take turns, so what the second reads is what the first left
    await lockScope(tx, `${organizationId}:purchase:${orderId}`)
    const order = await tx.purchaseOrder.findFirst({
      where: { id: orderId, organizationId },
      select: { id: true, number: true, status: true, supplierId: true, warehouseId: true }
    })
    if (order === null) throw resourceNotFound('purchase order')
    const current = order.status as PurchaseOrderStatus
    if (
      current !== PurchaseOrderStatus.ORDERED &&
      current !== PurchaseOrderStatus.PARTIALLY_RECEIVED
    ) {
      throw invalidTransition(order.status, PurchaseOrderStatus.RECEIVED)
    }
    // The supplier is locked after the order, always in that order, so the payments of the supplier see this bill whole or not at all
    await lockScope(tx, `${organizationId}:supplier:${order.supplierId}`)

    const lines = await tx.purchaseOrderLine.findMany({
      where: { organizationId, purchaseOrderId: orderId },
      orderBy: { lineNo: 'asc' }
    })
    const sent = new Map(body.lines.map(line => [line.orderLineId, line.quantity]))
    const chosen = lines.filter(line => sent.has(line.id))
    if (chosen.length !== sent.size) throw resourceNotFound('purchase order line')
    // A line is read and written by the members of its store only: a receipt must be wholly the caller's
    if (!seesEveryLine(chosen, visible)) {
      throw resourceConflict('a line of the receipt is of a store the caller does not see', {
        conflict: PurchaseConflicts.LINE_STORE_NOT_VISIBLE
      })
    }
    for (const line of chosen) {
      const quantity = sent.get(line.id) ?? 0
      if (quantity > line.quantity - line.receivedQuantity) {
        throw new PlatformException(
          ErrorCodes.PURCHASE_RECEIPT_EXCEEDS_ORDER,
          'a receipt is never above what was ordered',
          HttpStatusCodes.CONFLICT,
          { orderLineId: line.id, open: line.quantity - line.receivedQuantity }
        )
      }
    }

    const settings = await tx.financeSettings.findUnique({
      where: { organizationId },
      select: { taxRounding: true }
    })
    if (settings === null) throw financeRefusal(ErrorCodes.FINANCE_SETUP_REQUIRED)
    const supplier = await tx.supplier.findFirst({
      where: { id: order.supplierId, organizationId },
      select: { id: true, paymentTermsDays: true, defaultPayableAccountId: true }
    })
    if (supplier === null) throw resourceNotFound('supplier')
    const rateIds = [
      ...new Set(chosen.flatMap(line => (line.taxRateId === null ? [] : [line.taxRateId])))
    ]
    const rates = new Map(
      (
        await tx.taxRate.findMany({
          where: { id: { in: rateIds }, organizationId },
          select: { id: true, rateBps: true, inputAccountId: true, active: true }
        })
      ).map(rate => [rate.id, rate])
    )

    const inputs = chosen.map(line => ({
      quantity: sent.get(line.id) ?? 0,
      unitCostCents: line.unitCostCents,
      rateBps: line.taxRateId === null ? null : (rates.get(line.taxRateId)?.rateBps ?? null)
    }))
    const money = receiptMoney(inputs, settings.taxRounding as TaxRounding)
    const document = body.supplierDocumentNumber ?? null
    const taxCreditable = body.taxCreditable ?? document !== null
    const problems: PurchaseRuleName[] = [
      ...receiptProblems(inputs, money),
      ...(chosen.some(line => line.taxRateId !== null && rates.get(line.taxRateId)?.active !== true)
        ? [PurchaseRule.TAX_RATE_INACTIVE]
        : []),
      // The tax is credited only against a supplier document, and its number is what says there is one [ACCOUNTANT]
      ...(taxCreditable && document === null ? [PurchaseRule.CREDITABLE_NEEDS_DOCUMENT] : []),
      ...(body.receivedOn > latestDay() ? [PurchaseRule.DATE_IN_FUTURE] : [])
    ]
    if (problems.length > 0) throw invalidPurchase(problems)
    // Several receipts of ONE order may share the supplier's invoice (it arrives in parts); the same invoice on another order would
    // credit its tax twice, so it is refused [ACCOUNTANT]
    if (document !== null) {
      const elsewhere = await tx.purchaseReceipt.count({
        where: {
          organizationId,
          supplierId: supplier.id,
          supplierDocumentNumber: document,
          purchaseOrderId: { not: orderId }
        }
      })
      if (elsewhere > 0) {
        throw resourceConflict('the supplier document belongs to another purchase order', {
          conflict: PurchaseConflicts.DOCUMENT_NUMBER_IN_USE
        })
      }
    }

    const inventoryAccountId = await roleAccount(tx, organizationId, AccountRole.INVENTORY)
    const payableAccountId =
      supplier.defaultPayableAccountId ??
      (await roleAccount(tx, organizationId, AccountRole.PAYABLE_SUPPLIERS))
    const uncreditableTaxAccountId = needsUncreditableTaxAccount(money, taxCreditable)
      ? await roleAccount(tx, organizationId, AccountRole.UNCATEGORIZED_EXPENSE)
      : null

    const receiptId = randomUUID()
    // The stock first: it takes the level rows (always in the same order) and refuses what cannot be received (a store not linked to
    // the warehouse, a product switched off) before anything is posted
    const movements = await this.inventory.moveMany(
      chosen.map((line, index) => ({
        storeId: line.storeId,
        productId: line.productId,
        variantId: line.variantId,
        warehouseId: order.warehouseId,
        type: InventoryMovementType.RECEIPT,
        quantity: inputs[index]?.quantity ?? 0,
        idempotencyKey: PurchaseIdempotencyKey.RECEIPT_LINE(receiptId, line.id),
        unitCostCents: line.unitCostCents,
        note: order.number,
        reference: { type: InventoryReferenceType.PURCHASE_RECEIPT, id: receiptId },
        createdBy: actor.userId
      })),
      tx
    )

    // The arrays below go by position: a stock engine that answered another number of movements would write a wrong receipt, so it stops here
    if (movements.length !== chosen.length) {
      throw new Error(
        'the stock engine answered another number of movements than the receipt has lines'
      )
    }
    const posted = await this.ledger.post(
      {
        organizationId,
        entryDate: body.receivedOn,
        type: JournalEntryType.PURCHASE_RECEIPT,
        sourceType: FinanceSourceType.PURCHASE_RECEIPT,
        sourceId: receiptId,
        sourceDate: body.receivedOn,
        idempotencyKey: PurchaseIdempotencyKey.RECEIPT(receiptId),
        memo: order.number,
        origin: EntryOrigin.USER,
        createdBy: actor.userId,
        lines: receiptEntryLines(
          chosen.map((line, index) => ({
            subtotalCents: money.lines[index]?.subtotalCents ?? 0,
            taxCents: money.lines[index]?.taxCents ?? 0,
            storeId: line.storeId,
            taxRateId: line.taxRateId,
            inputTaxAccountId:
              line.taxRateId === null ? null : (rates.get(line.taxRateId)?.inputAccountId ?? null)
          })),
          {
            inventoryAccountId,
            payableAccountId,
            uncreditableTaxAccountId,
            supplierId: supplier.id
          },
          taxCreditable
        )
      },
      tx
    )

    await tx.purchaseReceipt.create({
      data: {
        id: receiptId,
        organizationId,
        purchaseOrderId: orderId,
        supplierId: supplier.id,
        receivedOn: dayToDate(body.receivedOn),
        dueOn: dayToDate(dueDay(body.receivedOn, supplier.paymentTermsDays)),
        supplierDocumentNumber: document,
        taxCreditable,
        subtotalCents: money.subtotalCents,
        taxCents: money.taxCents,
        totalCents: money.totalCents,
        clientKey: body.idempotencyKey,
        entryId: posted.id,
        createdBy: actor.userId
      }
    })
    await tx.purchaseReceiptLine.createMany({
      data: chosen.map((line, index) => ({
        organizationId,
        storeId: line.storeId,
        receiptId,
        orderLineId: line.id,
        quantity: inputs[index]?.quantity ?? 0,
        unitCostCents: line.unitCostCents,
        subtotalCents: money.lines[index]?.subtotalCents ?? 0,
        taxCents: money.lines[index]?.taxCents ?? 0,
        movementId: movements[index]?.movement.id ?? ''
      }))
    })
    for (const [index, line] of chosen.entries()) {
      await tx.purchaseOrderLine.update({
        where: { id: line.id },
        data: { receivedQuantity: { increment: inputs[index]?.quantity ?? 0 } }
      })
    }
    const after = await tx.purchaseOrderLine.findMany({
      where: { organizationId, purchaseOrderId: orderId },
      select: { quantity: true, receivedQuantity: true }
    })
    const status = statusAfterReceipt(after)
    if (!canTransition(current, status) && current !== status) {
      throw invalidTransition(order.status, status)
    }
    await tx.purchaseOrder.update({ where: { id: orderId }, data: { status } })

    this.events.publish(tx, Events.PURCHASE_ORDER_RECEIVED, {
      organizationId,
      purchaseOrderId: orderId,
      receiptId,
      supplierId: supplier.id,
      status,
      actor: { type: EntryOrigin.USER, id: actor.userId }
    })
    return {
      receiptId,
      replayed: false,
      status,
      entryNumber: posted.number,
      totalCents: money.totalCents
    }
  }

  // The same key with the same content is the same request; with another content it is a mistake of the client
  private async sameReceive(
    tx: PrismaTransaction,
    organizationId: string,
    receiptId: string,
    body: ReceivePurchaseOrderBody
  ): Promise<boolean> {
    const receipt = await tx.purchaseReceipt.findFirst({
      where: { id: receiptId, organizationId },
      select: { receivedOn: true, supplierDocumentNumber: true, taxCreditable: true }
    })
    const lines = await tx.purchaseReceiptLine.findMany({
      where: { organizationId, receiptId },
      select: { orderLineId: true, quantity: true }
    })
    if (receipt === null) return false
    const document = body.supplierDocumentNumber ?? null
    return (
      dateToDay(receipt.receivedOn) === body.receivedOn &&
      receipt.supplierDocumentNumber === document &&
      receipt.taxCreditable === (body.taxCreditable ?? document !== null) &&
      lines.length === body.lines.length &&
      body.lines.every(sent =>
        lines.some(line => line.orderLineId === sent.orderLineId && line.quantity === sent.quantity)
      )
    )
  }
}
