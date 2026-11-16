import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { type PrismaTransaction, PrismaService } from '@platform/core/database'
import {
  AccountRole,
  EntryOrigin,
  FinanceAutoMemo,
  FinanceEventKind,
  FinanceEventSource,
  FinanceLockScopes,
  FinancePostingFailureReason,
  FinancePostingKey,
  FinancePostingOutcome,
  FinanceSourceType,
  InventoryMovementType,
  InventoryReferenceType,
  JournalEntryType,
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  RemittanceDestinationProblem,
  remittanceDestinationProblem,
  RemittanceStatus,
  SaleRecognition,
  SettlingOutcomes,
  ShipmentInactiveStatuses,
  ShipmentKind,
  ShipmentStatus
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
  settleRemittanceLine
} from './carrier-entry-rules'
import type { DraftLine } from './entry-rules'
import { LedgerService } from './ledger.service'
import { automaticEntryDate, dateToDay } from './period-rules'

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
    case FinanceEventKind.RETURN_RESTOCK:
      return FinancePostingKey.RETURN_RESTOCK(input.sourceId)
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
    if (
      input.kind === FinanceEventKind.CHARGES &&
      (result.outcome === FinancePostingOutcome.POSTED ||
        result.outcome === FinancePostingOutcome.REPLAYED)
    ) {
      await this.repostRemittancesOf(input)
    }
    return result
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
    settings: { accountingStartDate: Date; lockedThrough: Date | null; recognizeSaleOn: string }
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
      return this.reverseRemittance(tx, input, {
        accountingStartDate: dateToDay(settings.accountingStartDate),
        lockedThrough: settings.lockedThrough === null ? null : dateToDay(settings.lockedThrough)
      })
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
    return this.write(tx, input, candidate, lines, {
      accountingStartDate: dateToDay(settings.accountingStartDate),
      lockedThrough: settings.lockedThrough === null ? null : dateToDay(settings.lockedThrough)
    })
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
    calendar: { accountingStartDate: string; lockedThrough: string | null }
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
        return this.loadRemittanceConfirm(tx, input, dateToDay(settings.accountingStartDate))
      default:
        // The return (E8) has no loader yet: nothing is posted, and nothing is claimed as posted
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
        items: { select: { quantity: true, unitPriceCents: true, taxCents: true } }
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
      select: { quantity: true, unitCostCents: true }
    })
    return issueCost(movements)
  }

  // E1: the order is paid and it is not cash on delivery
  private async loadPayment(tx: PrismaTransaction, input: PostSourceInput): Promise<Candidate> {
    const order = await this.orderOf(tx, input.organizationId, input.sourceId)
    if (order === null) return NOTHING
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
    if (isCod) {
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

  // E4: what the carrier charges for a guide that was delivered. Posted as the TDD writes it: gross, no input VAT [ACCOUNTANT], and
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
    if (
      shipment.kind !== (ShipmentKind.OUTBOUND as string) ||
      shipment.status !== (ShipmentStatus.DELIVERED as string)
    ) {
      return NOTHING
    }
    const amounts = chargeAmounts(shipment)
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
    accountingStartDate: string
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
      select: { shipmentId: true, reportedFeeCents: true }
    })
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
      // difference); one whose file said the carrier kept nothing did not, and this one may
      const feeAlreadySettled = earlier.some(
        row =>
          row.shipmentId === line.shipmentId &&
          (row.reportedFeeCents ?? (deducts ? estimate : 0)) > 0
      )
      settlements.push(
        settleRemittanceLine({
          reportedCents: line.reportedCents,
          reportedFeeCents: line.reportedFeeCents,
          estimateCents: estimate,
          deductsFee: deducts,
          feeAlreadySettled
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
    calendar: { accountingStartDate: string; lockedThrough: string | null }
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
    const lines = await this.prisma.client.codRemittanceLine.findMany({
      where: {
        shipmentId: input.sourceId,
        remittance: {
          status: RemittanceStatus.CONFIRMED,
          store: { organizationId: input.organizationId }
        }
      },
      select: { remittanceId: true }
    })
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
