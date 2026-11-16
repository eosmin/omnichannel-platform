import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import {
  CodStatus,
  FinanceEventKind,
  FinancePostingFailureReason,
  FinancePostingKey,
  FinancePostingOutcome,
  FinanceSourceType,
  FinanceSweepLimits,
  InventoryMovementType,
  OrderStatus,
  RemittanceStatus,
  SaleRecognition,
  ShipmentKind,
  ShipmentStatus
} from '@platform/core/domain'
import { errorName } from '@platform/core/errors'

import { isAdjustmentType } from './auto-entry-rules'
import { FinancePostingService, type PostSourceInput } from './finance-posting.service'
import { dateToDay } from './period-rules'

// How far back the sweep looks for a source whose event was lost, unless the caller names a date (the close of an old period does).
// Older than this and older than the start of the books are left to the accountant (a person pressing "post again" on the failure
// list, or a manual entry): the sweep is for the lost event of last week, not for the history of the business.
export const FINANCE_SWEEP_LOOKBACK_DAYS = 120
const DAY_MS = 86_400_000
// Rows one page of a source table reads, and the rows of all the tables one run reads at most (a run that reaches it says it was
// truncated, and the close is refused: it cannot say the books are complete)
const PAGE_SIZE = 500
const SCAN_MAX = 20_000

// The reasons of an open failure that pass with time: the sweep looks at them again (a source that waited for another one, an event that
// never reached the queue). Every other reason (a mapping, an account, a period) waits for a person, who fixes it and presses "post
// again": the sweep does not spend its budget on them or queue them over and over.
const RETRIED_REASONS: ReadonlySet<string> = new Set([
  FinancePostingFailureReason.SOURCE_NOT_READY,
  FinancePostingFailureReason.NOT_QUEUED
])

export interface SweepOptions {
  // Sources one run previews at most (a test lowers it)
  maxCandidates?: number
  // The earliest date to look at: never before the start of the books
  since?: Date
}

export interface SweepResult {
  // Sources previewed
  examined: number
  // What a job must post or record now: the entry would be written, or the books cannot post it and no person has been told yet
  toQueue: PostSourceInput[]
  // Open failures of the organization (what a person has to fix, plus what waits)
  openFailures: number
  // Sources with no entry that need attention: the queued ones plus the open failures, each counted once
  unposted: number
  // The sweep stopped at a cap (the sources previewed or the rows read): the rest is for the next run, and the books cannot be called
  // complete
  truncated: boolean
}

interface Candidate {
  key: string
  at: Date
  input: PostSourceInput
}

// The sweep of the books (TDD_18 §6.1): the sources that SHOULD have an entry and have none. It finds them and says what must be
// queued; it posts nothing and never writes outside the idempotency of the posting service (the job it asks for reads the rows and
// posts under the key of its event, so a source found twice is one entry). A candidate is classified by `preview`, the same decision
// the job takes with nothing written, so what it counts is what a job would post or fail on.
@Injectable()
export class FinanceSweepService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: FinancePostingService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FinanceSweepService.name)
  }

  async sweep(
    organizationId: string,
    now: Date = new Date(),
    options: SweepOptions = {}
  ): Promise<SweepResult> {
    const cap = options.maxCandidates ?? FinanceSweepLimits.MAX_CANDIDATES_PER_RUN
    const settings = await this.prisma.client.financeSettings.findUnique({
      where: { organizationId },
      select: { accountingStartDate: true, recognizeSaleOn: true }
    })
    // An organization that has not set up its books has nothing to post to and nothing unposted
    if (settings === null) {
      return { examined: 0, toQueue: [], openFailures: 0, unposted: 0, truncated: false }
    }
    const lookback = options.since ?? new Date(now.getTime() - FINANCE_SWEEP_LOOKBACK_DAYS * DAY_MS)
    const start = new Date(`${dateToDay(settings.accountingStartDate)}T00:00:00Z`)
    const since = start.getTime() > lookback.getTime() ? start : lookback

    const open = await this.prisma.client.financePostingFailure.findMany({
      where: { organizationId, resolvedAt: null },
      select: { sourceType: true, sourceId: true, eventKind: true, reason: true }
    })
    const openReason = new Map(
      open.map(row => [`${row.sourceType}:${row.sourceId}:${row.eventKind}`, row.reason])
    )
    const scan = { rows: 0, truncated: false }
    const candidates = await this.candidates(
      organizationId,
      since,
      settings.recognizeSaleOn,
      openReason,
      scan,
      cap
    )

    const toQueue: PostSourceInput[] = []
    let examined = 0
    let truncated = scan.truncated
    for (const candidate of candidates) {
      if (examined >= cap) {
        truncated = true
        break
      }
      examined += 1
      try {
        const preview = await this.posting.preview(candidate.input)
        const listed = openReason.has(
          `${candidate.input.sourceType}:${candidate.input.sourceId}:${candidate.input.kind}`
        )
        if (preview.outcome === FinancePostingOutcome.PENDING) {
          toQueue.push(candidate.input)
        } else if (preview.outcome === FinancePostingOutcome.FAILED && !listed) {
          // The books cannot post it and nobody has been told: the job records the failure, which is what a person reads
          toQueue.push(candidate.input)
        }
      } catch (error) {
        // One source that cannot be previewed (a lock timeout) is logged and the rest goes on: tomorrow looks at it again
        this.logger.warn(
          { organizationId, sourceType: candidate.input.sourceType, errorName: errorName(error) },
          'a source could not be checked by the sweep'
        )
      }
    }
    // A source that is queued and listed (it waited and now would post) is one source
    const queuedKeys = new Set(toQueue.map(job => `${job.sourceType}:${job.sourceId}:${job.kind}`))
    const stillOpen = open.filter(
      row => !queuedKeys.has(`${row.sourceType}:${row.sourceId}:${row.eventKind}`)
    ).length
    return {
      examined,
      toQueue,
      openFailures: open.length,
      unposted: stillOpen + toQueue.length,
      truncated
    }
  }

  // The balances of the organization against its own lines (TDD_18 §11): for every account, store dimension and period, the sum of the
  // lines must equal what `account_period_balances` holds. Read only; a difference is the caller's metric and alert, and nothing here
  // (or anywhere) corrects it: the journal is the truth and a correction is a person's decision.
  async balanceMismatches(organizationId: string): Promise<number> {
    const rows = await this.prisma.client.$queryRaw<{ mismatches: bigint }[]>`
      SELECT COUNT(*)::bigint AS mismatches FROM (
        SELECT COALESCE(l.account_id, b.account_id) AS account_id
        FROM (
          SELECT ln.account_id, ln.store_id, e.period_id,
                 SUM(ln.debit_cents)::bigint AS debit_cents, SUM(ln.credit_cents)::bigint AS credit_cents
          FROM journal_lines ln
          JOIN journal_entries e ON e.id = ln.entry_id AND e.organization_id = ln.organization_id
          WHERE ln.organization_id = ${organizationId}
          GROUP BY ln.account_id, ln.store_id, e.period_id
        ) l
        FULL OUTER JOIN (
          SELECT account_id, store_id, period_id, debit_cents, credit_cents
          FROM account_period_balances WHERE organization_id = ${organizationId}
        ) b
          ON b.account_id = l.account_id AND b.period_id = l.period_id
         AND b.store_id IS NOT DISTINCT FROM l.store_id
        WHERE COALESCE(l.debit_cents, 0) <> COALESCE(b.debit_cents, 0)
           OR COALESCE(l.credit_cents, 0) <> COALESCE(b.credit_cents, 0)
      ) differing`
    return Number(rows[0]?.mismatches ?? 0)
  }

  private async existingKeys(
    organizationId: string,
    keys: readonly string[]
  ): Promise<Set<string>> {
    const found = new Set<string>()
    for (let from = 0; from < keys.length; from += PAGE_SIZE) {
      const page = keys.slice(from, from + PAGE_SIZE)
      const rows = await this.prisma.client.journalEntry.findMany({
        where: { organizationId, idempotencyKey: { in: page } },
        select: { idempotencyKey: true }
      })
      for (const row of rows) found.add(row.idempotencyKey)
    }
    return found
  }

  // Pages through one table of sources and keeps the candidates that have no entry yet and no failure a person must fix first. It
  // stops at `cap` candidates (the rest is for the next run) and at the rows of the run (`SCAN_MAX`), and says it did.
  private async collect<T extends { id: string }>(
    input: {
      organizationId: string
      openReason: ReadonlyMap<string, string>
      scan: { rows: number; truncated: boolean }
      cap: number
      page: (after: string | undefined, take: number) => Promise<T[]>
      // The candidates of one row (a row can be the source of several events)
      of: (row: T) => Candidate[]
      // How the page's candidates are held back; by default, those whose own key already holds an entry
      keep?: (candidates: Candidate[]) => Promise<Candidate[]>
    },
    out: Candidate[]
  ): Promise<void> {
    let after: string | undefined
    let collected = 0
    for (;;) {
      if (input.scan.rows >= SCAN_MAX || collected >= input.cap) {
        input.scan.truncated = true
        return
      }
      const rows = await input.page(after, PAGE_SIZE)
      if (rows.length === 0) return
      input.scan.rows += rows.length
      const mine = rows
        .flatMap(row => input.of(row))
        .filter(candidate => {
          const reason = input.openReason.get(
            `${candidate.input.sourceType}:${candidate.input.sourceId}:${candidate.input.kind}`
          )
          // A failure that waits for a person is theirs; one that passes with time is looked at again
          return reason === undefined || RETRIED_REASONS.has(reason)
        })
      const keep =
        input.keep ??
        (async (candidates: Candidate[]): Promise<Candidate[]> => {
          const done = await this.existingKeys(
            input.organizationId,
            candidates.map(candidate => candidate.key)
          )
          return candidates.filter(candidate => !done.has(candidate.key))
        })
      const missing = await keep(mine)
      out.push(...missing)
      collected += missing.length
      if (rows.length < PAGE_SIZE) return
      after = rows.at(-1)?.id
    }
  }

  // The sources that SHOULD have an entry (a necessary condition each, the preview decides the rest). The dates are the ones the
  // loaders read, so a source the loader would date before the start of the books is not a candidate.
  private async candidates(
    organizationId: string,
    since: Date,
    recognizeSaleOn: string,
    openReason: ReadonlyMap<string, string>,
    scan: { rows: number; truncated: boolean },
    cap: number
  ): Promise<Candidate[]> {
    const db = this.prisma.client
    const out: Candidate[] = []
    const make = (
      sourceType: FinanceSourceType,
      sourceId: string,
      kind: FinanceEventKind,
      key: string,
      at: Date,
      occurredAt?: Date
    ): Candidate => ({
      key,
      at,
      input: {
        organizationId,
        sourceType,
        sourceId,
        kind,
        ...(occurredAt === undefined ? {} : { occurredAt: occurredAt.toISOString() })
      }
    })
    const common = { organizationId, openReason, scan, cap }
    const cursor = (after: string | undefined): { cursor?: { id: string }; skip?: number } =>
      after === undefined ? {} : { cursor: { id: after }, skip: 1 }
    const onShipped = recognizeSaleOn === (SaleRecognition.SHIPPED as string)
    const live = { notIn: [OrderStatus.CANCELLED as string] }
    const storeOf = { store: { organizationId } }

    // E3: the order was delivered (or shipped, by the setting)
    await this.collect(
      {
        ...common,
        page: (after, take) =>
          db.order.findMany({
            where: {
              ...storeOf,
              status: live,
              ...(onShipped ? { shippedAt: { gte: since } } : { deliveredAt: { gte: since } })
            },
            select: { id: true, shippedAt: true, deliveredAt: true },
            orderBy: { id: 'asc' },
            take,
            ...cursor(after)
          }),
        of: order => [
          make(
            FinanceSourceType.ORDER,
            order.id,
            FinanceEventKind.SALE,
            FinancePostingKey.ORDER_SALE(order.id),
            (onShipped ? order.shippedAt : order.deliveredAt) ?? since
          )
        ]
      },
      out
    )
    // E2: the goods left, whether or not the order was delivered since: an order in transit with a lost event is the one the
    // inventory in transit misses. Not when the sale is recognized at shipping (the sale entry takes the cost itself).
    if (!onShipped) {
      await this.collect(
        {
          ...common,
          page: (after, take) =>
            db.order.findMany({
              where: { ...storeOf, status: live, shippedAt: { gte: since } },
              select: { id: true, shippedAt: true },
              orderBy: { id: 'asc' },
              take,
              ...cursor(after)
            }),
          of: order => [
            make(
              FinanceSourceType.ORDER,
              order.id,
              FinanceEventKind.SENT,
              FinancePostingKey.ORDER_SENT(order.id),
              order.shippedAt ?? since
            )
          ]
        },
        out
      )
    }
    // E1 (an order paid before delivery) is NOT swept: an order has no date of its payment, and dating a late E1 by the last change of
    // the order would post an advance that the opening balance may already hold (a prepaid order from before the books, updated
    // since). A payment event that never reached the queue is listed as a failure by the listener and a person presses "post again"
    // (debt of the plan: a payment date on the order, then the sweep heals E1 too).

    // E4 and E7: a guide delivered, a guide written off
    await this.collect(
      {
        ...common,
        page: (after, take) =>
          db.shipment.findMany({
            where: {
              ...storeOf,
              kind: ShipmentKind.OUTBOUND,
              OR: [
                { status: ShipmentStatus.DELIVERED, deliveredAt: { gte: since } },
                { codStatus: CodStatus.WRITTEN_OFF, updatedAt: { gte: since } }
              ]
            },
            select: { id: true, status: true, codStatus: true, deliveredAt: true, updatedAt: true },
            orderBy: { id: 'asc' },
            take,
            ...cursor(after)
          }),
        of: shipment => {
          const list: Candidate[] = []
          if (shipment.status === (ShipmentStatus.DELIVERED as string)) {
            list.push(
              make(
                FinanceSourceType.SHIPMENT,
                shipment.id,
                FinanceEventKind.CHARGES,
                FinancePostingKey.SHIPMENT_CHARGES(shipment.id),
                shipment.deliveredAt ?? shipment.updatedAt
              )
            )
          }
          if (shipment.codStatus === (CodStatus.WRITTEN_OFF as string)) {
            // The action leaves no date of its own: the last change of the guide stands for it (debt of the plan)
            list.push(
              make(
                FinanceSourceType.SHIPMENT,
                shipment.id,
                FinanceEventKind.COD_WRITE_OFF,
                FinancePostingKey.SHIPMENT_WRITE_OFF(shipment.id),
                shipment.updatedAt,
                shipment.updatedAt
              )
            )
          }
          return list
        }
      },
      out
    )
    // E5: a remittance confirmed
    await this.collect(
      {
        ...common,
        page: (after, take) =>
          db.codRemittance.findMany({
            where: {
              ...storeOf,
              status: RemittanceStatus.CONFIRMED,
              confirmedAt: { gte: since }
            },
            select: { id: true, confirmedAt: true },
            orderBy: { id: 'asc' },
            take,
            ...cursor(after)
          }),
        of: remittance => [
          make(
            FinanceSourceType.REMITTANCE,
            remittance.id,
            FinanceEventKind.REMITTANCE_CONFIRM,
            FinancePostingKey.REMITTANCE_CONFIRM(remittance.id),
            remittance.confirmedAt ?? since
          )
        ]
      },
      out
    )
    // E6: a confirmed remittance voided. Only when its confirmation was posted and nothing reversed it yet: a voiding of a remittance
    // whose confirmation never posted has nothing to undo, and the ones already reversed are done.
    await this.collect(
      {
        ...common,
        page: (after, take) =>
          db.codRemittance.findMany({
            where: { ...storeOf, status: RemittanceStatus.VOIDED, voidedAt: { gte: since } },
            select: { id: true, voidedAt: true },
            orderBy: { id: 'asc' },
            take,
            ...cursor(after)
          }),
        of: remittance => [
          make(
            FinanceSourceType.REMITTANCE,
            remittance.id,
            FinanceEventKind.REMITTANCE_VOID,
            FinancePostingKey.REMITTANCE_CONFIRM(remittance.id),
            remittance.voidedAt ?? since
          )
        ],
        keep: async candidates => {
          const confirmed = await db.journalEntry.findMany({
            where: {
              organizationId,
              idempotencyKey: { in: candidates.map(candidate => candidate.key) }
            },
            select: { id: true, idempotencyKey: true }
          })
          const reversed = new Set(
            (
              await db.journalEntry.findMany({
                where: {
                  organizationId,
                  reversesEntryId: { in: confirmed.map(entry => entry.id) }
                },
                select: { reversesEntryId: true }
              })
            ).map(entry => entry.reversesEntryId)
          )
          const undone = new Set(
            confirmed.filter(entry => !reversed.has(entry.id)).map(entry => entry.idempotencyKey)
          )
          return candidates.filter(candidate => undone.has(candidate.key))
        }
      },
      out
    )
    // E8: a return received
    await this.collect(
      {
        ...common,
        page: (after, take) =>
          db.orderReturn.findMany({
            where: { ...storeOf, receivedAt: { gte: since } },
            select: { id: true, receivedAt: true },
            orderBy: { id: 'asc' },
            take,
            ...cursor(after)
          }),
        of: row => [
          make(
            FinanceSourceType.RETURN,
            row.id,
            FinanceEventKind.RETURN_RESTOCK,
            FinancePostingKey.RETURN_RESTOCK(row.id),
            row.receivedAt ?? since
          )
        ]
      },
      out
    )
    // E8: an order that came back as a whole with no return row
    await this.collect(
      {
        ...common,
        page: (after, take) =>
          db.order.findMany({
            where: { ...storeOf, status: OrderStatus.RETURNED, updatedAt: { gte: since } },
            select: { id: true, updatedAt: true },
            orderBy: { id: 'asc' },
            take,
            ...cursor(after)
          }),
        of: order => [
          make(
            FinanceSourceType.ORDER,
            order.id,
            FinanceEventKind.ORDER_RETURN,
            FinancePostingKey.ORDER_RETURN(order.id),
            order.updatedAt
          )
        ]
      },
      out
    )
    // E9: an adjustment or a count variance
    await this.collect(
      {
        ...common,
        page: (after, take) =>
          db.inventoryMovement.findMany({
            where: {
              ...storeOf,
              type: {
                in: Object.values(InventoryMovementType).filter(type => isAdjustmentType(type))
              },
              createdAt: { gte: since }
            },
            select: { id: true, createdAt: true },
            orderBy: { id: 'asc' },
            take,
            ...cursor(after)
          }),
        of: movement => [
          make(
            FinanceSourceType.INVENTORY_MOVEMENT,
            movement.id,
            FinanceEventKind.ADJUST,
            FinancePostingKey.MOVEMENT_ADJUST(movement.id),
            movement.createdAt
          )
        ]
      },
      out
    )
    // Oldest first across every kind, so a backlog drains in the order it happened
    return out.sort((a, b) => a.at.getTime() - b.at.getTime())
  }
}
