import {
  ExchangeCreditMode,
  FinancePostingFailureReason,
  TaxRounding,
  TaxTreatment
} from '@platform/core/domain'

import { computeOrderTax } from './tax-rules'

// The replacement of an exchange with a difference is a sale at the FULL price: the credit of the return it uses is consumed from the
// customer's advances and the customer pays only the difference (criterion of the accountant, kept in a private file). The order itself
// stores what the customer pays (the credit is its discount, so its total is the difference), and an order made before the mode existed was
// posted and documented that way, NET. So the figures of the sale are read through this one view:
//   - an order that is not `gross` is returned as it is, whatever its discount (its entries and its accepted documents never move);
//   - a `gross` order is returned with no discount and the tax of its lines and of its shipping fee at the full price, recomputed from what
//     the order stored (rate of each line, price mode, rounding, rate of the shipping fee), so no amount is kept twice.
// The books, the VAT report, the margin and the fiscal documents all read an order through it, so they cannot disagree.

export interface ExchangeLineRow {
  quantity: number
  unitPriceCents: number
  taxCents: number | null
  taxTreatment: string | null
  taxRateBps: number | null
}

export interface ExchangeOrderRow<L extends ExchangeLineRow = ExchangeLineRow> {
  // Order.exchangeCreditMode: null (and 'net') read the order as it was posted
  exchangeCreditMode: string | null
  subtotalCents: number
  shippingCents: number
  discountCents: number
  totalCents: number
  taxCents: number | null
  pricesIncludeTax: boolean | null
  taxRounding: string | null
  shippingTaxRateBps: number | null
  lines: readonly L[]
}

export type GrossViewResult<O> =
  | {
      ok: true
      // The order as the sale reads it
      order: O
      // What the sale takes from the customer's advances besides what the customer pays: the credit of the return. Zero for a net order.
      creditConsumedCents: number
    }
  | { ok: false; reason: FinancePostingFailureReason }

const isRounding = (value: string | null): value is TaxRounding =>
  Object.values<string>(TaxRounding).includes(value ?? '')

const isTreatment = (value: string | null): value is TaxTreatment =>
  Object.values<string>(TaxTreatment).includes(value ?? '')

export const isGrossExchange = (order: { exchangeCreditMode: string | null }): boolean =>
  order.exchangeCreditMode === (ExchangeCreditMode.GROSS as string)

export function grossExchangeView<L extends ExchangeLineRow, O extends ExchangeOrderRow<L>>(
  order: O
): GrossViewResult<O> {
  if (!isGrossExchange(order)) return { ok: true, order, creditConsumedCents: 0 }
  const bad = (reason: FinancePostingFailureReason): GrossViewResult<O> => ({ ok: false, reason })
  const gross = (
    taxCents: number | null,
    lineTax: readonly (number | null)[],
    addedCents: number
  ) =>
    ({
      ...order,
      discountCents: 0,
      taxCents,
      totalCents: order.subtotalCents + order.shippingCents + addedCents,
      lines: order.lines.map((line, index) => ({ ...line, taxCents: lineTax[index] ?? null }))
    }) as O
  // An order with no tax snapshot carries no tax: its sale is refused downstream (TAX_MISSING) as any order without one
  if (order.taxCents === null || order.pricesIncludeTax === null) {
    const view = gross(
      null,
      order.lines.map(() => null),
      0
    )
    return { ok: true, order: view, creditConsumedCents: order.discountCents }
  }
  if (!isRounding(order.taxRounding) || order.lines.some(line => !isTreatment(line.taxTreatment))) {
    return bad(FinancePostingFailureReason.TAX_MISSING)
  }
  const rounding = order.taxRounding
  const taxOf = (discountCents: number) => {
    try {
      return computeOrderTax({
        lines: order.lines.map(line => ({
          unitPriceCents: line.unitPriceCents,
          quantity: line.quantity,
          treatment: line.taxTreatment as TaxTreatment,
          rateBps: line.taxRateBps
        })),
        discountCents,
        shippingCents: order.shippingCents,
        shippingRateBps: order.shippingTaxRateBps,
        includesTax: order.pricesIncludeTax === true,
        rounding
      })
    } catch {
      return null
    }
  }
  // What the order stored must be what its own rule gives with the discount it has: otherwise the figures are not the ones the order made,
  // and nothing is forced from them
  const paid = taxOf(order.discountCents)
  if (
    paid === null ||
    paid.taxCents !== order.taxCents ||
    paid.lines.some((line, index) => line.taxCents !== order.lines[index]?.taxCents) ||
    order.subtotalCents - order.discountCents + order.shippingCents + paid.addedToTotalCents !==
      order.totalCents
  ) {
    return bad(FinancePostingFailureReason.AMOUNTS_DISAGREE)
  }
  const full = taxOf(0)
  if (full === null) return bad(FinancePostingFailureReason.AMOUNTS_DISAGREE)
  const view = gross(
    full.taxCents,
    full.lines.map(line => line.taxCents),
    full.addedToTotalCents
  )
  const creditConsumedCents = view.totalCents - order.totalCents
  if (creditConsumedCents < 0) return bad(FinancePostingFailureReason.AMOUNTS_DISAGREE)
  return { ok: true, order: view, creditConsumedCents }
}
