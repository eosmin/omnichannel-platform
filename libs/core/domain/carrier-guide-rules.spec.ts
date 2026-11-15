import {
  BenefitBase,
  BenefitLossRule,
  BenefitPeriodKind,
  BenefitRefundRule,
  BenefitState
} from './carrier-guide-constants'
import {
  averageCostCents,
  balanceAlertOf,
  benefitAlertOf,
  type BenefitEvent,
  type BenefitRules,
  benefitStateOf,
  evaluatePeriod,
  parseCivilDate,
  periodOf,
  policyProblem,
  rateBps
} from './carrier-guide-rules'

const RULES: BenefitRules = {
  thresholdBps: 1000,
  warnAtBps: 8000,
  base: BenefitBase.DELIVERED,
  refundRule: BenefitRefundRule.AT_PERIOD_CLOSE,
  lossRule: BenefitLossRule.FROM_CROSSING
}

describe('averageCostCents', () => {
  it('is what was paid over every guide received, gifts included', () => {
    // buy 100 for 80.00 and receive 10 free: 8000 cents over 110 guides
    expect(averageCostCents(8000, 110)).toBe(73) // 72.7 rounds half up
    expect(averageCostCents(110, 110)).toBe(1)
  })
  it('rounds half up and has none before a purchase', () => {
    expect(averageCostCents(5, 2)).toBe(3)
    expect(averageCostCents(0, 0)).toBeNull()
    expect(averageCostCents(100, 0)).toBeNull()
    expect(averageCostCents(-1, 5)).toBeNull()
  })
  it('weighs two purchases at different prices', () => {
    // 100 guides for 8000 and 50 guides for 5000 (no gift): 13000 / 150
    expect(averageCostCents(8000 + 5000, 100 + 50)).toBe(87)
  })
})

describe('balanceAlertOf', () => {
  const quiet = { lowBalanceThreshold: null, warnOnEmpty: true }
  it('says empty when the balance reaches zero, once', () => {
    expect(balanceAlertOf({ before: 1, after: 0, ...quiet })).toBe('empty')
    expect(balanceAlertOf({ before: 0, after: -1, ...quiet })).toBeNull()
  })
  it('says low when it crosses down to the threshold, once', () => {
    const input = { lowBalanceThreshold: 10, warnOnEmpty: true }
    expect(balanceAlertOf({ before: 11, after: 10, ...input })).toBe('low')
    expect(balanceAlertOf({ before: 10, after: 9, ...input })).toBeNull()
  })
  it('does not tell a rise, and empty wins over low', () => {
    const input = { lowBalanceThreshold: 10, warnOnEmpty: true }
    expect(balanceAlertOf({ before: 3, after: 4, ...input })).toBeNull()
    expect(balanceAlertOf({ before: 1, after: 0, ...input })).toBe('empty')
  })
  it('keeps the low alert when the store does not want the empty one', () => {
    expect(
      balanceAlertOf({ before: 1, after: 0, lowBalanceThreshold: 5, warnOnEmpty: false })
    ).toBeNull()
    expect(
      balanceAlertOf({ before: 6, after: 5, lowBalanceThreshold: 5, warnOnEmpty: false })
    ).toBe('low')
  })
})

describe('periodOf', () => {
  const ZONE = 'America/El_Salvador' // UTC-6 all year
  it('cuts fixed days from the anchor, in the store day', () => {
    const rules = {
      periodKind: BenefitPeriodKind.FIXED_DAYS,
      periodDays: 15,
      periodAnchor: '2026-11-01'
    }
    const period = periodOf(rules, new Date('2026-11-20T10:00:00Z'), ZONE)
    expect(period.start.toISOString()).toBe('2026-11-16T06:00:00.000Z')
    expect(period.end.toISOString()).toBe('2026-12-01T06:00:00.000Z')
  })
  it('puts a moment of the first night of a day in the previous store day', () => {
    const rules = {
      periodKind: BenefitPeriodKind.FIXED_DAYS,
      periodDays: 15,
      periodAnchor: '2026-11-01'
    }
    // 03:00Z on the 16th is still the 15th at UTC-6
    const period = periodOf(rules, new Date('2026-11-16T03:00:00Z'), ZONE)
    expect(period.start.toISOString()).toBe('2026-11-01T06:00:00.000Z')
    expect(period.end.toISOString()).toBe('2026-11-16T06:00:00.000Z')
  })
  it('reaches back before the anchor', () => {
    const rules = {
      periodKind: BenefitPeriodKind.FIXED_DAYS,
      periodDays: 10,
      periodAnchor: '2026-11-11'
    }
    const period = periodOf(rules, new Date('2026-11-05T12:00:00Z'), 'UTC')
    expect(period.start.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(period.end.toISOString()).toBe('2026-11-11T00:00:00.000Z')
  })
  it('takes the calendar month and the half month', () => {
    const month = {
      periodKind: BenefitPeriodKind.CALENDAR_MONTH,
      periodDays: 15,
      periodAnchor: '2026-01-01'
    }
    const half = { ...month, periodKind: BenefitPeriodKind.CALENDAR_HALF_MONTH }
    const at = new Date('2026-12-20T12:00:00Z')
    expect(periodOf(month, at, 'UTC').start.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(periodOf(month, at, 'UTC').end.toISOString()).toBe('2027-01-01T00:00:00.000Z')
    expect(periodOf(half, at, 'UTC').start.toISOString()).toBe('2026-12-16T00:00:00.000Z')
    expect(periodOf(half, at, 'UTC').end.toISOString()).toBe('2027-01-01T00:00:00.000Z')
    const early = new Date('2026-12-15T23:59:59Z')
    expect(periodOf(half, early, 'UTC').start.toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(periodOf(half, early, 'UTC').end.toISOString()).toBe('2026-12-16T00:00:00.000Z')
  })
  it('follows a timezone that changes its offset', () => {
    const month = {
      periodKind: BenefitPeriodKind.CALENDAR_MONTH,
      periodDays: 15,
      periodAnchor: '2026-01-01'
    }
    const period = periodOf(month, new Date('2026-03-20T12:00:00Z'), 'America/New_York')
    expect(period.start.toISOString()).toBe('2026-03-01T05:00:00.000Z')
    expect(period.end.toISOString()).toBe('2026-04-01T04:00:00.000Z')
  })
  it('refuses an anchor that is not a day', () => {
    expect(parseCivilDate('2026-02-30')).toBeNull()
    expect(parseCivilDate('2026-2-3')).toBeNull()
    expect(() =>
      periodOf(
        { periodKind: BenefitPeriodKind.FIXED_DAYS, periodDays: 15, periodAnchor: 'nope' },
        new Date(),
        'UTC'
      )
    ).toThrow(RangeError)
  })
})

describe('rate and state', () => {
  it('has rate 0 with nothing in the base', () => {
    expect(rateBps(3, 0)).toBe(0)
    expect(benefitStateOf(3, 0, RULES)).toBe(BenefitState.IN_FORCE)
  })
  it('holds only strictly below the threshold, by integers', () => {
    // 10 % of 100 is exactly 10 returns: lost; 9 returns: still held (at risk from 8)
    expect(benefitStateOf(9, 100, RULES)).toBe(BenefitState.AT_RISK)
    expect(benefitStateOf(10, 100, RULES)).toBe(BenefitState.LOST)
    expect(benefitStateOf(7, 100, RULES)).toBe(BenefitState.IN_FORCE)
    expect(benefitStateOf(8, 100, RULES)).toBe(BenefitState.AT_RISK)
    expect(rateBps(9, 100)).toBe(900)
  })
  it('keeps a base of 3 honest: one return of 3 is 33 %', () => {
    expect(benefitStateOf(1, 3, RULES)).toBe(BenefitState.LOST)
  })
  it('follows another threshold and another warning share', () => {
    const rules = { ...RULES, thresholdBps: 500, warnAtBps: 5000 }
    expect(benefitStateOf(2, 100, rules)).toBe(BenefitState.IN_FORCE)
    expect(benefitStateOf(3, 100, rules)).toBe(BenefitState.AT_RISK)
    expect(benefitStateOf(5, 100, rules)).toBe(BenefitState.LOST)
  })
})

function base(shipmentId: string, minute: number): BenefitEvent {
  return { shipmentId, at: new Date(Date.UTC(2026, 10, 1, 0, minute)), kind: 'base' }
}
function ret(shipmentId: string, minute: number): BenefitEvent {
  return { shipmentId, at: new Date(Date.UTC(2026, 10, 1, 0, minute)), kind: 'return' }
}

describe('evaluatePeriod', () => {
  const bases = Array.from({ length: 20 }, (_, index) => base(`b${index}`, index))

  it('counts a package once in the base and once in the returns', () => {
    const result = evaluatePeriod(RULES, [base('a', 1), base('a', 2), ret('a', 3), ret('a', 4)])
    expect(result.baseCount).toBe(1)
    expect(result.returnCount).toBe(1)
  })

  it('refunds what came back before the rate reached the threshold (from the crossing)', () => {
    // 20 delivered, then returns: the second makes 2/20 = 10 % exactly, which is lost
    const result = evaluatePeriod(RULES, [...bases, ret('r1', 30), ret('r2', 31), ret('r3', 32)])
    expect(result.state).toBe(BenefitState.LOST)
    expect(result.crossedAt?.toISOString()).toBe(
      new Date(Date.UTC(2026, 10, 1, 0, 31)).toISOString()
    )
    expect([...result.refundable]).toEqual(['r1'])
  })

  it('judges the whole period by its final rate (from the close)', () => {
    const rules = { ...RULES, lossRule: BenefitLossRule.FROM_CLOSE }
    const lost = evaluatePeriod(rules, [...bases, ret('r1', 30), ret('r2', 31)])
    expect(lost.refundable.size).toBe(0)
    const held = evaluatePeriod(rules, [...bases, ret('r1', 30)])
    expect([...held.refundable]).toEqual(['r1'])
    expect(held.state).toBe(BenefitState.IN_FORCE)
  })

  it('counts the base that arrives at the same instant before the return', () => {
    const at = new Date('2026-11-01T00:00:00Z')
    const result = evaluatePeriod(RULES, [
      { shipmentId: 'r', at, kind: 'return' },
      { shipmentId: 'b', at, kind: 'base' },
      ...Array.from({ length: 19 }, (_, index) => ({
        shipmentId: `x${index}`,
        at: new Date(Date.UTC(2026, 9, 31, 0, index)),
        kind: 'base' as const
      }))
    ])
    // 20 in the base when the return is read: 1/20 is 5 %, still held
    expect(result.refundable.has('r')).toBe(true)
  })

  it('a period with returns and no base keeps the benefit', () => {
    const result = evaluatePeriod(RULES, [ret('r', 1)])
    expect(result.state).toBe(BenefitState.IN_FORCE)
    expect(result.refundable.has('r')).toBe(true)
  })

  it('is empty with no events', () => {
    const result = evaluatePeriod(RULES, [])
    expect(result).toMatchObject({ baseCount: 0, returnCount: 0, rateBps: 0, crossedAt: null })
  })
})

describe('benefitAlertOf', () => {
  it('tells only a state that got worse', () => {
    expect(benefitAlertOf(BenefitState.IN_FORCE, BenefitState.AT_RISK)).toBe('at_risk')
    expect(benefitAlertOf(BenefitState.AT_RISK, BenefitState.LOST)).toBe('lost')
    expect(benefitAlertOf(BenefitState.IN_FORCE, BenefitState.LOST)).toBe('lost')
    expect(benefitAlertOf(BenefitState.LOST, BenefitState.AT_RISK)).toBeNull()
    expect(benefitAlertOf(BenefitState.AT_RISK, BenefitState.AT_RISK)).toBeNull()
    expect(benefitAlertOf(BenefitState.AT_RISK, BenefitState.IN_FORCE)).toBeNull()
  })
})

describe('policyProblem', () => {
  it('refuses an immediate refund that waits for the closing rate', () => {
    expect(
      policyProblem({
        refundRule: BenefitRefundRule.IMMEDIATE,
        lossRule: BenefitLossRule.FROM_CLOSE
      })
    ).not.toBeNull()
    expect(
      policyProblem({
        refundRule: BenefitRefundRule.IMMEDIATE,
        lossRule: BenefitLossRule.FROM_CROSSING
      })
    ).toBeNull()
    expect(policyProblem(RULES)).toBeNull()
  })
})
