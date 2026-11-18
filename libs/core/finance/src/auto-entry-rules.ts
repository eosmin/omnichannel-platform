import {
  AccountRole,
  FinancePostingFailureReason,
  InventoryAdjustmentReason,
  InventoryMovementType,
  PartyType
} from '@platform/core/domain'

import type { DraftLine } from './entry-rules'
import { movementCostCents } from './movement-cost'
import { allocateByWeight } from './tax-rules'

// The pure rules of the automatic entries (TDD_18 §4.2, E1 to E3 and E9), Step 4B.6a. They take rows the service already
// loaded, in cents, and answer lines or the reason there are none: nothing here reads a table, picks an account number or
// invents a figure. Accounts come by ROLE from the organization's mapping (the accountant's chart), so no account is built in.

// How the service tells the rules which account a role is: a null answer is a missing mapping, which the rules turn into a
// visible failure instead of guessing
export type RoleAccounts = (role: AccountRole) => string | null

export type AutoLinesResult =
  | { ok: true; lines: DraftLine[] }
  | {
      ok: false
      reason: FinancePostingFailureReason
      // The role that had no account, for the person who fixes the mapping
      role?: AccountRole
    }

// `ok` with no lines is "nothing to post" (an order of zero total with no cost), which is not a failure
export type AutoEntry = AutoLinesResult

export const missing = (role: AccountRole): AutoLinesResult => ({
  ok: false,
  reason: FinancePostingFailureReason.ROLE_NOT_MAPPED,
  role
})

export interface Side {
  role: AccountRole
  cents: number
  // The subledger party of the line (a carrier connection), when the account is one
  party?: { partyType: PartyType; partyId: string }
}

// Debit and credit sides by role, zero amounts dropped (a free shipping fee has no line), one dimension on every line
export function linesOf(
  accounts: RoleAccounts,
  debits: readonly Side[],
  credits: readonly Side[],
  dimension: { storeId: string }
): AutoLinesResult {
  const lines: DraftLine[] = []
  for (const [side, entries] of [
    ['debit', debits],
    ['credit', credits]
  ] as const) {
    for (const entry of entries) {
      if (entry.cents === 0) continue
      const accountId = accounts(entry.role)
      if (accountId === null) return missing(entry.role)
      lines.push({
        accountId,
        debitCents: side === 'debit' ? entry.cents : 0,
        creditCents: side === 'credit' ? entry.cents : 0,
        storeId: dimension.storeId,
        ...(entry.party === undefined ? {} : entry.party)
      })
    }
  }
  return { ok: true, lines }
}

// ---------------------------------------------------------------------------------------------------------------------------
// The money of a sale (E3): what the order says it took, split into revenue, shipping and tax

export interface SaleLineRow {
  quantity: number
  unitPriceCents: number
  // The tax of the line, after its share of the discount (OrderItem.taxCents); null on an order made before the tax columns
  taxCents: number | null
}

export interface SaleOrderRow {
  subtotalCents: number
  shippingCents: number
  discountCents: number
  totalCents: number
  // Order.taxCents and Order.pricesIncludeTax: null on an order made before the tax columns
  taxCents: number | null
  pricesIncludeTax: boolean | null
  lines: readonly SaleLineRow[]
}

export interface SaleAmounts {
  // What the lines sold for after their share of the discount, without the tax
  revenueNetCents: number
  shippingNetCents: number
  vatCents: number
  // What the customer owes for the order: always equal to the order's total
  totalCents: number
}

export type SaleAmountsResult =
  { ok: true; amounts: SaleAmounts } | { ok: false; reason: FinancePostingFailureReason }

// The split of an order's total, from the figures the order stored when it was made (TDD_18 §7). The discount is taken out of
// the revenue (revenue is net of it) so every cent is one the order recorded: showing the discount apart would need the net of the
// discount, which the order does not store, and the figure would be computed here, not read (debt in the plan, [ACCOUNTANT]).
// The result is checked against the order's total, and an order that does not add up is refused, never forced to.
export function saleAmounts(order: SaleOrderRow): SaleAmountsResult {
  const bad = (reason: FinancePostingFailureReason): SaleAmountsResult => ({ ok: false, reason })
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
  let revenueNet = 0
  let lineTax = 0
  let negativeLine = false
  gross.forEach((cents, index) => {
    const tax = order.lines[index]?.taxCents ?? 0
    const base = cents - (shares[index] ?? 0)
    const lineNet = order.pricesIncludeTax ? base - tax : base
    // Each line alone: a sale with a line below zero is refused like the return of it is (HC-203), the total would hide it
    if (lineNet < 0) negativeLine = true
    revenueNet += lineNet
    lineTax += tax
  })
  if (negativeLine) return bad(FinancePostingFailureReason.AMOUNTS_DISAGREE)
  // The order's tax is the tax of its lines plus the tax of the shipping fee
  const shippingTax = order.taxCents - lineTax
  if (shippingTax < 0 || shippingTax > order.shippingCents) {
    return bad(FinancePostingFailureReason.AMOUNTS_DISAGREE)
  }
  const shippingNet = order.pricesIncludeTax
    ? order.shippingCents - shippingTax
    : order.shippingCents
  const amounts: SaleAmounts = {
    revenueNetCents: revenueNet,
    shippingNetCents: shippingNet,
    vatCents: order.taxCents,
    totalCents: revenueNet + shippingNet + order.taxCents
  }
  if (amounts.totalCents !== order.totalCents || revenueNet < 0 || shippingNet < 0) {
    return bad(FinancePostingFailureReason.AMOUNTS_DISAGREE)
  }
  return { ok: true, amounts }
}

// ---------------------------------------------------------------------------------------------------------------------------
// The cost of what left the warehouse: the movements carry the cost, the books never recompute it (TDD_18 §4.2)

export interface IssueMovementRow {
  quantity: number
  unitCostCents: number | null
  // The value the movement took out of the stock: what the books credit to inventory, so that the two agree to the cent
  valueCents?: bigint | null
}

export type CostResult =
  { ok: true; costCents: number } | { ok: false; reason: FinancePostingFailureReason }

// The value each movement took out of the stock, summed (a movement written before the value was recorded: units x the cost one unit carried). A movement that left with no cost (nothing on hand to average) cannot be valued
// and is a failure: a cost of zero would hide a gap in the books. No movement at all is a cost of zero (a service, or a product
// whose stock is not tracked).
export function issueCost(movements: readonly IssueMovementRow[]): CostResult {
  let costCents = 0
  for (const movement of movements) {
    if (movement.unitCostCents === null) {
      return { ok: false, reason: FinancePostingFailureReason.COST_MISSING }
    }
    costCents += movementCostCents(movement.quantity, movement.unitCostCents, movement.valueCents)
  }
  return { ok: true, costCents }
}

// ---------------------------------------------------------------------------------------------------------------------------
// E1: an order paid before delivery. The money lands in the account of the payment method; it is the customer's advance until the
// sale is recognized.

export function orderPaymentLines(input: {
  accounts: RoleAccounts
  // The account the payment method receives into (PaymentMethodAccount), resolved by the service
  paymentAccountId: string
  totalCents: number
  storeId: string
}): AutoEntry {
  if (input.totalCents === 0) return { ok: true, lines: [] }
  const advances = input.accounts(AccountRole.CUSTOMER_ADVANCES)
  if (advances === null) return missing(AccountRole.CUSTOMER_ADVANCES)
  return {
    ok: true,
    lines: [
      {
        accountId: input.paymentAccountId,
        debitCents: input.totalCents,
        creditCents: 0,
        storeId: input.storeId
      },
      { accountId: advances, debitCents: 0, creditCents: input.totalCents, storeId: input.storeId }
    ]
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// E2: the goods leave the warehouse: from inventory to inventory in transit, at the cost the movements carry

export function sentLines(input: {
  accounts: RoleAccounts
  costCents: number
  storeId: string
}): AutoEntry {
  if (input.costCents === 0) return { ok: true, lines: [] }
  return linesOf(
    input.accounts,
    [{ role: AccountRole.INVENTORY_IN_TRANSIT, cents: input.costCents }],
    [{ role: AccountRole.INVENTORY, cents: input.costCents }],
    { storeId: input.storeId }
  )
}

// ---------------------------------------------------------------------------------------------------------------------------
// E3: the sale is recognized. The debit is by how it is collected: a cash on delivery order is the carrier's debt (a party line);
// an order already paid clears the customer's advance (E1). The cost then leaves inventory in transit when E2 happened, else
// inventory itself (a sale recognized at shipping, or one with no E2).

export type SaleCollection = { kind: 'carrier'; carrierConnectionId: string } | { kind: 'advance' }

export function saleLines(input: {
  accounts: RoleAccounts
  amounts: SaleAmounts
  collection: SaleCollection
  costCents: number
  // Whether the cost is held in inventory in transit (an entry of E2 exists) or still in inventory
  costFromTransit: boolean
  storeId: string
}): AutoEntry {
  const { amounts, collection, storeId } = input
  const lines: DraftLine[] = []
  const add = (
    role: AccountRole,
    side: 'debit' | 'credit',
    cents: number,
    party?: string
  ): AutoLinesResult | null => {
    if (cents === 0) return null
    const accountId = input.accounts(role)
    if (accountId === null) return missing(role)
    lines.push({
      accountId,
      debitCents: side === 'debit' ? cents : 0,
      creditCents: side === 'credit' ? cents : 0,
      storeId,
      ...(party === undefined ? {} : { partyType: PartyType.CARRIER_CONNECTION, partyId: party })
    })
    return null
  }
  const steps: (AutoLinesResult | null)[] = [
    collection.kind === 'carrier'
      ? add(
          AccountRole.RECEIVABLE_CARRIERS,
          'debit',
          amounts.totalCents,
          collection.carrierConnectionId
        )
      : add(AccountRole.CUSTOMER_ADVANCES, 'debit', amounts.totalCents),
    add(AccountRole.SALES_REVENUE, 'credit', amounts.revenueNetCents),
    add(AccountRole.SHIPPING_REVENUE, 'credit', amounts.shippingNetCents),
    add(AccountRole.VAT_OUTPUT, 'credit', amounts.vatCents),
    add(AccountRole.COST_OF_GOODS_SOLD, 'debit', input.costCents),
    add(
      input.costFromTransit ? AccountRole.INVENTORY_IN_TRANSIT : AccountRole.INVENTORY,
      'credit',
      input.costCents
    )
  ]
  for (const step of steps) if (step !== null) return step
  return { ok: true, lines }
}

// ---------------------------------------------------------------------------------------------------------------------------
// E9: a stock adjustment or a count variance, at the cost of the movement. Units out are a loss, units in a gain, the opening
// stock of a warehouse goes against the opening equity. Transfers, reserves and receipts post nothing here: a transfer moves the same
// asset inside the organization, and a receipt is E10 of the purchase.

export interface AdjustmentMovementRow {
  type: string
  reason: string | null
  quantity: number
  unitCostCents: number | null
  // The value the movement moved: the loss of units out is exactly what the stock lost (the units in keep the cost times the units)
  valueCents?: bigint | null
}

const OUT_TYPES: ReadonlySet<string> = new Set([
  InventoryMovementType.ADJUSTMENT_OUT,
  InventoryMovementType.COUNT_OUT
])
const IN_TYPES: ReadonlySet<string> = new Set([
  InventoryMovementType.ADJUSTMENT_IN,
  InventoryMovementType.COUNT_IN
])

// Whether a movement of this type is one the adjustment entry is for
export const isAdjustmentType = (type: string): boolean => OUT_TYPES.has(type) || IN_TYPES.has(type)

export function adjustmentLines(input: {
  accounts: RoleAccounts
  movement: AdjustmentMovementRow
  storeId: string
}): AutoEntry {
  const { movement, storeId } = input
  if (!isAdjustmentType(movement.type)) return { ok: true, lines: [] }
  if (movement.unitCostCents === null) {
    // Units out with nothing on hand to average carry no cost: there is nothing to write off. Units in with no cost cannot be valued
    return OUT_TYPES.has(movement.type)
      ? { ok: true, lines: [] }
      : { ok: false, reason: FinancePostingFailureReason.COST_MISSING }
  }
  const cents = OUT_TYPES.has(movement.type)
    ? movementCostCents(movement.quantity, movement.unitCostCents, movement.valueCents)
    : movement.quantity * movement.unitCostCents
  if (cents === 0) return { ok: true, lines: [] }
  if (OUT_TYPES.has(movement.type)) {
    return linesOf(
      input.accounts,
      [{ role: AccountRole.INVENTORY_LOSS, cents }],
      [{ role: AccountRole.INVENTORY, cents }],
      { storeId }
    )
  }
  const against =
    movement.reason === InventoryAdjustmentReason.OPENING_STOCK
      ? AccountRole.OPENING_EQUITY
      : AccountRole.INVENTORY_GAIN
  return linesOf(
    input.accounts,
    [{ role: AccountRole.INVENTORY, cents }],
    [{ role: against, cents }],
    { storeId }
  )
}
