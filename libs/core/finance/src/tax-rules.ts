import { taxOfAmount, type TaxRounding, TaxTreatment } from '@platform/core/domain'

// The tax math of an order (TDD_18 §7), pure: whole cents in, whole cents out, no float anywhere. A rate is basis points (13 % is
// 1300). The tax of a line is computed on that line, after its share of the discount; the tax of the order is the sum of its
// lines (and of the shipping fee), so the order, the entry that books it and the fiscal document agree to the cent (§6.4).

// The rate check, the rounded quotient and the tax of an amount are pure and a screen needs them to show the tax before it is sent,
// so they live in `@platform/core/domain` (the web imports no other core library) and are re-exported here for the api.
export { isRateBps, roundedQuotient, taxOfAmount } from '@platform/core/domain'

// A whole amount shared in proportion to weights, by the largest remainder: the parts add up to the amount exactly, a tie goes
// to the earlier part, and the same input always gives the same parts. BigInt, because amount x weight passes 2^53 in range.
export function allocateByWeight(totalCents: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((acc, weight) => acc + BigInt(weight), 0n)
  if (totalCents === 0 || sum === 0n) return weights.map(() => 0)
  const total = BigInt(totalCents)
  const parts = weights.map(weight => (total * BigInt(weight)) / sum)
  const remainders = weights.map((weight, index) => ({
    index,
    remainder: (total * BigInt(weight)) % sum
  }))
  let left = Number(total - parts.reduce((acc, part) => acc + part, 0n))
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1
  )
  const shared = parts.map(part => Number(part))
  for (const { index } of remainders) {
    if (left === 0) break
    shared[index] = (shared[index] ?? 0) + 1
    left -= 1
  }
  return shared
}

export interface TaxableLine {
  readonly unitPriceCents: number
  readonly quantity: number
  readonly treatment: TaxTreatment
  // The rate of a taxed line; ignored for an exempt or not subject one
  readonly rateBps: number | null
}

export interface TaxInput {
  readonly lines: readonly TaxableLine[]
  readonly discountCents: number
  readonly shippingCents: number
  // The rate the shipping fee is taxed at, or null when the fee carries no tax (TDD_18 §7, [ACCOUNTANT])
  readonly shippingRateBps: number | null
  readonly includesTax: boolean
  readonly rounding: TaxRounding
}

export interface TaxedLine {
  // unit price x quantity, before the discount
  readonly grossCents: number
  // This line's share of the order's discount, in proportion to its gross amount
  readonly discountShareCents: number
  // What the tax is computed on: the gross amount less the share (it includes the tax when the prices do)
  readonly baseCents: number
  readonly taxCents: number
  // The base without the tax
  readonly netCents: number
}

export interface OrderTax {
  readonly lines: readonly TaxedLine[]
  readonly shippingTaxCents: number
  readonly shippingNetCents: number
  // The sum of the tax of the lines and of the shipping fee: what the order stores
  readonly taxCents: number
  // What the tax adds to the total the customer pays: zero when the prices include it, the whole tax when they do not
  readonly addedToTotalCents: number
}

export function computeOrderTax(input: TaxInput): OrderTax {
  const { discountCents, shippingCents, includesTax, rounding } = input
  if (!Number.isSafeInteger(discountCents) || discountCents < 0) {
    throw new RangeError('the discount is not a whole number of cents')
  }
  if (!Number.isSafeInteger(shippingCents) || shippingCents < 0) {
    throw new RangeError('the shipping fee is not a whole number of cents')
  }
  const gross = input.lines.map(line => {
    if (
      !Number.isSafeInteger(line.unitPriceCents) ||
      !Number.isSafeInteger(line.quantity) ||
      line.unitPriceCents < 0 ||
      line.quantity < 1
    ) {
      throw new RangeError('a line is not a whole price and a quantity')
    }
    return line.unitPriceCents * line.quantity
  })
  const subtotal = gross.reduce((acc, amount) => acc + amount, 0)
  if (discountCents > subtotal) throw new RangeError('the discount is above the subtotal')
  const shares = allocateByWeight(discountCents, gross)

  const lines = input.lines.map((line, index): TaxedLine => {
    const grossCents = gross[index] ?? 0
    const discountShareCents = shares[index] ?? 0
    const baseCents = grossCents - discountShareCents
    let taxCents = 0
    if (line.treatment === TaxTreatment.TAXED) {
      if (line.rateBps === null) throw new RangeError('a taxed line needs a rate')
      taxCents = taxOfAmount({
        amountCents: baseCents,
        rateBps: line.rateBps,
        includesTax,
        rounding
      })
    }
    return {
      grossCents,
      discountShareCents,
      baseCents,
      taxCents,
      netCents: includesTax ? baseCents - taxCents : baseCents
    }
  })

  const shippingTaxCents =
    input.shippingRateBps === null
      ? 0
      : taxOfAmount({
          amountCents: shippingCents,
          rateBps: input.shippingRateBps,
          includesTax,
          rounding
        })
  const taxCents = lines.reduce((acc, line) => acc + line.taxCents, shippingTaxCents)
  return {
    lines,
    shippingTaxCents,
    shippingNetCents: includesTax ? shippingCents - shippingTaxCents : shippingCents,
    taxCents,
    addedToTotalCents: includesTax ? 0 : taxCents
  }
}

// The rate and the treatment a line is taxed at, from the product and the organization's default: a taxed product takes its own
// rate, else the default; an exempt or not subject one takes none. A null rate for a taxed product means the organization has no
// default and the product names none: the caller refuses the order, it never guesses.
export function resolveLineTax(input: {
  treatment: TaxTreatment
  productRateBps: number | null
  defaultRateBps: number | null
}): { treatment: TaxTreatment; rateBps: number | null } {
  if (input.treatment !== TaxTreatment.TAXED) return { treatment: input.treatment, rateBps: null }
  return { treatment: input.treatment, rateBps: input.productRateBps ?? input.defaultRateBps }
}
