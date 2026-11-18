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
  paymentReturnLines,
  paymentReturnProblems
} from '@platform/core/finance'
import { LedgerService } from '@platform/core/finance-ledger'

import { encodeCursor } from '../customers/list-cursor'
import { lockScope } from '../finance/finance.support'
import type { Actor } from '../tenancy'

import { PayablesService } from './payables.service'
import type {
  ListPaymentsQuery,
  RecordPaymentReturnBody,
  VoidPaymentReturnBody
} from './purchases.schemas'
import { invalidPurchase, latestDay, roleAccount } from './purchases.support'
import {
  PAYMENT_RETURN_SELECT,
  type PaymentReturnPage,
  type PaymentReturnRow,
  type PaymentReturnView,
  paymentReturnView
} from './purchases.views'

interface Recorded {
  id: string
  replayed: boolean
  entryNumber: bigint | null
}

// What a supplier gave back of a payment (TDD_18 §4.2 E11b, HC-121): the bank returned the money or the payment bounced. It is a row and ONE
// journal entry written in the same transaction through LedgerService (Dr the cash, bank or wallet account the money came back into, Cr the
// payable account with the supplier as party), so the debt is owed again by that amount and the bank statement can match the entry. The
// payment is never touched: it happened, and the bank saw it. A return is never above what is left of its payment (the payment minus its
// live returns), is never dated before the payment, and never lands in a closed month (the ledger refuses it: nothing is posted backwards
// into a frozen period). It is never edited; voiding it writes the reversing entry and the debt goes back to what it was.
@Injectable()
export class SupplierPaymentReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly payables: PayablesService
  ) {}

  // The returns of one payment, the newest first
  async list(
    organizationId: string,
    paymentId: string,
    query: ListPaymentsQuery
  ): Promise<PaymentReturnPage> {
    const payment = await this.prisma.client.supplierPayment.findFirst({
      where: { id: paymentId, organizationId },
      select: { id: true }
    })
    if (payment === null) throw resourceNotFound('supplier payment')
    const { cursor } = query
    const rows = await this.prisma.client.supplierPaymentReturn.findMany({
      where: {
        organizationId,
        supplierPaymentId: paymentId,
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: PAYMENT_RETURN_SELECT,
      take: query.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(paymentReturnView),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  // Records one. The key is the screen's: a retry (a double click, a lost answer) finds the first and writes nothing.
  async record(
    organizationId: string,
    paymentId: string,
    body: RecordPaymentReturnBody,
    actor: Actor
  ): Promise<PaymentReturnView> {
    const recorded = await this.prisma.transaction(async tx => {
      await lockScope(tx, `${organizationId}:supplier_payment_return:${body.idempotencyKey}`)
      const found = await tx.supplierPaymentReturn.findUnique({
        where: { organizationId_clientKey: { organizationId, clientKey: body.idempotencyKey } },
        select: PAYMENT_RETURN_SELECT
      })
      if (found !== null) {
        if (!this.sameRequest(found, paymentId, body)) {
          throw resourceConflict('the key of the request belongs to another return', {
            conflict: PurchaseConflicts.KEY_REUSED
          })
        }
        // A retry with the key of a return that was voided meanwhile is not the return it asked for: a new one takes a new key
        if (found.voidedByEntryId !== null) throw this.alreadyVoided()
        return { id: found.id, replayed: true, entryNumber: null }
      }
      return this.recordIn(tx, organizationId, paymentId, body, actor)
    })
    const row = await this.read(organizationId, recorded.id)
    if (!recorded.replayed) {
      this.audit.log({
        action: AuditAction.SUPPLIER_PAYMENT_RETURNED,
        actor: { userId: actor.userId },
        organizationId,
        storeId: actor.storeId,
        resourceType: PurchaseResourceTypes.SUPPLIER_PAYMENT_RETURN,
        resourceId: recorded.id,
        metadata: {
          supplierId: row.supplierId,
          supplierPaymentId: paymentId,
          amountCents: row.amountCents,
          entryNumber: recorded.entryNumber?.toString() ?? null
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    // A void may commit between the replay and this read (the two take different locks): the row read here decides
    if (recorded.replayed && row.voidedByEntryId !== null) throw this.alreadyVoided()
    return paymentReturnView(row)
  }

  // Voids one: the reversing entry is posted (dated like the original, or in the open period when the original's is closed) and the return
  // points at it. HIGH tier of DestructiveActionTiers (VOID_SUPPLIER_PAYMENT_RETURN). A return the bank statement matched is not voided
  // (the match is taken back first: the ledger says FINANCE_ENTRY_RECONCILED).
  async voidReturn(
    organizationId: string,
    id: string,
    body: VoidPaymentReturnBody,
    actor: Actor
  ): Promise<PaymentReturnView> {
    const reversalEntryId = await this.prisma.transaction(async tx => {
      const original = await tx.supplierPaymentReturn.findFirst({
        where: { id, organizationId },
        select: {
          supplierId: true,
          entryId: true,
          voidedByEntryId: true,
          amountCents: true,
          payment: { select: { purchaseReceiptId: true } }
        }
      })
      if (original === null) throw resourceNotFound('supplier payment return')
      await lockScope(tx, `${organizationId}:supplier:${original.supplierId}`)
      if (original.voidedByEntryId !== null) throw this.alreadyVoided()
      // The return reopened a debt that may have been paid again: voiding it takes that money back out of the debt, so the payments would
      // pass what is owed (to the supplier in all, or on the bill the payment named) and the payable account would stop agreeing with them
      const { supplier: balance, bills } = await this.payables.openBalance(
        tx,
        organizationId,
        original.supplierId
      )
      const billId = original.payment.purchaseReceiptId
      const billOpen = bills.find(bill => bill.id === billId)?.openCents ?? Number.POSITIVE_INFINITY
      if (original.amountCents > balance.openCents || original.amountCents > billOpen) {
        throw resourceConflict('the debt it reopened was paid again', {
          conflict: PurchaseConflicts.RETURN_VOID_WOULD_OVERPAY,
          openCents: Math.min(balance.openCents, billOpen)
        })
      }
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
      const pointed = await tx.supplierPaymentReturn.updateMany({
        where: { id, organizationId, voidedByEntryId: null },
        data: { voidedByEntryId: reversal.id }
      })
      if (pointed.count === 0) throw this.alreadyVoided()
      return reversal.id
    })
    this.audit.log({
      action: AuditAction.SUPPLIER_PAYMENT_RETURN_VOIDED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: PurchaseResourceTypes.SUPPLIER_PAYMENT_RETURN,
      resourceId: id,
      metadata: { reversalEntryId },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return paymentReturnView(await this.read(organizationId, id))
  }

  private async read(organizationId: string, id: string): Promise<PaymentReturnRow> {
    const row = await this.prisma.client.supplierPaymentReturn.findFirst({
      where: { id, organizationId },
      select: PAYMENT_RETURN_SELECT
    })
    if (row === null) throw resourceNotFound('supplier payment return')
    return row
  }

  private alreadyVoided() {
    return resourceConflict('the return was voided already', {
      conflict: PurchaseConflicts.RETURN_ALREADY_VOIDED
    })
  }

  private async recordIn(
    tx: PrismaTransaction,
    organizationId: string,
    paymentId: string,
    body: RecordPaymentReturnBody,
    actor: Actor
  ): Promise<Recorded> {
    const payment = await tx.supplierPayment.findFirst({
      where: { id: paymentId, organizationId },
      select: { id: true, supplierId: true, amountCents: true, paidOn: true }
    })
    if (payment === null) throw resourceNotFound('supplier payment')
    // The supplier is locked until the end, like in a payment and in its voiding: what is left of the payment is read under it
    await lockScope(tx, `${organizationId}:supplier:${payment.supplierId}`)
    // Read again under the lock: a void that committed while this waited is seen here
    const current = await tx.supplierPayment.findFirst({
      where: { id: paymentId, organizationId },
      select: { voidedByEntryId: true }
    })
    if (current === null) throw resourceNotFound('supplier payment')
    if (current.voidedByEntryId !== null) {
      throw resourceConflict('a voided payment has nothing to give back', {
        conflict: PurchaseConflicts.PAYMENT_VOIDED
      })
    }
    const supplier = await tx.supplier.findFirst({
      where: { id: payment.supplierId, organizationId },
      select: { id: true, defaultPayableAccountId: true }
    })
    if (supplier === null) throw resourceNotFound('supplier')

    const into = await tx.ledgerAccount.findFirst({
      where: { id: body.receivedIntoAccountId, organizationId },
      select: { id: true, cashKind: true }
    })
    if (into === null) throw resourceNotFound('ledger account')
    const problems = paymentReturnProblems({
      amountCents: body.amountCents,
      intoIsCash: into.cashKind !== null,
      returnedOn: body.returnedOn,
      paidOn: dateToDay(payment.paidOn),
      today: latestDay()
    })
    if (problems.length > 0) throw invalidPurchase(problems)

    const given = await tx.supplierPaymentReturn.aggregate({
      where: { organizationId, supplierPaymentId: paymentId, voidedByEntryId: null },
      _sum: { amountCents: true }
    })
    const leftCents = payment.amountCents - (given._sum.amountCents ?? 0)
    if (body.amountCents > leftCents) {
      throw resourceConflict('a payment is never given back for more than it was', {
        conflict: PurchaseConflicts.RETURN_EXCEEDS_PAYMENT,
        leftCents
      })
    }
    const payableAccountId =
      supplier.defaultPayableAccountId ??
      (await roleAccount(tx, organizationId, AccountRole.PAYABLE_SUPPLIERS))
    const id = randomUUID()
    const posted = await this.ledger.post(
      {
        organizationId,
        entryDate: body.returnedOn,
        type: JournalEntryType.SUPPLIER_PAYMENT_RETURN,
        sourceType: FinanceSourceType.SUPPLIER_PAYMENT_RETURN,
        sourceId: id,
        sourceDate: body.returnedOn,
        idempotencyKey: PurchaseIdempotencyKey.PAYMENT_RETURN(id),
        memo: body.reference ?? null,
        origin: EntryOrigin.USER,
        createdBy: actor.userId,
        lines: paymentReturnLines({
          payableAccountId,
          receivedIntoAccountId: into.id,
          supplierId: payment.supplierId,
          amountCents: body.amountCents
        })
      },
      tx
    )
    await tx.supplierPaymentReturn.create({
      data: {
        id,
        organizationId,
        supplierId: payment.supplierId,
        supplierPaymentId: paymentId,
        receivedIntoAccountId: into.id,
        amountCents: body.amountCents,
        returnedOn: dayToDate(body.returnedOn),
        reference: body.reference ?? null,
        clientKey: body.idempotencyKey,
        entryId: posted.id,
        createdBy: actor.userId
      }
    })
    return { id, replayed: false, entryNumber: posted.number }
  }

  // The same key with the same content is the same request; with another content it is a mistake of the client, never a second return
  private sameRequest(
    found: PaymentReturnRow,
    paymentId: string,
    body: RecordPaymentReturnBody
  ): boolean {
    return (
      found.supplierPaymentId === paymentId &&
      found.receivedIntoAccountId === body.receivedIntoAccountId &&
      found.amountCents === body.amountCents &&
      dateToDay(found.returnedOn) === body.returnedOn &&
      found.reference === (body.reference ?? null)
    )
  }
}
