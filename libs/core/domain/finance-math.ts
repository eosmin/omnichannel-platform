import { FinanceTaxLimits, TaxRounding } from './finance-constants'

// Pure rules the screens share with the books (TDD_18 §7): whole cents in, whole cents out, no float. They live here, and not in
// `@platform/core/finance`, because the web imports no other core library; `@platform/core/finance` re-exports them for the api.

const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

// A calendar date, not only a shape that looks like one (no 31 of February)
export function isIsoDate(value: string): boolean {
  if (!DATE.test(value)) return false
  const [year = 0, month = 0, day = 0] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

export const isRateBps = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= FinanceTaxLimits.MIN_RATE_BPS &&
  value <= FinanceTaxLimits.MAX_RATE_BPS

// numerator / denominator, both whole and non-negative, to a whole number by the rounding the books chose. Done on the
// quotient and the remainder, never on a float, so no amount of the range of an order can be off by a cent.
export function roundedQuotient(
  numerator: number,
  denominator: number,
  rounding: TaxRounding
): number {
  if (
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator) ||
    numerator < 0 ||
    denominator <= 0
  ) {
    throw new RangeError(
      'roundedQuotient takes a whole non-negative numerator and a positive denominator'
    )
  }
  // The remainder of whole numbers is exact, and so is the quotient taken from it: no float division decides a cent
  const remainder = numerator % denominator
  const quotient = (numerator - remainder) / denominator
  if (remainder === 0) return quotient
  switch (rounding) {
    case TaxRounding.DOWN:
      return quotient
    case TaxRounding.UP:
      return quotient + 1
    case TaxRounding.HALF_EVEN: {
      const twice = remainder * 2
      if (twice === denominator) return quotient % 2 === 0 ? quotient : quotient + 1
      return twice > denominator ? quotient + 1 : quotient
    }
    case TaxRounding.HALF_UP:
      return remainder * 2 >= denominator ? quotient + 1 : quotient
  }
}

// The tax inside an amount that already includes it (`tax = round(amount x rate / (10000 + rate))`), or on top of an amount
// that does not (`tax = round(amount x rate / 10000)`). A rate of zero is no tax.
export function taxOfAmount(input: {
  amountCents: number
  rateBps: number
  includesTax: boolean
  rounding: TaxRounding
}): number {
  const { amountCents, rateBps, includesTax, rounding } = input
  if (!isRateBps(rateBps)) throw new RangeError('the tax rate is not a rate in basis points')
  if (rateBps === 0 || amountCents === 0) return 0
  const denominator = includesTax
    ? FinanceTaxLimits.BPS_DENOMINATOR + rateBps
    : FinanceTaxLimits.BPS_DENOMINATOR
  return roundedQuotient(amountCents * rateBps, denominator, rounding)
}
