import {
  FinanceLimits,
  PartyType,
  PurchaseOrderStatus,
  PurchaseOrderStatusTransitions,
  type TaxRounding
} from './finance-constants'
import { dateToDay, dayToDate, type DraftLine } from './ledger-days'
import { PurchaseLimits } from './purchase-constants'
import { taxOfAmount } from './tax-rules'

// The rules of purchases and supplier payments (TDD_18 §2.7, §4.2 E10 and E11), pure: the money of a receipt, the lines of its
// entry, what a payment may be and what is still owed. The service loads the rows, asks these rules and only then posts. Whole USD
// cents everywhere: a line's tax is rounded by the organization's rule, line by line, so the receipt, the entry and the VAT report agree
// to the cent.

export const PurchaseRule = {
  QUANTITY: 'quantity',
  UNIT_COST: 'unit_cost',
  LINE_TOTAL_TOO_BIG: 'line_total_too_big',
  RECEIPT_TOTAL_TOO_BIG: 'receipt_total_too_big',
  NO_LINES: 'no_lines',
  TAX_RATE_INACTIVE: 'tax_rate_inactive',
  DATE_IN_FUTURE: 'date_in_future',
  // The tax is credited only against a supplier document [ACCOUNTANT]: the number of it is what says there is one
  CREDITABLE_NEEDS_DOCUMENT: 'creditable_needs_document',
  AMOUNT: 'amount',
  // What the services check against the rows they load
  BILL_REQUIRED: 'bill_required',
  PAYABLE_ACCOUNT_TYPE: 'payable_account_type'
} as const
export type PurchaseRuleName = (typeof PurchaseRule)[keyof typeof PurchaseRule]

// What a line of a receipt is, for the money: the units, the cost of one before tax and the rate it is taxed at (null = untaxed)
export interface ReceiptLineInput {
  quantity: number
  unitCostCents: number
  rateBps: number | null
}

export interface ReceiptLineMoney {
  subtotalCents: number
  taxCents: number
}

export interface ReceiptMoney {
  lines: ReceiptLineMoney[]
  subtotalCents: number
  taxCents: number
  totalCents: number
}

// The money of each line (units x cost, and the tax ON TOP of it) and of the receipt. A line whose amount or whose sum with the others
// would pass the Int of the database is a problem the caller reports, never a wrapped number: the sums run in the safe range of a double
// (the ceiling of a line is 2^31, a receipt has at most 200 lines).
export function receiptMoney(
  lines: readonly ReceiptLineInput[],
  rounding: TaxRounding
): ReceiptMoney {
  const money = lines.map(line => {
    const subtotalCents = line.quantity * line.unitCostCents
    const taxCents =
      // A line above the Int of the database is reported by `receiptProblems`; its tax is not computed (amount x rate must stay in the
      // safe range of a double: 2^31 x 10000 does, a bigger line would not)
      line.rateBps === null || !(subtotalCents <= FinanceLimits.MAX_LINE_CENTS)
        ? 0
        : taxOfAmount({
            amountCents: subtotalCents,
            rateBps: line.rateBps,
            includesTax: false,
            rounding
          })
    return { subtotalCents, taxCents }
  })
  const subtotalCents = money.reduce((sum, line) => sum + line.subtotalCents, 0)
  const taxCents = money.reduce((sum, line) => sum + line.taxCents, 0)
  return { lines: money, subtotalCents, taxCents, totalCents: subtotalCents + taxCents }
}

// Every rule the receipt breaks, in a fixed order (empty when it is valid)
export function receiptProblems(
  lines: readonly ReceiptLineInput[],
  money: ReceiptMoney
): PurchaseRuleName[] {
  const problems: PurchaseRuleName[] = []
  if (lines.length === 0 || lines.length > PurchaseLimits.MAX_LINES_PER_ORDER) {
    problems.push(PurchaseRule.NO_LINES)
  }
  if (
    lines.some(
      line =>
        !Number.isInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > PurchaseLimits.MAX_LINE_QUANTITY
    )
  ) {
    problems.push(PurchaseRule.QUANTITY)
  }
  if (
    lines.some(
      line =>
        !Number.isInteger(line.unitCostCents) ||
        line.unitCostCents < 0 ||
        line.unitCostCents > FinanceLimits.MAX_LINE_CENTS
    )
  ) {
    problems.push(PurchaseRule.UNIT_COST)
  }
  if (
    money.lines.some(
      line =>
        !Number.isSafeInteger(line.subtotalCents) ||
        line.subtotalCents + line.taxCents > FinanceLimits.MAX_LINE_CENTS
    )
  ) {
    problems.push(PurchaseRule.LINE_TOTAL_TOO_BIG)
  }
  if (money.totalCents > FinanceLimits.MAX_LINE_CENTS) {
    problems.push(PurchaseRule.RECEIPT_TOTAL_TOO_BIG)
  }
  // A receipt that owes nothing posts no entry (an entry has positive debits): the goods are free, so nothing is received through it
  if (money.totalCents <= 0 && !problems.includes(PurchaseRule.NO_LINES)) {
    problems.push(PurchaseRule.AMOUNT)
  }
  return problems
}

// What the entry of a receipt needs of each line: the store the stock goes to (the dimension), the money and the tax rate with the
// account its tax lands on
export interface ReceiptEntryLine extends ReceiptLineMoney {
  storeId: string
  taxRateId: string | null
  // The account of the input tax of the rate; null for an untaxed line
  inputTaxAccountId: string | null
}

export interface ReceiptEntryAccounts {
  inventoryAccountId: string
  payableAccountId: string
  // Where the tax goes when it is not creditable: a cost, never a default the books did not choose (the role UNCATEGORIZED_EXPENSE)
  uncreditableTaxAccountId: string | null
  supplierId: string
}

// E10: Dr inventory (the net of each store) · Dr input VAT (a creditable tax, by rate and store) · Cr payable to the supplier (the
// total, with the supplier as party). A tax that is not creditable is booked to the expense account, so the stock keeps the cost the
// movements carry (the ledger and the stock value agree) and the tax is still a visible cost. Lines of one store and one account merge:
// the entry has one line per (account, store, rate), in a fixed order.
export function receiptEntryLines(
  lines: readonly ReceiptEntryLine[],
  accounts: ReceiptEntryAccounts,
  taxCreditable: boolean
): DraftLine[] {
  const debits = new Map<string, DraftLine>()
  const add = (
    accountId: string,
    storeId: string,
    cents: number,
    taxRateId: string | null
  ): void => {
    if (cents <= 0) return
    const key = `${accountId}|${storeId}|${taxRateId ?? ''}`
    const found = debits.get(key)
    if (found === undefined) {
      debits.set(key, { accountId, debitCents: cents, creditCents: 0, storeId, taxRateId })
    } else found.debitCents += cents
  }
  let total = 0
  for (const line of lines) {
    add(accounts.inventoryAccountId, line.storeId, line.subtotalCents, null)
    if (line.taxCents > 0) {
      if (taxCreditable && line.inputTaxAccountId !== null) {
        add(line.inputTaxAccountId, line.storeId, line.taxCents, line.taxRateId)
      } else if (accounts.uncreditableTaxAccountId !== null) {
        add(accounts.uncreditableTaxAccountId, line.storeId, line.taxCents, line.taxRateId)
      }
    }
    total += line.subtotalCents + line.taxCents
  }
  const ordered = [...debits.values()].sort(
    (a, b) =>
      a.accountId.localeCompare(b.accountId) ||
      (a.storeId ?? '').localeCompare(b.storeId ?? '') ||
      (a.taxRateId ?? '').localeCompare(b.taxRateId ?? '')
  )
  return [
    ...ordered,
    {
      accountId: accounts.payableAccountId,
      debitCents: 0,
      creditCents: total,
      partyType: PartyType.SUPPLIER,
      partyId: accounts.supplierId
    }
  ]
}

// Whether a non-creditable tax has somewhere to go: a taxed receipt without the expense role mapped must fail visibly, never drop the tax
export function needsUncreditableTaxAccount(money: ReceiptMoney, taxCreditable: boolean): boolean {
  return !taxCreditable && money.taxCents > 0
}

// E11: Dr payable to the supplier (party) · Cr the account the money leaves
export function paymentLines(input: {
  payableAccountId: string
  paidFromAccountId: string
  supplierId: string
  amountCents: number
}): DraftLine[] {
  return [
    {
      accountId: input.payableAccountId,
      debitCents: input.amountCents,
      creditCents: 0,
      partyType: PartyType.SUPPLIER,
      partyId: input.supplierId
    },
    { accountId: input.paidFromAccountId, debitCents: 0, creditCents: input.amountCents }
  ]
}

export const PaymentRule = {
  AMOUNT: 'amount',
  FROM_NOT_CASH: 'from_not_cash',
  DATE_IN_FUTURE: 'date_in_future'
} as const
export type PaymentRuleName = (typeof PaymentRule)[keyof typeof PaymentRule]

export function paymentProblems(input: {
  amountCents: number
  paidFromIsCash: boolean
}): PaymentRuleName[] {
  const problems: PaymentRuleName[] = []
  if (
    !Number.isInteger(input.amountCents) ||
    input.amountCents <= 0 ||
    input.amountCents > FinanceLimits.MAX_LINE_CENTS
  ) {
    problems.push(PaymentRule.AMOUNT)
  }
  if (!input.paidFromIsCash) problems.push(PaymentRule.FROM_NOT_CASH)
  return problems
}

// The day a bill falls due: the day the goods were received plus the supplier's terms
export function dueDay(receivedOn: string, termsDays: number): string {
  const due = dayToDate(receivedOn)
  due.setUTCDate(due.getUTCDate() + termsDays)
  return dateToDay(due)
}

export interface BillFacts {
  id: string
  supplierId: string
  dueOn: string
  totalCents: number
  // What the payments that name this bill added up to (the live ones)
  paidCents: number
}

export interface BillBalance extends BillFacts {
  // What is still owed on it after the payments that name it and the ones that name no bill (applied oldest due first)
  openCents: number
  overdue: boolean
}

// What is owed per bill. A payment that names no bill is the supplier's in all: it is applied to the supplier's bills, the oldest due
// date first (then the oldest id, so the same input always gives the same answer). The sum of the open amounts of a supplier is
// exactly (bills - payments), whatever the way the payments were named.
export function billBalances(
  bills: readonly BillFacts[],
  unappliedBySupplier: ReadonlyMap<string, number>,
  today: string
): BillBalance[] {
  const remaining = new Map(unappliedBySupplier)
  return [...bills]
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.id.localeCompare(b.id))
    .map(bill => {
      let open = Math.max(bill.totalCents - bill.paidCents, 0)
      const spare = remaining.get(bill.supplierId) ?? 0
      const used = Math.min(open, spare)
      if (used > 0) {
        open -= used
        remaining.set(bill.supplierId, spare - used)
      }
      return { ...bill, openCents: open, overdue: open > 0 && bill.dueOn < today }
    })
}

// A purchase order moves along its table only (TDD_18 §3)
export function canTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): boolean {
  return PurchaseOrderStatusTransitions[from].includes(to)
}

// The status after a receipt: received when every line has all its units, otherwise partially received
export function statusAfterReceipt(
  lines: readonly { quantity: number; receivedQuantity: number }[]
): PurchaseOrderStatus.RECEIVED | PurchaseOrderStatus.PARTIALLY_RECEIVED {
  return lines.every(line => line.receivedQuantity >= line.quantity)
    ? PurchaseOrderStatus.RECEIVED
    : PurchaseOrderStatus.PARTIALLY_RECEIVED
}

// What two writings of the same supplier document have in common: letters and digits, in capitals, in NFKC (a full-width digit is the digit). "fac-001", "FAC 001" and
// "Fac001" are one invoice, so the duplicate check compares this and not the text as it was typed (HC-124). Empty when nothing is left. Two numbers that differ only in where the separators are (`12-3`, `1-23`) share a key: that is the price of ignoring them, [ACCOUNTANT] to confirm.
export function documentNumberKey(value: string): string {
  return value
    .normalize('NFKC')
    .toUpperCase()
    .replaceAll(/[^\p{L}\p{N}]/gu, '')
}
