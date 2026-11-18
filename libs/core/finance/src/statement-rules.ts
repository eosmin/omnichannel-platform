import { AccountType, NormalSide, NormalSideOfType, StatementWarning } from '@platform/core/domain'

import { normalBalance } from './report-rules'

// The statements and the lists with age (TDD_18 §10). Pure arithmetic over the sums a caller read from the lines: whole cents as
// bigint, nothing here touches the journal, and no account is chosen by its code. The sections come from the type of each account and the
// subtotals from its parent, both of the accountant's chart (**[ACCOUNTANT]**).

export interface StatementAccount {
  id: string
  code: string
  name: string
  type: AccountType
  parentId: string | null
  isPostable: boolean
  debitCents: bigint
  creditCents: bigint
}

export interface StatementRow {
  accountId: string
  code: string
  name: string
  parentId: string | null
  isPostable: boolean
  // On the side where the account normally sits
  balanceCents: bigint
  // The account and everything under it of the same section: what a header shows
  rollupCents: bigint
}

export interface StatementSection {
  rows: StatementRow[]
  totalCents: bigint
}

// The same order on every server: a plain comparison, never the locale of the machine
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const normalIsDebit = (type: AccountType): boolean => NormalSideOfType[type] === NormalSide.DEBIT

// The accounts of one type, ordered by code, each with the balance on its normal side and the rollup of its children. The total adds each
// account's own balance once: a header carries no lines of its own, and a child is never counted twice.
export function statementSection(
  accounts: readonly StatementAccount[],
  type: AccountType
): StatementSection {
  const own = accounts
    .filter(account => account.type === type)
    .toSorted((a, b) => byText(a.code, b.code))
  const balance = new Map<string, bigint>()
  for (const account of own) balance.set(account.id, normalBalance(account, normalIsDebit(type)))
  const childrenOf = new Map<string, string[]>()
  for (const account of own) {
    if (account.parentId !== null && balance.has(account.parentId)) {
      childrenOf.set(account.parentId, [...(childrenOf.get(account.parentId) ?? []), account.id])
    }
  }
  // Each account's rollup once, whatever order the rows come in; a parent loop cannot happen (the chart refuses it), but a report must
  // never spin on one: an account met again on its own path counts as zero
  const memo = new Map<string, bigint>()
  const visiting = new Set<string>()
  const rollup = (id: string): bigint => {
    const known = memo.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0n
    visiting.add(id)
    let sum = balance.get(id) ?? 0n
    for (const child of childrenOf.get(id) ?? []) sum += rollup(child)
    visiting.delete(id)
    memo.set(id, sum)
    return sum
  }
  let totalCents = 0n
  const rows = own.map(account => {
    const balanceCents = balance.get(account.id) ?? 0n
    totalCents += balanceCents
    return {
      accountId: account.id,
      code: account.code,
      name: account.name,
      parentId: account.parentId,
      isPostable: account.isPostable,
      balanceCents,
      rollupCents: rollup(account.id)
    }
  })
  return { rows, totalCents }
}

export interface IncomeStatement {
  income: StatementSection
  costOfSales: StatementSection
  expenses: StatementSection
  grossMarginCents: bigint
  netResultCents: bigint
  warnings: StatementWarning[]
}

// Income, cost of sales, gross margin, expenses and the net result of the lines read. A section with no account that moved is warned,
// never filled in: an income statement with no cost of sales shows a margin of one hundred per cent, and the reader must be told.
export function incomeStatement(accounts: readonly StatementAccount[]): IncomeStatement {
  const income = statementSection(accounts, AccountType.INCOME)
  const costOfSales = statementSection(accounts, AccountType.COST_OF_SALES)
  const expenses = statementSection(accounts, AccountType.EXPENSE)
  const grossMarginCents = income.totalCents - costOfSales.totalCents
  const warnings: StatementWarning[] = []
  if (!moved(accounts, AccountType.INCOME)) warnings.push(StatementWarning.NO_INCOME)
  if (!moved(accounts, AccountType.COST_OF_SALES)) warnings.push(StatementWarning.NO_COST_OF_SALES)
  return {
    income,
    costOfSales,
    expenses,
    grossMarginCents,
    netResultCents: grossMarginCents - expenses.totalCents,
    warnings
  }
}

const moved = (accounts: readonly StatementAccount[], type: AccountType): boolean =>
  accounts.some(
    account => account.type === type && (account.debitCents !== 0n || account.creditCents !== 0n)
  )

export interface BalanceSheet {
  assets: StatementSection
  liabilities: StatementSection
  equity: StatementSection
  // Income less cost of sales less expenses since the books started: the books carry no closing entry, so the result of every period
  // not yet moved to equity is here and equity is shown with it (the fiscal year cut is the accountant's, debt of 4B.8b)
  resultCents: bigint
  equityWithResultCents: bigint
  // Assets equal liabilities plus equity plus the result: always, if the journal balances; false is an incident
  balanced: boolean
  warnings: StatementWarning[]
}

export function balanceSheet(accounts: readonly StatementAccount[]): BalanceSheet {
  const assets = statementSection(accounts, AccountType.ASSET)
  const liabilities = statementSection(accounts, AccountType.LIABILITY)
  const equity = statementSection(accounts, AccountType.EQUITY)
  const result = incomeStatement(accounts).netResultCents
  const equityWithResultCents = equity.totalCents + result
  const balanced = assets.totalCents === liabilities.totalCents + equityWithResultCents
  return {
    assets,
    liabilities,
    equity,
    resultCents: result,
    equityWithResultCents,
    balanced,
    warnings: balanced ? [] : [StatementWarning.NOT_BALANCED]
  }
}

export interface CashFlowSource {
  // The source of the entries (an order, a remittance, ...), or the manual ones
  source: string
  inflowCents: bigint
  outflowCents: bigint
}

export interface CashFlow {
  sources: (CashFlowSource & { netCents: bigint })[]
  inflowCents: bigint
  outflowCents: bigint
  netCents: bigint
  openingCents: bigint
  closingCents: bigint
  // Opening plus the net movement is what the cash accounts hold at the end
  closes: boolean
  warnings: StatementWarning[]
}

// The direct-method view: what moved the cash-kind accounts, by the source of the entry. A transfer between two cash accounts shows
// as an inflow and an outflow of equal amount and nets to zero.
export function cashFlow(
  sources: readonly CashFlowSource[],
  openingCents: bigint,
  closingCents: bigint,
  hasCashAccounts: boolean
): CashFlow {
  const rows = sources
    .map(row => ({ ...row, netCents: row.inflowCents - row.outflowCents }))
    .toSorted((a, b) => byText(a.source, b.source))
  let inflowCents = 0n
  let outflowCents = 0n
  for (const row of rows) {
    inflowCents += row.inflowCents
    outflowCents += row.outflowCents
  }
  const netCents = inflowCents - outflowCents
  const closes = openingCents + netCents === closingCents
  const warnings: StatementWarning[] = []
  if (!hasCashAccounts) warnings.push(StatementWarning.NO_CASH_ACCOUNTS)
  if (!closes) warnings.push(StatementWarning.CASH_FLOW_DOES_NOT_CLOSE)
  return {
    sources: rows,
    inflowCents,
    outflowCents,
    netCents,
    openingCents,
    closingCents,
    closes,
    warnings
  }
}

export interface AgingLine {
  // YYYY-MM-DD of the entry
  entryDate: string
  debitCents: bigint
  creditCents: bigint
  // The entry of the line, and the entry it reverses when it is a reversal: a reversal settles what the entry it reverses opened, before
  // anything older (an invoice that is reversed is not paid by the oldest one still open)
  entryId?: string
  reversesEntryId?: string | null
}

interface OpenItem {
  date: string
  cents: bigint
  entryId: string | null
}

export interface Aging {
  // One amount per bucket, the oldest last; the length is the number of cuts plus one
  bucketsCents: bigint[]
  // Payments (or credits) that exceed what was open: shown apart, never netted into a bucket
  unappliedCents: bigint
  // What is open less what is unapplied
  totalCents: bigint
}

// Settles `cents` against the open items, oldest first, and returns what was left over. The settled items are dropped from the front in
// one move, not one at a time.
function settleOldest(open: OpenItem[], cents: bigint): bigint {
  let settle = cents
  let settled = 0
  while (settle > 0n) {
    const oldest = open[settled]
    if (oldest === undefined) break
    const used = oldest.cents < settle ? oldest.cents : settle
    oldest.cents -= used
    settle -= used
    if (oldest.cents === 0n) settled += 1
  }
  open.splice(0, settled)
  return settle
}

// Settles `cents` against the open items the entry opened, and returns what was left over. The emptied items are dropped.
function settleOfEntry(open: OpenItem[], cents: bigint, entryId: string): bigint {
  let settle = cents
  for (const item of open) {
    if (settle === 0n) break
    if (item.entryId !== entryId) continue
    const used = item.cents < settle ? item.cents : settle
    item.cents -= used
    settle -= used
  }
  if (settle !== cents) {
    let kept = 0
    for (const item of open) {
      if (item.cents > 0n) open[kept++] = item
    }
    open.length = kept
  }
  return settle
}

const DAY_MS = 86_400_000
const daysBetween = (from: string, to: string): number =>
  Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)

// The age of what one party owes (or is owed) at a date. The lines come in the order of the ledger. The side that grows the balance
// opens an item dated by its entry; the other side settles the oldest open items first (a reversal, the items of the entry it reverses) (the usual first-in, first-out; whether the
// accountant ages by another rule is **[ACCOUNTANT]**). `cuts` are the upper bounds in days of every bucket but the last.
export function agingOf(
  lines: readonly AgingLine[],
  asOf: string,
  growsOnCredit: boolean,
  cuts: readonly number[]
): Aging {
  const open: OpenItem[] = []
  let unappliedCents = 0n
  for (const line of lines) {
    const net = normalBalance(line, !growsOnCredit)
    if (net > 0n) {
      open.push({ date: line.entryDate, cents: net, entryId: line.entryId ?? null })
      continue
    }
    // A reversal first cancels what the entry it reverses opened (that is its age); what that entry no longer has open is settled oldest first
    const left =
      line.reversesEntryId === undefined || line.reversesEntryId === null
        ? -net
        : settleOfEntry(open, -net, line.reversesEntryId)
    unappliedCents += settleOldest(open, left)
  }
  // A payment dated before the item it pays (an advance, or a date typed earlier) waited as unapplied: it pays what is open now
  unappliedCents = settleOldest(open, unappliedCents)
  const bucketsCents: bigint[] = Array.from({ length: cuts.length + 1 }, () => 0n)
  let openCents = 0n
  for (const item of open) {
    const age = daysBetween(item.date, asOf)
    const index = cuts.findIndex(cut => age <= cut)
    const at = index === -1 ? cuts.length : index
    bucketsCents[at] = (bucketsCents[at] ?? 0n) + item.cents
    openCents += item.cents
  }
  return { bucketsCents, unappliedCents, totalCents: openCents - unappliedCents }
}
