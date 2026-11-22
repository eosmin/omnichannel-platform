import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { JobContext, PrismaService } from '@platform/core/database'
import { FinanceReportLimits, FinanceResourceTypes, NormalSide } from '@platform/core/domain'
import {
  ErrorCodes,
  errorName,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { normalBalance, trialBalanceTotals, withRunningBalance } from '@platform/core/finance'

import type { Actor } from '../tenancy'

import { FinanceReportGate } from './finance-report-gate.service'
import {
  type JournalCsvRow,
  type LedgerCsvRow,
  type TrialBalanceCsvRow
} from './finance-reports.csv'
import type {
  AccountBalancesQuery,
  JournalCsvQuery,
  LedgerCsvQuery,
  LedgerQuery,
  TrialBalanceQuery
} from './finance-reports.schemas'
import { centsAsNumber } from './finance.support'
import { isoDay } from './finance.views'

export interface TrialBalanceRowView {
  accountId: string
  code: string
  name: string
  type: string
  debitCents: string
  creditCents: string
  // On the side where the account normally sits
  balanceCents: string
}

export interface TrialBalanceView {
  periodId: string
  storeId: string | null
  rows: TrialBalanceRowView[]
  totals: { debitCents: string; creditCents: string; balanced: boolean }
}

export interface AccountBalanceRowView {
  accountId: string
  code: string
  name: string
  type: string
  isPostable: boolean
  // cash | bank | wallet for the accounts of money, null for the rest: the screen highlights the ones with a value
  cashKind: string | null
  debitCents: string
  creditCents: string
  // On the side where the account normally sits
  balanceCents: string
}

export interface AccountBalancesView {
  asOf: string
  storeId: string | null
  rows: AccountBalanceRowView[]
  totals: { debitCents: string; creditCents: string; balanced: boolean | null }
}

interface AccountBalanceSqlRow {
  id: string
  code: string
  name: string
  type: string
  normal_side: string
  is_postable: boolean
  cash_kind: string | null
  debit: bigint
  credit: bigint
}

export interface LedgerLineView {
  entryId: string
  number: string
  entryDate: string
  lineNo: number
  type: string
  sourceType: string | null
  sourceId: string | null
  entryMemo: string | null
  lineMemo: string | null
  storeId: string | null
  partyType: string | null
  partyId: string | null
  debitCents: string
  creditCents: string
  // The balance of the account after this line, on its normal side
  runningCents: string
}

export interface LedgerView {
  account: { id: string; code: string; name: string; type: string; normalSide: string }
  // What the account held before the first line of this page
  openingCents: string
  lines: LedgerLineView[]
  nextCursor: string | null
  hasMore: boolean
}

interface LedgerRow {
  entry_id: string
  number: bigint
  entry_date: Date
  type: string
  source_type: string | null
  source_id: string | null
  entry_memo: string | null
  line_no: number
  store_id: string | null
  party_type: string | null
  party_id: string | null
  line_memo: string | null
  debit_cents: number
  credit_cents: number
}

interface JournalRow extends LedgerRow {
  period_id: string
  source_date: Date | null
  reverses_entry_id: string | null
  idempotency_key: string
  currency: string
  total_cents: number
  origin: string
  created_by: string | null
  prev_hash: string | null
  hash: string
  account_id: string
  account_code: string
  account_name: string
  tax_rate_id: string | null
}

const tooLarge = (): PlatformException =>
  new PlatformException(
    ErrorCodes.EXPORT_TOO_LARGE,
    'the file would be larger than one export: narrow the dates',
    HttpStatusCodes.BAD_REQUEST
  )

// The reports of the books (TDD_18 §10): the trial balance of a period, the ledger of an account with its running balance, and the
// auditor's CSV files. Everything is read for the organization of the request, through the balances and the lines, and nothing here
// writes the journal. A file taken out leaves an audit row (FINANCE_EXPORTED) before the first byte.
@Injectable()
export class FinanceReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly jobContext: JobContext,
    private readonly gate: FinanceReportGate,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FinanceReportsService.name)
  }

  async trialBalance(organizationId: string, query: TrialBalanceQuery): Promise<TrialBalanceView> {
    const db = this.prisma.client
    const period = await db.fiscalPeriod.count({ where: { id: query.periodId, organizationId } })
    if (period === 0) throw resourceNotFound('fiscal period')
    const sums = await db.accountPeriodBalance.groupBy({
      by: ['accountId'],
      where: {
        organizationId,
        periodId: query.periodId,
        ...(query.storeId === undefined ? {} : { storeId: query.storeId })
      },
      _sum: { debitCents: true, creditCents: true }
    })
    const accounts = await db.ledgerAccount.findMany({
      where: { organizationId, id: { in: sums.map(sum => sum.accountId) } },
      select: { id: true, code: true, name: true, type: true, normalSide: true },
      orderBy: { code: 'asc' }
    })
    const bySum = new Map(sums.map(sum => [sum.accountId, sum._sum]))
    const rows = accounts.map(account => {
      const sum = bySum.get(account.id)
      const debitCents = sum?.debitCents ?? 0n
      const creditCents = sum?.creditCents ?? 0n
      return {
        accountId: account.id,
        code: account.code,
        name: account.name,
        type: account.type,
        debitCents,
        creditCents,
        balanceCents: normalBalance(
          { debitCents, creditCents },
          (account.normalSide as NormalSide) === NormalSide.DEBIT
        )
      }
    })
    const totals = trialBalanceTotals(rows)
    return {
      periodId: query.periodId,
      storeId: query.storeId ?? null,
      rows: rows.map(row => ({
        ...row,
        debitCents: row.debitCents.toString(),
        creditCents: row.creditCents.toString(),
        balanceCents: row.balanceCents.toString()
      })),
      totals: {
        debitCents: totals.debitCents.toString(),
        creditCents: totals.creditCents.toString(),
        balanced: totals.balanced
      }
    }
  }

  // What each account holds at the end of a day, since the books started (TDD_18 §10, "balances by account"): the sum of its lines up to the
  // date, so it does not depend on how the periods were cut. One store narrows the lines; then the totals need not balance (an entry may put
  // its lines in two stores or in none), so `balanced` is null, as in the balance sheet. Accounts with no line and no cash kind are left out.
  async accountBalances(
    organizationId: string,
    query: AccountBalancesQuery
  ): Promise<AccountBalancesView> {
    const storeId = query.storeId ?? null
    if (storeId !== null) {
      const store = await this.prisma.client.store.count({ where: { id: storeId, organizationId } })
      if (store === 0) throw resourceNotFound('store')
    }
    const found = await this.prisma.client.$queryRaw<AccountBalanceSqlRow[]>`
      SELECT a.id, a.code, a.name, a.type, a.normal_side, a.is_postable, a.cash_kind,
             COALESCE(s.debit, 0)::bigint AS debit, COALESCE(s.credit, 0)::bigint AS credit
      FROM ledger_accounts a
      LEFT JOIN (
        SELECT l.account_id, SUM(l.debit_cents) AS debit, SUM(l.credit_cents) AS credit
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
        WHERE l.organization_id = ${organizationId}
          AND e.entry_date <= ${query.asOf}::date
          AND (${storeId}::text IS NULL OR l.store_id = ${storeId}::text)
        GROUP BY l.account_id
      ) s ON s.account_id = a.id
      WHERE a.organization_id = ${organizationId} AND (s.account_id IS NOT NULL OR a.cash_kind IS NOT NULL)
      ORDER BY a.code`
    const rows = found.map(row => ({
      row,
      balance: normalBalance(
        { debitCents: row.debit, creditCents: row.credit },
        (row.normal_side as NormalSide) === NormalSide.DEBIT
      )
    }))
    const totals = trialBalanceTotals(
      rows.map(({ row }) => ({ debitCents: row.debit, creditCents: row.credit }))
    )
    return {
      asOf: query.asOf,
      storeId,
      rows: rows.map(({ row, balance }) => ({
        accountId: row.id,
        code: row.code,
        name: row.name,
        type: row.type,
        isPostable: row.is_postable,
        cashKind: row.cash_kind,
        debitCents: row.debit.toString(),
        creditCents: row.credit.toString(),
        balanceCents: balance.toString()
      })),
      totals: {
        debitCents: totals.debitCents.toString(),
        creditCents: totals.creditCents.toString(),
        balanced: storeId === null ? totals.balanced : null
      }
    }
  }

  // `carriedOpening` is the balance the caller already knows at the start of this page: the CSV walks the pages and carries it
  async ledger(
    organizationId: string,
    query: LedgerQuery,
    carriedOpening?: bigint
  ): Promise<LedgerView> {
    const account = await this.accountOf(organizationId, query.accountId)
    const normalIsDebit = (account.normalSide as NormalSide) === NormalSide.DEBIT
    const cursor = query.cursor === undefined ? null : parseCursor(query.cursor)
    const storeId = query.storeId ?? null
    const partyType = query.partyType ?? null
    const partyId = query.partyId ?? null
    const from = query.from ?? null
    const to = query.to ?? null
    const db = this.prisma.client

    const [before] =
      carriedOpening === undefined
        ? await db.$queryRaw<{ debit: bigint; credit: bigint }[]>`
      SELECT COALESCE(SUM(l.debit_cents), 0)::bigint AS debit, COALESCE(SUM(l.credit_cents), 0)::bigint AS credit
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
      WHERE l.organization_id = ${organizationId} AND l.account_id = ${query.accountId}
        AND (${storeId}::text IS NULL OR l.store_id = ${storeId}::text)
        AND (${partyType}::text IS NULL OR l.party_type = ${partyType}::text)
        AND (${partyId}::text IS NULL OR l.party_id = ${partyId}::text)
        AND (
          (${cursor?.date ?? null}::date IS NOT NULL
            AND (e.entry_date, e.number, l.line_no) <= (${cursor?.date ?? null}::date, ${cursor?.number ?? null}::bigint, ${cursor?.lineNo ?? null}::int))
          OR (${cursor?.date ?? null}::date IS NULL AND ${from}::date IS NOT NULL AND e.entry_date < ${from}::date)
        )`
        : []
    const opening =
      carriedOpening ??
      normalBalance(
        { debitCents: before?.debit ?? 0n, creditCents: before?.credit ?? 0n },
        normalIsDebit
      )
    const rows = await db.$queryRaw<LedgerRow[]>`
      SELECT e.id AS entry_id, e.number, e.entry_date, e.type, e.source_type, e.source_id, e.memo AS entry_memo,
             l.line_no, l.store_id, l.party_type, l.party_id, l.memo AS line_memo, l.debit_cents, l.credit_cents
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
      WHERE l.organization_id = ${organizationId} AND l.account_id = ${query.accountId}
        AND (${storeId}::text IS NULL OR l.store_id = ${storeId}::text)
        AND (${partyType}::text IS NULL OR l.party_type = ${partyType}::text)
        AND (${partyId}::text IS NULL OR l.party_id = ${partyId}::text)
        AND (${from}::date IS NULL OR e.entry_date >= ${from}::date)
        AND (${to}::date IS NULL OR e.entry_date <= ${to}::date)
        AND (${cursor?.date ?? null}::date IS NULL
             OR (e.entry_date, e.number, l.line_no) > (${cursor?.date ?? null}::date, ${cursor?.number ?? null}::bigint, ${cursor?.lineNo ?? null}::int))
      ORDER BY e.entry_date, e.number, l.line_no
      LIMIT ${query.limit + 1}`
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const running = withRunningBalance(
      opening,
      page.map(row => ({
        key: `${row.entry_id}:${String(row.line_no)}`,
        debitCents: BigInt(row.debit_cents),
        creditCents: BigInt(row.credit_cents)
      })),
      normalIsDebit
    )
    const last = page.at(-1)
    return {
      account,
      openingCents: opening.toString(),
      lines: page.map((row, index) => ({
        entryId: row.entry_id,
        number: row.number.toString(),
        entryDate: isoDay(row.entry_date),
        lineNo: row.line_no,
        type: row.type,
        sourceType: row.source_type,
        sourceId: row.source_id,
        entryMemo: row.entry_memo,
        lineMemo: row.line_memo,
        storeId: row.store_id,
        partyType: row.party_type,
        partyId: row.party_id,
        debitCents: String(row.debit_cents),
        creditCents: String(row.credit_cents),
        runningCents: (running[index]?.runningCents ?? 0n).toString()
      })),
      nextCursor:
        hasMore && last !== undefined
          ? `${isoDay(last.entry_date)}:${last.number.toString()}:${String(last.line_no)}`
          : null,
      hasMore
    }
  }

  // The rows of the auditor's CSV of the trial balance of a period: the same figures as the screen, in cents
  async trialBalanceCsvRows(
    organizationId: string,
    query: TrialBalanceQuery,
    actor: Actor
  ): Promise<TrialBalanceCsvRow[]> {
    const report = await this.trialBalance(organizationId, query)
    const rows = report.rows.map(row => ({
      code: row.code,
      name: row.name,
      type: row.type,
      debitCents: centsAsNumber(BigInt(row.debitCents)),
      creditCents: centsAsNumber(BigInt(row.creditCents)),
      balanceCents: centsAsNumber(BigInt(row.balanceCents))
    }))
    this.auditExport(organizationId, actor, 'trial_balance', {
      periodId: query.periodId,
      rows: rows.length
    })
    return rows
  }

  // The CSV of the journal: one row per line with everything the hash covers, so an auditor holding only the file can recompute the chain.
  // The route is @NoTenantTransaction: the file is read as it is sent, after the handler returned, so no transaction of the request is open
  // then. The count (and the audit row that says it) is one short unit of the organization and each page another, never one held open for
  // the whole download. The count also takes the highest entry number of the range: every page stops there, so the file holds exactly the
  // rows that were counted and audited (the book is append-only with consecutive numbers: an entry that arrives meanwhile can only come
  // after that number).
  async journalCsv(
    organizationId: string,
    query: JournalCsvQuery,
    actor: Actor
  ): Promise<AsyncGenerator<JournalCsvRow[]>> {
    // The file takes one of the few places an organization has for files being sent (debt (a) of 7.3-D): the place is held for the whole
    // download and given back when the stream ends or the client drops
    return this.gate.openStream(organizationId, async () => {
      const { rows, maxNumber } = await this.jobContext.inOrganization(organizationId, async () => {
        const [counted] = await this.prisma.client.$queryRaw<
          [{ rows: bigint; max_number: bigint | null }]
        >`
        SELECT COUNT(*)::bigint AS rows, MAX(e.number) AS max_number
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
        WHERE e.organization_id = ${organizationId}
          AND e.entry_date >= ${query.from}::date AND e.entry_date <= ${query.to}::date`
        if (counted.rows > BigInt(FinanceReportLimits.MAX_CSV_ROWS)) throw tooLarge()
        this.auditExport(organizationId, actor, 'journal', {
          from: query.from,
          to: query.to,
          rows: Number(counted.rows)
        })
        return { rows: counted.rows, maxNumber: counted.max_number }
      })
      // Nothing in the range: the file is the header alone
      const cut = rows === 0n ? null : maxNumber
      return () => this.journalPages(organizationId, query, cut)
    })
  }

  private async *journalPages(
    organizationId: string,
    query: JournalCsvQuery,
    maxNumber: bigint | null
  ): AsyncGenerator<JournalCsvRow[]> {
    if (maxNumber === null) return
    let after: { number: bigint; lineNo: number } | null = null
    for (;;) {
      const lastNumber: bigint | null = after?.number ?? null
      const lastLine: number | null = after?.lineNo ?? null
      let page: JournalRow[]
      try {
        page = await this.jobContext.inOrganization(
          organizationId,
          () =>
            this.prisma.client.$queryRaw<JournalRow[]>`
        SELECT e.id AS entry_id, e.number, e.entry_date, e.period_id, e.type, e.source_type, e.source_id, e.source_date,
               e.reverses_entry_id, e.idempotency_key, e.memo AS entry_memo, e.currency, e.total_cents, e.origin, e.created_by,
               e.prev_hash, e.hash, l.line_no, l.account_id, a.code AS account_code, a.name AS account_name, l.debit_cents,
               l.credit_cents, l.store_id, l.party_type, l.party_id, l.tax_rate_id, l.memo AS line_memo
        FROM journal_lines l
        JOIN journal_entries e ON e.id = l.entry_id AND e.organization_id = l.organization_id
        JOIN ledger_accounts a ON a.id = l.account_id AND a.organization_id = l.organization_id
        WHERE e.organization_id = ${organizationId}
          AND e.entry_date >= ${query.from}::date AND e.entry_date <= ${query.to}::date
          AND e.number <= ${maxNumber}::bigint
          AND (${lastNumber}::bigint IS NULL OR (e.number, l.line_no) > (${lastNumber}::bigint, ${lastLine}::int))
        ORDER BY e.number, l.line_no
        LIMIT ${FinanceReportLimits.CSV_PAGE_SIZE}`
        )
      } catch (error) {
        // The headers went already: the stream is cut (never a short file that looks whole) and the audit row stays what it was, a request
        this.logger.error(
          { organizationId, errorName: errorName(error) },
          'a page of the journal file could not be read; the file was cut'
        )
        throw error
      }
      if (page.length === 0) return
      yield page.map(row => ({
        number: Number(row.number),
        entryId: row.entry_id,
        entryDate: isoDay(row.entry_date),
        periodId: row.period_id,
        type: row.type,
        sourceType: row.source_type,
        sourceId: row.source_id,
        sourceDate: row.source_date === null ? null : isoDay(row.source_date),
        reversesEntryId: row.reverses_entry_id,
        idempotencyKey: row.idempotency_key,
        entryMemo: row.entry_memo,
        currency: row.currency,
        totalCents: row.total_cents,
        origin: row.origin,
        createdBy: row.created_by,
        prevHash: row.prev_hash,
        hash: row.hash,
        lineNo: row.line_no,
        accountId: row.account_id,
        accountCode: row.account_code,
        accountName: row.account_name,
        debitCents: row.debit_cents,
        creditCents: row.credit_cents,
        storeId: row.store_id,
        partyType: row.party_type,
        partyId: row.party_id,
        taxRateId: row.tax_rate_id,
        lineMemo: row.line_memo
      }))
      const last = page.at(-1)
      if (page.length < FinanceReportLimits.CSV_PAGE_SIZE || last === undefined) return
      after = { number: last.number, lineNo: last.line_no }
    }
  }

  // The CSV of the ledger of one account for a range: its lines with the running balance, from the balance the account held the day before
  async ledgerCsv(
    organizationId: string,
    query: LedgerCsvQuery,
    actor: Actor
  ): Promise<{ account: LedgerView['account']; rows: LedgerCsvRow[] }> {
    const rows: LedgerCsvRow[] = []
    let cursor: string | undefined
    let carried: bigint | undefined
    const account = await this.accountOf(organizationId, query.accountId)
    for (;;) {
      const page: LedgerView = await this.ledger(
        organizationId,
        {
          accountId: query.accountId,
          from: query.from,
          to: query.to,
          ...(query.storeId === undefined ? {} : { storeId: query.storeId }),
          ...(query.partyType === undefined ? {} : { partyType: query.partyType }),
          ...(query.partyId === undefined ? {} : { partyId: query.partyId }),
          ...(cursor === undefined ? {} : { cursor }),
          limit: FinanceReportLimits.LEDGER_PAGE_MAX
        },
        carried
      )
      carried = BigInt(page.lines.at(-1)?.runningCents ?? page.openingCents)
      if (rows.length + page.lines.length > FinanceReportLimits.MAX_CSV_ROWS) throw tooLarge()
      for (const line of page.lines) {
        rows.push({
          number: Number(line.number),
          entryDate: line.entryDate,
          lineNo: line.lineNo,
          type: line.type,
          sourceType: line.sourceType,
          sourceId: line.sourceId,
          entryMemo: line.entryMemo,
          lineMemo: line.lineMemo,
          storeId: line.storeId,
          partyType: line.partyType,
          partyId: line.partyId,
          debitCents: centsAsNumber(BigInt(line.debitCents)),
          creditCents: centsAsNumber(BigInt(line.creditCents)),
          runningCents: centsAsNumber(BigInt(line.runningCents))
        })
      }
      if (!page.hasMore || page.nextCursor === null) break
      cursor = page.nextCursor
    }
    this.auditExport(organizationId, actor, 'ledger', {
      accountId: query.accountId,
      from: query.from,
      to: query.to,
      // A narrowed file is told from a whole one in the audit row
      ...(query.storeId === undefined ? {} : { storeId: query.storeId }),
      ...(query.partyType === undefined ? {} : { partyType: query.partyType }),
      ...(query.partyId === undefined ? {} : { partyId: query.partyId }),
      rows: rows.length
    })
    return { account, rows }
  }

  private async accountOf(
    organizationId: string,
    accountId: string
  ): Promise<LedgerView['account']> {
    const account = await this.prisma.client.ledgerAccount.findFirst({
      where: { id: accountId, organizationId },
      select: { id: true, code: true, name: true, type: true, normalSide: true }
    })
    if (account === null) throw resourceNotFound('ledger account')
    return account
  }

  private auditExport(
    organizationId: string,
    actor: Actor,
    report: string,
    metadata: Record<string, string | number>
  ): void {
    this.audit.log({
      action: AuditAction.FINANCE_EXPORTED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.ENTRY,
      resourceId: organizationId,
      metadata: { report, ...metadata },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}

function parseCursor(cursor: string): { date: string; number: bigint; lineNo: number } {
  const [date = '', number = '0', lineNo = '0'] = cursor.split(':')
  return { date, number: BigInt(number), lineNo: Number(lineNo) }
}
