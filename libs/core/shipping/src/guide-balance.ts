import { lockStoreScope, type PrismaService, type PrismaTransaction } from '@platform/core/database'
import {
  averageCostCents,
  BenefitBase,
  type BenefitBaseType,
  BenefitDispatchedStatuses,
  type BenefitEvent,
  type BenefitLossRuleType,
  type BenefitPeriodKindType,
  BenefitRefundRule,
  type BenefitRefundRuleType,
  benefitAlertOf,
  balanceAlertOf,
  CarrierGuideLimits,
  evaluatePeriod,
  GuideMovementActor,
  GuideMovementKind,
  GuideZoneFallback,
  type PeriodBounds,
  periodOf,
  ShipmentKind,
  ShipmentLockScopes,
  ShipmentStatus
} from '@platform/core/domain'
import type { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

// The writes of the guide balance and of the refund benefit that happen inside a move of a shipment, and the daily close of the
// benefit periods (TDD_17 §4.18, Step 4.16). Everything is a no-op for a connection with no policy or with the switch off, and
// nothing here ever refuses a move: a guide made against a balance of 0 only raises an alert. The ledger is append-only, so a
// retried move or two workers writing the same consume or refund end with one row (the partial unique index).

const SYSTEM = GuideMovementActor.SYSTEM

export interface GuidePolicy {
  connectionId: string
  storeId: string
  balanceEnabled: boolean
  benefitEnabled: boolean
  warnOnEmptyBalance: boolean
  lowBalanceThreshold: number | null
  periodKind: BenefitPeriodKindType
  periodDays: number
  periodAnchor: string
  thresholdBps: number
  warnAtBps: number
  base: BenefitBaseType
  returnStatuses: ShipmentStatus[]
  refundRule: BenefitRefundRuleType
  lossRule: BenefitLossRuleType
  benefitSince: Date
}

type Reader = Pick<
  PrismaTransaction,
  'carrierGuidePolicy' | 'carrierGuideMovement' | 'shipmentEvent' | 'store'
>

// The policy of a connection, or null when it never opted in. Read under the store: an id of another store finds nothing.
export async function readGuidePolicy(
  client: Reader,
  storeId: string,
  connectionId: string
): Promise<GuidePolicy | null> {
  const row = await client.carrierGuidePolicy.findFirst({ where: { storeId, connectionId } })
  if (row === null) return null
  return {
    connectionId: row.connectionId,
    storeId: row.storeId,
    balanceEnabled: row.balanceEnabled,
    benefitEnabled: row.benefitEnabled,
    warnOnEmptyBalance: row.warnOnEmptyBalance,
    lowBalanceThreshold: row.lowBalanceThreshold,
    periodKind: row.periodKind as BenefitPeriodKindType,
    periodDays: row.periodDays,
    periodAnchor: row.periodAnchor,
    thresholdBps: row.thresholdBps,
    warnAtBps: row.warnAtBps,
    base: row.base as BenefitBaseType,
    returnStatuses: row.returnStatuses as ShipmentStatus[],
    refundRule: row.refundRule as BenefitRefundRuleType,
    lossRule: row.lossRule as BenefitLossRuleType,
    benefitSince: row.benefitSince
  }
}

export interface GuideBalanceSummary {
  // Guides left: every movement added
  balance: number
  // Every guide a purchase brought, gifts included, net of the purchases voided
  receivedGuides: number
  // What those purchases cost, VAT included, in cents
  paidCents: number
  // paid over received, half up; null before the first purchase
  averageCostCents: number | null
}

export async function guideBalanceOf(
  client: Reader,
  storeId: string,
  connectionId: string
): Promise<GuideBalanceSummary> {
  const [all, bought] = await Promise.all([
    client.carrierGuideMovement.aggregate({
      where: { storeId, connectionId },
      _sum: { guidesDelta: true }
    }),
    client.carrierGuideMovement.aggregate({
      where: {
        storeId,
        connectionId,
        kind: { in: [GuideMovementKind.PURCHASE, GuideMovementKind.VOID] }
      },
      _sum: { guidesDelta: true, costCentsDelta: true }
    })
  ])
  const receivedGuides = bought._sum.guidesDelta ?? 0
  const paidCents = bought._sum.costCentsDelta ?? 0
  return {
    balance: all._sum.guidesDelta ?? 0,
    receivedGuides,
    paidCents,
    averageCostCents: averageCostCents(paidCents, receivedGuides)
  }
}

// The events of the packages of a connection inside a period, one per package and kind, at the moment of the package's
// earliest event of the kind: that moment must fall inside the period for the package to count in it.
export async function loadBenefitEvents(
  client: Reader,
  policy: GuidePolicy,
  bounds: PeriodBounds
): Promise<BenefitEvent[]> {
  const baseStatuses =
    policy.base === BenefitBase.CREATED
      ? [ShipmentStatus.LABEL_CREATED]
      : policy.base === BenefitBase.DISPATCHED
        ? [...BenefitDispatchedStatuses]
        : [ShipmentStatus.DELIVERED]
  const read = async (statuses: ShipmentStatus[], kind: BenefitEvent['kind']) => {
    const rows = await client.shipmentEvent.groupBy({
      by: ['shipmentId'],
      where: {
        storeId: policy.storeId,
        status: { in: statuses },
        // What happened after the period is not read: the first event of a package must still fall inside it
        occurredAt: { lt: bounds.end },
        shipment: { connectionId: policy.connectionId, kind: ShipmentKind.OUTBOUND }
      },
      _min: { occurredAt: true },
      having: { occurredAt: { _min: { gte: bounds.start, lt: bounds.end } } }
    })
    return rows.flatMap(row =>
      row._min.occurredAt === null
        ? []
        : [{ shipmentId: row.shipmentId, at: row._min.occurredAt, kind }]
    )
  }
  const [base, returns] = await Promise.all([
    read(baseStatuses, 'base'),
    read(policy.returnStatuses, 'return')
  ])
  return [...base, ...returns]
}

export async function storeTimezone(client: Reader, storeId: string): Promise<string> {
  const store = await client.store.findUnique({
    where: { id: storeId },
    select: { timezone: true }
  })
  return store?.timezone ?? GuideZoneFallback
}

// The state of the period that holds an instant, as it stands now
export async function currentBenefit(
  client: Reader,
  policy: GuidePolicy,
  at: Date
): Promise<{ bounds: PeriodBounds; events: BenefitEvent[] }> {
  const natural = periodOf(policy, at, await storeTimezone(client, policy.storeId))
  // Nothing before the benefit was switched on (or its period changed) is judged, as at the daily close
  const bounds: PeriodBounds = {
    start: natural.start < policy.benefitSince ? policy.benefitSince : natural.start,
    end: natural.end
  }
  return { bounds, events: await loadBenefitEvents(client, policy, bounds) }
}

interface MovedShipment {
  shipmentId: string
  storeId: string
  connectionId: string
}

// Called by `ShipmentWrites.move` once the status and its history row are written, in the same transaction.
export async function applyGuideEffectsOfMove(
  tx: PrismaTransaction,
  events: DomainEvents,
  shipment: MovedShipment,
  to: ShipmentStatus,
  occurredAt: Date
): Promise<void> {
  const isCreated = to === ShipmentStatus.LABEL_CREATED
  const policy = await readGuidePolicy(tx, shipment.storeId, shipment.connectionId)
  if (policy === null) return
  try {
    if (isCreated && policy.balanceEnabled) {
      await consumeGuide(tx, events, policy, shipment)
      return
    }
    if (policy.benefitEnabled && policy.returnStatuses.includes(to)) {
      await judgeReturn(tx, events, policy, shipment, occurredAt)
    }
  } catch (error) {
    // A zone or an anchor the calendar cannot read (RangeError) must not stop the carrier's status from being applied: the
    // benefit of this move is skipped (the daily close fails on the same policy and says so in the worker's log). A database
    // error is not caught here, it aborts the transaction as it must
    if (!(error instanceof RangeError)) throw error
  }
}

async function consumeGuide(
  tx: PrismaTransaction,
  events: DomainEvents,
  policy: GuidePolicy,
  shipment: MovedShipment
): Promise<void> {
  // Only the guide an outbound shipment made: a return guide consumes nothing (TDD_17 §4.18)
  const row = await tx.shipment.findFirst({
    where: { id: shipment.shipmentId, storeId: shipment.storeId, kind: ShipmentKind.OUTBOUND },
    select: { id: true }
  })
  if (row === null) return
  // One taker at a time per connection until the transaction ends, so that the balance each one reads (and the alert it
  // raises) is the one the previous one left
  await lockStoreScope(
    tx,
    shipment.storeId,
    `${ShipmentLockScopes.GUIDE_BALANCE}:${shipment.connectionId}`
  )
  const before = await guideBalanceOf(tx, shipment.storeId, shipment.connectionId)
  const written = await tx.carrierGuideMovement.createMany({
    data: [
      {
        storeId: shipment.storeId,
        connectionId: shipment.connectionId,
        kind: GuideMovementKind.CONSUME,
        guidesDelta: -1,
        unitCostCents: before.averageCostCents,
        shipmentId: shipment.shipmentId,
        createdBy: SYSTEM
      }
    ],
    skipDuplicates: true
  })
  // This shipment already consumed its guide (a retried move): nothing moved, nothing to tell
  if (written.count === 0) return
  const level = balanceAlertOf({
    before: before.balance,
    after: before.balance - 1,
    lowBalanceThreshold: policy.lowBalanceThreshold,
    warnOnEmpty: policy.warnOnEmptyBalance
  })
  if (level === null) return
  events.publish(tx, Events.CARRIER_GUIDE_BALANCE_ALERT, {
    storeId: shipment.storeId,
    connectionId: shipment.connectionId,
    level,
    balance: before.balance - 1
  })
}

// A package of the connection went back: it counts in the period of its return, the team is told when that makes the state
// worse, and the guide is given back at once when the policy says so.
async function judgeReturn(
  tx: PrismaTransaction,
  events: DomainEvents,
  policy: GuidePolicy,
  shipment: MovedShipment,
  occurredAt: Date
): Promise<void> {
  const { bounds, events: periodEvents } = await currentBenefit(tx, policy, occurredAt)
  const after = evaluatePeriod(policy, periodEvents)
  // Only the first return event of a package changes the count (a package may pass `returning` and then `returned`)
  const returnEvents = await tx.shipmentEvent.count({
    where: {
      storeId: shipment.storeId,
      shipmentId: shipment.shipmentId,
      status: { in: policy.returnStatuses }
    }
  })
  if (returnEvents === 1) {
    const before = evaluatePeriod(
      policy,
      periodEvents.filter(
        event => !(event.kind === 'return' && event.shipmentId === shipment.shipmentId)
      )
    )
    const level = benefitAlertOf(before.state, after.state)
    // A late or replayed event of a period that already ended tells nobody: the period is history, not a warning
    if (level !== null && bounds.end > new Date()) {
      events.publish(tx, Events.CARRIER_BENEFIT_ALERT, {
        storeId: shipment.storeId,
        connectionId: shipment.connectionId,
        level,
        rateBps: after.rateBps,
        thresholdBps: policy.thresholdBps
      })
    }
  }
  if (
    policy.refundRule === BenefitRefundRule.IMMEDIATE &&
    policy.balanceEnabled &&
    after.refundable.has(shipment.shipmentId)
  ) {
    await refundGuides(tx, policy, [shipment.shipmentId])
  }
}

// One refund per shipment; a shipment already given back (or whose guide was never taken from the balance) writes nothing
async function refundGuides(
  tx: PrismaTransaction,
  policy: GuidePolicy,
  shipmentIds: readonly string[]
): Promise<number> {
  if (shipmentIds.length === 0) return 0
  // Only a guide that was taken from the balance is given back: with the balance switched on after the guide was made there
  // is nothing to return
  const consumed = await tx.carrierGuideMovement.findMany({
    where: {
      storeId: policy.storeId,
      connectionId: policy.connectionId,
      kind: GuideMovementKind.CONSUME,
      shipmentId: { in: [...shipmentIds] }
    },
    select: { shipmentId: true }
  })
  const owed = consumed.flatMap(row => (row.shipmentId === null ? [] : [row.shipmentId]))
  if (owed.length === 0) return 0
  const written = await tx.carrierGuideMovement.createMany({
    data: owed.map(shipmentId => ({
      storeId: policy.storeId,
      connectionId: policy.connectionId,
      kind: GuideMovementKind.REFUND,
      guidesDelta: 1,
      shipmentId,
      createdBy: SYSTEM
    })),
    skipDuplicates: true
  })
  return written.count
}

export interface ClosedPeriodResult {
  periodStart: Date
  refunded: number
}

// Judges, once each, the periods of a connection that ended since the last one it judged (at most MAX_PERIODS_PER_CLOSE a run):
// the numbers are kept as the history of the benefit and, for a policy that refunds at the close, the guides of the returns
// the loss rule still holds are given back. A period already judged is skipped by its unique row, so two runs never refund twice.
export async function closeBenefitPeriods(
  prisma: PrismaService,
  policy: GuidePolicy,
  now: Date
): Promise<ClosedPeriodResult[]> {
  if (!policy.benefitEnabled) return []
  const zone = await storeTimezone(prisma.client, policy.storeId)
  const last = await prisma.client.carrierBenefitPeriod.findFirst({
    where: { storeId: policy.storeId, connectionId: policy.connectionId },
    orderBy: { periodStart: 'desc' },
    select: { periodEnd: true }
  })
  // Judged from the later of the last closed period and the moment the benefit was switched on or its period changed: what
  // happened before is not judged retroactively and two periods never overlap
  const floor =
    last !== null && last.periodEnd > policy.benefitSince ? last.periodEnd : policy.benefitSince
  const first = periodOf(policy, floor, zone)
  let cursor: PeriodBounds = { start: first.start < floor ? floor : first.start, end: first.end }
  const closed: ClosedPeriodResult[] = []
  while (cursor.end <= now && closed.length < CarrierGuideLimits.MAX_PERIODS_PER_CLOSE) {
    const bounds = cursor
    const refunded = await prisma.transaction(async tx => {
      const events = await loadBenefitEvents(tx, policy, bounds)
      const result = evaluatePeriod(policy, events)
      const row = await tx.carrierBenefitPeriod.createMany({
        data: [
          {
            storeId: policy.storeId,
            connectionId: policy.connectionId,
            periodStart: bounds.start,
            periodEnd: bounds.end,
            baseCount: result.baseCount,
            returnCount: result.returnCount,
            rateBps: result.rateBps,
            state: result.state,
            refundedCount: 0
          }
        ],
        skipDuplicates: true
      })
      // Another run judged this period first
      if (row.count === 0) return 0
      if (policy.refundRule === BenefitRefundRule.IMMEDIATE) {
        // The guides were given back move by move: the history says how many
        const given = await tx.carrierGuideMovement.count({
          where: {
            storeId: policy.storeId,
            connectionId: policy.connectionId,
            kind: GuideMovementKind.REFUND,
            shipmentId: { in: [...result.refundable] }
          }
        })
        await tx.carrierBenefitPeriod.updateMany({
          where: {
            storeId: policy.storeId,
            connectionId: policy.connectionId,
            periodStart: bounds.start
          },
          data: { refundedCount: given }
        })
        return 0
      }
      if (!policy.balanceEnabled) return 0
      const count = await refundGuides(tx, policy, [...result.refundable])
      await tx.carrierBenefitPeriod.updateMany({
        where: {
          storeId: policy.storeId,
          connectionId: policy.connectionId,
          periodStart: bounds.start
        },
        data: { refundedCount: count }
      })
      return count
    })
    closed.push({ periodStart: bounds.start, refunded })
    cursor = periodOf(policy, bounds.end, zone)
  }
  return closed
}
