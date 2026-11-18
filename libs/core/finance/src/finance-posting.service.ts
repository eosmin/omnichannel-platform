import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  AccountRole,
  CodStatus,
  EntryOrigin,
  FinanceAutoMemo,
  FinanceEventKind,
  FinanceEventSource,
  FinanceLockScopes,
  FinancePostingFailureReason,
  FinancePostingKey,
  FinancePostingOutcome,
  FinanceSourceType,
  hasReceivedUnits,
  InventoryMovementType,
  InventoryReferenceType,
  JournalEntryType,
  OrderReturnStatus,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  RemittanceDestinationProblem,
  remittanceDestinationProblem,
  ReturnCostAgainst,
  ReturnSettlementKind,
  RemittanceStatus,
  SaleRecognition,
  SettlingOutcomes,
  ShipmentInactiveStatuses,
  ShipmentKind,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'
import { errorName, PlatformException } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import {
  adjustmentLines,
  type AutoEntry,
  issueCost,
  orderPaymentLines,
  type RoleAccounts,
  saleAmounts,
  saleLines,
  sentLines
} from './auto-entry-rules'
import {
  chargeAmounts,
  chargeLines,
  remittanceLines,
  type RemittanceLineSettlement,
  replaySettlements,
  settleRemittanceLine
} from './carrier-entry-rules'
import type { DraftLine } from './entry-rules'
import { LedgerService } from './ledger.service'
import { automaticEntryDate, dateToDay } from './period-rules'
import {
  lineBases,
  openReceivableCents,
  restockCost,
  returnLines,
  type ReturnReversal,
  type ReturnSettlement,
  reversalOf,
  type SettledLine,
  writeOffLines
} from './return-entry-rules'

export interface PostSourceInput {
  organizationId: string
  sourceType: FinanceSourceType
  sourceId: string
  kind: FinanceEventKind
  // When the event happened (ISO instant) when the source row does not say (a payment has no date of its own); a retry reads it
  // from the failure it is resolving
  occurredAt?: string
}

export interface PostSourceResult {
  outcome: FinancePostingOutcome
  entryId: string | null
  reason: FinancePostingFailureReason | null
}

// What the loader of an event answers: the entry it wants, or why not. `sourceDay` is the day the event happened, in the zone of the store.
type Candidate =
  | {
      kind: 'entry'
      sourceDay: string
      type: JournalEntryType
      sourceType: FinanceSourceType
      key: string
      memo: string
      result: AutoEntry
    }
  | { kind: 'nothing' }
  | { kind: 'failed'; reason: FinancePostingFailureReason }

// What the posting reads of the settings of the books
type PostingSettings = { accountingStartDate: Date; recognizeSaleOn: string }

const NOTHING: Candidate = { kind: 'nothing' }
const failed = (reason: FinancePostingFailureReason): Candidate => ({ kind: 'failed', reason })

// The key of the entry an event posts (the same the loaders use)
const keyOf = (input: PostSourceInput): string => {
  switch (input.kind) {
    case FinanceEventKind.PAYMENT:
      return FinancePostingKey.ORDER_PAYMENT(input.sourceId)
    case FinanceEventKind.SENT:
      return FinancePostingKey.ORDER_SENT(input.sourceId)
    case FinanceEventKind.SALE:
      return FinancePostingKey.ORDER_SALE(input.sourceId)
    case FinanceEventKind.CHARGES:
      return FinancePostingKey.SHIPMENT_CHARGES(input.sourceId)
    case FinanceEventKind.REMITTANCE_CONFIRM:
      return FinancePostingKey.REMITTANCE_CONFIRM(input.sourceId)
    case FinanceEventKind.REMITTANCE_VOID:
      return FinancePostingKey.REMITTANCE_VOID(input.sourceId)
    case FinanceEventKind.COD_WRITE_OFF:
      return FinancePostingKey.SHIPMENT_WRITE_OFF(input.sourceId)
    case FinanceEventKind.RETURN_RESTOCK:
      return FinancePostingKey.RETURN_RESTOCK(input.sourceId)
    case FinanceEventKind.ORDER_RETURN:
      return FinancePostingKey.ORDER_RETURN(input.sourceId)
    case FinanceEventKind.ADJUST:
      return FinancePostingKey.MOVEMENT_ADJUST(input.sourceId)
  }
}

const POST_TRANSACTION = { maxWait: 10_000, timeout: 30_000 }

// The day an instant falls on in a time zone, 'YYYY-MM-DD'
export function dayInZone(instant: Date, timeZone: string): string {
  const format = (zone: string): string =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(instant)
  try {
    return format(timeZone)
  } catch {
    // A store with a zone the runtime does not know must not stop its books: the day is the UTC one, which is never off by more than
    // the offset of the zone, and the entry is still the one the key says
    return format('UTC')
  }
}

// Posts the automatic entry of ONE event of ONE source (TDD_18 §4.2, §6.1): loads the CURRENT rows, builds the entry with the pure
// rules, and writes it through the ledger under its key. Safe to run twice and to run late: the key says it was already done, and a
// source that cannot be posted leaves a `FinancePostingFailure` for a person to fix, never a silent gap. It never touches the
// operation of the business: it only reads the source.
@Injectable()
export class FinancePostingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FinancePostingService.name)
  }

  async post(input: PostSourceInput): Promise<PostSourceResult> {
    let result: PostSourceResult
    try {
      result = await this.prisma.transaction(async tx => {
        await this.lockSource(tx, input)
        // Read under the lock: a close or a change of `recognizeSaleOn` that happened while this job waited is the one decided on
        const settings = await tx.financeSettings.findUnique({
          where: { organizationId: input.organizationId },
          select: { accountingStartDate: true, lockedThrough: true, recognizeSaleOn: true }
        })
        // An organization that has not set the books up has nothing to post to
        if (settings === null) return this.done(FinancePostingOutcome.NOTHING_TO_POST)
        const outcome = await this.decide(tx, input, settings)
        // The failure row moves in the same transaction and under the same lock as the entry: a stale answer of a slower job can
        // neither reopen what another one just posted nor close what it did not
        await this.settle(tx, input, outcome)
        return outcome
      }, POST_TRANSACTION)
    } catch (error) {
      // The ledger's own refusal (a period closed a moment ago, a dimension that is gone) is a failure a person sees; anything else
      // is the job's to retry (the database was down), so it travels up
      if (error instanceof PlatformException) {
        this.logger.warn({ code: error.code, ...input }, 'the ledger refused an automatic entry')
        result = {
          outcome: FinancePostingOutcome.FAILED,
          entryId: null,
          reason: FinancePostingFailureReason.LEDGER_REFUSED
        }
      } else {
        throw error
      }
    }

    // The ledger refused and the transaction rolled back with its lock: the failure is recorded in a transaction of its own, unless
    // another job posted the entry while this one was out of the lock (a period reopened and a retry that got through)
    if (result.reason === FinancePostingFailureReason.LEDGER_REFUSED) {
      const refused = result
      result = await this.prisma.transaction(async tx => {
        await this.lockSource(tx, input)
        const existsId = await this.entryUnderKey(tx, input)
        const settled =
          existsId === null ? refused : this.done(FinancePostingOutcome.REPLAYED, existsId)
        await this.settle(tx, input, settled)
        return settled
      }, POST_TRANSACTION)
    }
    // E1 is what a prepaid sale waits for: once the advance is there the sale is posted now, not left until someone asks (it posts
    // nothing when the order is not delivered yet)
    if (
      input.kind === FinanceEventKind.PAYMENT &&
      result.outcome === FinancePostingOutcome.POSTED
    ) {
      try {
        await this.post({ ...input, kind: FinanceEventKind.SALE })
      } catch (error) {
        // E1 is committed and must stay the answer of this job: the sale has its own job and its own failure row
        this.logger.warn(
          { ...input, errorName: errorName(error) },
          'the sale that waited for a payment could not be posted'
        )
      }
    }
    // E4 is what a remittance of the guide waits for (its payable is the estimate the remittance settles): once it is posted, the
    // remittances that settled the guide and could not post are asked again
    // (also when the entry was already there: a job that died after the commit and before this re-ask is retried and must still do it)
    // E3 is the other thing it waits for (the receivable the cash clears): the same re-ask when the sale is posted
    if (
      (input.kind === FinanceEventKind.CHARGES || input.kind === FinanceEventKind.SALE) &&
      (result.outcome === FinancePostingOutcome.POSTED ||
        result.outcome === FinancePostingOutcome.REPLAYED)
    ) {
      await this.repostRemittancesOf(input)
    }
    return result
  }

  // What an event WOULD do now, with nothing written: PENDING when its entry would be posted (it has none yet), FAILED with its reason when
  // the books cannot post it, and the same answers as `post` for the rest (replayed, nothing to post, before the start). The sweep asks
  // this before it queues a source, so that what it counts as unposted is exactly what a job would post or fail on. It takes no lock and
  // records nothing: it never touches a failure row either.
  async preview(input: PostSourceInput): Promise<PostSourceResult> {
    return this.prisma.transaction(async tx => {
      const settings = await tx.financeSettings.findUnique({
        where: { organizationId: input.organizationId },
        select: { accountingStartDate: true, lockedThrough: true, recognizeSaleOn: true }
      })
      if (settings === null) return this.done(FinancePostingOutcome.NOTHING_TO_POST)
      return this.decide(tx, input, settings, true)
    }, POST_TRANSACTION)
  }

  // For a job that ran out of attempts on an error of the infrastructure: the source is put on the list of failures, so that it is not
  // lost in the dead-letter queue where no person looks
  async markUnposted(input: PostSourceInput): Promise<void> {
    await this.prisma.transaction(async tx => {
      await this.lockSource(tx, input)
      // A failure that is open says more than this does (its reason, its date), and a source that was posted meanwhile is not a failure
      const open = await tx.financePostingFailure.findFirst({
        where: {
          organizationId: input.organizationId,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          eventKind: input.kind,
          resolvedAt: null
        },
        select: { id: true }
      })
      const posted = await this.entryUnderKey(tx, input)
      if (open !== null || posted !== null) return
      await this.recordFailure(tx, input, FinancePostingFailureReason.NOT_QUEUED)
    }, POST_TRANSACTION)
  }

  private async decide(
    tx: PrismaTransaction,
    input: PostSourceInput,
    settings: { accountingStartDate: Date; lockedThrough: Date | null; recognizeSaleOn: string },
    dryRun = false
  ): Promise<PostSourceResult> {
    // A job that pairs an event with a source of another kind has nothing to read: nothing is posted under a wrong key
    if (FinanceEventSource[input.kind] !== input.sourceType) {
      return this.done(FinancePostingOutcome.NOTHING_TO_POST)
    }
    // An entry under the key is the answer, whatever the books look like now (an account unmapped since, an order returned since): a
    // job that comes late must not turn a posted entry into a failure
    const postedId = await this.entryUnderKey(tx, input)
    if (postedId !== null) return this.done(FinancePostingOutcome.REPLAYED, postedId)
    // E6 is not a new entry built from rows: it reverses the one E5 wrote
    if (input.kind === FinanceEventKind.REMITTANCE_VOID) {
      return this.reverseRemittance(
        tx,
        input,
        {
          accountingStartDate: dateToDay(settings.accountingStartDate),
          lockedThrough: settings.lockedThrough === null ? null : dateToDay(settings.lockedThrough)
        },
        dryRun
      )
    }
    const candidate = await this.load(tx, input, settings)
    if (candidate.kind === 'nothing') return this.done(FinancePostingOutcome.NOTHING_TO_POST)
    if (candidate.kind === 'failed') {
      return { outcome: FinancePostingOutcome.FAILED, entryId: null, reason: candidate.reason }
    }
    if (!candidate.result.ok) {
      return {
        outcome: FinancePostingOutcome.FAILED,
        entryId: null,
        reason: candidate.result.reason
      }
    }
    const lines = candidate.result.lines
    if (lines.length === 0) return this.done(FinancePostingOutcome.NOTHING_TO_POST)
    return this.write(
      tx,
      input,
      candidate,
      lines,
      {
        accountingStartDate: dateToDay(settings.accountingStartDate),
        lockedThrough: settings.lockedThrough === null ? null : dateToDay(settings.lockedThrough)
      },
      dryRun
    )
  }

  private async settle(
    tx: PrismaTransaction,
    input: PostSourceInput,
    result: PostSourceResult
  ): Promise<void> {
    if (result.outcome === FinancePostingOutcome.FAILED && result.reason !== null) {
      await this.recordFailure(tx, input, result.reason)
    } else {
      await this.resolveFailure(tx, input)
    }
  }

  private done(outcome: FinancePostingOutcome, entryId: string | null = null): PostSourceResult {
    return { outcome, entryId, reason: null }
  }

  // The events of one order are processed one after the other, so the decision "E2 or straight from inventory" is taken on a
  // settled state. A transaction-level advisory lock, taken on the order, not on the organization: other sources run in parallel.
  private async lockSource(tx: PrismaTransaction, input: PostSourceInput): Promise<void> {
    const scope = FinanceLockScopes.POSTING(input.organizationId, input.sourceType, input.sourceId)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`
  }

  private async write(
    tx: PrismaTransaction,
    input: PostSourceInput,
    candidate: Extract<Candidate, { kind: 'entry' }>,
    lines: DraftLine[],
    calendar: { accountingStartDate: string; lockedThrough: string | null },
    dryRun = false
  ): Promise<PostSourceResult> {
    // The key may already hold the entry, dated when it was first posted: a retry after a close must not be refused for a date that
    // moved. What is compared is the content the key stands for, and another content is a bug that is never overwritten.
    const existing = await tx.journalEntry.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: candidate.key
        }
      },
      select: { id: true, totalCents: true }
    })
    if (existing !== null) {
      // An entry already under this key is the one this event posted: the accountant may have re-mapped an account since, and the entry
      // is immutable, so what is compared is the AMOUNT the key stands for. Another amount is a bug and is never overwritten.
      const wanted = lines.reduce((sum, line) => sum + line.debitCents, 0)
      const same = existing.totalCents === wanted
      return same
        ? this.done(FinancePostingOutcome.REPLAYED, existing.id)
        : {
            outcome: FinancePostingOutcome.FAILED,
            entryId: existing.id,
            reason: FinancePostingFailureReason.KEY_CONTENT_MISMATCH
          }
    }

    const date = automaticEntryDate(candidate.sourceDay, calendar)
    if (!date.post) return this.done(FinancePostingOutcome.BEFORE_START)
    // A preview stops where the entry would be written
    if (dryRun) return this.done(FinancePostingOutcome.PENDING)
    const posted = await this.ledger.post(
      {
        organizationId: input.organizationId,
        entryDate: date.entryDate,
        type: candidate.type,
        sourceType: candidate.sourceType,
        sourceId: input.sourceId,
        sourceDate: candidate.sourceDay,
        idempotencyKey: candidate.key,
        memo: candidate.memo,
        origin: EntryOrigin.SYSTEM,
        createdBy: null,
        lines
      },
      tx
    )
    return this.done(
      posted.replayed ? FinancePostingOutcome.REPLAYED : FinancePostingOutcome.POSTED,
      posted.id
    )
  }

  // ------------------------------------------------------------------------------------------------------------------------
  // The loaders: one per event, each answering from the current rows

  private async load(
    tx: PrismaTransaction,
    input: PostSourceInput,
    settings: { accountingStartDate: Date; recognizeSaleOn: string }
  ): Promise<Candidate> {
    const recognizeSaleOn = settings.recognizeSaleOn
    switch (input.kind) {
      case FinanceEventKind.PAYMENT:
        return this.loadPayment(tx, input)
      case FinanceEventKind.SENT:
        return this.loadSent(tx, input, recognizeSaleOn)
      case FinanceEventKind.SALE:
        return this.loadSale(tx, input, recognizeSaleOn)
      case FinanceEventKind.ADJUST:
        return this.loadAdjustment(tx, input)
      case FinanceEventKind.CHARGES:
        return this.loadCharges(tx, input)
      case FinanceEventKind.REMITTANCE_CONFIRM:
        return this.loadRemittanceConfirm(
          tx,
          input,
          dateToDay(settings.accountingStartDate),
          recognizeSaleOn
        )
      case FinanceEventKind.COD_WRITE_OFF:
        return this.loadWriteOff(
          tx,
          input,
          dateToDay(settings.accountingStartDate),
          recognizeSaleOn
        )
      case FinanceEventKind.RETURN_RESTOCK:
        return this.loadReturn(tx, input, settings)
      case FinanceEventKind.ORDER_RETURN:
        return this.loadOrderReturn(tx, input, settings)
      default:
        return NOTHING
    }
  }

  private async accountsOf(tx: PrismaTransaction, organizationId: string): Promise<RoleAccounts> {
    const mappings = await tx.accountRoleMapping.findMany({
      where: { organizationId },
      select: { role: true, accountId: true }
    })
    const usable = await tx.ledgerAccount.findMany({
      where: {
        organizationId,
        id: { in: mappings.map(mapping => mapping.accountId) },
        active: true,
        isPostable: true
      },
      select: { id: true }
    })
    const ok = new Set(usable.map(account => account.id))
    const byRole = new Map(
      mappings.filter(mapping => ok.has(mapping.accountId)).map(m => [m.role, m.accountId])
    )
    // A role whose account was switched off is as good as unmapped: the person fixes the mapping
    return (role: AccountRole): string | null => byRole.get(role) ?? null
  }

  private async orderOf(tx: PrismaTransaction, organizationId: string, orderId: string) {
    return tx.order.findFirst({
      where: { id: orderId, store: { organizationId } },
      select: {
        id: true,
        storeId: true,
        status: true,
        subtotalCents: true,
        shippingCents: true,
        discountCents: true,
        totalCents: true,
        taxCents: true,
        pricesIncludeTax: true,
        paymentMethod: true,
        paymentStatus: true,
        carrierConnectionId: true,
        shippedAt: true,
        deliveredAt: true,
        store: { select: { timezone: true } },
        items: { select: { id: true, quantity: true, unitPriceCents: true, taxCents: true } }
      }
    })
  }

  // The cost of what left for an order: the ISSUE movements it made, at the cost each carried
  private async issuedCost(tx: PrismaTransaction, storeId: string, orderId: string) {
    const movements = await tx.inventoryMovement.findMany({
      where: {
        storeId,
        type: InventoryMovementType.ISSUE,
        referenceType: InventoryReferenceType.ORDER,
        referenceId: orderId
      },
      select: { quantity: true, unitCostCents: true, valueCents: true }
    })
    return issueCost(movements)
  }

  // E1: the order is paid and it is not cash on delivery
  private async loadPayment(tx: PrismaTransaction, input: PostSourceInput): Promise<Candidate> {
    const order = await this.orderOf(tx, input.organizationId, input.sourceId)
    if (order === null) return NOTHING
    // No money came in (a replacement covered by a credit, a full discount): there is no payment to record and no account to receive it,
    // so an unmapped or inactive account of the method is not a failure of this order
    if (order.totalCents === 0) return NOTHING
    if (
      order.paymentStatus !== (PaymentStatus.COMPLETED as string) ||
      order.paymentMethod === (PaymentMethod.CASH_ON_DELIVERY as string) ||
      order.status === (OrderStatus.CANCELLED as string)
    ) {
      return NOTHING
    }
    const methods = await tx.paymentMethodAccount.findMany({
      where: {
        organizationId: input.organizationId,
        paymentMethod: order.paymentMethod,
        OR: [{ storeId: order.storeId }, { storeId: null }]
      },
      select: { storeId: true, accountId: true }
    })
    // A store's own account wins over the organization's default
    const chosen = methods.find(m => m.storeId !== null) ?? methods[0]
    if (chosen === undefined) return failed(FinancePostingFailureReason.PAYMENT_ACCOUNT_MISSING)
    const account = await tx.ledgerAccount.findFirst({
      where: { id: chosen.accountId, organizationId: input.organizationId },
      select: { active: true, isPostable: true }
    })
    if (account === null || !account.active || !account.isPostable) {
      return failed(FinancePostingFailureReason.ACCOUNT_INACTIVE)
    }
    const accounts = await this.accountsOf(tx, input.organizationId)
    const when = input.occurredAt === undefined ? new Date() : new Date(input.occurredAt)
    return {
      kind: 'entry',
      sourceDay: dayInZone(when, order.store.timezone),
      type: JournalEntryType.SALE,
      sourceType: FinanceSourceType.ORDER,
      key: FinancePostingKey.ORDER_PAYMENT(order.id),
      memo: FinanceAutoMemo.PAYMENT,
      result: orderPaymentLines({
        accounts,
        paymentAccountId: chosen.accountId,
        totalCents: order.totalCents,
        storeId: order.storeId
      })
    }
  }

  // E2: the goods left. Skipped when the sale is recognized at shipping (E3 then posts the cost), and when the sale entry already took
  // the cost straight from inventory (a sale that did not wait for this one): the cost is taken out once.
  private async loadSent(
    tx: PrismaTransaction,
    input: PostSourceInput,
    recognizeSaleOn: string
  ): Promise<Candidate> {
    if (recognizeSaleOn === (SaleRecognition.SHIPPED as string)) return NOTHING
    const order = await this.orderOf(tx, input.organizationId, input.sourceId)
    if (order === null || order.shippedAt === null) return NOTHING
    if (order.status === (OrderStatus.CANCELLED as string)) return NOTHING
    const saleExists = await tx.journalEntry.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: FinancePostingKey.ORDER_SALE(order.id)
        }
      },
      select: { id: true }
    })
    if (saleExists !== null) return NOTHING
    const cost = await this.issuedCost(tx, order.storeId, order.id)
    if (!cost.ok) return failed(cost.reason)
    const accounts = await this.accountsOf(tx, input.organizationId)
    return {
      kind: 'entry',
      sourceDay: dayInZone(order.shippedAt, order.store.timezone),
      type: JournalEntryType.SALE_SHIPMENT,
      sourceType: FinanceSourceType.ORDER,
      key: FinancePostingKey.ORDER_SENT(order.id),
      memo: FinanceAutoMemo.SENT,
      result: sentLines({ accounts, costCents: cost.costCents, storeId: order.storeId })
    }
  }

  // E3: the sale is recognized, at delivery or at shipping by the setting
  private async loadSale(
    tx: PrismaTransaction,
    input: PostSourceInput,
    recognizeSaleOn: string
  ): Promise<Candidate> {
    const order = await this.orderOf(tx, input.organizationId, input.sourceId)
    if (order === null) return NOTHING
    const onShipped = recognizeSaleOn === (SaleRecognition.SHIPPED as string)
    const when = onShipped ? order.shippedAt : order.deliveredAt
    // The moment has not come (no date of it) or the order was cancelled: there is nothing to recognize. An order that passed the moment
    // and was RETURNED since is still a sale: its return is E8, and the sale must exist for the return to reverse it
    if (when === null || order.status === (OrderStatus.CANCELLED as string)) return NOTHING

    const amounts = saleAmounts({
      subtotalCents: order.subtotalCents,
      shippingCents: order.shippingCents,
      discountCents: order.discountCents,
      totalCents: order.totalCents,
      taxCents: order.taxCents,
      pricesIncludeTax: order.pricesIncludeTax,
      lines: order.items
    })
    if (!amounts.ok) return failed(amounts.reason)

    const isCod = order.paymentMethod === (PaymentMethod.CASH_ON_DELIVERY as string)
    let collection: Parameters<typeof saleLines>[0]['collection']
    if (amounts.amounts.totalCents === 0) {
      // Nothing to collect (the replacement of an exchange whose credit covers it, an order with a full discount): no money is owed by a
      // customer or a carrier, E1 had nothing to receive and wrote no entry, so there is no advance to clear, no receivable to open and
      // no credit sale to refuse. The debit of the sale is zero and the entry holds the cost of what left, the only figure such an order
      // has (revenue, shipping and tax add up to the total, so they are zero). Waiting for an E1 that can never exist left the sale as
      // source_not_ready for good and the close of the period blocked (QA HC-138). The treatment of an exchange as such is the
      // accountant's, see the plan.
      collection = { kind: 'advance' }
    } else if (isCod) {
      const shipment = await tx.shipment.findFirst({
        where: {
          orderId: order.id,
          storeId: order.storeId,
          kind: ShipmentKind.OUTBOUND,
          status: { notIn: [...ShipmentInactiveStatuses] }
        },
        orderBy: { createdAt: 'desc' },
        select: { connectionId: true }
      })
      const carrierConnectionId = shipment?.connectionId ?? order.carrierConnectionId
      if (carrierConnectionId === null) return failed(FinancePostingFailureReason.CARRIER_MISSING)
      collection = { kind: 'carrier', carrierConnectionId }
    } else if (order.paymentStatus === (PaymentStatus.REFUNDED as string)) {
      // The goods were delivered after the money went back: the sale would be a credit sale (TDD_18 §4.2 E3, not built) and recognizing
      // it would put revenue and tax on money that left, so nothing is posted. Waiting changes nothing (E1 posts only a completed
      // payment), so this is no wait: a person is told [ACCOUNTANT] (HC-105)
      return failed(FinancePostingFailureReason.PAYMENT_REFUNDED)
    } else if (order.paymentStatus === (PaymentStatus.COMPLETED as string)) {
      // The advance is cleared only when E1 put it there: a debit of an advance that was never credited (a payment before the start of the
      // books, or an E1 that failed) would leave the account negative for good. The payment event posts E1 and queues the sale again.
      const advance = await tx.journalEntry.findUnique({
        where: {
          organizationId_idempotencyKey: {
            organizationId: input.organizationId,
            idempotencyKey: FinancePostingKey.ORDER_PAYMENT(order.id)
          }
        },
        select: { id: true }
      })
      if (advance === null) return failed(FinancePostingFailureReason.SOURCE_NOT_READY)
      collection = { kind: 'advance' }
    } else {
      // Not collected on delivery and not paid: a sale on credit, which the MVP does not build (TDD_18 §4.2 E3). It is a failure a
      // person sees, never an invented receivable; the payment event posts it again once the order is paid
      return failed(FinancePostingFailureReason.SOURCE_NOT_READY)
    }

    // The cost clears what E2 put in transit when it was posted, to the cent; else it leaves inventory itself
    const sent = await tx.journalEntry.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: FinancePostingKey.ORDER_SENT(order.id)
        }
      },
      select: { totalCents: true }
    })
    let costCents: number
    if (sent === null) {
      const cost = await this.issuedCost(tx, order.storeId, order.id)
      if (!cost.ok) return failed(cost.reason)
      costCents = cost.costCents
    } else {
      costCents = sent.totalCents
    }
    const accounts = await this.accountsOf(tx, input.organizationId)
    return {
      kind: 'entry',
      sourceDay: dayInZone(when, order.store.timezone),
      type: JournalEntryType.SALE,
      sourceType: FinanceSourceType.ORDER,
      key: FinancePostingKey.ORDER_SALE(order.id),
      memo: FinanceAutoMemo.SALE,
      result: saleLines({
        accounts,
        amounts: amounts.amounts,
        collection,
        costCents,
        costFromTransit: sent !== null,
        storeId: order.storeId
      })
    }
  }

  // E7: a person wrote off the difference of a guide that did not match its remittance. The amount is what the books still hold as owed by
  // the carrier for the guide: what it had to collect less what each confirmed remittance cleared (the same settlement E5 made), so the
  // entry follows the books and not a figure typed by a person. A surplus is written the other way round.
  private async loadWriteOff(
    tx: PrismaTransaction,
    input: PostSourceInput,
    accountingStartDate: string,
    recognizeSaleOn: string
  ): Promise<Candidate> {
    const shipment = await tx.shipment.findFirst({
      where: { id: input.sourceId, store: { organizationId: input.organizationId } },
      select: {
        storeId: true,
        orderId: true,
        connectionId: true,
        codStatus: true,
        codAmountCents: true,
        deliveredAt: true,
        shippingPayer: true,
        carrierCostCents: true,
        carrierRateCents: true,
        commissionBps: true,
        store: { select: { timezone: true } },
        connection: { select: { remittanceDeductsFee: true } }
      }
    })
    if (
      shipment === null ||
      shipment.codStatus !== (CodStatus.WRITTEN_OFF as string) ||
      shipment.codAmountCents === null
    ) {
      return NOTHING
    }
    // The receivable is there only when E3 put it there (or the guide was delivered before the books began, and the opening balance
    // holds it): a sale that is not posted yet makes this wait, it never clears a receivable that does not exist
    const awaiting = await this.ordersAwaitingSale(
      tx,
      input.organizationId,
      [
        {
          orderId: shipment.orderId,
          storeId: shipment.storeId,
          deliveredAt: shipment.deliveredAt,
          timezone: shipment.store.timezone
        }
      ],
      accountingStartDate,
      recognizeSaleOn
    )
    if (awaiting) return failed(FinancePostingFailureReason.SOURCE_NOT_READY)
    const lines = await tx.codRemittanceLine.findMany({
      where: {
        shipmentId: input.sourceId,
        storeId: shipment.storeId,
        excluded: false,
        outcome: { in: [...SettlingOutcomes] },
        remittance: { storeId: shipment.storeId, status: RemittanceStatus.CONFIRMED }
      },
      orderBy: [{ remittance: { confirmedAt: 'asc' } }, { remittanceId: 'asc' }],
      select: { remittanceId: true, reportedCents: true, reportedFeeCents: true }
    })
    // What each remittance cleared is in its entry: one that is not posted yet makes this wait
    const wanted = [
      ...new Set(lines.map(line => FinancePostingKey.REMITTANCE_CONFIRM(line.remittanceId)))
    ]
    const postedKeys = await tx.journalEntry.findMany({
      where: { organizationId: input.organizationId, idempotencyKey: { in: wanted } },
      select: { idempotencyKey: true }
    })
    if (postedKeys.length < wanted.length)
      return failed(FinancePostingFailureReason.SOURCE_NOT_READY)
    const charged = await this.entryOf(
      tx,
      input.organizationId,
      FinancePostingKey.SHIPMENT_CHARGES(input.sourceId)
    )
    const estimate = this.estimateOf(
      charged?.totalCents,
      accountingStartDate,
      shipment,
      shipment.store.timezone
    )
    if (estimate === null) return failed(FinancePostingFailureReason.SOURCE_NOT_READY)
    const deducts = shipment.connection.remittanceDeductsFee
    const replay = replaySettlements(lines, {
      estimateCents: estimate,
      deductsFee: deducts,
      grossCents: shipment.codAmountCents
    })
    const settled: SettledLine[] = replay.settlements.map(settlement => ({
      reportedCents: settlement.reportedCents,
      deductedCents: settlement.deductedCents
    }))
    const accounts = await this.accountsOf(tx, input.organizationId)
    return {
      kind: 'entry',
      sourceDay: this.dayOfJob(input, shipment.store.timezone),
      type: JournalEntryType.COD_WRITE_OFF,
      sourceType: FinanceSourceType.SHIPMENT,
      key: FinancePostingKey.SHIPMENT_WRITE_OFF(input.sourceId),
      memo: FinanceAutoMemo.COD_WRITE_OFF,
      result: writeOffLines({
        accounts,
        carrierConnectionId: shipment.connectionId,
        openCents: openReceivableCents(shipment.codAmountCents, settled),
        storeId: shipment.storeId
      })
    }
  }

  // The day the job says the event happened (the action of a person has no date column of its own), else today
  private dayOfJob(input: PostSourceInput, timeZone: string): string {
    const when = input.occurredAt === undefined ? new Date() : new Date(input.occurredAt)
    return dayInZone(Number.isNaN(when.getTime()) ? new Date() : when, timeZone)
  }

  // E8: a return was received. What the units that came back give back of the sale (revenue and tax, in proportion), and the cost of
  // the units put back on the shelf. The returns of an order are posted in the order they were received, so the running total of units
  // back makes the parts add up to the sale to the cent.
  private async loadReturn(
    tx: PrismaTransaction,
    input: PostSourceInput,
    settings: PostingSettings
  ): Promise<Candidate> {
    const found = await tx.orderReturn.findFirst({
      where: { id: input.sourceId, store: { organizationId: input.organizationId } },
      select: {
        id: true,
        storeId: true,
        orderId: true,
        status: true,
        receivedAt: true,
        lines: { select: { orderItemId: true, quantity: true } },
        store: { select: { timezone: true } }
      }
    })
    if (
      found === null ||
      found.receivedAt === null ||
      !hasReceivedUnits(found.status as OrderReturnStatus)
    ) {
      return NOTHING
    }
    const earlier = await tx.orderReturn.findMany({
      where: {
        storeId: found.storeId,
        orderId: found.orderId,
        status: { in: [OrderReturnStatus.RECEIVED, OrderReturnStatus.COMPLETED] },
        receivedAt: { not: null },
        OR: [
          { receivedAt: { lt: found.receivedAt } },
          { receivedAt: found.receivedAt, id: { lt: found.id } }
        ]
      },
      select: { lines: { select: { orderItemId: true, quantity: true } } }
    })
    return this.returnEntry(tx, input, settings, {
      orderId: found.orderId,
      returned: this.unitsBy(found.lines),
      before: this.unitsBy(earlier.flatMap(row => row.lines)),
      restock: { type: InventoryReferenceType.RETURN, id: found.id },
      sourceDay: dayInZone(found.receivedAt, found.store.timezone),
      key: FinancePostingKey.RETURN_RESTOCK(found.id),
      memo: FinanceAutoMemo.RETURN_RESTOCK,
      sourceType: FinanceSourceType.RETURN
    })
  }

  // E8, the order as a whole: a parcel that came back, or a delivered order an agent put back, with no return row. Every unit is back.
  // An order that has received returns is theirs (each posts its own part), so this posts nothing for it.
  private async loadOrderReturn(
    tx: PrismaTransaction,
    input: PostSourceInput,
    settings: PostingSettings
  ): Promise<Candidate> {
    const order = await this.orderOf(tx, input.organizationId, input.sourceId)
    if (order === null || order.status !== (OrderStatus.RETURNED as string)) return NOTHING
    const withReturns = await tx.orderReturn.count({
      where: {
        storeId: order.storeId,
        orderId: order.id,
        status: { in: [OrderReturnStatus.RECEIVED, OrderReturnStatus.COMPLETED] }
      }
    })
    if (withReturns > 0) return NOTHING
    return this.returnEntry(tx, input, settings, {
      orderId: order.id,
      returned: new Map(order.items.map(item => [item.id, item.quantity])),
      before: new Map(),
      restock: { type: InventoryReferenceType.ORDER, id: order.id },
      sourceDay: this.dayOfJob(input, order.store.timezone),
      key: FinancePostingKey.ORDER_RETURN(order.id),
      memo: FinanceAutoMemo.ORDER_RETURN,
      sourceType: FinanceSourceType.ORDER
    })
  }

  private unitsBy(
    lines: readonly { orderItemId: string; quantity: number }[]
  ): Map<string, number> {
    const units = new Map<string, number>()
    for (const line of lines)
      units.set(line.orderItemId, (units.get(line.orderItemId) ?? 0) + line.quantity)
    return units
  }

  private async returnEntry(
    tx: PrismaTransaction,
    input: PostSourceInput,
    settings: PostingSettings,
    facts: {
      orderId: string
      returned: ReadonlyMap<string, number>
      before: ReadonlyMap<string, number>
      restock: { type: InventoryReferenceType; id: string }
      sourceDay: string
      key: string
      memo: string
      sourceType: FinanceSourceType
    }
  ): Promise<Candidate> {
    const order = await this.orderOf(tx, input.organizationId, facts.orderId)
    if (order === null) return NOTHING
    const startDay = dateToDay(settings.accountingStartDate)
    const onShipped = settings.recognizeSaleOn === (SaleRecognition.SHIPPED as string)
    const recognizedAt = onShipped ? order.shippedAt : order.deliveredAt
    const recognized = recognizedAt !== null
    const saleExists =
      (await this.entryOf(tx, input.organizationId, FinancePostingKey.ORDER_SALE(order.id))) !==
      null
    // What the return reverses must be there: a sale of the books that is not posted yet makes this wait; a sale from before the books
    // began is in the opening balance, and its return reverses against it
    if (recognized && !saleExists && dayInZone(recognizedAt, order.store.timezone) >= startDay) {
      return failed(FinancePostingFailureReason.SOURCE_NOT_READY)
    }
    // Before the sale the goods are in transit (E2): the same wait for it, unless they left before the books began
    if (!recognized) {
      const sentExists =
        (await this.entryOf(tx, input.organizationId, FinancePostingKey.ORDER_SENT(order.id))) !==
        null
      const shippedBefore =
        order.shippedAt === null || dayInZone(order.shippedAt, order.store.timezone) < startDay
      if (order.shippedAt !== null && !sentExists && !shippedBefore) {
        return failed(FinancePostingFailureReason.SOURCE_NOT_READY)
      }
    }

    let reversal: ReturnReversal | null = null
    let shipping: ReturnReversal | null = null
    if (recognized) {
      const bases = lineBases({
        subtotalCents: order.subtotalCents,
        shippingCents: order.shippingCents,
        discountCents: order.discountCents,
        totalCents: order.totalCents,
        taxCents: order.taxCents,
        pricesIncludeTax: order.pricesIncludeTax,
        lines: order.items.map(item => ({
          orderItemId: item.id,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          taxCents: item.taxCents
        }))
      })
      if (!bases.ok) return failed(bases.reason)
      const reversed = reversalOf({
        bases: bases.lines,
        before: facts.before,
        returned: facts.returned
      })
      if (!reversed.ok) return failed(reversed.reason)
      reversal = reversed.reversal
      // The shipping fee goes with the receivable of a guide that will never be remitted, once the order is back in full
      const backInFull = order.items.every(
        item =>
          (facts.before.get(item.id) ?? 0) + (facts.returned.get(item.id) ?? 0) >= item.quantity
      )
      const sale = saleAmounts({
        subtotalCents: order.subtotalCents,
        shippingCents: order.shippingCents,
        discountCents: order.discountCents,
        totalCents: order.totalCents,
        taxCents: order.taxCents,
        pricesIncludeTax: order.pricesIncludeTax,
        lines: order.items
      })
      if (!sale.ok) return failed(sale.reason)
      if (backInFull) {
        const lineTax = order.items.reduce((sum, item) => sum + (item.taxCents ?? 0), 0)
        shipping = {
          netCents: sale.amounts.shippingNetCents,
          vatCents: sale.amounts.vatCents - lineTax
        }
      }
    }

    // The units put back on the shelf, at the cost their movements carry (a unit that came back with no cost cannot be valued)
    const movements = await tx.inventoryMovement.findMany({
      where: {
        storeId: order.storeId,
        type: InventoryMovementType.RETURN_IN,
        referenceType: facts.restock.type,
        referenceId: facts.restock.id
      },
      select: { productId: true, variantId: true, quantity: true, unitCostCents: true }
    })
    // A unit that comes back is stored with no cost (the engine values it at the level's average): it is valued at what the sale took it
    // out at, the cost of the ISSUE movements of the order
    const issued =
      movements.some(move => move.unitCostCents === null) && movements.length > 0
        ? await tx.inventoryMovement.findMany({
            where: {
              storeId: order.storeId,
              type: InventoryMovementType.ISSUE,
              referenceType: InventoryReferenceType.ORDER,
              referenceId: order.id
            },
            select: {
              productId: true,
              variantId: true,
              quantity: true,
              unitCostCents: true,
              valueCents: true
            }
          })
        : []
    const cost = restockCost(movements, issued)
    if (!cost.ok) return failed(cost.reason)

    // Who owes the money back: the carrier's debt is cancelled when a guide that will never be remitted was sold cash on delivery; in
    // every other case it is the customer's advance, the refund the business owes until a person pays it out
    let settlement: ReturnSettlement = { kind: ReturnSettlementKind.ADVANCE }
    if (recognized && order.paymentMethod === (PaymentMethod.CASH_ON_DELIVERY as string)) {
      // The guide of a parcel that came back is RETURNED and its cash void: the latest guide of the way out, whatever its status
      const guide = await tx.shipment.findFirst({
        where: { orderId: order.id, storeId: order.storeId, kind: ShipmentKind.OUTBOUND },
        orderBy: { createdAt: 'desc' },
        select: { connectionId: true, codStatus: true }
      })
      if (guide !== null && guide.codStatus === (CodStatus.VOID as string)) {
        settlement = {
          kind: ReturnSettlementKind.CARRIER,
          carrierConnectionId: guide.connectionId
        }
      }
    }
    const accounts = await this.accountsOf(tx, input.organizationId)
    return {
      kind: 'entry',
      sourceDay: facts.sourceDay,
      type: JournalEntryType.SALE_RETURN,
      sourceType: facts.sourceType,
      key: facts.key,
      memo: facts.memo,
      result: returnLines({
        accounts,
        reversal,
        shipping: settlement.kind === ReturnSettlementKind.CARRIER ? shipping : null,
        settlement,
        restockCostCents: cost.costCents,
        costAgainst: recognized ? ReturnCostAgainst.COST_OF_GOODS_SOLD : ReturnCostAgainst.TRANSIT,
        storeId: order.storeId
      })
    }
  }

  // E9: an adjustment, a count variance
  private async loadAdjustment(tx: PrismaTransaction, input: PostSourceInput): Promise<Candidate> {
    const movement = await tx.inventoryMovement.findFirst({
      where: { id: input.sourceId, store: { organizationId: input.organizationId } },
      select: {
        storeId: true,
        type: true,
        reason: true,
        quantity: true,
        unitCostCents: true,
        valueCents: true,
        createdAt: true,
        store: { select: { timezone: true } }
      }
    })
    if (movement === null) return NOTHING
    const accounts = await this.accountsOf(tx, input.organizationId)
    return {
      kind: 'entry',
      sourceDay: dayInZone(movement.createdAt, movement.store.timezone),
      type: JournalEntryType.INVENTORY_ADJUSTMENT,
      sourceType: FinanceSourceType.INVENTORY_MOVEMENT,
      key: FinancePostingKey.MOVEMENT_ADJUST(input.sourceId),
      memo: FinanceAutoMemo.ADJUST,
      result: adjustmentLines({ accounts, movement, storeId: movement.storeId })
    }
  }

  // The entry an event already left: the one under its key, or, for the voiding of a remittance (which reverses E5 under the
  // ledger's own key), the reversal of the entry of the confirmation
  private async entryUnderKey(
    tx: PrismaTransaction,
    input: PostSourceInput
  ): Promise<string | null> {
    if (input.kind === FinanceEventKind.REMITTANCE_VOID) {
      const confirmed = await this.entryOf(
        tx,
        input.organizationId,
        FinancePostingKey.REMITTANCE_CONFIRM(input.sourceId)
      )
      if (confirmed === null) return null
      const reversal = await tx.journalEntry.findFirst({
        where: { organizationId: input.organizationId, reversesEntryId: confirmed.id },
        select: { id: true }
      })
      return reversal?.id ?? null
    }
    const entry = await this.entryOf(tx, input.organizationId, keyOf(input))
    return entry?.id ?? null
  }

  private async entryOf(
    tx: PrismaTransaction,
    organizationId: string,
    idempotencyKey: string
  ): Promise<{ id: string; totalCents: number; entryDate: Date } | null> {
    return tx.journalEntry.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey } },
      select: { id: true, totalCents: true, entryDate: true }
    })
  }

  // E4: what the carrier charges for a guide that was delivered (of the way out or of a return, Step 4B.6b-2). Posted as the TDD writes it: gross, no input VAT [ACCOUNTANT], and
  // the same for every charge model of the connection (the model is the owner's information to confirm, debt of the plan)
  private async loadCharges(tx: PrismaTransaction, input: PostSourceInput): Promise<Candidate> {
    const shipment = await tx.shipment.findFirst({
      where: { id: input.sourceId, store: { organizationId: input.organizationId } },
      select: {
        storeId: true,
        connectionId: true,
        kind: true,
        status: true,
        deliveredAt: true,
        shippingPayer: true,
        codAmountCents: true,
        carrierCostCents: true,
        carrierRateCents: true,
        commissionBps: true,
        store: { select: { timezone: true } }
      }
    })
    if (shipment === null || shipment.deliveredAt === null) return NOTHING
    // The guide of the way out and the guide of a return (the units come back by one): both are charged when they arrive. A return guide
    // collects no cash, so it has no commission. Its payer is stored from the side of the guide, not of the store (the sender of a return
    // is the customer): the store pays when the RECIPIENT of the guide pays, so the sides are swapped back before the rule is applied
    const charged: readonly string[] = [ShipmentKind.OUTBOUND, ShipmentKind.RETURN]
    if (
      !charged.includes(shipment.kind) ||
      shipment.status !== (ShipmentStatus.DELIVERED as string)
    ) {
      return NOTHING
    }
    const amounts = chargeAmounts(
      shipment.kind === (ShipmentKind.RETURN as string)
        ? {
            ...shipment,
            shippingPayer:
              shipment.shippingPayer === (ShippingPayer.SENDER as string)
                ? ShippingPayer.RECIPIENT
                : ShippingPayer.SENDER
          }
        : shipment
    )
    if (amounts.freightCents + amounts.commissionCents === 0) return NOTHING
    const accounts = await this.accountsOf(tx, input.organizationId)
    return {
      kind: 'entry',
      sourceDay: dayInZone(shipment.deliveredAt, shipment.store.timezone),
      type: JournalEntryType.SALE_SHIPMENT,
      sourceType: FinanceSourceType.SHIPMENT,
      key: FinancePostingKey.SHIPMENT_CHARGES(input.sourceId),
      memo: FinanceAutoMemo.CHARGES,
      result: chargeLines({
        accounts,
        carrierConnectionId: shipment.connectionId,
        amounts,
        storeId: shipment.storeId
      })
    }
  }

  // E5: a remittance that was confirmed. The loader reads the lines as the confirmation settled them and, for each guide, what E4
  // posted for it: the payable the carrier settles by keeping its fee.
  private async loadRemittanceConfirm(
    tx: PrismaTransaction,
    input: PostSourceInput,
    accountingStartDate: string,
    recognizeSaleOn: string
  ): Promise<Candidate> {
    const remittance = await tx.codRemittance.findFirst({
      where: { id: input.sourceId, store: { organizationId: input.organizationId } },
      select: {
        id: true,
        storeId: true,
        connectionId: true,
        status: true,
        confirmedAt: true,
        destinationAccountId: true,
        connection: { select: { remittanceDeductsFee: true } },
        store: { select: { timezone: true } }
      }
    })
    // A remittance that is not confirmed (a draft, or voided before its entry was posted) has nothing to post
    if (
      remittance === null ||
      remittance.confirmedAt === null ||
      remittance.status !== (RemittanceStatus.CONFIRMED as string)
    ) {
      return NOTHING
    }
    // The money went to the account the owner chose: it must still be one the books can post to, and a cash, bank or wallet account
    let destinationAccountId: string | null = null
    if (remittance.destinationAccountId !== null) {
      const account = await tx.ledgerAccount.findFirst({
        where: { id: remittance.destinationAccountId, organizationId: input.organizationId },
        select: { id: true, cashKind: true, active: true, isPostable: true }
      })
      const problem = account === null ? null : remittanceDestinationProblem(account)
      if (account === null || problem === RemittanceDestinationProblem.INACTIVE) {
        return failed(FinancePostingFailureReason.ACCOUNT_INACTIVE)
      }
      if (problem === RemittanceDestinationProblem.NOT_CASH) {
        return failed(FinancePostingFailureReason.ACCOUNT_NOT_POSTABLE)
      }
      destinationAccountId = account.id
    }
    const lines = await tx.codRemittanceLine.findMany({
      where: {
        remittanceId: remittance.id,
        storeId: remittance.storeId,
        excluded: false,
        shipmentId: { not: null },
        outcome: { in: [...SettlingOutcomes] }
      },
      orderBy: { position: 'asc' },
      select: {
        shipmentId: true,
        reportedCents: true,
        reportedFeeCents: true,
        shipment: {
          select: {
            orderId: true,
            deliveredAt: true,
            shippingPayer: true,
            codAmountCents: true,
            carrierCostCents: true,
            carrierRateCents: true,
            commissionBps: true
          }
        }
      }
    })
    const shipmentIds = lines.flatMap(line => (line.shipmentId === null ? [] : [line.shipmentId]))
    // The cash clears the receivable that E3 put there: a remittance whose sale is not posted yet (or failed) waits, it never credits a
    // receivable that does not exist (QA HC-103). The failure row it leaves is the alarm, and the sale posting asks this one again.
    const awaitingSale = await this.ordersAwaitingSale(
      tx,
      input.organizationId,
      lines.flatMap(line =>
        line.shipment === null
          ? []
          : [
              {
                orderId: line.shipment.orderId,
                storeId: remittance.storeId,
                deliveredAt: line.shipment.deliveredAt,
                timezone: remittance.store.timezone
              }
            ]
      ),
      accountingStartDate,
      recognizeSaleOn
    )
    if (awaitingSale) return failed(FinancePostingFailureReason.SOURCE_NOT_READY)
    // What E4 posted for every guide and the lines of earlier confirmed remittances for them: one query each, not one per line (a
    // file can carry thousands of guides and this runs inside the transaction that holds the lock of the books)
    const charged = await tx.journalEntry.findMany({
      where: {
        organizationId: input.organizationId,
        idempotencyKey: { in: shipmentIds.map(id => FinancePostingKey.SHIPMENT_CHARGES(id)) }
      },
      select: { idempotencyKey: true, totalCents: true }
    })
    const chargedOf = new Map(charged.map(entry => [entry.idempotencyKey, entry.totalCents]))
    const earlier = await tx.codRemittanceLine.findMany({
      where: {
        storeId: remittance.storeId,
        shipmentId: { in: shipmentIds },
        excluded: false,
        outcome: { in: [...SettlingOutcomes] },
        remittance: {
          storeId: remittance.storeId,
          status: RemittanceStatus.CONFIRMED,
          OR: [
            { confirmedAt: { lt: remittance.confirmedAt } },
            { confirmedAt: remittance.confirmedAt, id: { lt: remittance.id } }
          ]
        }
      },
      // In the order the remittances were confirmed: what each one cleared depends on what the ones before it left
      orderBy: [{ remittance: { confirmedAt: 'asc' } }, { remittanceId: 'asc' }],
      select: { shipmentId: true, reportedCents: true, reportedFeeCents: true }
    })
    // Each guide's earlier lines, grouped once: a file can carry thousands of guides and this runs under the lock of the books
    const earlierOf = new Map<
      string,
      { reportedCents: number; reportedFeeCents: number | null }[]
    >()
    for (const row of earlier) {
      if (row.shipmentId === null) continue
      const rows = earlierOf.get(row.shipmentId) ?? []
      rows.push({ reportedCents: row.reportedCents, reportedFeeCents: row.reportedFeeCents })
      earlierOf.set(row.shipmentId, rows)
    }
    const deducts = remittance.connection.remittanceDeductsFee
    const settlements: RemittanceLineSettlement[] = []
    for (const line of lines) {
      if (line.shipmentId === null || line.shipment === null) continue
      const estimate = this.estimateOf(
        chargedOf.get(FinancePostingKey.SHIPMENT_CHARGES(line.shipmentId)),
        accountingStartDate,
        line.shipment,
        remittance.store.timezone
      )
      if (estimate === null) return failed(FinancePostingFailureReason.SOURCE_NOT_READY)
      // An earlier confirmed remittance that kept a fee for the guide cleared its payable already (a guide settled again after a
      // difference); one whose file said the carrier kept nothing did not, and this one may. The same walk gives what they cleared of the
      // receivable, which is what is left for this one to be taken out of.
      const before = replaySettlements(earlierOf.get(line.shipmentId) ?? [], {
        estimateCents: estimate,
        deductsFee: deducts,
        grossCents: line.shipment.codAmountCents
      })
      settlements.push(
        settleRemittanceLine({
          reportedCents: line.reportedCents,
          reportedFeeCents: line.reportedFeeCents,
          estimateCents: estimate,
          deductsFee: deducts,
          grossCents: line.shipment.codAmountCents,
          clearedBeforeCents: before.clearedCents,
          feeAlreadySettled: before.feeSettled
        })
      )
    }
    const accounts = await this.accountsOf(tx, input.organizationId)
    return {
      kind: 'entry',
      sourceDay: dayInZone(remittance.confirmedAt, remittance.store.timezone),
      type: JournalEntryType.COD_REMITTANCE,
      sourceType: FinanceSourceType.REMITTANCE,
      key: FinancePostingKey.REMITTANCE_CONFIRM(remittance.id),
      memo: FinanceAutoMemo.REMITTANCE_CONFIRM,
      result: remittanceLines({
        accounts,
        destinationAccountId,
        carrierConnectionId: remittance.connectionId,
        storeId: remittance.storeId,
        lines: settlements
      })
    }
  }

  // Whether any of the orders is a sale of the books that E3 has not posted yet. A sale recognized (on shipping or on delivery, as the
  // setting says) before the books began is in the opening balance and is never waited for; the day of the guide does not matter then.
  // One query for the orders and one for the entries, however many guides a remittance carries.
  private async ordersAwaitingSale(
    tx: PrismaTransaction,
    organizationId: string,
    guides: { orderId: string; storeId: string; deliveredAt: Date | null; timezone: string }[],
    accountingStartDate: string,
    recognizeSaleOn: string
  ): Promise<boolean> {
    if (guides.length === 0) return false
    const orders = await tx.order.findMany({
      where: {
        id: { in: [...new Set(guides.map(guide => guide.orderId))] },
        storeId: { in: [...new Set(guides.map(guide => guide.storeId))] }
      },
      select: { id: true, storeId: true, shippedAt: true, deliveredAt: true }
    })
    const orderOf = new Map(orders.map(order => [`${order.storeId}:${order.id}`, order]))
    const needed = new Set<string>()
    for (const guide of guides) {
      const order = orderOf.get(`${guide.storeId}:${guide.orderId}`)
      const recognizedAt =
        recognizeSaleOn === (SaleRecognition.SHIPPED as string)
          ? (order?.shippedAt ?? null)
          : (order?.deliveredAt ?? guide.deliveredAt)
      const day = recognizedAt === null ? null : dayInZone(recognizedAt, guide.timezone)
      if (day === null || day >= accountingStartDate) {
        needed.add(FinancePostingKey.ORDER_SALE(guide.orderId))
      }
    }
    if (needed.size === 0) return false
    const posted = await tx.journalEntry.count({
      where: { organizationId, idempotencyKey: { in: [...needed] } }
    })
    return posted < needed.size
  }

  // What E4 posted as payable for a guide (`posted`, read in one query for the whole remittance). A guide delivered before the start of
  // the books has no E4 (its charges are in the opening balance), so the estimate is read from the guide; one delivered after it whose
  // E4 has not been posted yet makes the remittance wait: null. A guide with nothing to charge has an estimate of zero.
  private estimateOf(
    posted: number | undefined,
    accountingStartDate: string,
    shipment: {
      deliveredAt: Date | null
      shippingPayer: string
      codAmountCents: number | null
      carrierCostCents: number | null
      carrierRateCents: number | null
      commissionBps: number | null
    },
    timeZone: string
  ): number | null {
    // What the books carry wins over what the guide says now (a commission edited since): the payable is the entry's
    if (posted !== undefined) return posted
    const amounts = chargeAmounts(shipment)
    const wanted = amounts.freightCents + amounts.commissionCents
    if (wanted === 0) return 0
    const deliveredDay =
      shipment.deliveredAt === null ? null : dayInZone(shipment.deliveredAt, timeZone)
    return deliveredDay !== null && deliveredDay < accountingStartDate ? wanted : null
  }

  // E6: the confirmed remittance was voided: the entry of E5 is reversed by a reversing entry of the system (the journal is never
  // edited). The reversal is dated the day it was voided, or the first day of the open period when that day is closed; never before
  // the entry it reverses.
  private async reverseRemittance(
    tx: PrismaTransaction,
    input: PostSourceInput,
    calendar: { accountingStartDate: string; lockedThrough: string | null },
    dryRun = false
  ): Promise<PostSourceResult> {
    const remittance = await tx.codRemittance.findFirst({
      where: { id: input.sourceId, store: { organizationId: input.organizationId } },
      select: { status: true, voidedAt: true, store: { select: { timezone: true } } }
    })
    if (
      remittance === null ||
      remittance.voidedAt === null ||
      remittance.status !== (RemittanceStatus.VOIDED as string)
    ) {
      return this.done(FinancePostingOutcome.NOTHING_TO_POST)
    }
    const confirmed = await this.entryOf(
      tx,
      input.organizationId,
      FinancePostingKey.REMITTANCE_CONFIRM(input.sourceId)
    )
    // Voided before the confirmation was ever posted: there is nothing to undo, and the failure of that confirmation (a mapping, a guide
    // that waited) is no longer anyone's to fix: it is closed, so that it does not hold anything back for a remittance that posts nothing
    if (confirmed === null) {
      if (dryRun) return this.done(FinancePostingOutcome.NOTHING_TO_POST)
      await tx.financePostingFailure.updateMany({
        where: {
          organizationId: input.organizationId,
          sourceType: FinanceSourceType.REMITTANCE,
          sourceId: input.sourceId,
          eventKind: FinanceEventKind.REMITTANCE_CONFIRM,
          resolvedAt: null
        },
        data: { resolvedAt: new Date() }
      })
      return this.done(FinancePostingOutcome.NOTHING_TO_POST)
    }
    const voidDay = dayInZone(remittance.voidedAt, remittance.store.timezone)
    const date = automaticEntryDate(voidDay, calendar)
    const original = dateToDay(confirmed.entryDate)
    if (dryRun) return this.done(FinancePostingOutcome.PENDING)
    const reversed = await this.ledger.reverse(
      {
        organizationId: input.organizationId,
        entryId: confirmed.id,
        memo: FinanceAutoMemo.REMITTANCE_VOID,
        entryDate: date.post && date.entryDate >= original ? date.entryDate : null,
        createdBy: null
      },
      tx
    )
    return this.done(
      reversed.replayed ? FinancePostingOutcome.REPLAYED : FinancePostingOutcome.POSTED,
      reversed.id
    )
  }

  // The confirmed remittances that settled a guide and whose entry waited for its E4: asked again, each one under its own failure row
  private async repostRemittancesOf(input: PostSourceInput): Promise<void> {
    let lines: { remittanceId: string }[]
    try {
      lines = await this.prisma.client.codRemittanceLine.findMany({
        where: {
          // E4 is the source of a guide, E3 the one of an order: the remittances of the guides of that order
          ...(input.kind === FinanceEventKind.SALE
            ? { shipment: { orderId: input.sourceId } }
            : { shipmentId: input.sourceId }),
          remittance: {
            status: RemittanceStatus.CONFIRMED,
            store: { organizationId: input.organizationId }
          }
        },
        select: { remittanceId: true }
      })
    } catch (error) {
      // The entry that asked is committed and stays the answer of its job: the sweep asks the waiting remittances again
      this.logger.warn(
        { sourceId: input.sourceId, errorName: errorName(error) },
        'the remittances that waited for a posting could not be listed'
      )
      return
    }
    for (const remittanceId of new Set(lines.map(line => line.remittanceId))) {
      try {
        await this.post({
          organizationId: input.organizationId,
          sourceType: FinanceSourceType.REMITTANCE,
          sourceId: remittanceId,
          kind: FinanceEventKind.REMITTANCE_CONFIRM
        })
      } catch (error) {
        // E4 is committed and stays the answer of this job: the remittance has its own job and its own failure row
        this.logger.warn(
          { remittanceId, errorName: errorName(error) },
          'a remittance that waited for a carrier charge could not be posted'
        )
      }
    }
  }

  // ------------------------------------------------------------------------------------------------------------------------
  // The failure of a source: one row per (source, event), counted, and an event only when a person has something new to read

  private async recordFailure(
    tx: PrismaTransaction,
    input: PostSourceInput,
    reason: FinancePostingFailureReason
  ): Promise<void> {
    const where = {
      organizationId_sourceType_sourceId_eventKind: {
        organizationId: input.organizationId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        eventKind: input.kind
      }
    }
    const before = await tx.financePostingFailure.findUnique({
      where,
      select: { reason: true, resolvedAt: true, attempts: true }
    })
    const row = await tx.financePostingFailure.upsert({
      where,
      create: {
        organizationId: input.organizationId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        eventKind: input.kind,
        reason
      },
      // A failure that comes back after it was closed is a new trouble with its own date ("post again" dates the event by it)
      update: {
        reason,
        resolvedAt: null,
        attempts: { increment: 1 },
        ...(before?.resolvedAt == null ? {} : { createdAt: new Date() })
      },
      select: { attempts: true }
    })
    this.logger.warn({ ...input, reason, attempts: row.attempts }, 'an automatic entry failed')
    // New, reopened or with another reason: the same failure again is not news
    // (a source that is only waiting, like a sale not yet paid, is on the list but is not an alarm)
    const alarm = reason !== FinancePostingFailureReason.SOURCE_NOT_READY
    if (
      alarm &&
      (before === null || before.resolvedAt !== null || before.reason !== (reason as string))
    ) {
      this.events.publish(tx, Events.FINANCE_POSTING_FAILED, {
        organizationId: input.organizationId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        eventKind: input.kind,
        reason,
        attempts: row.attempts
      })
    }
  }

  private async resolveFailure(tx: PrismaTransaction, input: PostSourceInput): Promise<void> {
    await tx.financePostingFailure.updateMany({
      where: {
        organizationId: input.organizationId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        eventKind: input.kind,
        resolvedAt: null
      },
      data: { resolvedAt: new Date() }
    })
  }
}
