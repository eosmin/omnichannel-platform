import type { PrismaService, PrismaTransaction } from '@platform/core/database'
import {
  CarrierChargeModel,
  BenefitBase,
  BenefitLossRule,
  BenefitPeriodKind,
  BenefitRefundRule,
  GuideMovementKind,
  ShipmentKind,
  ShipmentStatus
} from '@platform/core/domain'
import type { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'

import {
  applyGuideEffectsOfMove,
  closeBenefitPeriods,
  currentBenefit,
  type GuidePolicy,
  guideBalanceOf,
  loadBenefitEvents,
  readGuidePolicy
} from './guide-balance'

// The writes of the guide balance and of the benefit, against an in-memory stand-in of the few tables they touch (the same
// rules run against a real database in tests/api/carrier-guide-balance.spec.ts)

const STORE = 'store-1'
const CONNECTION = 'conn-1'
const DAY = 24 * 60 * 60 * 1000
// A closed month, far from the one the suite runs in
const T0 = Date.UTC(2026, 0, 1)

interface Movement {
  storeId: string
  connectionId: string
  kind: string
  guidesDelta: number
  costCentsDelta: number
  unitCostCents?: number | null
  onAdvance?: boolean
  shipmentId?: string | null
}
interface EventRow {
  shipmentId: string
  status: string
  occurredAt: Date
}
interface PeriodRow {
  storeId: string
  connectionId: string
  periodStart: Date
  periodEnd: Date
  refundedCount: number
  baseCount: number
  returnCount: number
  state: string
}

function policyRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    connectionId: CONNECTION,
    storeId: STORE,
    balanceEnabled: true,
    benefitEnabled: true,
    warnOnEmptyBalance: true,
    lowBalanceThreshold: null,
    periodKind: BenefitPeriodKind.CALENDAR_MONTH,
    periodDays: 15,
    periodAnchor: '2026-01-01',
    thresholdBps: 1000,
    warnAtBps: 8000,
    base: BenefitBase.DELIVERED,
    returnStatuses: [ShipmentStatus.RETURNED],
    refundRule: BenefitRefundRule.AT_PERIOD_CLOSE,
    lossRule: BenefitLossRule.FROM_CROSSING,
    benefitSince: new Date(T0),
    ...overrides
  }
}

function fakeDb(
  options: {
    policy?: ReturnType<typeof policyRow> | null
    timezone?: string | null
    chargeModel?: string
  } = {}
) {
  const state = {
    policy: options.policy === undefined ? policyRow() : options.policy,
    movements: [] as Movement[],
    events: [] as EventRow[],
    shipments: new Map<string, { kind: string; connectionId: string }>(),
    periods: [] as PeriodRow[],
    timezone: options.timezone === undefined ? 'UTC' : options.timezone,
    locks: 0
  }
  const sum = (rows: Movement[], key: 'guidesDelta' | 'costCentsDelta') =>
    rows.reduce((total, row) => total + row[key], 0)
  const db = {
    carrierGuidePolicy: {
      findFirst: () => Promise.resolve(state.policy)
    },
    carrierConnection: {
      findFirst: () => Promise.resolve({ chargeModel: options.chargeModel ?? 'invoiced' })
    },
    store: {
      findUnique: () =>
        Promise.resolve(state.timezone === null ? null : { timezone: state.timezone })
    },
    shipment: {
      findFirst: ({ where }: { where: { id: string; kind: string } }) => {
        const row = state.shipments.get(where.id)
        return Promise.resolve(
          row !== undefined && row.kind === where.kind ? { id: where.id } : null
        )
      }
    },
    carrierGuideMovement: {
      aggregate: ({ where }: { where: { kind?: { in: string[] } } }) => {
        const rows = state.movements.filter(
          row => where.kind === undefined || where.kind.in.includes(row.kind)
        )
        return Promise.resolve({
          _sum: {
            guidesDelta: sum(rows, 'guidesDelta'),
            costCentsDelta: sum(rows, 'costCentsDelta')
          }
        })
      },
      createMany: ({
        data
      }: {
        data: Array<Omit<Movement, 'costCentsDelta'> & { costCentsDelta?: number }>
      }) => {
        let count = 0
        for (const row of data) {
          const twin = state.movements.some(
            known =>
              known.shipmentId === row.shipmentId &&
              known.kind === row.kind &&
              row.shipmentId !== undefined &&
              (row.kind === GuideMovementKind.CONSUME || row.kind === GuideMovementKind.REFUND)
          )
          if (twin) continue
          state.movements.push({ ...row, costCentsDelta: row.costCentsDelta ?? 0 })
          count += 1
        }
        return Promise.resolve({ count })
      },
      findMany: ({ where }: { where: { kind: string; shipmentId: { in: string[] } } }) =>
        Promise.resolve(
          state.movements.filter(
            row =>
              row.kind === where.kind &&
              row.shipmentId !== undefined &&
              row.shipmentId !== null &&
              where.shipmentId.in.includes(row.shipmentId)
          )
        ),
      count: ({ where }: { where: { kind: string; shipmentId: { in: string[] } } }) =>
        Promise.resolve(
          state.movements.filter(
            row =>
              row.kind === where.kind &&
              row.shipmentId !== undefined &&
              row.shipmentId !== null &&
              where.shipmentId.in.includes(row.shipmentId)
          ).length
        )
    },
    shipmentEvent: {
      groupBy: ({
        where,
        having
      }: {
        where: {
          status: { in: string[] }
          occurredAt: { lt: Date }
          shipment: { connectionId: string; kind: string }
        }
        having: { occurredAt: { _min: { gte: Date; lt: Date } } }
      }) => {
        const firsts = new Map<string, Date>()
        for (const event of state.events) {
          const shipment = state.shipments.get(event.shipmentId)
          if (
            shipment === undefined ||
            shipment.connectionId !== where.shipment.connectionId ||
            shipment.kind !== where.shipment.kind ||
            !where.status.in.includes(event.status) ||
            event.occurredAt >= where.occurredAt.lt
          ) {
            continue
          }
          const known = firsts.get(event.shipmentId)
          if (known === undefined || event.occurredAt < known)
            firsts.set(event.shipmentId, event.occurredAt)
        }
        const range = having.occurredAt._min
        return Promise.resolve(
          [...firsts]
            .filter(([, at]) => at >= range.gte && at < range.lt)
            .map(([shipmentId, at]) => ({ shipmentId, _min: { occurredAt: at } }))
        )
      },
      count: ({ where }: { where: { shipmentId: string; status: { in: string[] } } }) =>
        Promise.resolve(
          state.events.filter(
            event => event.shipmentId === where.shipmentId && where.status.in.includes(event.status)
          ).length
        )
    },
    carrierBenefitPeriod: {
      findFirst: () =>
        Promise.resolve(
          [...state.periods].sort((a, b) => b.periodStart.getTime() - a.periodStart.getTime())[0] ??
            null
        ),
      createMany: ({ data }: { data: PeriodRow[] }) => {
        let count = 0
        for (const row of data) {
          if (
            state.periods.some(known => known.periodStart.getTime() === row.periodStart.getTime())
          )
            continue
          state.periods.push({ ...row })
          count += 1
        }
        return Promise.resolve({ count })
      },
      updateMany: ({
        where,
        data
      }: {
        where: { periodStart: Date }
        data: { refundedCount: number }
      }) => {
        for (const row of state.periods) {
          if (row.periodStart.getTime() === where.periodStart.getTime()) {
            row.refundedCount = data.refundedCount
          }
        }
        return Promise.resolve({ count: 1 })
      }
    },
    $queryRaw: () => {
      state.locks += 1
      return Promise.resolve([])
    },
    transaction: <T>(fn: (tx: PrismaTransaction) => Promise<T>) =>
      fn(db as unknown as PrismaTransaction)
  }
  const published: Array<{ name: string; payload: Record<string, unknown> }> = []
  const events = {
    publish: (_tx: unknown, name: string, payload: Record<string, unknown>) => {
      published.push({ name, payload })
    }
  } as unknown as DomainEvents
  return {
    state,
    published,
    events,
    tx: db as unknown as PrismaTransaction,
    prisma: { client: db, transaction: db.transaction } as unknown as PrismaService
  }
}

function ship(
  fake: ReturnType<typeof fakeDb>,
  id: string,
  kind: string = ShipmentKind.OUTBOUND
): string {
  fake.state.shipments.set(id, { kind, connectionId: CONNECTION })
  return id
}
function event(
  fake: ReturnType<typeof fakeDb>,
  shipmentId: string,
  status: ShipmentStatus,
  at: number
): void {
  fake.state.events.push({ shipmentId, status, occurredAt: new Date(at) })
}
const identity = (shipmentId: string) => ({ shipmentId, storeId: STORE, connectionId: CONNECTION })

describe('the policy and the balance', () => {
  it('reads no policy as none and a stored one as typed values', async () => {
    expect(await readGuidePolicy(fakeDb({ policy: null }).tx, STORE, CONNECTION)).toBeNull()
    const policy = await readGuidePolicy(fakeDb().tx, STORE, CONNECTION)
    expect(policy).toMatchObject({ thresholdBps: 1000, returnStatuses: [ShipmentStatus.RETURNED] })
  })

  it('sums the ledger and weighs the average cost over purchases and voids only', async () => {
    const fake = fakeDb()
    fake.state.movements.push(
      {
        storeId: STORE,
        connectionId: CONNECTION,
        kind: 'purchase',
        guidesDelta: 110,
        costCentsDelta: 8000
      },
      {
        storeId: STORE,
        connectionId: CONNECTION,
        kind: 'consume',
        guidesDelta: -1,
        costCentsDelta: 0
      }
    )
    expect(await guideBalanceOf(fake.tx, STORE, CONNECTION)).toEqual({
      balance: 109,
      receivedGuides: 110,
      paidCents: 8000,
      averageCostCents: 73
    })
    expect(await guideBalanceOf(fakeDb().tx, STORE, CONNECTION)).toMatchObject({
      balance: 0,
      averageCostCents: null
    })
  })
})

describe('the events of a period', () => {
  const bounds = { start: new Date(T0), end: new Date(T0 + 30 * DAY) }

  it.each([
    [BenefitBase.CREATED, ShipmentStatus.LABEL_CREATED],
    [BenefitBase.DISPATCHED, ShipmentStatus.IN_TRANSIT],
    [BenefitBase.DELIVERED, ShipmentStatus.DELIVERED]
  ])('reads the base %s from its own statuses', async (base, status) => {
    const fake = fakeDb({ policy: policyRow({ base }) })
    ship(fake, 'a')
    event(fake, 'a', status, T0 + DAY)
    event(fake, 'a', ShipmentStatus.RETURNED, T0 + 2 * DAY)
    const policy = (await readGuidePolicy(fake.tx, STORE, CONNECTION)) as GuidePolicy
    const events = await loadBenefitEvents(fake.tx, policy, bounds)
    expect(events.map(row => row.kind).sort()).toEqual(['base', 'return'])
  })

  it('counts a package where its first event of the kind fell, and not after the period', async () => {
    const fake = fakeDb()
    ship(fake, 'early')
    ship(fake, 'late')
    event(fake, 'early', ShipmentStatus.DELIVERED, T0 - DAY)
    event(fake, 'early', ShipmentStatus.DELIVERED, T0 + DAY)
    event(fake, 'late', ShipmentStatus.DELIVERED, T0 + 31 * DAY)
    const policy = (await readGuidePolicy(fake.tx, STORE, CONNECTION)) as GuidePolicy
    expect(await loadBenefitEvents(fake.tx, policy, bounds)).toEqual([])
  })

  it('takes the zone of the store, UTC when it names none, and clamps to the switch-on', async () => {
    const withZone = fakeDb({ timezone: 'America/El_Salvador' })
    const policy = (await readGuidePolicy(withZone.tx, STORE, CONNECTION)) as GuidePolicy
    const at = new Date(T0 + 10 * DAY)
    expect((await currentBenefit(withZone.tx, policy, at)).bounds.start.toISOString()).toBe(
      '2026-01-01T06:00:00.000Z'
    )
    const noStore = fakeDb({ timezone: null })
    const clamped = {
      ...((await readGuidePolicy(noStore.tx, STORE, CONNECTION)) as GuidePolicy),
      benefitSince: new Date(T0 + 5 * DAY)
    }
    expect((await currentBenefit(noStore.tx, clamped, at)).bounds.start.toISOString()).toBe(
      new Date(T0 + 5 * DAY).toISOString()
    )
  })
})

describe('the guide taken when a label is made', () => {
  async function made(fake: ReturnType<typeof fakeDb>, id: string, kind?: string) {
    ship(fake, id, kind)
    await applyGuideEffectsOfMove(
      fake.tx,
      fake.events,
      identity(id),
      ShipmentStatus.LABEL_CREATED,
      new Date(T0)
    )
  }

  it('does nothing without a policy, with the balance off, or for a return guide', async () => {
    const none = fakeDb({ policy: null })
    await made(none, 'a')
    expect(none.state.movements).toHaveLength(0)
    const off = fakeDb({ policy: policyRow({ balanceEnabled: false, benefitEnabled: false }) })
    await made(off, 'a')
    expect(off.state.movements).toHaveLength(0)
    const back = fakeDb()
    await made(back, 'a', ShipmentKind.RETURN)
    expect(back.state.movements).toHaveLength(0)
  })

  it('takes one guide under a lock, once, and keeps the average cost of that moment', async () => {
    const fake = fakeDb()
    fake.state.movements.push({
      storeId: STORE,
      connectionId: CONNECTION,
      kind: 'purchase',
      guidesDelta: 10,
      costCentsDelta: 1000
    })
    await made(fake, 'a')
    await made(fake, 'a')
    const consumed = fake.state.movements.filter(row => row.kind === GuideMovementKind.CONSUME)
    expect(consumed).toHaveLength(1)
    expect(consumed[0]?.unitCostCents).toBe(100)
    expect(fake.state.locks).toBe(2)
    expect(fake.published).toHaveLength(0)
  })

  it('writes on the movement whether the guide took its cost out of the advance, from how the connection charges when it was made (HC-101)', async () => {
    for (const [chargeModel, onAdvance] of [
      [CarrierChargeModel.PREPAID, true],
      [CarrierChargeModel.INVOICED, false],
      [CarrierChargeModel.REMITTANCE, false]
    ] as const) {
      const fake = fakeDb({ chargeModel })
      await made(fake, 'a')
      const consumed = fake.state.movements.filter(row => row.kind === GuideMovementKind.CONSUME)
      expect(consumed.map(row => row.onAdvance)).toEqual([onAdvance])
    }
  })

  it('says low and then empty when the balance gets there, and never refuses', async () => {
    const fake = fakeDb({ policy: policyRow({ lowBalanceThreshold: 2, benefitEnabled: false }) })
    fake.state.movements.push({
      storeId: STORE,
      connectionId: CONNECTION,
      kind: 'purchase',
      guidesDelta: 3,
      costCentsDelta: 300
    })
    await made(fake, 'a')
    await made(fake, 'b')
    await made(fake, 'c')
    await made(fake, 'd')
    expect(
      fake.published.map(row => [row.name, row.payload['level'], row.payload['balance']])
    ).toEqual([
      [Events.CARRIER_GUIDE_BALANCE_ALERT, 'low', 2],
      [Events.CARRIER_GUIDE_BALANCE_ALERT, 'empty', 0]
    ])
    expect(fake.state.movements.filter(row => row.kind === GuideMovementKind.CONSUME)).toHaveLength(
      4
    )
  })
})

describe('a package that goes back', () => {
  // 12 packages delivered in November, all made under the balance
  function withDelivered(fake: ReturnType<typeof fakeDb>, count = 12) {
    for (let index = 0; index < count; index += 1) {
      const id = ship(fake, `d${index}`)
      fake.state.movements.push({
        storeId: STORE,
        connectionId: CONNECTION,
        kind: 'consume',
        guidesDelta: -1,
        costCentsDelta: 0,
        shipmentId: id
      })
      event(fake, id, ShipmentStatus.DELIVERED, T0 + DAY + index)
    }
  }
  async function returned(fake: ReturnType<typeof fakeDb>, id: string, at: number) {
    ship(fake, id)
    fake.state.movements.push({
      storeId: STORE,
      connectionId: CONNECTION,
      kind: 'consume',
      guidesDelta: -1,
      costCentsDelta: 0,
      shipmentId: id
    })
    event(fake, id, ShipmentStatus.RETURNED, at)
    await applyGuideEffectsOfMove(
      fake.tx,
      fake.events,
      identity(id),
      ShipmentStatus.RETURNED,
      new Date(at)
    )
  }

  it('warns before the limit and on the loss, once each, only in the current period', async () => {
    const fake = fakeDb()
    withDelivered(fake)
    const now = Date.now()
    // a period far in the past tells nobody
    const old = fakeDb({ policy: policyRow({ benefitSince: new Date(T0 - 400 * DAY) }) })
    withDelivered(old)
    await returned(old, 'r', T0 + 2 * DAY)
    expect(old.published).toHaveLength(0)
    // the current month: build the same shape around now
    const live = fakeDb({ policy: policyRow({ benefitSince: new Date(now - 40 * DAY) }) })
    const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)
    for (let index = 0; index < 12; index += 1) {
      const id = ship(live, `d${index}`)
      event(live, id, ShipmentStatus.DELIVERED, monthStart + index)
    }
    await returned(live, 'r1', now)
    await returned(live, 'r2', now + 1)
    expect(live.published.map(row => row.payload['level'])).toEqual(['at_risk', 'lost'])
  })

  it('counts a second return event of a package once and does not warn again', async () => {
    const now = Date.now()
    const fake = fakeDb({
      policy: policyRow({
        benefitSince: new Date(now - 40 * DAY),
        returnStatuses: [ShipmentStatus.RETURNING, ShipmentStatus.RETURNED]
      })
    })
    const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1)
    for (let index = 0; index < 12; index += 1) {
      event(fake, ship(fake, `d${index}`), ShipmentStatus.DELIVERED, monthStart + index)
    }
    ship(fake, 'r')
    event(fake, 'r', ShipmentStatus.RETURNING, now)
    await applyGuideEffectsOfMove(
      fake.tx,
      fake.events,
      identity('r'),
      ShipmentStatus.RETURNING,
      new Date(now)
    )
    event(fake, 'r', ShipmentStatus.RETURNED, now + 1)
    await applyGuideEffectsOfMove(
      fake.tx,
      fake.events,
      identity('r'),
      ShipmentStatus.RETURNED,
      new Date(now + 1)
    )
    expect(fake.published).toHaveLength(1)
  })

  it('gives the guide back at once when the policy says so, and never twice', async () => {
    const fake = fakeDb({
      policy: policyRow({
        refundRule: BenefitRefundRule.IMMEDIATE,
        benefitSince: new Date(T0 - DAY)
      })
    })
    withDelivered(fake, 20)
    await returned(fake, 'r', T0 + 5 * DAY)
    await returned(fake, 'r', T0 + 5 * DAY)
    expect(fake.state.movements.filter(row => row.kind === GuideMovementKind.REFUND)).toHaveLength(
      1
    )
  })

  it('gives nothing back for a guide never taken from the balance, or with the balance off', async () => {
    const fake = fakeDb({
      policy: policyRow({
        refundRule: BenefitRefundRule.IMMEDIATE,
        benefitSince: new Date(T0 - DAY)
      })
    })
    withDelivered(fake, 20)
    ship(fake, 'x')
    event(fake, 'x', ShipmentStatus.RETURNED, T0 + 5 * DAY)
    await applyGuideEffectsOfMove(
      fake.tx,
      fake.events,
      identity('x'),
      ShipmentStatus.RETURNED,
      new Date(T0 + 5 * DAY)
    )
    expect(fake.state.movements.filter(row => row.kind === GuideMovementKind.REFUND)).toHaveLength(
      0
    )
    const off = fakeDb({
      policy: policyRow({
        refundRule: BenefitRefundRule.IMMEDIATE,
        balanceEnabled: false,
        benefitSince: new Date(T0 - DAY)
      })
    })
    withDelivered(off, 20)
    await returned(off, 'r', T0 + 5 * DAY)
    expect(off.state.movements.filter(row => row.kind === GuideMovementKind.REFUND)).toHaveLength(0)
  })

  it('skips the benefit of a move whose calendar cannot be read, and rethrows anything else', async () => {
    const badZone = fakeDb({ timezone: 'Not/AZone' })
    ship(badZone, 'r')
    event(badZone, 'r', ShipmentStatus.RETURNED, T0 + DAY)
    await expect(
      applyGuideEffectsOfMove(
        badZone.tx,
        badZone.events,
        identity('r'),
        ShipmentStatus.RETURNED,
        new Date(T0 + DAY)
      )
    ).resolves.toBeUndefined()
    const broken = fakeDb()
    ship(broken, 'r')
    ;(broken.tx as unknown as { store: { findUnique: () => Promise<never> } }).store.findUnique =
      () => Promise.reject(new TypeError('database down'))
    await expect(
      applyGuideEffectsOfMove(
        broken.tx,
        broken.events,
        identity('r'),
        ShipmentStatus.RETURNED,
        new Date(T0)
      )
    ).rejects.toThrow('database down')
  })

  it('ignores a status that is neither a made guide nor a return', async () => {
    const fake = fakeDb()
    ship(fake, 'a')
    await applyGuideEffectsOfMove(
      fake.tx,
      fake.events,
      identity('a'),
      ShipmentStatus.IN_TRANSIT,
      new Date(T0)
    )
    expect(fake.state.movements).toHaveLength(0)
    expect(fake.published).toHaveLength(0)
  })
})

describe('the daily close', () => {
  async function closeWith(
    fake: ReturnType<typeof fakeDb>,
    now: Date,
    overrides: Partial<GuidePolicy> = {}
  ) {
    const policy = {
      ...((await readGuidePolicy(fake.tx, STORE, CONNECTION)) as GuidePolicy),
      ...overrides
    }
    return closeBenefitPeriods(fake.prisma, policy, now)
  }
  // 12 delivered (one a day) and 2 returned in January, all taken from the balance
  function january(fake: ReturnType<typeof fakeDb>) {
    for (let index = 0; index < 14; index += 1) {
      const id = ship(fake, `s${index}`)
      fake.state.movements.push({
        storeId: STORE,
        connectionId: CONNECTION,
        kind: 'consume',
        guidesDelta: -1,
        costCentsDelta: 0,
        shipmentId: id
      })
      if (index < 12) event(fake, id, ShipmentStatus.DELIVERED, T0 + (1 + index) * DAY)
      else event(fake, id, ShipmentStatus.RETURNED, T0 + 20 * DAY + index * 1000)
    }
  }
  const afterJanuary = new Date(T0 + 40 * DAY)

  it('does nothing when the benefit is off', async () => {
    const fake = fakeDb({ policy: policyRow({ benefitEnabled: false }) })
    expect(await closeWith(fake, afterJanuary)).toEqual([])
  })

  it('refunds at the close what came back before the crossing, writes the history, and is idempotent', async () => {
    const fake = fakeDb()
    january(fake)
    const closed = await closeWith(fake, afterJanuary)
    expect(closed.length).toBeGreaterThan(0)
    const refunds = fake.state.movements.filter(row => row.kind === GuideMovementKind.REFUND)
    expect(refunds.map(row => row.shipmentId)).toEqual(['s12'])
    expect(fake.state.periods[0]).toMatchObject({
      baseCount: 12,
      returnCount: 2,
      state: 'lost',
      refundedCount: 1
    })
    await closeWith(fake, afterJanuary)
    expect(fake.state.movements.filter(row => row.kind === GuideMovementKind.REFUND)).toHaveLength(
      1
    )
  })

  it('keeps the period unjudged when another run judged it first', async () => {
    const fake = fakeDb()
    january(fake)
    fake.state.periods.push({
      storeId: STORE,
      connectionId: CONNECTION,
      periodStart: new Date(T0),
      periodEnd: new Date(T0),
      refundedCount: 0,
      baseCount: 0,
      returnCount: 0,
      state: 'in_force'
    })
    const closed = await closeWith(fake, afterJanuary)
    expect(closed.every(period => period.refunded === 0)).toBe(true)
    expect(fake.state.movements.filter(row => row.kind === GuideMovementKind.REFUND)).toHaveLength(
      0
    )
  })

  it('records the guides an immediate policy already gave back, and gives none itself', async () => {
    const fake = fakeDb({ policy: policyRow({ refundRule: BenefitRefundRule.IMMEDIATE }) })
    january(fake)
    fake.state.movements.push({
      storeId: STORE,
      connectionId: CONNECTION,
      kind: 'refund',
      guidesDelta: 1,
      costCentsDelta: 0,
      shipmentId: 's12'
    })
    await closeWith(fake, afterJanuary)
    expect(fake.state.movements.filter(row => row.kind === GuideMovementKind.REFUND)).toHaveLength(
      1
    )
    expect(fake.state.periods[0]?.refundedCount).toBe(1)
  })

  it('judges the period without refunding when the balance is not kept', async () => {
    const fake = fakeDb({ policy: policyRow({ balanceEnabled: false }) })
    january(fake)
    await closeWith(fake, afterJanuary)
    expect(fake.state.periods).toHaveLength(1)
    expect(fake.state.movements.filter(row => row.kind === GuideMovementKind.REFUND)).toHaveLength(
      0
    )
  })

  it('starts after the last judged period and after the switch-on, never overlapping', async () => {
    const fake = fakeDb({ policy: policyRow({ benefitSince: new Date(T0 + 3 * DAY) }) })
    january(fake)
    await closeWith(fake, afterJanuary)
    // the first period starts at the switch-on, not at the first of the month
    expect(fake.state.periods[0]?.periodStart.toISOString()).toBe(
      new Date(T0 + 3 * DAY).toISOString()
    )
    expect(fake.state.periods[0]?.baseCount).toBe(10)
    const again = await closeWith(fake, new Date(Date.UTC(2027, 3, 1)))
    // at most the periods of the cap, each once
    expect(again.length).toBeLessThanOrEqual(12)
    const starts = fake.state.periods.map(period => period.periodStart.getTime())
    expect(new Set(starts).size).toBe(starts.length)
  })
})
