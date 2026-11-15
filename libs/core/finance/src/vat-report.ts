import { TaxTreatment, VatLineKind } from '@platform/core/domain'

import { allocateByWeight } from './tax-rules'

// The output side of the VAT report (TDD_18 §7), pure: what one order sold, by the kind of line and the rate it was taxed at, read
// from the snapshot the order keeps (never from today's rates). `baseCents` is what was sold without the tax, `taxCents` the tax, and
// the two add up to what the customer paid for it, so the report adds up to the orders of the period.

export interface ReportableOrder {
  readonly discountCents: number
  readonly shippingCents: number
  readonly taxCents: number
  readonly pricesIncludeTax: boolean
  readonly shippingTaxRateBps: number | null
  readonly items: readonly {
    readonly unitPriceCents: number
    readonly quantity: number
    readonly taxTreatment: string
    readonly taxRateBps: number | null
    readonly taxCents: number
  }[]
}

export interface VatOrderLine {
  readonly kind: VatLineKind
  readonly rateBps: number | null
  readonly baseCents: number
  readonly taxCents: number
}

// The lines of the report that one order makes, one per kind and rate. Null when the order's snapshot does not add up (the tax of its
// lines above the tax of the order), which the report counts and does not guess about.
export function vatLinesOfOrder(order: ReportableOrder): VatOrderLine[] | null {
  const grossOf = order.items.map(item => item.unitPriceCents * item.quantity)
  const shares = allocateByWeight(order.discountCents, grossOf)
  const buckets = new Map<
    string,
    { kind: VatLineKind; rateBps: number | null; base: number; tax: number }
  >()
  const add = (kind: VatLineKind, rateBps: number | null, base: number, tax: number): void => {
    const key = `${kind}:${rateBps ?? ''}`
    const found = buckets.get(key)
    if (found === undefined) buckets.set(key, { kind, rateBps, base, tax })
    else {
      found.base += base
      found.tax += tax
    }
  }
  let itemTax = 0
  for (const [index, item] of order.items.entries()) {
    const taxable = (grossOf[index] ?? 0) - (shares[index] ?? 0)
    const base = order.pricesIncludeTax ? taxable - item.taxCents : taxable
    itemTax += item.taxCents
    const kind =
      item.taxTreatment === (TaxTreatment.EXEMPT as string)
        ? VatLineKind.EXEMPT
        : item.taxTreatment === (TaxTreatment.NOT_SUBJECT as string)
          ? VatLineKind.NOT_SUBJECT
          : VatLineKind.TAXED
    add(kind, kind === VatLineKind.TAXED ? item.taxRateBps : null, base, item.taxCents)
  }
  // The shipping fee is not a line: what the order's tax has beyond its lines is the tax of the fee
  const shippingTax = order.taxCents - itemTax
  if (shippingTax < 0) return null
  if (order.shippingCents > 0) {
    const base = order.pricesIncludeTax ? order.shippingCents - shippingTax : order.shippingCents
    if (base < 0) return null
    add(
      order.shippingTaxRateBps === null ? VatLineKind.SHIPPING_NOT_TAXED : VatLineKind.TAXED,
      order.shippingTaxRateBps,
      base,
      shippingTax
    )
  } else if (shippingTax !== 0) {
    return null
  }
  return [...buckets.values()].map(bucket => ({
    kind: bucket.kind,
    rateBps: bucket.rateBps,
    baseCents: bucket.base,
    taxCents: bucket.tax
  }))
}
