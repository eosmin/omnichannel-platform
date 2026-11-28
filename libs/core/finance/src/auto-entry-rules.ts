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
  // The credit of a return that a replacement at the full price consumes (`grossExchangeView`): part of the debit comes from the customer's
  // advances, the rest is collected as usual. Zero for any other sale.
  advanceConsumedCents?: number
  storeId: string
}): AutoEntry {
  const { amounts, collection, storeId } = input
  const consumed = input.advanceConsumedCents ?? 0
  if (consumed < 0 || consumed > amounts.totalCents) {
    return { ok: false, reason: FinancePostingFailureReason.AMOUNTS_DISAGREE }
  }
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
          amounts.totalCents - consumed,
          collection.carrierConnectionId
        )
      : add(AccountRole.CUSTOMER_ADVANCES, 'debit', amounts.totalCents - consumed),
    // What the customer's credit pays: for an advance collection it joins the advance E1 holds (two lines of the same account, each one its own
    // origin), for a carrier it is the only advance debit
    add(AccountRole.CUSTOMER_ADVANCES, 'debit', consumed),
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
  // The value the movement moved: the loss of units out is exactly what the stock lost (the units in keep the cost times the units,
  // except when they carry no cost, as the units of a count: then it is the value the movement recorded)
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
  const isOut = OUT_TYPES.has(movement.type)
  let cents: number
  if (movement.unitCostCents !== null) {
    cents = isOut
      ? movementCostCents(movement.quantity, movement.unitCostCents, movement.valueCents)
      : movement.quantity * movement.unitCostCents
  } else if (isOut) {
    // Units out with nothing on hand to average carry no cost: there is nothing to write off
    return { ok: true, lines: [] }
  } else {
    // Units in with no cost: a count never carries one, so the engine valued the units at the average of the level and wrote that
    // value on the movement, and the books trust the movement (TDD_18 §4.2, E9). With neither a cost nor a value (or a value that
    // is not one) they cannot be valued: a failure a person can see, never a quiet zero
    const { valueCents } = movement
    if (valueCents === null || valueCents === undefined || valueCents < 0n) {
      return { ok: false, reason: FinancePostingFailureReason.COST_MISSING }
    }
    cents = movementCostCents(movement.quantity, 0, valueCents)
  }
  if (cents === 0) return { ok: true, lines: [] }
  if (isOut) {
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

// ---------------------------------------------------------------------------------------------------------------------------
// E9, the transfer write-off: a transfer closed with units that did not arrive and that a person wrote off. The units left the source
// at the dispatch (one TRANSFER_OUT at the cost of that warehouse) and only the received ones came in (TRANSFER_IN at the same unit
// cost), so the stock lost exactly the dispatched value minus the received units at their cost, and the books must say so: Dr
// INVENTORY_LOSS · Cr INVENTORY. No movement is written for it (the units are already out of every level), which is why this event has
// its own source: the line of the transfer, once.

export interface TransferWriteOffRow {
  // What the line dispatched and what arrived of it
  quantity: number
  receivedQuantity: number
  // The cost of the dispatch movement (TRANSFER_OUT): null when the source had nothing on hand to average
  unitCostCents: number | null
  valueCents?: bigint | null
  // The value the receipts actually put in the destination (the sum of what its TRANSFER_IN movements recorded), when the service has it:
  // the loss is then exactly what the stock lost. Absent, the received units at the dispatch unit cost
  receivedValueCents?: bigint | null
}

// The value the stock lost with the units that never arrived, in cents (0 when it lost none)
export function transferWriteOffCents(row: TransferWriteOffRow): number {
  if (row.quantity - row.receivedQuantity <= 0) return 0
  let dispatched: number
  if (row.valueCents !== null && row.valueCents !== undefined) {
    dispatched = movementCostCents(row.quantity, row.unitCostCents ?? 0, row.valueCents)
  } else if (row.unitCostCents !== null) {
    dispatched = row.quantity * row.unitCostCents
  } else {
    return 0
  }
  let received: number
  if (row.receivedValueCents !== null && row.receivedValueCents !== undefined) {
    received = Number(row.receivedValueCents)
    if (!Number.isSafeInteger(received))
      throw new RangeError('the value of a receipt is out of range')
  } else {
    received = row.receivedQuantity * (row.unitCostCents ?? 0)
  }
  const cents = dispatched - received
  return cents > 0 ? cents : 0
}

export function transferWriteOffLines(input: {
  accounts: RoleAccounts
  row: TransferWriteOffRow
  storeId: string
}): AutoEntry {
  const cents = transferWriteOffCents(input.row)
  if (cents === 0) return { ok: true, lines: [] }
  return linesOf(
    input.accounts,
    [{ role: AccountRole.INVENTORY_LOSS, cents }],
    [{ role: AccountRole.INVENTORY, cents }],
    { storeId: input.storeId }
  )
}
