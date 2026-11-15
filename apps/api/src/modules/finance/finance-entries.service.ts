import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import {
  EntryOrigin,
  FinanceConflicts,
  FinanceIdempotencyKey,
  FinanceResourceTypes,
  PurchaseConflicts
} from '@platform/core/domain'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'
import { LedgerService } from '@platform/core/finance-ledger'

import { encodeCursor } from '../customers/list-cursor'
import type { Actor } from '../tenancy'

import { FinancePostingQueue } from './finance-posting.queue'
import type {
  BalancesQuery,
  ListEntriesQuery,
  ListPostingsQuery,
  ManualEntryBody,
  ReverseEntryBody
} from './finance.schemas'
import { dayDate } from './finance.support'
import {
  type BalanceView,
  balanceView,
  ENTRY_SELECT,
  type EntryDetailView,
  type EntryPage,
  entryView,
  LINE_SELECT,
  lineView,
  POSTING_SELECT,
  type PostingPage,
  postingView
} from './finance.views'

// The journal, the balances and the postings that wait, of the organization of the request (TDD_18 §2.5, §6.1). Reading is
// free of the ledger's lock; writing goes through LedgerService, the only writer of the journal.
@Injectable()
export class FinanceEntriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly postingQueue: FinancePostingQueue
  ) {}

  async list(organizationId: string, query: ListEntriesQuery): Promise<EntryPage> {
    const rows = await this.prisma.client.journalEntry.findMany({
      where: {
        organizationId,
        ...(query.cursor === undefined ? {} : { number: { lt: BigInt(query.cursor) } }),
        ...(query.periodId === undefined ? {} : { periodId: query.periodId }),
        ...(query.type === undefined ? {} : { type: query.type }),
        ...(query.from === undefined && query.to === undefined
          ? {}
          : {
              entryDate: {
                ...(query.from === undefined ? {} : { gte: dayDate(query.from) }),
                ...(query.to === undefined ? {} : { lte: dayDate(query.to) })
              }
            }),
        ...(query.accountId === undefined
          ? {}
          : { lines: { some: { organizationId, accountId: query.accountId } } })
      },
      select: ENTRY_SELECT,
      take: query.limit + 1,
      // The newest first: the number is gapless and grows with every entry
      orderBy: { number: 'desc' }
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const reversals = await this.reversalsOf(
      organizationId,
      page.map(row => row.id)
    )
    return {
      data: page.map(row => entryView(row, reversals.get(row.id) ?? null)),
      nextCursor: hasMore ? (page.at(-1)?.number.toString() ?? null) : null,
      hasMore
    }
  }

  async get(organizationId: string, entryId: string): Promise<EntryDetailView> {
    const row = await this.prisma.client.journalEntry.findFirst({
      where: { id: entryId, organizationId },
      select: { ...ENTRY_SELECT, lines: { select: LINE_SELECT, orderBy: { lineNo: 'asc' } } }
    })
    if (row === null) throw resourceNotFound('journal entry')
    const reversals = await this.reversalsOf(organizationId, [row.id])
    return { ...entryView(row, reversals.get(row.id) ?? null), lines: row.lines.map(lineView) }
  }

  // An entry written by a person (TDD_18 §4.2, E13). The key is the screen's, so a retry is the same entry.
  async postManual(
    organizationId: string,
    body: ManualEntryBody,
    actor: Actor
  ): Promise<EntryDetailView> {
    const posted = await this.ledger.post({
      organizationId,
      entryDate: body.entryDate,
      type: body.type,
      idempotencyKey: FinanceIdempotencyKey.MANUAL(body.idempotencyKey),
      memo: body.memo,
      origin: EntryOrigin.USER,
      createdBy: actor.userId,
      lines: body.lines.map(line => ({
        accountId: line.accountId,
        debitCents: line.debitCents,
        creditCents: line.creditCents,
        ...(line.storeId === undefined ? {} : { storeId: line.storeId }),
        ...(line.memo === undefined ? {} : { memo: line.memo })
      }))
    })
    // A retry that found its entry wrote nothing, so it leaves no second record of the same act
    if (!posted.replayed) {
      this.audit.log({
        action: AuditAction.FINANCE_ENTRY_POSTED_MANUAL,
        actor: { userId: actor.userId },
        organizationId,
        storeId: actor.storeId,
        resourceType: FinanceResourceTypes.ENTRY,
        resourceId: posted.id,
        metadata: {
          number: posted.number.toString(),
          type: body.type,
          totalCents: posted.totalCents
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return this.get(organizationId, posted.id)
  }

  async reverse(
    organizationId: string,
    entryId: string,
    body: ReverseEntryBody,
    actor: Actor
  ): Promise<EntryDetailView> {
    // The entry of an expense, an income or a transfer is voided through its transaction: that is where the permission of its kind,
    // the pointer that marks it voided and the audit row live, and a reversal made here would leave the transaction looking live
    const owned = await this.prisma.client.financeTransaction.count({
      where: { organizationId, entryId }
    })
    if (owned > 0) {
      throw resourceConflict('the entry belongs to a transaction: void the transaction', {
        conflict: FinanceConflicts.ENTRY_OWNED_BY_TRANSACTION
      })
    }
    // The entry of a purchase receipt or a supplier payment is the same: the receipt moved stock and the payment is voided through its own
    // route (permission, audit row and the pointer that makes the bill owed again), so a reversal made here would leave them out of step
    const [receipts, payments] = await Promise.all([
      this.prisma.client.purchaseReceipt.count({ where: { organizationId, entryId } }),
      this.prisma.client.supplierPayment.count({ where: { organizationId, entryId } })
    ])
    if (receipts + payments > 0) {
      throw resourceConflict('the entry belongs to a purchase: use the purchase', {
        conflict: PurchaseConflicts.ENTRY_OWNED_BY_PURCHASE
      })
    }
    const posted = await this.ledger.reverse({
      organizationId,
      entryId,
      memo: body.memo,
      entryDate: body.entryDate ?? null,
      createdBy: actor.userId
    })
    if (posted.replayed) return this.get(organizationId, posted.id)
    this.audit.log({
      action: AuditAction.FINANCE_ENTRY_REVERSED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.ENTRY,
      resourceId: entryId,
      metadata: { reversalEntryId: posted.id, number: posted.number.toString() },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.get(organizationId, posted.id)
  }

  // What each account has had debited and credited, from the balances the database keeps by period (TDD_18 §2.5): one
  // period, or all of them; for one store (the dimension of the lines), or the whole organization
  async balances(organizationId: string, query: BalancesQuery): Promise<{ data: BalanceView[] }> {
    if (query.periodId !== undefined) {
      const period = await this.prisma.client.fiscalPeriod.count({
        where: { id: query.periodId, organizationId }
      })
      if (period === 0) throw resourceNotFound('fiscal period')
    }
    const sums = await this.prisma.client.accountPeriodBalance.groupBy({
      by: ['accountId'],
      where: {
        organizationId,
        ...(query.periodId === undefined ? {} : { periodId: query.periodId }),
        ...(query.storeId === undefined ? {} : { storeId: query.storeId })
      },
      _sum: { debitCents: true, creditCents: true },
      orderBy: { accountId: 'asc' }
    })
    const accounts = await this.prisma.client.ledgerAccount.findMany({
      where: { organizationId, id: { in: sums.map(sum => sum.accountId) } },
      select: { id: true, normalSide: true, code: true },
      orderBy: { code: 'asc' }
    })
    const bySum = new Map(sums.map(sum => [sum.accountId, sum]))
    return {
      data: accounts.map(account =>
        balanceView({
          accountId: account.id,
          normalSide: account.normalSide,
          debitCents: bySum.get(account.id)?._sum.debitCents ?? 0n,
          creditCents: bySum.get(account.id)?._sum.creditCents ?? 0n
        })
      )
    }
  }

  // "Post again" of a failed source (TDD_18 §6.1): the same job the event queued, so the worker runs the same service on the rows as they
  // are and closes the failure when it posts: a retry can never post what the job would not. It is queued, not run in the request, because
  // the request's transaction cannot be rolled back in part when the ledger refuses.
  async retryPosting(
    organizationId: string,
    failureId: string,
    actor: Actor
  ): Promise<{ data: { queued: true } }> {
    const failure = await this.prisma.client.financePostingFailure.findFirst({
      where: { id: failureId, organizationId, resolvedAt: null },
      select: { sourceType: true, sourceId: true, eventKind: true, createdAt: true }
    })
    if (failure === null) throw resourceNotFound(FinanceResourceTypes.POSTING)
    await this.postingQueue.enqueue({
      organizationId,
      sourceType: failure.sourceType,
      sourceId: failure.sourceId,
      kind: failure.eventKind,
      occurredAt: failure.createdAt.toISOString()
    })
    this.audit.log({
      action: AuditAction.FINANCE_POSTING_RETRIED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.POSTING,
      resourceId: failureId,
      metadata: { sourceType: failure.sourceType, eventKind: failure.eventKind },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return { data: { queued: true } }
  }

  // The sources whose automatic entry failed and wait for a person (TDD_18 §6.1), the oldest trouble last
  async postings(organizationId: string, query: ListPostingsQuery): Promise<PostingPage> {
    const { cursor } = query
    const rows = await this.prisma.client.financePostingFailure.findMany({
      where: {
        organizationId,
        resolvedAt: null,
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: POSTING_SELECT,
      take: query.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(postingView),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }

  // The entry that reverses each one of `ids`, when there is one
  private async reversalsOf(
    organizationId: string,
    ids: readonly string[]
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map()
    const rows = await this.prisma.client.journalEntry.findMany({
      where: { organizationId, reversesEntryId: { in: [...ids] } },
      select: { id: true, reversesEntryId: true }
    })
    return new Map(
      rows.flatMap(row =>
        row.reversesEntryId === null ? [] : [[row.reversesEntryId, row.id] as const]
      )
    )
  }
}
