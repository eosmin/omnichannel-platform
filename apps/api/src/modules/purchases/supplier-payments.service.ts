import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  AccountRole,
  EntryOrigin,
  FinanceSourceType,
  JournalEntryType,
  PurchaseConflicts,
  PurchaseIdempotencyKey,
  PurchaseResourceTypes
} from '@platform/core/domain'
import {
  ErrorCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import {
  dateToDay,
  dayToDate,
  paymentLines,
  paymentProblems,
  PaymentRule,
  PurchaseRule,
  type PaymentRuleName
} from '@platform/core/finance'
import { LedgerService } from '@platform/core/finance-ledger'

import { encodeCursor } from '../customers/list-cursor'
import { lockScope } from '../finance/finance.support'
import type { Actor } from '../tenancy'

import { PayablesService } from './payables.service'
import type { ListPaymentsQuery, RecordPaymentBody, VoidPaymentBody } from './purchases.schemas'
import { invalidPurchase, latestDay, roleAccount } from './purchases.support'
import {
  PAYMENT_SELECT,
  type PaymentPage,
  type PaymentRow,
  type PaymentView,
  paymentView
} from './purchases.views'

interface Recorded {
  id: string
  replayed: boolean
  entryNumber: bigint | null
}

// What the organization pays its suppliers (TDD_18 §4.2 E11): a payment is a row and ONE journal entry written in the same transaction
// through LedgerService (Dr the payable account with the supplier as party, Cr the cash, bank or wallet account the person chose). It
// never exceeds what is owed: to the supplier in all, nor, when it names a bill, the open part of that bill. A payment is never edited;
// voiding it writes the reversing entry and the bill is owed again. The supplier is locked while it is checked, so two payments at once
// never pass the balance together.
@Injectable()
export class SupplierPaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly payables: PayablesService
  ) {}

  // The live and voided payments of a supplier, the newest first
  async list(
    organizationId: string,
    supplierId: string,
    query: ListPaymentsQuery,
    purchaseOrderId: string | null = null
  ): Promise<PaymentPage> {
    const supplier = await this.prisma.client.supplier.findFirst({
      where: { id: supplierId, organizationId },
      select: { id: true }
    })
    if (supplier === null) throw resourceNotFound('supplier')
    const { cursor } = query
    const rows = await this.prisma.client.supplierPayment.findMany({
      where: {
        organizationId,
        supplierId,
        ...(purchaseOrderId === null ? {} : { receipt: { purchaseOrderId } }),
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: PAYMENT_SELECT,
      take: query.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(paymentView),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  // The payments of the bills of one purchase order
  async listOfOrder(
    organizationId: string,
    orderId: string,
    query: ListPaymentsQuery
  ): Promise<PaymentPage> {
    const order = await this.prisma.client.purchaseOrder.findFirst({
      where: { id: orderId, organizationId },
      select: { supplierId: true }
    })
    if (order === null) throw resourceNotFound('purchase order')
    return this.list(organizationId, order.supplierId, query, orderId)
  }

  // The route of a purchase order: pays a bill of THAT order (the supplier is the order's)
  async recordForOrder(
    organizationId: string,
    orderId: string,
    body: RecordPaymentBody,
    actor: Actor
  ): Promise<PaymentView> {
    const order = await this.prisma.client.purchaseOrder.findFirst({
      where: { id: orderId, organizationId },
      select: { supplierId: true }
    })
    if (order === null) throw resourceNotFound('purchase order')
    return this.record(organizationId, order.supplierId, body, actor, orderId)
  }

  // Records one. The key is the screen's: a retry (a double click, a lost answer) finds the first and writes nothing. `orderId` is set
  // by the route of a purchase order: the bill it names must belong to that order.
  async record(
    organizationId: string,
    supplierId: string,
    body: RecordPaymentBody,
    actor: Actor,
    orderId: string | null = null
  ): Promise<PaymentView> {
    const recorded = await this.prisma.transaction(async tx => {
      await lockScope(tx, `${organizationId}:supplier_payment:${body.idempotencyKey}`)
      const found = await tx.supplierPayment.findUnique({
        where: { organizationId_clientKey: { organizationId, clientKey: body.idempotencyKey } },
        select: PAYMENT_SELECT
      })
      if (found !== null) {
        if (!this.sameRequest(found, supplierId, body)) {
          throw resourceConflict('the key of the request belongs to another payment', {
            conflict: PurchaseConflicts.KEY_REUSED
          })
        }
        // A retry with the key of a payment that was voided meanwhile is not the payment it asked for: answering 201 with the voided
        // payment would tell the caller that the supplier was paid. A new payment takes a new key (HC-213)
        if (found.voidedByEntryId !== null) throw this.alreadyVoided()
        return { id: found.id, replayed: true, entryNumber: null }
      }
      return this.recordIn(tx, organizationId, supplierId, body, actor, orderId)
    })
    if (!recorded.replayed) {
      this.audit.log({
        action: AuditAction.SUPPLIER_PAID,
        actor: { userId: actor.userId },
        organizationId,
        storeId: actor.storeId,
        resourceType: PurchaseResourceTypes.SUPPLIER_PAYMENT,
        resourceId: recorded.id,
        metadata: {
          supplierId,
          amountCents: body.amountCents,
          purchaseReceiptId: body.purchaseReceiptId ?? null,
          entryNumber: recorded.entryNumber?.toString() ?? null
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    const row = await this.prisma.client.supplierPayment.findFirst({
      where: { id: recorded.id, organizationId },
      select: PAYMENT_SELECT
    })
    if (row === null) throw resourceNotFound('supplier payment')
    // A void may commit between the replay and this read (the two take different locks): the row read here decides
    if (recorded.replayed && row.voidedByEntryId !== null) throw this.alreadyVoided()
    return paymentView(row)
  }

  // Voids one: the reversing entry is posted (dated like the original, or in the open period when the original's is closed) and the
  // payment points at it. The reason is the memo of the reversal. HIGH tier of DestructiveActionTiers (VOID_SUPPLIER_PAYMENT).
  async voidPayment(
    organizationId: string,
    id: string,
    body: VoidPaymentBody,
    actor: Actor
  ): Promise<PaymentView> {
    const reversalEntryId = await this.prisma.transaction(async tx => {
      const original = await tx.supplierPayment.findFirst({
        where: { id, organizationId },
        select: { supplierId: true, entryId: true, voidedByEntryId: true }
      })
      if (original === null) throw resourceNotFound('supplier payment')
      // The supplier is locked like in a payment: a bill is never read half way between the void and its payments
      await lockScope(tx, `${organizationId}:supplier:${original.supplierId}`)
      if (original.voidedByEntryId !== null) throw this.alreadyVoided()
      // A return of this payment that nobody voided already reopened its debt: it is voided first, or the debt would be reopened twice
      const live = await tx.supplierPaymentReturn.count({
        where: { organizationId, supplierPaymentId: id, voidedByEntryId: null }
      })
      if (live > 0) {
        throw resourceConflict('the payment has a return: void the return first', {
          conflict: PurchaseConflicts.PAYMENT_HAS_RETURNS
        })
      }
      // The reversal found under the entry is another request's (another person or another reason got the lock first): the payment was
      // voided already, the typed answer of this route
      const reversal = await this.ledger
        .reverse(
          {
            organizationId,
            entryId: original.entryId,
            memo: body.reason,
            entryDate: null,
            createdBy: actor.userId
          },
          tx
        )
        .catch((error: unknown) => {
          if (
            error instanceof PlatformException &&
            error.code === ErrorCodes.FINANCE_ENTRY_ALREADY_REVERSED
          ) {
            throw this.alreadyVoided()
          }
          throw error
        })
      // The pointer is set once: a second request that got here after the first committed finds it set and answers it
      const pointed = await tx.supplierPayment.updateMany({
        where: { id, organizationId, voidedByEntryId: null },
        data: { voidedByEntryId: reversal.id }
      })
      if (pointed.count === 0) throw this.alreadyVoided()
      return reversal.id
    })
    this.audit.log({
      action: AuditAction.SUPPLIER_PAYMENT_VOIDED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: PurchaseResourceTypes.SUPPLIER_PAYMENT,
      resourceId: id,
      metadata: { reversalEntryId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    const row = await this.prisma.client.supplierPayment.findFirst({
      where: { id, organizationId },
      select: PAYMENT_SELECT
    })
    if (row === null) throw resourceNotFound('supplier payment')
    return paymentView(row)
  }

  private alreadyVoided() {
    return resourceConflict('the payment was voided already', {
      conflict: PurchaseConflicts.PAYMENT_ALREADY_VOIDED
    })
  }

  private async recordIn(
    tx: PrismaTransaction,
    organizationId: string,
    supplierId: string,
    body: RecordPaymentBody,
    actor: Actor,
    orderId: string | null
  ): Promise<Recorded> {
    // The supplier is locked until the end: the balance this payment is checked against is the one it leaves
    await lockScope(tx, `${organizationId}:supplier:${supplierId}`)
    const supplier = await tx.supplier.findFirst({
      where: { id: supplierId, organizationId },
      select: { id: true, defaultPayableAccountId: true }
    })
    if (supplier === null) throw resourceNotFound('supplier')

    const paidFrom = await tx.ledgerAccount.findFirst({
      where: { id: body.paidFromAccountId, organizationId },
      select: { id: true, cashKind: true }
    })
    if (paidFrom === null) throw resourceNotFound('ledger account')
    const problems: PaymentRuleName[] = [
      ...paymentProblems({
        amountCents: body.amountCents,
        paidFromIsCash: paidFrom.cashKind !== null
      }),
      ...(body.paidOn > latestDay() ? [PaymentRule.DATE_IN_FUTURE] : [])
    ]
    if (problems.length > 0) throw invalidPurchase(problems)

    const { supplier: balance } = await this.payables.openBalance(tx, organizationId, supplierId)
    if (body.purchaseReceiptId !== undefined) {
      const bill = await tx.purchaseReceipt.findFirst({
        where: {
          id: body.purchaseReceiptId,
          organizationId,
          supplierId,
          ...(orderId === null ? {} : { purchaseOrderId: orderId })
        },
        select: { id: true, totalCents: true }
      })
      if (bill === null) throw resourceNotFound('purchase receipt')
      const named = await tx.supplierPayment.aggregate({
        where: { organizationId, purchaseReceiptId: bill.id, voidedByEntryId: null },
        _sum: { amountCents: true }
      })
      // What the supplier gave back of those payments is owed again on the bill
      const given = await tx.supplierPaymentReturn.aggregate({
        where: { organizationId, voidedByEntryId: null, payment: { purchaseReceiptId: bill.id } },
        _sum: { amountCents: true }
      })
      const openOnBill =
        bill.totalCents - (named._sum.amountCents ?? 0) + (given._sum.amountCents ?? 0)
      if (body.amountCents > openOnBill) {
        throw resourceConflict('a payment is never above what is open on its bill', {
          conflict: PurchaseConflicts.PAYMENT_EXCEEDS_RECEIPT,
          openCents: openOnBill
        })
      }
    } else if (orderId !== null) {
      // The route of an order pays the bills of that order: a payment with no bill is the supplier's, at the route of the supplier
      throw invalidPurchase([PurchaseRule.BILL_REQUIRED])
    }
    if (body.amountCents > balance.openCents) {
      throw resourceConflict('a payment is never above what the supplier is owed', {
        conflict: PurchaseConflicts.PAYMENT_EXCEEDS_BALANCE,
        openCents: balance.openCents
      })
    }
    const payableAccountId =
      supplier.defaultPayableAccountId ??
      (await roleAccount(tx, organizationId, AccountRole.PAYABLE_SUPPLIERS))
    const id = randomUUID()
    const posted = await this.ledger.post(
      {
        organizationId,
        entryDate: body.paidOn,
        type: JournalEntryType.SUPPLIER_PAYMENT,
        sourceType: FinanceSourceType.SUPPLIER_PAYMENT,
        sourceId: id,
        sourceDate: body.paidOn,
        idempotencyKey: PurchaseIdempotencyKey.PAYMENT(id),
        memo: body.reference ?? null,
        origin: EntryOrigin.USER,
        createdBy: actor.userId,
        lines: paymentLines({
          payableAccountId,
          paidFromAccountId: paidFrom.id,
          supplierId,
          amountCents: body.amountCents
        })
      },
      tx
    )
    await tx.supplierPayment.create({
      data: {
        id,
        organizationId,
        supplierId,
        purchaseReceiptId: body.purchaseReceiptId ?? null,
        paidFromAccountId: paidFrom.id,
        amountCents: body.amountCents,
        paidOn: dayToDate(body.paidOn),
        reference: body.reference ?? null,
        clientKey: body.idempotencyKey,
        entryId: posted.id,
        createdBy: actor.userId
      }
    })
    return { id, replayed: false, entryNumber: posted.number }
  }

  // The same key with the same content is the same request; with another content it is a mistake of the client, never a second payment
  private sameRequest(found: PaymentRow, supplierId: string, body: RecordPaymentBody): boolean {
    return (
      found.supplierId === supplierId &&
      found.purchaseReceiptId === (body.purchaseReceiptId ?? null) &&
      found.paidFromAccountId === body.paidFromAccountId &&
      found.amountCents === body.amountCents &&
      dateToDay(found.paidOn) === body.paidOn &&
      found.reference === (body.reference ?? null)
    )
  }
}
