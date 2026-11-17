import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { type PrismaTransaction, PrismaService } from '@platform/core/database'
import { EntryOrigin, FinanceResourceTypes, PeriodStatus } from '@platform/core/domain'
import { ErrorCodes, resourceNotFound } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import {
  isLatestClosed,
  lockedThroughAfterReopen,
  periodEnded,
  trialBalanceTotals
} from '@platform/core/finance'
import { FinanceCloseGuard, financeRefusal } from '@platform/core/finance-ledger'

import type { Actor } from '../tenancy'

import type { ReopenPeriodBody } from './finance-reports.schemas'
import { dayDate, organizationDay } from './finance.support'
import { isoDay, PERIOD_SELECT, type PeriodView, periodView } from './finance.views'

const isClosed = (status: string): boolean => status === String(PeriodStatus.CLOSED)

// Closing and reopening a month (TDD_18 §5). The settings row is locked FOR UPDATE for the whole of it: the entry triggers take it
// FOR SHARE, so a posting in flight is waited for and a new one waits for the commit, and the head of the chain read here is the head
// the close freezes. The period changes first and the lock of the books after it, as the trigger of the settings requires.
@Injectable()
export class FinanceCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly guard: FinanceCloseGuard
  ) {}

  async close(
    organizationId: string,
    periodId: string,
    actor: Actor,
    now: Date = new Date()
  ): Promise<PeriodView> {
    await this.requireNothingPending(organizationId, periodId)
    const result = await this.prisma.transaction(async tx => {
      const head = await this.lockSettings(tx, organizationId)
      // The incident is read again under the lock: one that opened after the check above (the weekly job does not take this lock) still stops
      // the close, so a month is never frozen over a chain found altered a moment before
      const incident = await tx.financeChainIncident.count({
        where: { organizationId, resolvedAt: null }
      })
      if (incident > 0) throw financeRefusal(ErrorCodes.FINANCE_CLOSE_CHAIN_BROKEN)
      const period = await tx.fiscalPeriod.findFirst({
        where: { id: periodId, organizationId },
        select: { id: true, year: true, month: true, endsOn: true, status: true }
      })
      if (period === null) throw resourceNotFound('fiscal period')
      if (isClosed(period.status)) {
        throw financeRefusal(ErrorCodes.FINANCE_PERIOD_ALREADY_CLOSED)
      }
      // 4. A month is not closed before its last day is over
      // The month has ended where the books are kept: the organization has no zone of its own, so the day is the one of the store that is
      // furthest behind (a month is not closed while any store of the organization still has its last day)
      if (!periodEnded(isoDay(period.endsOn), await organizationDay(tx, organizationId, now))) {
        throw financeRefusal(ErrorCodes.FINANCE_CLOSE_NOT_ENDED)
      }
      // 1. Closes are in order and with no month left out: every month from the one the books start in up to the one before this is a
      // closed period (a month with no row would leave a hole that the lock of the books would then make impossible to post into)
      const settings = await tx.financeSettings.findUniqueOrThrow({
        where: { organizationId },
        select: { accountingStartDate: true }
      })
      const start = isoDay(settings.accountingStartDate)
      const expectedClosed =
        period.year * 12 +
        period.month -
        (Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)))
      const earlierClosed = await tx.fiscalPeriod.count({
        where: {
          organizationId,
          status: PeriodStatus.CLOSED,
          OR: [{ year: { lt: period.year } }, { year: period.year, month: { lt: period.month } }]
        }
      })
      if (earlierClosed < expectedClosed) {
        throw financeRefusal(ErrorCodes.FINANCE_CLOSE_PREVIOUS_OPEN)
      }
      // 2. No posting is waiting for a person. The guard of 4B.6b-3 already ran before the lock (it sweeps for sources with no entry,
      // and its preview transactions must not wait on the lock held here); this count under the lock is the one a failure recorded in
      // between cannot slip past. A failure holds no source date, so every unresolved one of the organization blocks the close.
      const failed = await tx.financePostingFailure.count({
        where: { organizationId, resolvedAt: null }
      })
      if (failed > 0) throw financeRefusal(ErrorCodes.FINANCE_CLOSE_PENDING_POSTINGS)
      // 3. The period balances: from the lines themselves (never from a table a trigger keeps, which is what the check is for) and the
      // balances the database keeps must say the same
      await this.requireBalanced(tx, organizationId, period.id)

      const closed = await tx.fiscalPeriod.updateMany({
        where: { id: period.id, organizationId, status: PeriodStatus.OPEN },
        data: {
          status: PeriodStatus.CLOSED,
          closedAt: now,
          closedBy: actor.userId,
          closingHash: head.hash
        }
      })
      if (closed.count !== 1) throw financeRefusal(ErrorCodes.FINANCE_PERIOD_ALREADY_CLOSED)
      await tx.financeSettings.update({
        where: { organizationId },
        data: { lockedThrough: period.endsOn }
      })
      this.events.publish(tx, Events.FINANCE_PERIOD_CLOSED, {
        organizationId,
        periodId: period.id,
        year: period.year,
        month: period.month,
        actor: { type: EntryOrigin.USER, id: actor.userId }
      })
      return { id: period.id, year: period.year, month: period.month, hash: head.hash }
    })
    this.audit.log({
      action: AuditAction.FINANCE_PERIOD_CLOSED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.PERIOD,
      resourceId: result.id,
      metadata: { year: result.year, month: result.month, closingHash: result.hash },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.get(organizationId, result.id)
  }

  // Only the latest closed period, with the reason typed (TDD_18 §5.3): who, when and why are the row's, kept after the next close
  async reopen(
    organizationId: string,
    periodId: string,
    body: ReopenPeriodBody,
    actor: Actor,
    now: Date = new Date()
  ): Promise<PeriodView> {
    const result = await this.prisma.transaction(async tx => {
      await this.lockSettings(tx, organizationId)
      const periods = await tx.fiscalPeriod.findMany({
        where: { organizationId },
        select: { id: true, year: true, month: true, endsOn: true, status: true }
      })
      const target = periods.find(period => period.id === periodId)
      if (target === undefined) throw resourceNotFound('fiscal period')
      if (!isClosed(target.status)) {
        throw financeRefusal(ErrorCodes.FINANCE_PERIOD_NOT_CLOSED)
      }
      const rows = periods.map(period => ({
        id: period.id,
        year: period.year,
        month: period.month,
        closed: isClosed(period.status),
        endsOn: isoDay(period.endsOn)
      }))
      if (!isLatestClosed(rows, periodId)) {
        throw financeRefusal(ErrorCodes.FINANCE_REOPEN_NOT_LATEST)
      }
      const reopened = await tx.fiscalPeriod.updateMany({
        where: { id: periodId, organizationId, status: PeriodStatus.CLOSED },
        data: {
          status: PeriodStatus.OPEN,
          reopenedAt: now,
          reopenedBy: actor.userId,
          reopenReason: body.reason
        }
      })
      if (reopened.count !== 1) throw financeRefusal(ErrorCodes.FINANCE_PERIOD_NOT_CLOSED)
      const lock = lockedThroughAfterReopen(rows, periodId)
      await tx.financeSettings.update({
        where: { organizationId },
        data: { lockedThrough: lock === null ? null : dayDate(lock) }
      })
      this.events.publish(tx, Events.FINANCE_PERIOD_REOPENED, {
        organizationId,
        periodId,
        year: target.year,
        month: target.month,
        actor: { type: EntryOrigin.USER, id: actor.userId }
      })
      return { year: target.year, month: target.month }
    })
    this.audit.log({
      action: AuditAction.FINANCE_PERIOD_REOPENED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.PERIOD,
      resourceId: periodId,
      metadata: { year: result.year, month: result.month, reason: body.reason },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.get(organizationId, periodId)
  }

  private async get(organizationId: string, periodId: string): Promise<PeriodView> {
    const row = await this.prisma.client.fiscalPeriod.findFirst({
      where: { id: periodId, organizationId },
      select: PERIOD_SELECT
    })
    if (row === null) throw resourceNotFound('fiscal period')
    return periodView(row, await organizationDay(this.prisma.client, organizationId, new Date()))
  }

  // Sources that should have an entry and have none, or whose entry failed (TDD_18 §5.1). Outside the transaction on purpose: the sweep
  // runs preview transactions that take the settings row FOR SHARE and would wait for the lock the close holds. A period that does not
  // exist is left to the transaction, which answers 404.
  private async requireNothingPending(organizationId: string, periodId: string): Promise<void> {
    const period = await this.prisma.client.fiscalPeriod.findFirst({
      where: { id: periodId, organizationId },
      select: { startsOn: true }
    })
    if (period === null) return
    const blockers = await this.guard.check(organizationId, { since: period.startsOn })
    // An altered chain is its own refusal: it is not fixed by posting again, a person must find out why (TDD_18 §11)
    if (blockers.chainBroken) throw financeRefusal(ErrorCodes.FINANCE_CLOSE_CHAIN_BROKEN)
    if (blockers.blocked) throw financeRefusal(ErrorCodes.FINANCE_CLOSE_PENDING_POSTINGS)
  }

  private async lockSettings(
    tx: PrismaTransaction,
    organizationId: string
  ): Promise<{ hash: string | null }> {
    const [row] = await tx.$queryRaw<{ hash: string | null }[]>`
      SELECT last_entry_hash AS hash FROM finance_settings WHERE organization_id = ${organizationId} FOR UPDATE`
    if (row === undefined) throw financeRefusal(ErrorCodes.FINANCE_SETUP_REQUIRED)
    return { hash: row.hash }
  }

  private async requireBalanced(
    tx: PrismaTransaction,
    organizationId: string,
    periodId: string
  ): Promise<void> {
    const [lines] = await tx.$queryRaw<{ debit: bigint; credit: bigint }[]>`
      SELECT COALESCE(SUM(l.debit_cents), 0)::bigint AS debit, COALESCE(SUM(l.credit_cents), 0)::bigint AS credit
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
      WHERE e.organization_id = ${organizationId} AND e.period_id = ${periodId}`
    const kept = await tx.accountPeriodBalance.aggregate({
      where: { organizationId, periodId },
      _sum: { debitCents: true, creditCents: true }
    })
    const totals = trialBalanceTotals([
      { debitCents: lines?.debit ?? 0n, creditCents: lines?.credit ?? 0n }
    ])
    const keptDebit = kept._sum.debitCents ?? 0n
    const keptCredit = kept._sum.creditCents ?? 0n
    if (!totals.balanced || keptDebit !== totals.debitCents || keptCredit !== totals.creditCents) {
      throw financeRefusal(ErrorCodes.FINANCE_BALANCE_MISMATCHES, { periodId })
    }
  }
}
