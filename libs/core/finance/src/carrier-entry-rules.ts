import {
  AccountRole,
  commissionCents,
  FinancePostingFailureReason,
  PartyType,
  ShippingPayer
} from '@platform/core/domain'

import { type AutoEntry, linesOf, missing, type RoleAccounts } from './auto-entry-rules'

// The pure rules of the entries that depend on a carrier (TDD_18 §4.2, E4 to E6), Step 4B.6b. Like the rules of 4B.6a they take
// the rows the service already loaded, in whole cents, and answer lines or the reason there are none. Nothing here picks an account
// (roles come from the organization's mapping) and nothing invents a figure: what the carrier keeps is the file's own number when
// the file has one, and the estimate E4 posted otherwise.
//
// [ACCOUNTANT]: E4 posts the charges gross, with no input VAT, until the accountant says how the carrier's document is handled
// (TDD_18 §4.2 note on E4, §13). The charge model of a connection (prepaid, collected in the remittance, invoiced) is the owner's
// information to confirm and is NOT decided here: this posts what the shipment says it will cost, as the TDD writes it.

// ---------------------------------------------------------------------------------------------------------------------------
// E4: what the carrier charges for a delivered guide

export interface ChargeBasis {
  shippingPayer: string
  // What the carrier collected from the recipient; null for a guide that was prepaid
  codAmountCents: number | null
  carrierCostCents: number | null
  carrierRateCents: number | null
  commissionBps: number | null
}

export interface ChargeAmounts {
  // The guide's cost, only when the sender pays it
  freightCents: number
  // The commission over the cash the carrier collected, whoever pays the guide
  commissionCents: number
}

// The cost the carrier reported, else the rate the connection had when the guide was made; the commission is half up over the amount
// collected (the same function that estimates the expected amount of the remittance, so the two never disagree by a cent)
export function chargeAmounts(basis: ChargeBasis): ChargeAmounts {
  const cost = basis.carrierCostCents ?? basis.carrierRateCents ?? 0
  return {
    freightCents: basis.shippingPayer === (ShippingPayer.SENDER as string) ? cost : 0,
    commissionCents:
      basis.codAmountCents === null || basis.commissionBps === null
        ? 0
        : commissionCents(basis.codAmountCents, basis.commissionBps)
  }
}

export function chargeLines(input: {
  accounts: RoleAccounts
  carrierConnectionId: string
  amounts: ChargeAmounts
  storeId: string
}): AutoEntry {
  const { amounts } = input
  const total = amounts.freightCents + amounts.commissionCents
  if (total === 0) return { ok: true, lines: [] }
  return linesOf(
    input.accounts,
    [
      { role: AccountRole.CARRIER_FREIGHT_EXPENSE, cents: amounts.freightCents },
      { role: AccountRole.CARRIER_COMMISSION_EXPENSE, cents: amounts.commissionCents }
    ],
    [
      {
        role: AccountRole.PAYABLE_CARRIERS,
        cents: total,
        party: { partyType: PartyType.CARRIER_CONNECTION, partyId: input.carrierConnectionId }
      }
    ],
    { storeId: input.storeId }
  )
}

// ---------------------------------------------------------------------------------------------------------------------------
// E5: a COD remittance confirmed. One entry per remittance:
//   Dr the account the money went to ........ what the carrier reported (what it remitted)
//   Dr PAYABLE_CARRIERS ...................... what the carrier kept, up to the estimate E4 posted
//   Dr CARRIER_COMMISSION_EXPENSE ............ what it kept beyond that estimate (the file's figure wins over the estimate)
//   Cr PAYABLE_CARRIERS ...................... what it charged but could NOT take out of the cash (see below), netted with the debit above
//   Cr RECEIVABLE_CARRIERS ................... what was reported plus what was taken out of the cash, per line
// A line whose amount differs clears the receivable only for what the carrier reported and kept: the rest stays open on the
// receivable, and the shipment stays matchable by a later remittance (TDD_18 §4.2 E5).
// What a carrier takes out of the cash is bounded by the cash it collected: out of a guide of 25.99 that it remitted 0.00 for it can
// keep at most 25.99. A charge above that (a fee of 30.00, a guide of 3.50 on a cash on delivery of 2.00) is still an expense, but the part
// the cash could not cover is owed to the carrier, not cleared from the receivable, so the receivable of a guide never goes below
// what the carrier reported against it because of a fee (Step 4B.6b fix, HC-001).

export interface RemittanceLineFacts {
  // The money the carrier remitted for the guide (what the file says it paid)
  reportedCents: number
  // The fee the file says the carrier kept; null when the file has no fee column or the line no figure
  reportedFeeCents: number | null
  // What E4 posted as payable for this guide (its credit); 0 when it posted none
  estimateCents: number
  // Whether the connection deducts its fee from what it remits (the flag of the connection, TDD_17 §4.15)
  deductsFee: boolean
  // What the carrier had to collect for the guide (the gross cash on delivery, the amount E3 debited the receivable for); null when the
  // guide holds none (then nothing can be taken out of the cash). It bounds what the carrier can have taken out of the cash.
  grossCents: number | null
  // What the earlier confirmed remittances of the same guide already cleared of its receivable (reported plus taken out of the cash): a guide
  // remitted in parts has only what is left to be taken out of
  clearedBeforeCents: number
  // An earlier confirmed remittance already cleared the payable of this guide (it kept a fee): a guide that is settled again (after a
  // difference) clears no payable twice
  feeAlreadySettled: boolean
}

export interface RemittanceLineSettlement {
  reportedCents: number
  // What the carrier charged for this line (the figure of the file, else the estimate): the expense and the payable it settles
  keptCents: number
  // Of what it charged, how much it took out of the cash it collected (what clears the receivable), and how much it could not: that is owed
  deductedCents: number
  owedCents: number
  // Of the payable E4 posted, how much this line settles
  payableCents: number
  // What the carrier kept beyond the estimate of E4 (or all of it when E4 posted none): commission expense
  expenseCents: number
  // What the line clears on the receivable
  clearedCents: number
}

export function settleRemittanceLine(line: RemittanceLineFacts): RemittanceLineSettlement {
  // The file's figure wins; without one the estimate is what the carrier kept, but only for a carrier that deducts its fee and only
  // the first time this guide is settled
  const estimated = line.deductsFee && !line.feeAlreadySettled ? line.estimateCents : 0
  const keptCents = line.reportedFeeCents ?? estimated
  // The payable is settled up to what the carrier kept (it paid itself out of the cash). What it did NOT keep stays owed, to be invoiced
  // and paid by hand: the books never wipe a payable the carrier did not take, and a fee of nothing leaves it all owed
  const payableCents = line.feeAlreadySettled ? 0 : Math.min(keptCents, line.estimateCents)
  // The cash the carrier collected and did not remit is all it could have taken out: a charge beyond it was not taken out of the cash
  // A guide with no amount to collect has no cash to take anything out of: the whole charge is owed. A negative reported amount (the schemas
  // refuse it) is never read as more room.
  const room =
    line.grossCents === null
      ? 0
      : Math.max(0, line.grossCents - line.clearedBeforeCents - Math.max(0, line.reportedCents))
  const deductedCents = Math.min(keptCents, room)
  return {
    reportedCents: line.reportedCents,
    keptCents,
    deductedCents,
    owedCents: keptCents - deductedCents,
    payableCents,
    expenseCents: keptCents - payableCents,
    clearedCents: line.reportedCents + deductedCents
  }
}

// Whether a line of an earlier remittance kept a fee for its guide, so that the payable E4 posted is cleared once: the file's own figure,
// else the estimate for a connection that deducts its fee. The one rule E5 and E7 share.
export const keptAFee = (
  reportedFeeCents: number | null,
  estimateCents: number,
  deductsFee: boolean
): boolean => (reportedFeeCents ?? (deductsFee ? estimateCents : 0)) > 0

// The lines of ONE guide in the order its remittances were confirmed, settled one after the other: what each cleared of the receivable depends
// on what the ones before it left, and whether the payable E4 posted was already settled by one of them. E5 (for the remittances before the one
// it posts) and E7 (for all of them) both read the books this way, so they cannot differ.
export interface GuideLineRow {
  reportedCents: number
  reportedFeeCents: number | null
}

export function replaySettlements(
  rows: readonly GuideLineRow[],
  guide: { estimateCents: number; deductsFee: boolean; grossCents: number | null }
): {
  settlements: RemittanceLineSettlement[]
  clearedCents: number
  feeSettled: boolean
} {
  const settlements: RemittanceLineSettlement[] = []
  let clearedCents = 0
  let feeSettled = false
  for (const row of rows) {
    const settlement = settleRemittanceLine({
      reportedCents: row.reportedCents,
      reportedFeeCents: row.reportedFeeCents,
      estimateCents: guide.estimateCents,
      deductsFee: guide.deductsFee,
      grossCents: guide.grossCents,
      clearedBeforeCents: clearedCents,
      feeAlreadySettled: feeSettled
    })
    settlements.push(settlement)
    clearedCents += settlement.clearedCents
    if (keptAFee(row.reportedFeeCents, guide.estimateCents, guide.deductsFee)) feeSettled = true
  }
  return { settlements, clearedCents, feeSettled }
}

export function remittanceLines(input: {
  accounts: RoleAccounts
  // The account the owner chose on the confirm screen (already checked), or null for the role BANK_DEFAULT
  destinationAccountId: string | null
  carrierConnectionId: string
  storeId: string
  lines: readonly RemittanceLineSettlement[]
}): AutoEntry {
  let reported = 0
  let payable = 0
  let owed = 0
  let expense = 0
  let cleared = 0
  for (const line of input.lines) {
    reported += line.reportedCents
    payable += line.payableCents
    owed += line.owedCents
    expense += line.expenseCents
    cleared += line.clearedCents
  }
  if (reported === 0 && payable === 0 && owed === 0 && expense === 0 && cleared === 0) {
    return { ok: true, lines: [] }
  }
  // The payable the carrier settled and the part of its charge it did not take out of the cash are the same account: one line, by the net
  const payableDebit = Math.max(0, payable - owed)
  const payableCredit = Math.max(0, owed - payable)
  const party = { partyType: PartyType.CARRIER_CONNECTION, partyId: input.carrierConnectionId }
  // The destination is needed only when there is cash to put in it
  const destination =
    reported > 0 ? (input.destinationAccountId ?? input.accounts(AccountRole.BANK_DEFAULT)) : null
  if (reported > 0 && destination === null) return missing(AccountRole.BANK_DEFAULT)
  const result = linesOf(
    input.accounts,
    [
      { role: AccountRole.PAYABLE_CARRIERS, cents: payableDebit, party },
      { role: AccountRole.CARRIER_COMMISSION_EXPENSE, cents: expense }
    ],
    [
      { role: AccountRole.PAYABLE_CARRIERS, cents: payableCredit, party },
      { role: AccountRole.RECEIVABLE_CARRIERS, cents: cleared, party }
    ],
    { storeId: input.storeId }
  )
  if (!result.ok) return result
  if (destination !== null) {
    result.lines.unshift({
      accountId: destination,
      debitCents: reported,
      creditCents: 0,
      storeId: input.storeId
    })
  }
  const debits = result.lines.reduce((sum, line) => sum + line.debitCents, 0)
  const credits = result.lines.reduce((sum, line) => sum + line.creditCents, 0)
  // The lines are built so that this holds; an entry that does not balance is a bug and is never forced
  if (debits !== credits) {
    return { ok: false, reason: FinancePostingFailureReason.UNBALANCED }
  }
  return result
}
