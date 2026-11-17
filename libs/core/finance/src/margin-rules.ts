import { type SaleLineRow, saleAmounts, type SaleOrderRow } from './auto-entry-rules'
import { movementCostCents } from './movement-cost'
import { allocateByWeight } from './tax-rules'

// The pure rules of the margin by product (TDD_18 §10, Step 4B.8b-2). A margin is the revenue the order recorded less the cost the stock
// movements carried, in whole cents: the ledger is not recomputed here, it is the thing the totals are compared with. Nothing in this file
// reads a table or invents a figure; an order that does not add up is refused, never forced to.

export interface MarginOrderLine extends SaleLineRow {
  productId: string
}

export interface MarginOrder extends Omit<SaleOrderRow, 'lines'> {
  storeId: string
  lines: readonly MarginOrderLine[]
}

// What left the warehouse for the order, at the cost each movement carried (the ISSUE movements)
export interface MarginMovement {
  productId: string
  quantity: number
  unitCostCents: number | null
  // The value the movement took out of the stock: the cost the sale entry credits to inventory
  valueCents?: bigint | null
}

export interface MarginRow {
  storeId: string
  productId: string
  unitsSold: number
  // What the lines sold for after their share of the discount, without the tax: the figure the sale entry credits to the revenue account
  revenueCents: number
  // The cost of the units that left, at the cost the movements carried
  costCents: number
}

export type MarginOfOrder =
  | { ok: true; rows: MarginRow[]; revenueCents: number; costCents: number; unvaluedUnits: number }
  | { ok: false }

// The revenue of each line is what the sale entry credits for it: the line's price less its share of the discount, and less its tax when
// the prices carry it. The lines add up to the revenue of the sale entry exactly (`saleAmounts` checks the order first, so an order the
// books refused is refused here too). A movement with no cost is counted apart, never taken as free: the cost of its units is unknown.
export function marginOfOrder(
  order: MarginOrder,
  movements: readonly MarginMovement[]
): MarginOfOrder {
  const amounts = saleAmounts(order)
  if (!amounts.ok) return { ok: false }
  const gross = order.lines.map(line => line.quantity * line.unitPriceCents)
  const shares = allocateByWeight(order.discountCents, gross)
  const byProduct = new Map<string, MarginRow>()
  const row = (productId: string): MarginRow => {
    const found = byProduct.get(productId)
    if (found !== undefined) return found
    const created = {
      storeId: order.storeId,
      productId,
      unitsSold: 0,
      revenueCents: 0,
      costCents: 0
    }
    byProduct.set(productId, created)
    return created
  }
  order.lines.forEach((line, index) => {
    const base = (gross[index] ?? 0) - (shares[index] ?? 0)
    const tax = line.taxCents ?? 0
    const target = row(line.productId)
    target.unitsSold += line.quantity
    target.revenueCents += order.pricesIncludeTax === true ? base - tax : base
  })
  let costCents = 0
  let unvaluedUnits = 0
  for (const movement of movements) {
    if (movement.unitCostCents === null) {
      unvaluedUnits += movement.quantity
      continue
    }
    const cost = movementCostCents(movement.quantity, movement.unitCostCents, movement.valueCents)
    row(movement.productId).costCents += cost
    costCents += cost
  }
  return {
    ok: true,
    rows: [...byProduct.values()],
    revenueCents: amounts.amounts.revenueNetCents,
    costCents,
    unvaluedUnits
  }
}

// Adds the rows of one order to the rows of the report, by store and product
export function addMarginRows(into: Map<string, MarginRow>, rows: readonly MarginRow[]): void {
  for (const row of rows) {
    const key = `${row.storeId}:${row.productId}`
    const found = into.get(key)
    if (found === undefined) {
      into.set(key, { ...row })
      continue
    }
    found.unitsSold += row.unitsSold
    found.revenueCents += row.revenueCents
    found.costCents += row.costCents
  }
}

// The margin as a share of the revenue in basis points (2,550 is 25.50 %), rounded toward zero; null when nothing was sold for money, so
// a free item never shows a percentage that means nothing
export function marginBps(revenueCents: number, costCents: number): number | null {
  if (revenueCents <= 0) return null
  return Math.trunc(((revenueCents - costCents) * 10_000) / revenueCents)
}

export interface MarginReconciliation {
  // What the ledger says for the same sale entries (credit less debit of the revenue accounts, debit less credit of the cost accounts);
  // null when the organization has not mapped the role, so the report says so instead of comparing against zero
  ledgerRevenueCents: number | null
  ledgerCostCents: number | null
  // The report less the ledger; zero is the only value that reconciles, anything else is shown for a person to look at
  revenueDifferenceCents: number | null
  costDifferenceCents: number | null
}

export function reconcileMargin(
  reportRevenueCents: number,
  reportCostCents: number,
  ledgerRevenueCents: number | null,
  ledgerCostCents: number | null
): MarginReconciliation {
  return {
    ledgerRevenueCents,
    ledgerCostCents,
    revenueDifferenceCents:
      ledgerRevenueCents === null ? null : reportRevenueCents - ledgerRevenueCents,
    costDifferenceCents: ledgerCostCents === null ? null : reportCostCents - ledgerCostCents
  }
}
