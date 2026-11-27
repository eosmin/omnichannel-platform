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
  PurchaseDocumentProblems,
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
  documentNumberKey,
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
import { FiscalPurchaseDocumentService } from '@platform/fiscal/runtime'

import { lockScope } from '../finance/finance.support'
import type { Actor } from '../tenancy'

import { PurchaseOrdersService } from './purchase-orders.service'
import { seesEveryLine, visibleStoreIdsIn } from './purchases.reach'
import type { CompleteReceiptDocumentBody, ReceivePurchaseOrderBody } from './purchases.schemas'
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
    private readonly orders: PurchaseOrdersService,
    private readonly documents: FiscalPurchaseDocumentService
  ) {}

  async receive(
    organizationId: string,
    orderId: string,
    body: ReceivePurchaseOrderBody,
    actor: Actor
  ): Promise<OrderView> {
    const received = await this.prisma.transaction(tx =>
      this.receiveIn(tx, organizationId, orderId, body, actor)
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
    actor: Actor
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
    // A line is read and written by the members of its store only: a receipt must be wholly the caller's. The stores the caller may write
    // are read HERE, in this transaction and after the lock of the order, right before the stock moves: with the context of every store
    // of the organization the database no longer refuses a write to a sibling store, so a permission revoked while this request waited
    // for the lock is honored by this read and by nothing else
    const visible = await visibleStoreIdsIn(tx, organizationId, actor.userId)
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
          select: { id: true, rateBps: true, inputAccountId: true }
        })
      ).map(rate => [rate.id, rate])
    )

    // A rate that cannot be found is no tax: refused, never read as zero
    if (rateIds.some(id => !rates.has(id))) throw resourceNotFound('tax rate')
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
      // A rate switched off after the order was placed does not stop the receipt: a placed order cannot be edited and the supplier's invoice
      // carries that tax. The receipt posts with the rate as it is now (its percent and input account), and the accounts of a rate stay
      // active while the rate exists (HC-124)
      // The tax is credited only against a supplier document, and its number is what says there is one [ACCOUNTANT]
      ...(taxCreditable && document === null ? [PurchaseRule.CREDITABLE_NEEDS_DOCUMENT] : []),
      ...(body.receivedOn > latestDay() ? [PurchaseRule.DATE_IN_FUTURE] : [])
    ]
    if (problems.length > 0) throw invalidPurchase(problems)
    // The data of the supplier's document, when sent, is right by the rules of the provider and is not another receipt's
    const fiscal = body.fiscalDocument
    if (fiscal !== undefined) {
      await this.checkDocument(tx, organizationId, fiscal, document, body.receivedOn, null)
    }
    // Several receipts of ONE order may share the supplier's invoice (it arrives in parts); the same invoice on another order would
    // credit its tax twice, so it is refused [ACCOUNTANT]
    if (document !== null) {
      // Compared by letters and digits only, so the case, the spaces and the hyphens do not make another invoice (HC-124)
      const key = documentNumberKey(document)
      const others = await tx.purchaseReceipt.findMany({
        where: {
          organizationId,
          supplierId: supplier.id,
          supplierDocumentNumber: { not: null },
          purchaseOrderId: { not: orderId }
        },
        distinct: ['supplierDocumentNumber'],
        select: { supplierDocumentNumber: true }
      })
      // A number with no letter or digit has no key: it is compared as typed
      const elsewhere = others.filter(other =>
        key === ''
          ? other.supplierDocumentNumber === document
          : documentNumberKey(other.supplierDocumentNumber ?? '') === key
      ).length
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
    if (fiscal !== undefined) {
      await tx.purchaseReceiptDocument.create({
        data: { organizationId, receiptId, createdBy: actor.userId, ...documentColumns(fiscal) }
      })
    }
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

  // Completes the data of the supplier's document of a receipt written before (or without it), or marks the receipt as left out of the annex
  // of purchases. The money of the receipt and its entry are never touched: only the columns that say how the annex reads it.
  async completeDocument(
    organizationId: string,
    orderId: string,
    receiptId: string,
    body: CompleteReceiptDocumentBody,
    actor: Actor
  ): Promise<OrderView> {
    const previous = await this.prisma.transaction(async tx => {
      await lockScope(tx, `${organizationId}:purchase:${orderId}`)
      const receipt = await tx.purchaseReceipt.findFirst({
        where: { id: receiptId, purchaseOrderId: orderId, organizationId },
        select: {
          id: true,
          receivedOn: true,
          supplierDocumentNumber: true,
          taxCreditable: true,
          document: {
            select: {
              issuedOn: true,
              documentClass: true,
              documentType: true,
              generationCode: true,
              purchaseOrigin: true,
              expenseClass: true,
              sector: true,
              costType: true,
              annexExclusion: true
            }
          }
        }
      })
      if (receipt === null) throw resourceNotFound('purchase receipt')
      // As to receive it: a receipt is the caller's only if every line of it is of a store the caller sees
      const receiptLines = await tx.purchaseReceiptLine.findMany({
        where: { organizationId, receiptId },
        select: { storeId: true }
      })
      const visible = await visibleStoreIdsIn(tx, organizationId, actor.userId)
      if (!seesEveryLine(receiptLines, visible)) {
        throw resourceConflict('a line of the receipt is of a store the caller does not see', {
          conflict: PurchaseConflicts.LINE_STORE_NOT_VISIBLE
        })
      }
      if ('fiscalDocument' in body) {
        await this.checkDocument(
          tx,
          organizationId,
          body.fiscalDocument,
          receipt.supplierDocumentNumber,
          dateToDay(receipt.receivedOn),
          receipt.id
        )
        const columns = { ...documentColumns(body.fiscalDocument), annexExclusion: null }
        await tx.purchaseReceiptDocument.upsert({
          where: { organizationId_receiptId: { organizationId, receiptId: receipt.id } },
          create: { organizationId, receiptId: receipt.id, createdBy: actor.userId, ...columns },
          update: columns
        })
      } else {
        // A receipt that claims the tax as input VAT has a document that the annex declares: it is not left out. One that credits no tax may
        // be, with a reason from the closed list, and the audit row keeps what the document said before
        if (receipt.taxCreditable) {
          throw resourceConflict(
            'a receipt with a document to declare is not left out of the annex',
            {
              conflict: PurchaseConflicts.ANNEX_EXCLUSION_WITH_DOCUMENT
            }
          )
        }
        const columns = {
          ...documentColumns(undefined),
          annexExclusion: body.annexExclusion
        }
        await tx.purchaseReceiptDocument.upsert({
          where: { organizationId_receiptId: { organizationId, receiptId: receipt.id } },
          create: { organizationId, receiptId: receipt.id, createdBy: actor.userId, ...columns },
          update: columns
        })
      }
      // What the row said before: the audit keeps it, so a document that was declared and then changed leaves a trace
      return receipt.document
    })
    this.audit.log({
      action: AuditAction.PURCHASE_RECEIPT_DOCUMENT_COMPLETED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: PurchaseResourceTypes.PURCHASE_RECEIPT,
      resourceId: receiptId,
      metadata: {
        purchaseOrderId: orderId,
        // The codes of a document are not personal data: the values it had before and the ones it has now are in the row of the trail
        previous: previous === null ? null : trailOf(previous),
        current:
          'annexExclusion' in body
            ? { annexExclusion: body.annexExclusion }
            : trailOf(documentColumns(body.fiscalDocument))
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.orders.get(organizationId, orderId, actor)
  }

  // The rules of the provider on the document, and that its code of generation is on no other receipt of the organization
  private async checkDocument(
    tx: PrismaTransaction,
    organizationId: string,
    fiscal: NonNullable<ReceivePurchaseOrderBody['fiscalDocument']>,
    documentNumber: string | null,
    receivedOn: string,
    receiptId: string | null
  ): Promise<void> {
    const asked = await this.documents.problems(tx, organizationId, {
      issuedOn: fiscal.issuedOn,
      receivedOn,
      documentClass: fiscal.documentClass,
      documentType: fiscal.documentType,
      generationCode: fiscal.generationCode ?? null,
      documentNumber,
      origin: fiscal.origin,
      expenseClass: fiscal.expenseClass,
      sector: fiscal.sector,
      costType: fiscal.costType
    })
    // A document is never issued after the day it arrived, whatever the provider says (an organization with no issuer has no rule of its own)
    const found = [
      ...new Set([
        ...(fiscal.issuedOn > receivedOn ? [PurchaseDocumentProblems.ISSUED_AFTER_RECEIPT] : []),
        ...asked
      ])
    ]
    if (found.length > 0) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_INVALID_INPUT,
        'the document of the purchase breaks a rule of the provider',
        HttpStatusCodes.BAD_REQUEST,
        { problems: found }
      )
    }
    const code = normalizedCode(fiscal.generationCode)
    if (code === null) return
    // Two requests with one code do not both pass
    await lockScope(tx, `${organizationId}:generation_code:${code}`)
    const other = await tx.purchaseReceiptDocument.findFirst({
      where: {
        organizationId,
        generationCode: code,
        ...(receiptId === null ? {} : { receiptId: { not: receiptId } })
      },
      select: { id: true }
    })
    if (other !== null) {
      throw resourceConflict('the document is already on another receipt', {
        conflict: PurchaseConflicts.GENERATION_CODE_IN_USE
      })
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
      select: {
        receivedOn: true,
        supplierDocumentNumber: true,
        taxCreditable: true,
        document: {
          select: {
            issuedOn: true,
            documentClass: true,
            documentType: true,
            generationCode: true,
            purchaseOrigin: true,
            expenseClass: true,
            sector: true,
            costType: true
          }
        }
      }
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
      (body.fiscalDocument === undefined ||
        sameDocument(receipt.document, documentColumns(body.fiscalDocument))) &&
      lines.length === body.lines.length &&
      body.lines.every(sent =>
        lines.some(line => line.orderLineId === sent.orderLineId && line.quantity === sent.quantity)
      )
    )
  }
}

// The code of generation of a received document is stored in capitals, the way the authority writes it
const normalizedCode = (code: string | undefined): string | null =>
  code === undefined ? null : code.toUpperCase()

interface DocumentColumns {
  issuedOn: Date | null
  documentClass: string | null
  documentType: string | null
  generationCode: string | null
  purchaseOrigin: string | null
  expenseClass: string | null
  sector: string | null
  costType: string | null
}

// The columns of a receipt that hold the supplier's document: all null when none was sent
function documentColumns(fiscal: ReceivePurchaseOrderBody['fiscalDocument']): DocumentColumns {
  return {
    issuedOn: fiscal === undefined ? null : dayToDate(fiscal.issuedOn),
    documentClass: fiscal?.documentClass ?? null,
    documentType: fiscal?.documentType ?? null,
    generationCode: normalizedCode(fiscal?.generationCode),
    purchaseOrigin: fiscal?.origin ?? null,
    expenseClass: fiscal?.expenseClass ?? null,
    sector: fiscal?.sector ?? null,
    costType: fiscal?.costType ?? null
  }
}

function sameDocument(stored: DocumentColumns | null, sent: DocumentColumns): boolean {
  const has = stored ?? documentColumns(undefined)
  return (
    has.issuedOn?.getTime() === sent.issuedOn?.getTime() &&
    has.documentClass === sent.documentClass &&
    has.documentType === sent.documentType &&
    has.generationCode === sent.generationCode &&
    has.purchaseOrigin === sent.purchaseOrigin &&
    has.expenseClass === sent.expenseClass &&
    has.sector === sent.sector &&
    has.costType === sent.costType
  )
}

// A row of the audit trail: the days as text and the code of generation as it is kept (in capitals), so what it says before and now reads alike
function trailOf(
  columns: DocumentColumns & { annexExclusion?: string | null }
): Record<string, string | null> {
  return {
    issuedOn: columns.issuedOn === null ? null : dateToDay(columns.issuedOn),
    documentClass: columns.documentClass,
    documentType: columns.documentType,
    generationCode: columns.generationCode,
    purchaseOrigin: columns.purchaseOrigin,
    expenseClass: columns.expenseClass,
    sector: columns.sector,
    costType: columns.costType,
    annexExclusion: columns.annexExclusion ?? null
  }
}
