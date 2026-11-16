import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import {
  AccountType,
  AgingBucketDays,
  AgingKind,
  AgingRoles,
  FinanceReport,
  FinanceReportLimits,
  FinanceResourceTypes,
  FinanceSourceType,
  PartyType,
  StatementCsvSection,
  StatementTotalLine,
  StatementWarning
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import {
  type Aging,
  agingOf,
  balanceSheet,
  type BalanceSheet,
  cashFlow,
  type CashFlow,
  incomeStatement,
  type IncomeStatement,
  type StatementAccount,
  type StatementSection
} from '@platform/core/finance'

import type { Actor } from '../tenancy'

import type { AgingQuery, BalanceSheetQuery, FlowQuery } from './finance-reports.schemas'
import type { AgingCsvRow, StatementCsvRow } from './finance-statements.csv'
import { centsAsNumber } from './finance.support'

export interface StatementRowView {
  accountId: string
  code: string
  name: string
  parentId: string | null
  isPostable: boolean
  balanceCents: string
  rollupCents: string
}

export interface StatementSectionView {
  rows: StatementRowView[]
  totalCents: string
}

export interface IncomeStatementView {
  from: string
  to: string
  storeId: string | null
  income: StatementSectionView
  costOfSales: StatementSectionView
  expenses: StatementSectionView
  grossMarginCents: string
  netResultCents: string
  warnings: StatementWarning[]
}

export interface BalanceSheetView {
  asOf: string
  storeId: string | null
  assets: StatementSectionView
  liabilities: StatementSectionView
  equity: StatementSectionView
  resultCents: string
  equityWithResultCents: string
  // null for the slice of one store: an entry may put its lines in two stores or in none, so a store's lines need not balance by themselves
  balanced: boolean | null
  warnings: StatementWarning[]
}

export interface CashFlowView {
  from: string
  to: string
  storeId: string | null
  sources: { source: string; inflowCents: string; outflowCents: string; netCents: string }[]
  inflowCents: string
  outflowCents: string
  netCents: string
  openingCents: string
  closingCents: string
  closes: boolean
  warnings: StatementWarning[]
}

export interface AgingRowView {
  partyType: string | null
  partyId: string | null
  partyName: string | null
  bucketsCents: string[]
  unappliedCents: string
  totalCents: string
}

export interface AgingView {
  kind: AgingKind
  asOf: string
  storeId: string | null
  // The upper bounds, in days, of every bucket but the last (AgingBucketDays)
  bucketDays: number[]
  rows: AgingRowView[]
  bucketsCents: string[]
  unappliedCents: string
  totalCents: string
  // The roles of this list that have no account mapped in the settings
  missingRoles: string[]
  warnings: StatementWarning[]
}

interface AccountSumRow {
  id: string
  code: string
  name: string
  type: string
  parent_id: string | null
  is_postable: boolean
  debit: bigint
  credit: bigint
}

interface AgingLineRow {
  party_type: string | null
  party_id: string | null
  entry_date: Date
  debit_cents: number
  credit_cents: number
}

const view = (section: StatementSection): StatementSectionView => ({
  totalCents: section.totalCents.toString(),
  rows: section.rows.map(row => ({
    ...row,
    balanceCents: row.balanceCents.toString(),
    rollupCents: row.rollupCents.toString()
  }))
})

const isoDay = (date: Date): string => date.toISOString().slice(0, 10)

// The statements and the lists with age of the books (TDD_18 §10): income statement, balance sheet, cash flow, payables and receivables by
// party. They read the lines of the journal for the organization of the request, by store when asked, and write nothing. What each one
// groups is the type and the parent of the accounts of the accountant's chart, and the account roles of the settings; a section or a
// role that is missing is warned, never filled in with a guess. A file taken out leaves an audit row (FINANCE_EXPORTED) once its rows
// are built, written the way every finance audit row is (not awaited, debt (k) of 4B.8a).
@Injectable()
export class FinanceStatementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async incomeStatement(organizationId: string, query: FlowQuery): Promise<IncomeStatementView> {
    await this.requireStore(organizationId, query.storeId)
    const accounts = await this.sums(organizationId, query.storeId ?? null, query.from, query.to)
    return this.incomeView(query, incomeStatement(accounts))
  }

  async balanceSheet(organizationId: string, query: BalanceSheetQuery): Promise<BalanceSheetView> {
    await this.requireStore(organizationId, query.storeId)
    const accounts = await this.sums(organizationId, query.storeId ?? null, null, query.asOf)
    return this.balanceView(query, balanceSheet(accounts))
  }

  async cashFlow(organizationId: string, query: FlowQuery): Promise<CashFlowView> {
    await this.requireStore(organizationId, query.storeId)
    const storeId = query.storeId ?? null
    const cashAccounts = await this.prisma.client.$queryRaw<[{ cash: bigint }]>`
      SELECT COUNT(*)::bigint AS cash FROM ledger_accounts
      WHERE organization_id = ${organizationId} AND cash_kind IS NOT NULL`
    // One statement, so the movements, the opening and the closing are read from the same snapshot: three reads could see a posting
    // that commits between them and report a cash flow that does not close on perfectly good books
    const rows = await this.prisma.client.$queryRaw<
      { source: string; inflow: bigint; outflow: bigint; opening: bigint; closing: bigint }[]
    >`
      SELECT COALESCE(e.source_type, ${FinanceSourceType.MANUAL}) AS source,
             COALESCE(SUM(l.debit_cents) FILTER (WHERE e.entry_date >= ${query.from}::date), 0)::bigint AS inflow,
             COALESCE(SUM(l.credit_cents) FILTER (WHERE e.entry_date >= ${query.from}::date), 0)::bigint AS outflow,
             COALESCE(SUM(l.debit_cents - l.credit_cents) FILTER (WHERE e.entry_date < ${query.from}::date), 0)::bigint AS opening,
             COALESCE(SUM(l.debit_cents - l.credit_cents), 0)::bigint AS closing
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
      JOIN ledger_accounts a ON a.id = l.account_id AND a.organization_id = l.organization_id
      WHERE l.organization_id = ${organizationId} AND a.cash_kind IS NOT NULL
        AND e.entry_date <= ${query.to}::date
        AND (${storeId}::text IS NULL OR l.store_id = ${storeId})
      GROUP BY 1`
    let opening = 0n
    let closing = 0n
    for (const row of rows) {
      opening += row.opening
      closing += row.closing
    }
    const flow = cashFlow(
      rows
        .filter(row => row.inflow !== 0n || row.outflow !== 0n)
        .map(row => ({ source: row.source, inflowCents: row.inflow, outflowCents: row.outflow })),
      opening,
      closing,
      (cashAccounts[0]?.cash ?? 0n) > 0n
    )
    return this.cashView(query, flow)
  }

  async aging(organizationId: string, query: AgingQuery): Promise<AgingView> {
    await this.requireStore(organizationId, query.storeId)
    const storeId = query.storeId ?? null
    const roles = AgingRoles[query.kind]
    const mapped = await this.prisma.client.accountRoleMapping.findMany({
      where: { organizationId, role: { in: [...roles] } },
      select: { role: true, accountId: true }
    })
    const missingRoles = roles.filter(role => !mapped.some(row => row.role === String(role)))
    const warnings: StatementWarning[] = []
    if (missingRoles.length > 0) warnings.push(StatementWarning.ROLE_NOT_MAPPED)
    const accountIds = [...new Set(mapped.map(row => row.accountId))]
    const lines =
      accountIds.length === 0
        ? []
        : await this.agingLines(organizationId, accountIds, query.asOf, storeId)
    // Lines come ordered by party: one pass cuts them into parties and ages each
    const growsOnCredit = query.kind === AgingKind.PAYABLES
    const groups = new Map<
      string,
      { type: string | null; id: string | null; lines: AgingLineRow[] }
    >()
    for (const line of lines) {
      const key = `${line.party_type ?? ''}:${line.party_id ?? ''}`
      const group = groups.get(key) ?? { type: line.party_type, id: line.party_id, lines: [] }
      group.lines.push(line)
      groups.set(key, group)
    }
    const names = await this.partyNames(organizationId, [...groups.values()])
    const rows: (AgingRowView & { aging: Aging })[] = []
    const totals = Array.from({ length: AgingBucketDays.length + 1 }, () => 0n)
    let unapplied = 0n
    let total = 0n
    for (const group of groups.values()) {
      const aging = agingOf(
        group.lines.map(line => ({
          entryDate: isoDay(line.entry_date),
          debitCents: BigInt(line.debit_cents),
          creditCents: BigInt(line.credit_cents)
        })),
        query.asOf,
        growsOnCredit,
        AgingBucketDays
      )
      aging.bucketsCents.forEach((cents, index) => {
        totals[index] = (totals[index] ?? 0n) + cents
      })
      unapplied += aging.unappliedCents
      total += aging.totalCents
      rows.push({
        partyType: group.type,
        partyId: group.id,
        partyName:
          group.id === null ? null : (names.get(`${group.type ?? ''}:${group.id}`) ?? null),
        bucketsCents: aging.bucketsCents.map(String),
        unappliedCents: aging.unappliedCents.toString(),
        totalCents: aging.totalCents.toString(),
        aging
      })
    }
    if (rows.some(row => row.partyId === null)) warnings.push(StatementWarning.LINES_WITHOUT_PARTY)
    return {
      kind: query.kind,
      asOf: query.asOf,
      storeId,
      bucketDays: [...AgingBucketDays],
      rows: rows.map(({ aging: _aging, ...row }) => row),
      bucketsCents: totals.map(String),
      unappliedCents: unapplied.toString(),
      totalCents: total.toString(),
      missingRoles: missingRoles.map(String),
      warnings
    }
  }

  // The rows of the files: the same numbers as the views above, as the numbers of a spreadsheet. The audit row follows the rows, so a file
  // that could not be built leaves no record of an export.
  async incomeStatementCsvRows(
    organizationId: string,
    query: FlowQuery,
    actor: Actor
  ): Promise<StatementCsvRow[]> {
    await this.requireStore(organizationId, query.storeId)
    const accounts = await this.sums(organizationId, query.storeId ?? null, query.from, query.to)
    const statement = incomeStatement(accounts)
    const rows = [
      ...sectionRows(AccountType.INCOME, statement.income),
      ...sectionRows(AccountType.COST_OF_SALES, statement.costOfSales),
      ...sectionRows(AccountType.EXPENSE, statement.expenses),
      summary(StatementTotalLine.GROSS_MARGIN, statement.grossMarginCents),
      summary(StatementTotalLine.NET_RESULT, statement.netResultCents),
      ...warningRows(statement.warnings)
    ]
    capRows(rows)
    this.auditExport(organizationId, actor, FinanceReport.INCOME_STATEMENT, {
      from: query.from,
      to: query.to,
      storeId: query.storeId ?? '',
      rows: rows.length
    })
    return rows
  }

  async balanceSheetCsvRows(
    organizationId: string,
    query: BalanceSheetQuery,
    actor: Actor
  ): Promise<StatementCsvRow[]> {
    await this.requireStore(organizationId, query.storeId)
    const accounts = await this.sums(organizationId, query.storeId ?? null, null, query.asOf)
    const sheet = balanceSheet(accounts)
    const rows = [
      ...sectionRows(AccountType.ASSET, sheet.assets),
      ...sectionRows(AccountType.LIABILITY, sheet.liabilities),
      ...sectionRows(AccountType.EQUITY, sheet.equity),
      summary(StatementTotalLine.RESULT_NOT_CLOSED, sheet.resultCents),
      summary(StatementTotalLine.EQUITY_WITH_RESULT, sheet.equityWithResultCents),
      // The slice of one store carries no verdict, as in the view
      ...warningRows(query.storeId === undefined ? sheet.warnings : [])
    ]
    capRows(rows)
    this.auditExport(organizationId, actor, FinanceReport.BALANCE_SHEET, {
      asOf: query.asOf,
      storeId: query.storeId ?? '',
      rows: rows.length
    })
    return rows
  }

  async cashFlowCsvRows(
    organizationId: string,
    query: FlowQuery,
    actor: Actor
  ): Promise<StatementCsvRow[]> {
    const flow = await this.cashFlow(organizationId, query)
    const rows: StatementCsvRow[] = [
      ...flow.sources.map(source => ({
        section: StatementCsvSection.CASH,
        code: source.source,
        name: source.source,
        amountCents: centsAsNumber(BigInt(source.netCents)),
        rollupCents: null
      })),
      summary(StatementTotalLine.OPENING, BigInt(flow.openingCents)),
      summary(StatementTotalLine.NET, BigInt(flow.netCents)),
      summary(StatementTotalLine.CLOSING, BigInt(flow.closingCents)),
      ...warningRows(flow.warnings)
    ]
    this.auditExport(organizationId, actor, FinanceReport.CASH_FLOW, {
      from: query.from,
      to: query.to,
      storeId: query.storeId ?? '',
      rows: rows.length
    })
    return rows
  }

  async agingCsvRows(
    organizationId: string,
    query: AgingQuery,
    actor: Actor
  ): Promise<AgingCsvRow[]> {
    const report = await this.aging(organizationId, query)
    const rows = report.rows.map(row => ({
      partyType: row.partyType,
      partyId: row.partyId,
      partyName: row.partyName,
      bucketsCents: row.bucketsCents.map(cents => centsAsNumber(BigInt(cents))),
      unappliedCents: centsAsNumber(BigInt(row.unappliedCents)),
      totalCents: centsAsNumber(BigInt(row.totalCents))
    }))
    this.auditExport(organizationId, actor, FinanceReport.AGING, {
      kind: query.kind,
      asOf: query.asOf,
      storeId: query.storeId ?? '',
      rows: rows.length
    })
    return rows
  }

  // A store named in a query is a store of this organization, or the answer is the one of any resource that is not there
  private async requireStore(organizationId: string, storeId: string | undefined): Promise<void> {
    if (storeId === undefined) return
    const found = await this.prisma.client.store.count({ where: { id: storeId, organizationId } })
    if (found === 0) throw resourceNotFound('store')
  }

  // Every account of the organization with the sums of its lines in a range of days (`from` null = since the books started): the sections
  // come from the type of each account, so the statement follows the chart and never a list of codes
  private async sums(
    organizationId: string,
    storeId: string | null,
    from: string | null,
    to: string
  ): Promise<StatementAccount[]> {
    const rows = await this.prisma.client.$queryRaw<AccountSumRow[]>`
      SELECT a.id, a.code, a.name, a.type, a.parent_id, a.is_postable,
             COALESCE(s.debit, 0)::bigint AS debit, COALESCE(s.credit, 0)::bigint AS credit
      FROM ledger_accounts a
      LEFT JOIN (
        SELECT l.account_id, SUM(l.debit_cents) AS debit, SUM(l.credit_cents) AS credit
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
        WHERE l.organization_id = ${organizationId}
          AND (${from}::date IS NULL OR e.entry_date >= ${from}::date)
          AND e.entry_date <= ${to}::date
          AND (${storeId}::text IS NULL OR l.store_id = ${storeId})
        GROUP BY l.account_id
      ) s ON s.account_id = a.id
      WHERE a.organization_id = ${organizationId}
      ORDER BY a.code`
    return rows.map(row => ({
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type as AccountType,
      parentId: row.parent_id,
      isPostable: row.is_postable,
      debitCents: row.debit,
      creditCents: row.credit
    }))
  }

  // The lines of the accounts of one list, in the order of the ledger inside each party. A list longer than a file is refused: it is read
  // into memory to be aged, and the range to narrow here is the store.
  private async agingLines(
    organizationId: string,
    accountIds: string[],
    asOf: string,
    storeId: string | null
  ): Promise<AgingLineRow[]> {
    const rows = await this.prisma.client.$queryRaw<AgingLineRow[]>`
      SELECT l.party_type, l.party_id, e.entry_date, l.debit_cents, l.credit_cents
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
      WHERE l.organization_id = ${organizationId}
        AND l.account_id = ANY(${accountIds}::text[])
        AND e.entry_date <= ${asOf}::date
        AND (${storeId}::text IS NULL OR l.store_id = ${storeId})
      ORDER BY l.party_type NULLS FIRST, l.party_id NULLS FIRST, e.entry_date, e.number, l.line_no
      LIMIT ${FinanceReportLimits.MAX_CSV_ROWS + 1}`
    if (rows.length > FinanceReportLimits.MAX_CSV_ROWS) {
      throw new PlatformException(
        ErrorCodes.EXPORT_TOO_LARGE,
        'the list would read more lines than one report: narrow it to a store',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    return rows
  }

  // The names of the parties of a list, read only for the organization of the request: a supplier of the organization, a carrier
  // connection of one of its stores. A party that is gone keeps its id and no name.
  private async partyNames(
    organizationId: string,
    groups: readonly { type: string | null; id: string | null }[]
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    const idsOf = (type: PartyType): string[] =>
      groups.flatMap(group => (group.type === String(type) && group.id !== null ? [group.id] : []))
    const suppliers = idsOf(PartyType.SUPPLIER)
    if (suppliers.length > 0) {
      const found = await this.prisma.client.supplier.findMany({
        where: { organizationId, id: { in: suppliers } },
        select: { id: true, name: true }
      })
      for (const row of found) names.set(`${PartyType.SUPPLIER}:${row.id}`, row.name)
    }
    const connections = idsOf(PartyType.CARRIER_CONNECTION)
    if (connections.length > 0) {
      const found = await this.prisma.client.carrierConnection.findMany({
        where: { id: { in: connections }, store: { organizationId } },
        select: { id: true, displayName: true }
      })
      for (const row of found)
        names.set(`${PartyType.CARRIER_CONNECTION}:${row.id}`, row.displayName)
    }
    return names
  }

  private incomeView(query: FlowQuery, statement: IncomeStatement): IncomeStatementView {
    return {
      from: query.from,
      to: query.to,
      storeId: query.storeId ?? null,
      income: view(statement.income),
      costOfSales: view(statement.costOfSales),
      expenses: view(statement.expenses),
      grossMarginCents: statement.grossMarginCents.toString(),
      netResultCents: statement.netResultCents.toString(),
      warnings: statement.warnings
    }
  }

  private balanceView(query: BalanceSheetQuery, sheet: BalanceSheet): BalanceSheetView {
    return {
      asOf: query.asOf,
      storeId: query.storeId ?? null,
      assets: view(sheet.assets),
      liabilities: view(sheet.liabilities),
      equity: view(sheet.equity),
      resultCents: sheet.resultCents.toString(),
      equityWithResultCents: sheet.equityWithResultCents.toString(),
      balanced: query.storeId === undefined ? sheet.balanced : null,
      warnings: query.storeId === undefined ? sheet.warnings : []
    }
  }

  private cashView(query: FlowQuery, flow: CashFlow): CashFlowView {
    return {
      from: query.from,
      to: query.to,
      storeId: query.storeId ?? null,
      sources: flow.sources.map(row => ({
        source: row.source,
        inflowCents: row.inflowCents.toString(),
        outflowCents: row.outflowCents.toString(),
        netCents: row.netCents.toString()
      })),
      inflowCents: flow.inflowCents.toString(),
      outflowCents: flow.outflowCents.toString(),
      netCents: flow.netCents.toString(),
      openingCents: flow.openingCents.toString(),
      closingCents: flow.closingCents.toString(),
      closes: flow.closes,
      warnings: flow.warnings
    }
  }

  private auditExport(
    organizationId: string,
    actor: Actor,
    report: FinanceReport,
    metadata: Record<string, string | number>
  ): void {
    this.audit.log({
      action: AuditAction.FINANCE_EXPORTED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.REPORT,
      resourceId: organizationId,
      metadata: { report, ...metadata },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}

// A chart is not bounded here, so a statement file is held to the same cap as every other file
function capRows(rows: readonly unknown[]): void {
  if (rows.length > FinanceReportLimits.MAX_CSV_ROWS) {
    throw new PlatformException(
      ErrorCodes.EXPORT_TOO_LARGE,
      'the file would be larger than one export',
      HttpStatusCodes.BAD_REQUEST
    )
  }
}

function sectionRows(type: AccountType, section: StatementSection): StatementCsvRow[] {
  return [
    ...section.rows.map(row => ({
      section: type,
      code: row.code,
      name: row.name,
      amountCents: centsAsNumber(row.balanceCents),
      rollupCents: centsAsNumber(row.rollupCents)
    })),
    {
      section: type,
      code: null,
      name: StatementTotalLine.TOTAL,
      amountCents: centsAsNumber(section.totalCents),
      rollupCents: null
    }
  ]
}

const summary = (line: StatementTotalLine, cents: bigint): StatementCsvRow => ({
  section: StatementCsvSection.SUMMARY,
  code: null,
  name: line,
  amountCents: centsAsNumber(cents),
  rollupCents: null
})

const warningRows = (warnings: readonly StatementWarning[]): StatementCsvRow[] =>
  warnings.map(warning => ({
    section: StatementCsvSection.WARNING,
    code: null,
    name: warning,
    amountCents: 0,
    rollupCents: null
  }))
