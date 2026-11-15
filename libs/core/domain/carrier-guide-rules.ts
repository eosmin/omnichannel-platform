import {
  BenefitAlertLevel,
  type BenefitAlertLevelType,
  type BenefitBaseType,
  BenefitLossRule,
  type BenefitLossRuleType,
  BenefitPeriodKind,
  type BenefitPeriodKindType,
  BenefitRefundRule,
  type BenefitRefundRuleType,
  BenefitState,
  type BenefitStateType,
  GuideBalanceAlertLevel,
  type GuideBalanceAlertLevelType
} from './carrier-guide-constants'

// The pure rules of the guide balance and of the refund benefit (TDD_17 §4.18). No database, no clock, no carrier: the callers
// read the data and the policy and these functions decide. Money is whole cents, rates are basis points, never a float.

const DAY_MS = 24 * 60 * 60 * 1000
const BPS = 10_000

// ----- the balance -----

// What one guide cost on average: everything paid over every guide received, gifts included, half up to a cent. Null while
// nothing was bought (no cost is invented).
export function averageCostCents(totalCostCents: number, totalGuides: number): number | null {
  if (!Number.isSafeInteger(totalCostCents) || !Number.isSafeInteger(totalGuides)) return null
  if (totalGuides <= 0 || totalCostCents < 0) return null
  return Math.floor((2 * totalCostCents + totalGuides) / (2 * totalGuides))
}

// The alert a move of the balance raises, if any: the balance crossing to zero or below (when the store wants to be told),
// else crossing down to the low-balance threshold. A balance that was already below is not told again.
export function balanceAlertOf(input: {
  before: number
  after: number
  lowBalanceThreshold: number | null
  warnOnEmpty: boolean
}): GuideBalanceAlertLevelType | null {
  const { before, after, lowBalanceThreshold, warnOnEmpty } = input
  if (after >= before) return null
  if (warnOnEmpty && before > 0 && after <= 0) return GuideBalanceAlertLevel.EMPTY
  if (
    lowBalanceThreshold !== null &&
    before > lowBalanceThreshold &&
    after <= lowBalanceThreshold
  ) {
    return GuideBalanceAlertLevel.LOW
  }
  return null
}

// ----- periods -----

export interface BenefitPeriodRules {
  periodKind: BenefitPeriodKindType
  periodDays: number
  // 'YYYY-MM-DD', a calendar day of the store's timezone: the first day of a period of fixed days
  periodAnchor: string
}

// A period is [start, end): the first instant of its first day to the first instant of the day after its last
export interface PeriodBounds {
  start: Date
  end: Date
}

interface CivilDate {
  year: number
  month: number
  day: number
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = dayFormatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    dayFormatters.set(timeZone, formatter)
  }
  return formatter
}

function partsOf(at: Date, timeZone: string): Record<string, number> {
  const parts: Record<string, number> = {}
  for (const part of formatterFor(timeZone).formatToParts(at)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value)
  }
  return parts
}

// The calendar day of an instant in a timezone
export function civilDateOf(at: Date, timeZone: string): CivilDate {
  const parts = partsOf(at, timeZone)
  return { year: parts['year'] ?? 1970, month: parts['month'] ?? 1, day: parts['day'] ?? 1 }
}

// How far the timezone is ahead of UTC at an instant, in milliseconds
function offsetMs(at: Date, timeZone: string): number {
  const parts = partsOf(at, timeZone)
  const asUtc = Date.UTC(
    parts['year'] ?? 1970,
    (parts['month'] ?? 1) - 1,
    parts['day'] ?? 1,
    parts['hour'] ?? 0,
    parts['minute'] ?? 0,
    parts['second'] ?? 0
  )
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

// The instant at which a calendar day starts in a timezone (the day may be shorter or longer than 24 hours)
export function startOfCivilDay(date: CivilDate, timeZone: string): Date {
  const naive = Date.UTC(date.year, date.month - 1, date.day)
  const first = naive - offsetMs(new Date(naive), timeZone)
  return new Date(naive - offsetMs(new Date(first), timeZone))
}

function dayNumber(date: CivilDate): number {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / DAY_MS)
}

function fromDayNumber(days: number): CivilDate {
  const at = new Date(days * DAY_MS)
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() }
}

export function parseCivilDate(text: string): CivilDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return null
  const date = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  }
  const back = fromDayNumber(dayNumber(date))
  return back.year === date.year && back.month === date.month && back.day === date.day ? date : null
}

// The period of a policy that holds an instant. A policy that is not valid is the caller's bug.
export function periodOf(rules: BenefitPeriodRules, at: Date, timeZone: string): PeriodBounds {
  const local = civilDateOf(at, timeZone)
  if (rules.periodKind === BenefitPeriodKind.CALENDAR_MONTH) {
    return {
      start: startOfCivilDay({ ...local, day: 1 }, timeZone),
      end: startOfCivilDay(nextMonth(local), timeZone)
    }
  }
  if (rules.periodKind === BenefitPeriodKind.CALENDAR_HALF_MONTH) {
    if (local.day <= 15) {
      return {
        start: startOfCivilDay({ ...local, day: 1 }, timeZone),
        end: startOfCivilDay({ ...local, day: 16 }, timeZone)
      }
    }
    return {
      start: startOfCivilDay({ ...local, day: 16 }, timeZone),
      end: startOfCivilDay(nextMonth(local), timeZone)
    }
  }
  const anchor = parseCivilDate(rules.periodAnchor)
  if (anchor === null || !Number.isSafeInteger(rules.periodDays) || rules.periodDays < 1) {
    throw new RangeError('Invalid benefit period')
  }
  const index = Math.floor((dayNumber(local) - dayNumber(anchor)) / rules.periodDays)
  const first = dayNumber(anchor) + index * rules.periodDays
  return {
    start: startOfCivilDay(fromDayNumber(first), timeZone),
    end: startOfCivilDay(fromDayNumber(first + rules.periodDays), timeZone)
  }
}

function nextMonth(date: CivilDate): CivilDate {
  return date.month === 12
    ? { year: date.year + 1, month: 1, day: 1 }
    : { year: date.year, month: date.month + 1, day: 1 }
}

// ----- the rate and the state of a period -----

export interface BenefitRules {
  thresholdBps: number
  warnAtBps: number
  base: BenefitBaseType
  refundRule: BenefitRefundRuleType
  lossRule: BenefitLossRuleType
}

// The percentage of returns in basis points, rounded down, for a screen. A period with nothing in its base has rate 0.
export function rateBps(returns: number, base: number): number {
  if (base <= 0 || returns <= 0) return 0
  return Math.floor((returns * BPS) / base)
}

// The state, by integer arithmetic (no rounding decides it): `lost` from the threshold up (the benefit holds only while the
// rate is strictly below it), `at_risk` from `warnAtBps` of the threshold, else `in_force`. No base, no returns to weigh.
export function benefitStateOf(
  returns: number,
  base: number,
  rules: Pick<BenefitRules, 'thresholdBps' | 'warnAtBps'>
): BenefitStateType {
  if (base <= 0 || returns <= 0) return BenefitState.IN_FORCE
  if (returns * BPS >= rules.thresholdBps * base) return BenefitState.LOST
  if (returns * BPS * BPS >= rules.thresholdBps * rules.warnAtBps * base)
    return BenefitState.AT_RISK
  return BenefitState.IN_FORCE
}

// What happened to a package of the connection inside the period, at the moment of its own event
export interface BenefitEvent {
  shipmentId: string
  at: Date
  kind: 'base' | 'return'
}

export interface PeriodEvaluation {
  baseCount: number
  returnCount: number
  rateBps: number
  state: BenefitStateType
  // The moment of the return that took the rate to the threshold (null if it never did)
  crossedAt: Date | null
  // The returned packages whose guide the policy gives back, as far as the events say. For `from_crossing` it is the returns
  // whose running rate, with themselves in, was under the threshold; for `from_close` every return when the final rate is
  // under it and none otherwise. A caller that refunds at the close asks only after the period ended.
  refundable: ReadonlySet<string>
}

// Walks the events of one period in order (a base event before a return at the same instant, so the day a package is
// delivered it already counts in the base) and says where the period stands.
export function evaluatePeriod(
  rules: BenefitRules,
  events: readonly BenefitEvent[]
): PeriodEvaluation {
  const ordered = [...events].sort((a, b) => {
    const delta = a.at.getTime() - b.at.getTime()
    if (delta !== 0) return delta
    if (a.kind === b.kind) return 0
    return a.kind === 'base' ? -1 : 1
  })
  let base = 0
  let returns = 0
  let crossedAt: Date | null = null
  const running: string[] = []
  const returned: string[] = []
  const seenReturn = new Set<string>()
  const seenBase = new Set<string>()
  for (const event of ordered) {
    if (event.kind === 'base') {
      // A package counts once in the base
      if (seenBase.has(event.shipmentId)) continue
      seenBase.add(event.shipmentId)
      base += 1
      continue
    }
    if (seenReturn.has(event.shipmentId)) continue
    seenReturn.add(event.shipmentId)
    returns += 1
    returned.push(event.shipmentId)
    if (benefitStateOf(returns, base, rules) === BenefitState.LOST) {
      crossedAt ??= event.at
    } else if (crossedAt === null) {
      running.push(event.shipmentId)
    }
  }
  const state = benefitStateOf(returns, base, rules)
  const refundable =
    rules.lossRule === BenefitLossRule.FROM_CLOSE
      ? state === BenefitState.LOST
        ? []
        : returned
      : running
  return {
    baseCount: base,
    returnCount: returns,
    rateBps: rateBps(returns, base),
    state,
    crossedAt,
    refundable: new Set(refundable)
  }
}

// Is a policy a combination that can be honored? `immediate` with `from_close` cannot: the closing rate of the period is not
// known when a return happens. Returns the problem, or null.
export function policyProblem(rules: Pick<BenefitRules, 'refundRule' | 'lossRule'>): string | null {
  if (
    rules.refundRule === BenefitRefundRule.IMMEDIATE &&
    rules.lossRule === BenefitLossRule.FROM_CLOSE
  ) {
    return 'an immediate refund cannot wait for the closing rate of the period'
  }
  return null
}

// The warning before crossing and the loss: the alert a change of state raises, if any (only a worse state is told)
export function benefitAlertOf(
  before: BenefitStateType,
  after: BenefitStateType
): BenefitAlertLevelType | null {
  if (before === after) return null
  if (after === BenefitState.LOST) return BenefitAlertLevel.LOST
  if (after === BenefitState.AT_RISK && before === BenefitState.IN_FORCE) {
    return BenefitAlertLevel.AT_RISK
  }
  return null
}
