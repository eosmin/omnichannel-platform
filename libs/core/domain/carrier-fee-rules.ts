import { CarrierConnectionLimits } from './shipping-constants'

// What a carrier takes out of the cash it collects, as pure functions (TDD_17 §4.15): the commission is a percent of the amount
// collected that the owner agrees with the carrier, and the cost of the guide is a rate per service of the carrier. Percents are
// kept as integer basis points (4.5 % is 450) and money as integer cents, so no floating point ever touches an amount.

export const CarrierFeeLimits = {
  // A commission above half of what is collected is a typo, not an agreement
  MAX_COMMISSION_BPS: 5000,
  MAX_RATE_CENTS: CarrierConnectionLimits.MAX_FEE_CENTS,
  // The services a carrier can declare a rate for
  MAX_RATE_SERVICES: 20,
  RATE_CODE_PATTERN: /^[A-Za-z0-9_-]{1,32}$/
} as const

const BPS_PER_PERCENT = 100
const BPS_DENOMINATOR = 10_000

// The commission over an amount: whole cents, half up (the cents of the half go to the carrier, as its own system rounds)
export function commissionCents(amountCents: number, bps: number): number {
  return Math.floor((amountCents * bps + BPS_DENOMINATOR / 2) / BPS_DENOMINATOR)
}

const PERCENT_PATTERN = /^(\d{1,3})(?:[.,](\d{1,2}))?$/

// What a person types as a percent ("4.5" or "4,5"), as basis points. Null for anything that is not a plain non-negative
// number with at most two decimals: no sign, no exponent, no thousands separator
export function parsePercentToBps(text: string): number | null {
  const match = PERCENT_PATTERN.exec(text.trim())
  if (match === null) return null
  const whole = Number(match[1])
  const fraction = match[2] === undefined ? 0 : Number(match[2].padEnd(2, '0'))
  return whole * BPS_PER_PERCENT + fraction
}

// Basis points as the percent a person reads, without trailing zeros (450 is "4.5", 400 is "4")
export function formatBpsAsPercent(bps: number): string {
  const whole = Math.floor(bps / BPS_PER_PERCENT)
  const fraction = bps % BPS_PER_PERCENT
  if (fraction === 0) return String(whole)
  const digits = String(fraction).padStart(2, '0').replace(/0$/, '')
  return `${whole}.${digits}`
}

// What the shipment knows of what will be deducted: the cost the carrier reported when it made the guide, or else the rate of the
// connection for the service of the guide (kept when the guide was made, so a later edit of the rates never rewrites it), and
// the commission the connection had then
export interface FeeBasis {
  carrierCostCents: number | null
  carrierRateCents: number | null
  commissionBps: number | null
}

// What the carrier keeps out of `codAmountCents`: the cost of the guide plus the commission over the amount collected. Null when
// nothing is known, which is not the same as zero: the amount is then gross and the carrier's own figure is awaited
export function remittanceDeductionCents(codAmountCents: number, basis: FeeBasis): number | null {
  const cost = basis.carrierCostCents ?? basis.carrierRateCents
  if (cost === null && basis.commissionBps === null) return null
  return (cost ?? 0) + commissionCents(codAmountCents, basis.commissionBps ?? 0)
}

// The rate of a service in the table a connection keeps (read from the database, so nothing is trusted): a whole number of cents in
// range, or null when the service has none
export function rateCentsOf(rates: unknown, code: string | null): number | null {
  if (code === null || typeof rates !== 'object' || rates === null || Array.isArray(rates)) {
    return null
  }
  if (!Object.hasOwn(rates, code)) return null
  const cents = (rates as Record<string, unknown>)[code]
  return typeof cents === 'number' &&
    Number.isInteger(cents) &&
    cents >= 0 &&
    cents <= CarrierFeeLimits.MAX_RATE_CENTS
    ? cents
    : null
}

// What a carrier declares it can be given (the connect form is drawn from it)
export interface DeclaredFeeSettings {
  commission: boolean
  rateServices: readonly { code: string }[]
}

export interface FeeSettingsChange {
  commissionBps?: number | null
  serviceRatesCents?: Record<string, number> | null
}

// The first problem of a change to the commission or the rates of a connection, or null: a percent in range, only when the carrier
// takes one, and a rate only for a service the carrier declared
export function feeSettingsProblem(
  declared: DeclaredFeeSettings,
  change: FeeSettingsChange
): string | null {
  const { commissionBps, serviceRatesCents } = change
  if (commissionBps !== undefined && commissionBps !== null) {
    // 0 is "no commission", which is what a carrier that takes none already has
    if (!declared.commission && commissionBps !== 0) return 'the carrier takes no commission'
    if (
      !Number.isInteger(commissionBps) ||
      commissionBps < 0 ||
      commissionBps > CarrierFeeLimits.MAX_COMMISSION_BPS
    ) {
      return 'the commission is out of range'
    }
  }
  if (serviceRatesCents !== undefined && serviceRatesCents !== null) {
    const known = new Set(declared.rateServices.map(service => service.code))
    for (const [code, cents] of Object.entries(serviceRatesCents)) {
      if (!known.has(code)) return 'a rate is for a service the carrier does not have'
      if (!Number.isInteger(cents) || cents < 0 || cents > CarrierFeeLimits.MAX_RATE_CENTS) {
        return 'a rate is out of range'
      }
    }
  }
  return null
}
