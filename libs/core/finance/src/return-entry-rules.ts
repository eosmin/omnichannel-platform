import {
  AccountRole,
  FinancePostingFailureReason,
  PartyType,
  ReturnCostAgainst,
  ReturnSettlementKind
} from '@platform/core/domain'

import { type AutoEntry, linesOf, type RoleAccounts, type SaleOrderRow } from './auto-entry-rules'
import { allocateByWeight } from './tax-rules'

// The pure rules of the entries of a difference written off and of a return (TDD_18 §4.2, E7 and E8), Step 4B.6b-2. Like the other
// rules they take rows the service already loaded, in whole cents, and answer lines or the reason there are none: nothing here
// reads a table, picks an account number or invents a figure.
//
// [ACCOUNTANT]: the shipping fee of a returned order is NOT reversed (the order does not say whether it was given back), and an
// exchange credits the same account as a refund; both are choices of the accountant and are written in the plan.

// ---------------------------------------------------------------------------------------------------------------------------
// E7: the difference of a guide that did not match its remittance, written off by a person

export interface SettledLine {
  // What the carrier reported (the cash it remitted) and what it kept, for one confirmed remittance of the guide: together, what that
  // remittance cleared of the carrier's receivable (`settleRemittanceLine`)
  reportedCents: number
  keptCents: number
}

// What is still owed by the carrier for a guide: what it had to collect, less everything the confirmed remittances cleared. Positive is
// a shortfall (the carrier owes more), negative a surplus (it paid more than the guide was worth).
export function openReceivableCents(grossCents: number, settled: readonly SettledLine[]): number {
  const cleared = settled.reduce((sum, line) => sum + line.reportedCents + line.keptCents, 0)
  return grossCents - cleared
}

// A shortfall: Dr COD_DIFFERENCES · Cr RECEIVABLE_CARRIERS. A surplus is the other way round, so the receivable never ends below what
// the carrier really owes. Nothing open is nothing to write off.
export function writeOffLines(input: {
  accounts: RoleAccounts
  carrierConnectionId: string
  openCents: number
  storeId: string
}): AutoEntry {
  if (input.openCents === 0) return { ok: true, lines: [] }
  const cents = Math.abs(input.openCents)
  const receivable = {
    role: AccountRole.RECEIVABLE_CARRIERS,
    cents,
    party: { partyType: PartyType.CARRIER_CONNECTION, partyId: input.carrierConnectionId }
  }
  const difference = { role: AccountRole.COD_DIFFERENCES, cents }
  return input.openCents > 0
    ? linesOf(input.accounts, [difference], [receivable], { storeId: input.storeId })
    : linesOf(input.accounts, [receivable], [difference], { storeId: input.storeId })
}

// ---------------------------------------------------------------------------------------------------------------------------
// E8: what a return gives back of the sale

export interface ReturnableLine {
  orderItemId: string
  quantity: number
  unitPriceCents: number
  taxCents: number | null
}

export interface LineBasis {
  orderItemId: string
  // Units sold
  quantity: number
  // What the line brought in without its tax and after its share of the discount; and its tax
  netCents: number
  vatCents: number
}

export type LineBasesResult =
  { ok: true; lines: LineBasis[] } | { ok: false; reason: FinancePostingFailureReason }

// The revenue and the tax of each line of an order, split the way the sale split them (`saleAmounts`): the discount is shared in
// proportion to the gross of the lines, the tax is the one the line stored. An order that does not add up is refused, never forced.
export function lineBases(
  order: Omit<SaleOrderRow, 'lines'> & { lines: readonly ReturnableLine[] }
): LineBasesResult {
  const bad = (reason: FinancePostingFailureReason): LineBasesResult => ({ ok: false, reason })
  if (order.taxCents === null || order.pricesIncludeTax === null) {
    return bad(FinancePostingFailureReason.TAX_MISSING)
  }
  if (order.lines.some(line => line.taxCents === null)) {
    return bad(FinancePostingFailureReason.TAX_MISSING)
  }
  const gross = order.lines.map(line => line.quantity * line.unitPriceCents)
  if (gross.reduce((sum, cents) => sum + cents, 0) !== order.subtotalCents) {
    return bad(FinancePostingFailureReason.AMOUNTS_DISAGREE)
  }
  if (order.discountCents > order.subtotalCents) {
    return bad(FinancePostingFailureReason.AMOUNTS_DISAGREE)
  }
  const shares = allocateByWeight(order.discountCents, gross)
  const lines: LineBasis[] = []
  for (const [index, line] of order.lines.entries()) {
    const vatCents = line.taxCents ?? 0
    const base = (gross[index] ?? 0) - (shares[index] ?? 0)
    const netCents = order.pricesIncludeTax ? base - vatCents : base
    if (netCents < 0) return bad(FinancePostingFailureReason.AMOUNTS_DISAGREE)
    lines.push({ orderItemId: line.orderItemId, quantity: line.quantity, netCents, vatCents })
  }
  return { ok: true, lines }
}

// `cents` x part / whole, half up, in whole cents
function prorate(cents: number, part: number, whole: number): number {
  if (whole === 0 || part === 0 || cents === 0) return 0
  const numerator = BigInt(cents) * 2n * BigInt(part) + BigInt(whole)
  return Number(numerator / (2n * BigInt(whole)))
}

export interface ReturnReversal {
  netCents: number
  vatCents: number
}

export type ReturnReversalResult =
  { ok: true; reversal: ReturnReversal } | { ok: false; reason: FinancePostingFailureReason }

// What this return reverses: for each line, the share of its revenue and tax that the units back so far stand for, less the share the
// returns before this one already reversed. Working on the running total of units (not on each return) is what makes the parts add up
// to the sale to the cent once every unit is back, whatever the order or the size of the returns.
export function reversalOf(input: {
  bases: readonly LineBasis[]
  // Units back before this return, and in it, by order item
  before: ReadonlyMap<string, number>
  returned: ReadonlyMap<string, number>
}): ReturnReversalResult {
  // The total is the sum of the lines (`reversalLinesOf`, the one split of the books, which the credit note of Step 4B.7b also reads)
  const split = reversalLinesOf(input)
  if (!split.ok) return split
  return {
    ok: true,
    reversal: {
      netCents: split.lines.reduce((sum, line) => sum + line.netCents, 0),
      vatCents: split.lines.reduce((sum, line) => sum + line.vatCents, 0)
    }
  }
}

export interface ReversedLine {
  orderItemId: string
  // The units of this line that are back in this return
  quantity: number
  netCents: number
  vatCents: number
}

export type ReversedLinesResult =
  { ok: true; lines: ReversedLine[] } | { ok: false; reason: FinancePostingFailureReason }

// The same running-total split as `reversalOf`, kept line by line (the credit note of a return, Step 4B.7b, names each line). The lines come
// out in the order of `bases`, so two runs name them the same way, and the sum of the parts is what `reversalOf` gives for the same input.
export function reversalLinesOf(input: {
  bases: readonly LineBasis[]
  before: ReadonlyMap<string, number>
  returned: ReadonlyMap<string, number>
}): ReversedLinesResult {
  const lines: ReversedLine[] = []
  for (const basis of input.bases) {
    const back = input.returned.get(basis.orderItemId) ?? 0
    if (back === 0) continue
    const earlier = input.before.get(basis.orderItemId) ?? 0
    if (earlier + back > basis.quantity) {
      return { ok: false, reason: FinancePostingFailureReason.AMOUNTS_DISAGREE }
    }
    const upTo = (cents: number, units: number): number => prorate(cents, units, basis.quantity)
    lines.push({
      orderItemId: basis.orderItemId,
      quantity: back,
      netCents: upTo(basis.netCents, earlier + back) - upTo(basis.netCents, earlier),
      vatCents: upTo(basis.vatCents, earlier + back) - upTo(basis.vatCents, earlier)
    })
  }
  // A unit that is not on the order is refused, never ignored
  for (const orderItemId of input.returned.keys()) {
    if (!input.bases.some(basis => basis.orderItemId === orderItemId)) {
      return { ok: false, reason: FinancePostingFailureReason.AMOUNTS_DISAGREE }
    }
  }
  return { ok: true, lines }
}

export interface StockMove {
  productId: string
  variantId: string | null
  quantity: number
  // The cost the movement recorded; a unit that comes back (RETURN_IN) is stored with none, because the engine values it at the average
  // of the level without writing the figure on the row
  unitCostCents: number | null
}

export type RestockCostResult =
  { ok: true; costCents: number } | { ok: false; reason: FinancePostingFailureReason }

// What the units that came back cost: the cost their own movement recorded, else the cost the sale took them out at (the average of
// the ISSUE movements of that product and variant for the order). That is the figure that clears the cost of goods sold, so what E3
// took out and E8 puts back match to the cent. A unit with neither cannot be valued and is a failure, never a cost of zero.
export function restockCost(
  back: readonly StockMove[],
  issued: readonly StockMove[]
): RestockCostResult {
  let costCents = 0
  // The units with no cost of their own are valued by product and variant on their total, not move by move: rounding each move would
  // leave a cent of the cost of goods sold behind when a product comes back in several pieces
  const uncosted = new Map<string, { move: StockMove; quantity: number }>()
  for (const move of back) {
    if (move.unitCostCents !== null) {
      costCents += move.quantity * move.unitCostCents
      continue
    }
    const key = `${move.productId}:${move.variantId ?? ''}`
    uncosted.set(key, { move, quantity: (uncosted.get(key)?.quantity ?? 0) + move.quantity })
  }
  for (const { move, quantity } of uncosted.values()) {
    const same = issued.filter(
      row => row.productId === move.productId && row.variantId === move.variantId
    )
    const units = same.reduce((sum, row) => sum + row.quantity, 0)
    if (units === 0 || same.some(row => row.unitCostCents === null)) {
      return { ok: false, reason: FinancePostingFailureReason.COST_MISSING }
    }
    const total = same.reduce((sum, row) => sum + row.quantity * (row.unitCostCents ?? 0), 0)
    costCents += prorate(total, quantity, units)
  }
  return { ok: true, costCents }
}

// Where what the customer is owed goes: a COD guide whose carrier will never remit (void) is the carrier's debt cancelled; in every
// other case it is the customer's advance, the refund the business owes until a person pays it out (a transfer or an expense by hand,
// `finance:move_money`), so the books never invent a cash movement.
export type ReturnSettlement =
  | { kind: ReturnSettlementKind.ADVANCE }
  | { kind: ReturnSettlementKind.CARRIER; carrierConnectionId: string }

export function returnLines(input: {
  accounts: RoleAccounts
  // The revenue side, absent for a parcel that never became a sale
  reversal: ReturnReversal | null
  // The shipping fee of the order, reversed only when the carrier's receivable is cleared and the order is back in full: E3 debited that
  // receivable for the whole total, shipping included, and a guide that will never be remitted leaves nothing to collect for any of it
  shipping?: ReturnReversal | null
  settlement: ReturnSettlement
  // What the restocked units cost, at the cost the movements carry
  restockCostCents: number
  // Before the sale the cost went back from inventory in transit; after it, from the cost of goods sold
  costAgainst: ReturnCostAgainst
  storeId: string
}): AutoEntry {
  const { reversal, settlement } = input
  const net = reversal?.netCents ?? 0
  const shippingNet = input.shipping?.netCents ?? 0
  const vat = (reversal?.vatCents ?? 0) + (input.shipping?.vatCents ?? 0)
  const owed = net + shippingNet + vat
  const party =
    settlement.kind === ReturnSettlementKind.CARRIER
      ? { partyType: PartyType.CARRIER_CONNECTION, partyId: settlement.carrierConnectionId }
      : undefined
  const debits = [
    { role: AccountRole.SALES_RETURNS, cents: net },
    { role: AccountRole.SHIPPING_REVENUE, cents: shippingNet },
    { role: AccountRole.VAT_OUTPUT, cents: vat },
    { role: AccountRole.INVENTORY, cents: input.restockCostCents }
  ]
  const credits = [
    {
      role:
        settlement.kind === ReturnSettlementKind.CARRIER
          ? AccountRole.RECEIVABLE_CARRIERS
          : AccountRole.CUSTOMER_ADVANCES,
      cents: owed,
      ...(party === undefined ? {} : { party })
    },
    {
      role:
        input.costAgainst === ReturnCostAgainst.TRANSIT
          ? AccountRole.INVENTORY_IN_TRANSIT
          : AccountRole.COST_OF_GOODS_SOLD,
      cents: input.restockCostCents
    }
  ]
  return linesOf(input.accounts, debits, credits, { storeId: input.storeId })
}
