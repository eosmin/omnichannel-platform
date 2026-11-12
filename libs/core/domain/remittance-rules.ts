import { CodStatus, RemittanceLineOutcome, ShippingPayer } from './status-enums'

// The money rules of the cash-on-delivery remittances (TDD_17 §4.15) as pure functions: the service reads and writes, this
// only says what is due. Every amount is an integer number of cents of the store currency.

export const RemittanceLimits = {
  // A remittance holds the lines of one settlement file (§4.15: at most 5,000 rows)
  MAX_LINES: 5000,
  // The longest guide number, reference or note a line or a remittance keeps
  GUIDE_MAX_LENGTH: 80,
  REFERENCE_MAX_LENGTH: 80,
  NOTE_MAX_LENGTH: 500,
  // Largest amount a line accepts: a remittance of more than this per guide is a typo, not a settlement
  MAX_AMOUNT_CENTS: 100_000_000,
  // The shipments of one connection that the pending list names (the totals count all of them)
  PENDING_SHIPMENTS_MAX: 500
} as const

// Two people settling the same connection at once take turns: the lock of a remittance is one per store and connection
// (TDD_17 §4.15), so two overlapping confirmations of the same draft end with one
export const RemittanceLockScopes = { CONNECTION: 'cod_remittance' } as const

// What a shipment that was just delivered should bring (§4.15): the amount collected, minus the carrier's cost only when
// the connection deducts its fee AND the sender is the one who pays AND the cost is known. When the recipient pays the
// carrier nothing is deducted, and when no fee is known the amount is gross. Never below zero: a fee above the amount
// leaves nothing owed, not a debt of the owner to the carrier.
export interface ExpectedAmountInput {
  codAmountCents: number
  carrierCostCents: number | null
  shippingPayer: ShippingPayer
  deductsFee: boolean
}

export function expectedCodCents(input: ExpectedAmountInput): number {
  const { codAmountCents, carrierCostCents, shippingPayer, deductsFee } = input
  if (!deductsFee || shippingPayer !== ShippingPayer.SENDER || carrierCostCents === null) {
    return codAmountCents
  }
  return Math.max(0, codAmountCents - carrierCostCents)
}

// What the shipment of a line looks like to the matching: only what the outcome depends on
export interface MatchShipment {
  codStatus: CodStatus
  codAmountCents: number | null
  codExpectedCents: number | null
  carrierCostCents: number | null
  shippingPayer: ShippingPayer
}

// The amount a line is held against. The expected amount written at delivery wins, except in two cases where the fee is known
// better now: the carrier's cost arrived after the delivery (the amount written was gross and the cost is known now, so it is
// worked out again), or the fee came only in the settlement file (the line's own fee). Both need a connection that deducts the
// fee and a sender who pays; never below zero.
export function lineExpectedCents(
  shipment: MatchShipment,
  reportedFeeCents: number | null,
  deductsFee: boolean
): number | null {
  if (shipment.codAmountCents === null) return null
  if (deductsFee && shipment.shippingPayer === ShippingPayer.SENDER) {
    const fee = shipment.carrierCostCents ?? reportedFeeCents
    if (fee !== null) return Math.max(0, shipment.codAmountCents - fee)
  }
  return shipment.codExpectedCents ?? shipment.codAmountCents
}

// A shipment is open to a remittance while it is waiting for one, or when an earlier one differed
export const RemittableCodStatuses: readonly CodStatus[] = [
  CodStatus.PENDING_REMITTANCE,
  CodStatus.DISCREPANCY
]

export interface LineInput {
  reportedCents: number
  reportedFeeCents: number | null
  // The guide was already seen in this same remittance (the second occurrence is ignored)
  duplicate: boolean
  shipment: MatchShipment | null
}

export interface LineResult {
  outcome: RemittanceLineOutcome
  expectedCents: number | null
}

// The outcome of one line (§4.15). A line that finds no shipment, or one that cannot be remitted, keeps its expected amount
// empty or as a warning and affects nothing when the remittance is confirmed.
export function classifyLine(input: LineInput, deductsFee: boolean): LineResult {
  if (input.duplicate) {
    return { outcome: RemittanceLineOutcome.DUPLICATE_IN_FILE, expectedCents: null }
  }
  const { shipment } = input
  if (shipment === null) return { outcome: RemittanceLineOutcome.NOT_FOUND, expectedCents: null }
  if (shipment.codStatus === CodStatus.REMITTED) {
    return {
      outcome: RemittanceLineOutcome.ALREADY_REMITTED,
      expectedCents: shipment.codExpectedCents
    }
  }
  if (!RemittableCodStatuses.includes(shipment.codStatus)) {
    return { outcome: RemittanceLineOutcome.NOT_DELIVERED, expectedCents: null }
  }
  const expectedCents = lineExpectedCents(shipment, input.reportedFeeCents, deductsFee)
  return {
    outcome:
      expectedCents === input.reportedCents
        ? RemittanceLineOutcome.MATCHED
        : RemittanceLineOutcome.AMOUNT_DIFFERS,
    expectedCents
  }
}

// The outcomes that move a shipment when the remittance is confirmed
export const SettlingOutcomes: readonly RemittanceLineOutcome[] = [
  RemittanceLineOutcome.MATCHED,
  RemittanceLineOutcome.AMOUNT_DIFFERS
]

export interface TotalsLine {
  outcome: RemittanceLineOutcome
  excluded: boolean
  reportedCents: number
  reportedFeeCents: number | null
  expectedCents: number | null
}

export interface RemittanceTotals {
  expectedCents: number
  reportedCents: number
  feeCents: number
  // reported minus expected: positive when the carrier sent more than was due
  differenceCents: number
}

// The three totals of the draft and of the confirmation: only the lines that will settle a shipment count, so a line that
// matched nothing, an excluded one or a repeated one never changes what is owed
export function remittanceTotals(lines: readonly TotalsLine[]): RemittanceTotals {
  let expectedCents = 0
  let reportedCents = 0
  let feeCents = 0
  for (const line of lines) {
    if (line.excluded || !SettlingOutcomes.includes(line.outcome)) continue
    expectedCents += line.expectedCents ?? 0
    reportedCents += line.reportedCents
    feeCents += line.reportedFeeCents ?? 0
  }
  return { expectedCents, reportedCents, feeCents, differenceCents: reportedCents - expectedCents }
}

// The key of a guide for the matching: ignoring case and the whitespace around it (§4.15)
export function guideKey(guideNumber: string): string {
  return guideNumber.trim().toLowerCase()
}

// How many whole days a shipment has been waiting since it was delivered
export function ageInDays(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 86_400_000))
}
