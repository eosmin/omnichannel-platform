import type { PrismaTransaction } from '@platform/core/database'
import { TaxRounding, TaxTreatment } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { computeOrderTax, type TaxableLine } from '@platform/core/finance'
import { readFinancePreferences } from '@platform/core/store-preferences'

import { orderRefusal } from './orders.support'

// The tax of an order (TDD_18 §7, Step 4B.3b): what the organization's books say today, read when an order is made or priced again,
// and the snapshot of it that the order keeps. A later change of a rate, of the rounding or of the store's price mode never rewrites
// an order that exists: the order carries its own `taxCents`, `pricesIncludeTax` and the rate and tax of each line.

// What a price of this store is taxed by, today. Null: the organization has no books, and its orders carry no tax (as before).
export interface TaxContext {
  readonly rounding: TaxRounding
  // Whether the prices of the catalog include the tax (a store preference); an order that exists keeps the mode it was made in
  readonly includesTax: boolean
  readonly shippingTaxed: boolean
  // The rate of a taxed product that names none; null when the organization has no default rate
  readonly defaultRateBps: number | null
}

export async function loadTaxContext(
  tx: PrismaTransaction,
  storeId: string
): Promise<TaxContext | null> {
  const store = await tx.store.findUniqueOrThrow({
    where: { id: storeId },
    select: { organizationId: true, settings: { select: { preferences: true } } }
  })
  // A rate or a rounding changed at the very moment is either the old one or the new one: both are what the books said when the order
  // was made, and the order keeps the one it read (its snapshot)
  const [settings, rate] = await Promise.all([
    tx.financeSettings.findUnique({
      where: { organizationId: store.organizationId },
      select: { taxRounding: true, shippingTaxed: true }
    }),
    tx.taxRate.findFirst({
      where: { organizationId: store.organizationId, isDefault: true, active: true },
      select: { rateBps: true }
    })
  ])
  if (settings === null) return null
  return {
    rounding: settings.taxRounding as TaxRounding,
    includesTax: readFinancePreferences(store.settings?.preferences).pricesIncludeTax,
    shippingTaxed: settings.shippingTaxed,
    defaultRateBps: rate?.rateBps ?? null
  }
}

// The treatment and rate a line of an order is taxed at, from its product: a taxed product takes the rate it names, else the default
// of the organization; an exempt or not subject one takes none. A taxed product with no rate to take stops the order: it never guesses.
export function lineTaxOf(
  context: TaxContext | null,
  product: { taxTreatment: string; taxRate: { rateBps: number } | null }
): { taxTreatment: TaxTreatment | null; taxRateBps: number | null } {
  if (context === null) return { taxTreatment: null, taxRateBps: null }
  const treatment = product.taxTreatment as TaxTreatment
  if (treatment !== TaxTreatment.TAXED) return { taxTreatment: treatment, taxRateBps: null }
  const rateBps = product.taxRate?.rateBps ?? context.defaultRateBps
  if (rateBps === null) throw orderRefusal(ErrorCodes.FINANCE_TAX_RATE_NOT_CONFIGURED)
  return { taxTreatment: treatment, taxRateBps: rateBps }
}

// The rounding an order stored with its tax, read from its text column: a text that is no rounding (the database check keeps one out)
// is the same as none, and the order takes the rounding of the books of the day
export function storedRounding(value: string | null): TaxRounding | null {
  return Object.values<string>(TaxRounding).includes(value ?? '') ? (value as TaxRounding) : null
}

export interface LineTaxSnapshot {
  readonly taxTreatment: TaxTreatment
  readonly taxRateBps: number | null
  readonly taxCents: number
}

// What an order stores of its tax
export interface OrderTaxSnapshot {
  readonly taxCents: number
  readonly pricesIncludeTax: boolean
  // The rounding the tax was made with: the order keeps it, so that pricing it again never moves a tax that was quoted
  readonly taxRounding: TaxRounding
  // The rate the shipping fee was taxed at; null when it was not taxed
  readonly shippingTaxRateBps: number | null
  readonly lines: readonly LineTaxSnapshot[]
  // What the tax adds to the total the customer pays: zero when the prices include it
  readonly addedToTotalCents: number
}

// How an order is taxed now: the context, and what an order that exists fixes in it (the price mode, the rounding, and the rate of a
// shipping fee that did not change)
export interface TaxPlan {
  readonly rounding: TaxRounding
  readonly includesTax: boolean
  // null: the shipping fee carries no tax
  readonly shippingRateBps: number | null
  // The fee is to be taxed but the organization has no default rate to tax it at: a fee above zero stops the order
  readonly shippingNeedsRate: boolean
}

export function planTax(
  context: TaxContext | null,
  fixed?: {
    includesTax: boolean
    // null: an order made before the rounding was kept, which takes the one of the books today
    rounding: TaxRounding | null
    shippingRateBps: number | null | 'current'
  }
): TaxPlan | null {
  if (context === null) return null
  const current = context.shippingTaxed ? context.defaultRateBps : null
  const stored =
    fixed === undefined || fixed.shippingRateBps === 'current' ? undefined : fixed.shippingRateBps
  return {
    rounding: fixed?.rounding ?? context.rounding,
    includesTax: fixed?.includesTax ?? context.includesTax,
    shippingRateBps: stored === undefined ? current : stored,
    shippingNeedsRate:
      stored === undefined && context.shippingTaxed && context.defaultRateBps === null
  }
}

// The tax of an order from its lines, the discount and the fee. The lines must carry the treatment and rate they were given at their
// resolution (null on both for an order without a tax snapshot, which has no plan either). The caller has already checked the amounts.
export function snapshotTax(
  plan: TaxPlan,
  input: {
    lines: readonly {
      unitPriceCents: number
      quantity: number
      taxTreatment: TaxTreatment | null
      taxRateBps: number | null
    }[]
    discountCents: number
    shippingCents: number
  }
): OrderTaxSnapshot {
  const lines: TaxableLine[] = input.lines.map(line => {
    // A line with no treatment in an order that is taxed has no plan to follow (a partial write): refused, never guessed
    if (line.taxTreatment === null) throw orderRefusal(ErrorCodes.VALIDATION_FAILED)
    return {
      unitPriceCents: line.unitPriceCents,
      quantity: line.quantity,
      treatment: line.taxTreatment,
      rateBps: line.taxRateBps
    }
  })
  // A fee that must be taxed with no rate to tax it at stops the order, like a taxed product with none
  if (input.shippingCents > 0 && plan.shippingNeedsRate) {
    throw orderRefusal(ErrorCodes.FINANCE_TAX_RATE_NOT_CONFIGURED)
  }
  const tax = computeOrderTax({
    lines,
    discountCents: input.discountCents,
    shippingCents: input.shippingCents,
    shippingRateBps: plan.shippingRateBps,
    includesTax: plan.includesTax,
    rounding: plan.rounding
  })
  return {
    taxCents: tax.taxCents,
    pricesIncludeTax: plan.includesTax,
    taxRounding: plan.rounding,
    shippingTaxRateBps: input.shippingCents > 0 ? plan.shippingRateBps : null,
    lines: tax.lines.map((line, index) => ({
      taxTreatment: input.lines[index]?.taxTreatment as TaxTreatment,
      taxRateBps: input.lines[index]?.taxRateBps ?? null,
      taxCents: line.taxCents
    })),
    addedToTotalCents: tax.addedToTotalCents
  }
}

// The columns of the order that hold its tax: all four or none, and none when it carries no tax
export function taxColumnsOf(tax: OrderTaxSnapshot | null): {
  taxCents?: number
  pricesIncludeTax?: boolean
  taxRounding?: TaxRounding
  shippingTaxRateBps?: number | null
} {
  return tax === null
    ? {}
    : {
        taxCents: tax.taxCents,
        pricesIncludeTax: tax.pricesIncludeTax,
        taxRounding: tax.taxRounding,
        shippingTaxRateBps: tax.shippingTaxRateBps
      }
}
