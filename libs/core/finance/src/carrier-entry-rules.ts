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
//   Dr PAYABLE_CARRIERS ...................... the estimate of E4 that the carrier settled by keeping its fee
//   Dr / Cr CARRIER_COMMISSION_EXPENSE ....... what the carrier really kept, less that estimate (the file replaces the estimate)
//   Cr RECEIVABLE_CARRIERS ................... what was reported plus what was kept, per line
// A line whose amount differs clears the receivable only for what the carrier reported and kept: the rest stays open on the
// receivable, and the shipment stays matchable by a later remittance (TDD_18 §4.2 E5).

export interface RemittanceLineFacts {
  // The money the carrier remitted for the guide (what the file says it paid)
  reportedCents: number
  // The fee the file says the carrier kept; null when the file has no fee column or the line no figure
  reportedFeeCents: number | null
  // What E4 posted as payable for this guide (its credit); 0 when it posted none
  estimateCents: number
  // Whether the connection deducts its fee from what it remits (the flag of the connection, TDD_17 §4.15)
  deductsFee: boolean
  // An earlier confirmed remittance already settled this guide's fee: a guide that is settled again (after a difference) clears no
  // payable twice
  feeAlreadySettled: boolean
}

export interface RemittanceLineSettlement {
  reportedCents: number
  // What the carrier kept out of this line
  keptCents: number
  // Of the payable E4 posted, how much this line settles
  payableCents: number
  // The commission expense this line corrects: positive when the carrier kept more than the estimate, negative when less
  expenseCents: number
  // What the line clears on the receivable
  clearedCents: number
}

export function settleRemittanceLine(line: RemittanceLineFacts): RemittanceLineSettlement {
  // The file's figure wins; without one the estimate is what the carrier kept, but only for a carrier that deducts its fee and only
  // the first time this guide is settled
  const estimated = line.deductsFee && !line.feeAlreadySettled ? line.estimateCents : 0
  const keptCents = line.reportedFeeCents ?? estimated
  // The payable is settled when the carrier kept a fee (it paid itself out of the cash): a fee of nothing leaves it owed, to be
  // invoiced and paid by hand
  const payableCents = !line.feeAlreadySettled && keptCents > 0 ? line.estimateCents : 0
  return {
    reportedCents: line.reportedCents,
    keptCents,
    payableCents,
    expenseCents: keptCents - payableCents,
    clearedCents: line.reportedCents + keptCents
  }
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
  let expense = 0
  let cleared = 0
  for (const line of input.lines) {
    reported += line.reportedCents
    payable += line.payableCents
    expense += line.expenseCents
    cleared += line.clearedCents
  }
  if (reported === 0 && payable === 0 && expense === 0 && cleared === 0) {
    return { ok: true, lines: [] }
  }
  const party = { partyType: PartyType.CARRIER_CONNECTION, partyId: input.carrierConnectionId }
  const destination = input.destinationAccountId ?? input.accounts(AccountRole.BANK_DEFAULT)
  if (destination === null) return missing(AccountRole.BANK_DEFAULT)
  const result = linesOf(
    input.accounts,
    [
      { role: AccountRole.PAYABLE_CARRIERS, cents: payable, party },
      { role: AccountRole.CARRIER_COMMISSION_EXPENSE, cents: Math.max(expense, 0) }
    ],
    [
      { role: AccountRole.RECEIVABLE_CARRIERS, cents: cleared, party },
      { role: AccountRole.CARRIER_COMMISSION_EXPENSE, cents: Math.max(-expense, 0) }
    ],
    { storeId: input.storeId }
  )
  if (!result.ok) return result
  if (reported > 0) {
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
