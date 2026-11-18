import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { isUniqueViolation, PrismaService } from '@platform/core/database'
import {
  FinanceAutoMemo,
  FinancePostingKey,
  FinanceReportLimits,
  FinanceResourceTypes,
  FinanceSourceType,
  FiscalDocumentKind,
  JournalEntryType,
  LegalBookCorrelativeRestart,
  LegalBookField,
  LegalBookKind,
  LegalBookLayoutSource,
  legalBookReport,
  LegalBookSort,
  LegalBookUnissuedSales,
  PeriodStatus,
  VatLineKind
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import {
  type BookCell,
  type BookColumn,
  type BookSourceRow,
  buildLegalBook,
  correlativeBucketStart,
  layoutProblem,
  type LegalBookLayout,
  proposedLayout,
  saleBookOfDocumentType,
  vatLinesOfOrder
} from '@platform/core/finance'
import { FiscalProviderRegistry } from '@platform/fiscal/runtime'

import type { Actor } from '../tenancy'

import { bookCsv, bookSha256 } from './finance-books.csv'
import type { BookLayoutBody, BookQuery, FrozenBooksQuery } from './finance-books.schemas'
import { lockScope } from './finance.support'
import { isoDay } from './finance.views'

// What a layout is, to whoever reads it. `source` says whose it is: the proposal ships with the code and nobody has validated it; a
// stored one is the organization's own, and `accountantConfirmed` says whether its accountant vouched for it. **[ACCOUNTANT]**
export interface BookLayoutView {
  kind: LegalBookKind
  // 0 is the proposal of the code, 1 and up are the versions the organization wrote
  version: number
  source: LegalBookLayoutSource
  accountantConfirmed: boolean
  columns: BookColumn[]
  sort: LegalBookSort
  correlativeStart: number
  correlativeRestart: LegalBookCorrelativeRestart
  unissuedSales: LegalBookUnissuedSales
  createdAt: string | null
}

// What the book could not list, counted so that a file that looks whole is not one that left sales out
export interface BookWarnings {
  // Sales whose order has no tax snapshot (made before the columns existed) or whose snapshot does not add up
  salesWithoutTaxSnapshot: number
  salesNotReadable: number
  // Sales whose fiscal document was voided before the period ended: left out, the sale is not one
  voidedDocuments: number
  // Sales whose document is of a provider or a type this deployment does not know (a credit note is not the sale's document)
  unclassifiedDocuments: number
  // The returns of the period (entries of a return): the credit notes of a return are not listed yet (Step 4B.7b)
  returnsNotListed: number
}

export interface BookView {
  kind: LegalBookKind
  period: {
    id: string
    year: number
    month: number
    from: string
    to: string
    status: PeriodStatus
  }
  layout: {
    version: number
    source: LegalBookLayoutSource
    accountantConfirmed: boolean
  }
  // True while the layout is the proposal or no accountant has confirmed it: the book is a draft, not the legal book
  unvalidated: boolean
  header: string[]
  rows: BookCell[][]
  totals: Partial<Record<LegalBookField, number>>
  warnings: BookWarnings
  // The sha256 of the CSV of this book; a frozen book is served again with the same one
  contentSha256: string
  // True when the book is the one frozen at the close of the period (served from the snapshot, not rebuilt)
  frozen: boolean
}

export interface FrozenBookView {
  id: string
  periodId: string
  kind: LegalBookKind
  layoutVersion: number
  closedAt: string
  contentSha256: string
  createdAt: string
}

// What a snapshot keeps: the book and the CSV that was frozen with it
type StoredBook = Omit<BookView, 'frozen'> & { csv: string }
const withoutCsv = (stored: StoredBook): Omit<BookView, 'frozen'> =>
  Object.fromEntries(Object.entries(stored).filter(([key]) => key !== 'csv')) as Omit<
    BookView,
    'frozen'
  >

const tooLarge = (): PlatformException =>
  new PlatformException(
    ErrorCodes.EXPORT_TOO_LARGE,
    'the book would be larger than one export: ask for a shorter period',
    HttpStatusCodes.BAD_REQUEST
  )

const STORED = LegalBookLayoutSource.STORED
const PROPOSAL = LegalBookLayoutSource.PROPOSAL

type LayoutRow = {
  id: string
  bookKind: string
  version: number
  columns: unknown
  sort: string
  correlativeStart: number
  correlativeRestart: string
  unissuedSales: string
  accountantConfirmed: boolean
  createdAt: Date
}

const LAYOUT_SELECT = {
  id: true,
  bookKind: true,
  version: true,
  columns: true,
  sort: true,
  correlativeStart: true,
  correlativeRestart: true,
  unissuedSales: true,
  accountantConfirmed: true,
  createdAt: true
} as const

const columnsOf = (value: unknown): BookColumn[] =>
  Array.isArray(value)
    ? value.map(item => {
        const record = item as { field: LegalBookField; label: string | null }
        return { field: record.field, label: record.label }
      })
    : []

const layoutOfRow = (row: LayoutRow): LegalBookLayout => ({
  columns: columnsOf(row.columns),
  sort: row.sort as LegalBookSort,
  correlativeStart: row.correlativeStart,
  correlativeRestart: row.correlativeRestart as LegalBookCorrelativeRestart,
  unissuedSales: row.unissuedSales as LegalBookUnissuedSales
})

const viewOfLayout = (
  kind: LegalBookKind,
  layout: LegalBookLayout,
  meta: { version: number; accountantConfirmed: boolean; createdAt: Date | null }
): BookLayoutView => ({
  kind,
  version: meta.version,
  source: meta.version === 0 ? PROPOSAL : STORED,
  accountantConfirmed: meta.accountantConfirmed,
  columns: [...layout.columns],
  sort: layout.sort,
  correlativeStart: layout.correlativeStart,
  correlativeRestart: layout.correlativeRestart,
  unissuedSales: layout.unissuedSales,
  createdAt: meta.createdAt === null ? null : meta.createdAt.toISOString()
})

interface SaleEntryRow {
  number: bigint
  entry_date: Date
  idempotency_key: string
  order_id: string
  order_number: string
  provider_id: string | null
  document_type: string | null
  external_number: string | null
  sequence_number: number | null
  voided: boolean | null
}

interface PurchaseRow {
  number: bigint
  entry_date: Date
  document_number: string | null
  supplier_name: string
  supplier_tax_id: string | null
  subtotal_cents: number
  tax_cents: number
  total_cents: number
  tax_creditable: boolean
  due_on: Date
}

// The legal books (TDD_18 §7, §13 row 6; Step 4B.8b-3). **[ACCOUNTANT]** Each book is a read-only report over the ledger of a fiscal
// period, laid out by the layout of the organization (versioned data) or, until the accountant writes one, by the PROPOSAL of the code,
// which nobody has validated and which every answer says. The book of a closed period is frozen the first time it is asked for and
// served from that snapshot from then on, so it is the same bytes whatever changed since (a supplier renamed, a layout replaced). Nothing
// here writes the journal; a book carries no customer data, only the fields the catalog of its kind names.
@Injectable()
export class FinanceBooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly providers: FiscalProviderRegistry
  ) {}

  // The layout in force of each kind of book: the latest the organization wrote, or the proposal
  async layouts(organizationId: string): Promise<BookLayoutView[]> {
    const resolved = await Promise.all(
      Object.values(LegalBookKind).map(kind => this.resolveLayout(organizationId, kind, undefined))
    )
    return resolved.map(item => item.view)
  }

  // A layout is never changed: the answer is the new version. The pure rules refuse a column the kind of book may not show.
  async writeLayout(
    organizationId: string,
    kind: LegalBookKind,
    body: BookLayoutBody,
    actor: Actor
  ): Promise<BookLayoutView> {
    const layout: LegalBookLayout = {
      columns: body.columns,
      sort: body.sort,
      correlativeStart: body.correlativeStart,
      correlativeRestart: body.correlativeRestart,
      unissuedSales: body.unissuedSales
    }
    const problem = layoutProblem(kind, layout)
    if (problem !== null) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_INVALID_INPUT,
        'the layout breaks a rule of the book',
        HttpStatusCodes.BAD_REQUEST,
        { problem }
      )
    }
    const row = await this.prisma.transaction(async tx => {
      // The versions of a kind are numbered one request at a time
      await lockScope(tx, `${organizationId}:finance_book_layout:${kind}`)
      const latest = await tx.financeBookLayout.aggregate({
        where: { organizationId, bookKind: kind },
        _max: { version: true }
      })
      return tx.financeBookLayout.create({
        data: {
          organizationId,
          bookKind: kind,
          version: (latest._max.version ?? 0) + 1,
          columns: body.columns.map(column => ({ field: column.field, label: column.label })),
          sort: body.sort,
          correlativeStart: body.correlativeStart,
          correlativeRestart: body.correlativeRestart,
          unissuedSales: body.unissuedSales,
          accountantConfirmed: body.accountantConfirmed,
          createdBy: actor.userId
        },
        select: LAYOUT_SELECT
      })
    })
    this.audit.log({
      action: AuditAction.FINANCE_BOOK_LAYOUT_CHANGED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.BOOK_LAYOUT,
      resourceId: row.id,
      metadata: {
        kind,
        version: row.version,
        accountantConfirmed: row.accountantConfirmed,
        columns: body.columns.length
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return viewOfLayout(kind, layoutOfRow(row), {
      version: row.version,
      accountantConfirmed: row.accountantConfirmed,
      createdAt: row.createdAt
    })
  }

  // The book of a period as JSON. A closed period is served from its snapshot; the first request after the close takes it.
  async book(
    organizationId: string,
    kind: LegalBookKind,
    query: BookQuery,
    actor: Actor
  ): Promise<BookView> {
    const { book } = await this.served(organizationId, kind, query, actor)
    this.auditRead(organizationId, kind, query.periodId, book, 'json', actor)
    return book
  }

  // The CSV of the same book, audited. A frozen book is served as the bytes that were frozen (stored with it), so the digest in the
  // header and in the audit row is the digest of the file that left.
  async csv(
    organizationId: string,
    kind: LegalBookKind,
    query: BookQuery,
    actor: Actor
  ): Promise<{ book: BookView; csv: string; fileName: string }> {
    const { book, csv } = await this.served(organizationId, kind, query, actor)
    this.auditRead(organizationId, kind, query.periodId, book, 'csv', actor)
    return {
      book,
      csv,
      fileName: `book-${kind}-${String(book.period.year)}-${String(book.period.month).padStart(2, '0')}`
    }
  }

  // Every way out of a book (the JSON, the file, the frozen one) leaves an audit row: it lists supplier names and tax ids
  private auditRead(
    organizationId: string,
    kind: LegalBookKind,
    periodId: string,
    book: BookView,
    via: 'json' | 'csv' | 'frozen',
    actor: Actor
  ): void {
    this.audit.log({
      action: AuditAction.FINANCE_EXPORTED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.PERIOD,
      resourceId: periodId,
      metadata: {
        report: legalBookReport(kind),
        via,
        periodId,
        layoutVersion: book.layout.version,
        rows: book.rows.length,
        sha256: book.contentSha256,
        frozen: book.frozen
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }

  private async served(
    organizationId: string,
    kind: LegalBookKind,
    query: BookQuery,
    actor: Actor
  ): Promise<{ book: BookView; csv: string }> {
    const period = await this.periodOf(organizationId, query.periodId)
    const closed =
      (period.status as PeriodStatus) === PeriodStatus.CLOSED && period.closedAt !== null
    let version = query.layoutVersion
    if (version === undefined && period.closedAt !== null && closed) {
      // The default book of a closed month is the one that was frozen first: a layout written since does not change it
      const first = await this.prisma.client.financeBookSnapshot.findFirst({
        where: { organizationId, periodId: period.id, bookKind: kind, closedAt: period.closedAt },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { layoutVersion: true }
      })
      if (first !== null) version = first.layoutVersion
    }
    const resolved = await this.resolveLayout(organizationId, kind, version)
    if (closed) {
      const frozen = await this.frozenOf(organizationId, kind, period, resolved.view.version)
      if (frozen !== null) return { book: { ...frozen.book, frozen: true }, csv: frozen.csv }
    }
    const built = await this.build(organizationId, kind, period, resolved)
    // Only the default book of a closed month is frozen by a request: an explicit version with no snapshot is built and not kept, so asking
    // for an old version or the proposal can never decide what the month's book is
    // An unvalidated proposal is a draft, not evidence: it is never frozen, so the first layout the accountant writes can be
    if (!closed || query.layoutVersion !== undefined || resolved.view.source === PROPOSAL)
      return built
    return this.freeze(organizationId, kind, period, resolved.view.version, built, actor)
  }

  // The books frozen for the organization, newest first (the evidence of what was handed over for each closed month)
  async frozenList(organizationId: string, query: FrozenBooksQuery): Promise<FrozenBookView[]> {
    const rows = await this.prisma.client.financeBookSnapshot.findMany({
      where: {
        organizationId,
        ...(query.periodId === undefined ? {} : { periodId: query.periodId })
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      select: {
        id: true,
        periodId: true,
        bookKind: true,
        layoutVersion: true,
        closedAt: true,
        contentSha256: true,
        createdAt: true
      }
    })
    return rows.map(row => ({
      id: row.id,
      periodId: row.periodId,
      kind: row.bookKind as LegalBookKind,
      layoutVersion: row.layoutVersion,
      closedAt: row.closedAt.toISOString(),
      contentSha256: row.contentSha256,
      createdAt: row.createdAt.toISOString()
    }))
  }

  async frozenById(organizationId: string, id: string, actor: Actor): Promise<BookView> {
    const row = await this.prisma.client.financeBookSnapshot.findFirst({
      where: { id, organizationId },
      select: { book: true }
    })
    if (row === null) throw resourceNotFound('frozen book')
    const book: BookView = { ...withoutCsv(row.book as unknown as StoredBook), frozen: true }
    this.auditRead(organizationId, book.kind, book.period.id, book, 'frozen', actor)
    return book
  }

  private async periodOf(organizationId: string, periodId: string) {
    const period = await this.prisma.client.fiscalPeriod.findFirst({
      where: { id: periodId, organizationId },
      select: {
        id: true,
        year: true,
        month: true,
        startsOn: true,
        endsOn: true,
        status: true,
        closedAt: true
      }
    })
    if (period === null) throw resourceNotFound('fiscal period')
    return period
  }

  private async resolveLayout(
    organizationId: string,
    kind: LegalBookKind,
    version: number | undefined
  ): Promise<{ view: BookLayoutView; layout: LegalBookLayout }> {
    if (version === 0) {
      const layout = proposedLayout(kind)
      return {
        layout,
        view: viewOfLayout(kind, layout, {
          version: 0,
          accountantConfirmed: false,
          createdAt: null
        })
      }
    }
    const row = await this.prisma.client.financeBookLayout.findFirst({
      where: { organizationId, bookKind: kind, ...(version === undefined ? {} : { version }) },
      orderBy: { version: 'desc' },
      select: LAYOUT_SELECT
    })
    if (row === null) {
      // No layout written yet: the proposal (never a version that was asked for and does not exist)
      if (version !== undefined) throw resourceNotFound('book layout')
      const layout = proposedLayout(kind)
      return {
        layout,
        view: viewOfLayout(kind, layout, {
          version: 0,
          accountantConfirmed: false,
          createdAt: null
        })
      }
    }
    const layout = layoutOfRow(row)
    return {
      layout,
      view: viewOfLayout(kind, layout, {
        version: row.version,
        accountantConfirmed: row.accountantConfirmed,
        createdAt: row.createdAt
      })
    }
  }

  private async frozenOf(
    organizationId: string,
    kind: LegalBookKind,
    period: { id: string; closedAt: Date | null },
    layoutVersion: number
  ): Promise<{ book: Omit<BookView, 'frozen'>; csv: string } | null> {
    if (period.closedAt === null) return null
    const row = await this.prisma.client.financeBookSnapshot.findFirst({
      where: {
        organizationId,
        periodId: period.id,
        bookKind: kind,
        layoutVersion,
        closedAt: period.closedAt
      },
      select: { book: true }
    })
    if (row === null) return null
    const stored = row.book as unknown as StoredBook
    return { book: withoutCsv(stored), csv: stored.csv }
  }

  // The first request for a closed period's book takes the snapshot. Two at once: the unique key lets one in, the other reads it.
  private async freeze(
    organizationId: string,
    kind: LegalBookKind,
    period: { id: string; closedAt: Date | null },
    layoutVersion: number,
    built: { book: BookView; csv: string },
    actor: Actor
  ): Promise<{ book: BookView; csv: string }> {
    if (period.closedAt === null) return built
    // The close this book was built under must still be the close of the period: a month reopened and closed again while the book was
    // being built is not frozen under the old closing
    const now = await this.prisma.client.fiscalPeriod.findFirst({
      where: { id: period.id, organizationId },
      select: { closedAt: true, status: true }
    })
    if (
      now === null ||
      (now.status as PeriodStatus) !== PeriodStatus.CLOSED ||
      now.closedAt?.getTime() !== period.closedAt.getTime()
    ) {
      return built
    }
    const stored = Object.fromEntries(
      Object.entries(built.book).filter(([key]) => key !== 'frozen')
    ) as Omit<BookView, 'frozen'>
    try {
      await this.prisma.client.financeBookSnapshot.create({
        data: {
          organizationId,
          periodId: period.id,
          bookKind: kind,
          layoutVersion,
          closedAt: period.closedAt,
          // The CSV is stored with the book: what leaves for a closed month is the file that was frozen, whatever the writer does later
          book: JSON.parse(JSON.stringify({ ...stored, csv: built.csv })) as object,
          contentSha256: built.book.contentSha256,
          createdBy: actor.userId
        },
        select: { id: true }
      })
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      const winner = await this.frozenOf(organizationId, kind, period, layoutVersion)
      if (winner !== null) return { book: { ...winner.book, frozen: true }, csv: winner.csv }
      throw error
    }
    this.audit.log({
      action: AuditAction.FINANCE_BOOK_FROZEN,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FinanceResourceTypes.PERIOD,
      resourceId: period.id,
      metadata: {
        kind,
        layoutVersion,
        sha256: built.book.contentSha256,
        rows: built.book.rows.length
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return { book: { ...built.book, frozen: true }, csv: built.csv }
  }

  private async build(
    organizationId: string,
    kind: LegalBookKind,
    period: {
      id: string
      year: number
      month: number
      startsOn: Date
      endsOn: Date
      status: string
    },
    resolved: { view: BookLayoutView; layout: LegalBookLayout }
  ): Promise<{ book: BookView; csv: string }> {
    const from = isoDay(period.startsOn)
    const to = isoDay(period.endsOn)
    // The stretch the correlative runs over starts at the month or the year of the period: the rows before the period are numbered
    // and dropped, so the number of a row does not depend on which month was asked for
    const windowFrom = correlativeBucketStart(from, resolved.layout.correlativeRestart)
    const warnings: BookWarnings = {
      salesWithoutTaxSnapshot: 0,
      salesNotReadable: 0,
      voidedDocuments: 0,
      unclassifiedDocuments: 0,
      returnsNotListed: 0
    }
    const sources =
      kind === LegalBookKind.PURCHASES
        ? await this.purchaseSources(organizationId, windowFrom, to)
        : await this.saleSources(
            organizationId,
            kind,
            resolved.layout,
            windowFrom,
            from,
            to,
            warnings
          )
    // The cap is on what the book lists: the rows before the period only number the correlative
    if (sources.filter(row => row.entryDate >= from).length > FinanceReportLimits.MAX_CSV_ROWS) {
      throw tooLarge()
    }
    if (kind !== LegalBookKind.PURCHASES) {
      const [{ returns }] = await this.prisma.client.$queryRaw<[{ returns: bigint }]>`
        SELECT COUNT(*)::bigint AS returns FROM journal_entries
        WHERE organization_id = ${organizationId} AND type = ${JournalEntryType.SALE_RETURN}
          AND memo IS DISTINCT FROM ${FinanceAutoMemo.RETURN_REFUND}
          AND entry_date BETWEEN ${from}::date AND ${to}::date`
      warnings.returnsNotListed = Number(returns)
    }
    const book = buildLegalBook(kind, resolved.layout, sources, { from, to })
    const csv = bookCsv({ header: book.header, rows: book.rows })
    const view: BookView = {
      kind,
      period: {
        id: period.id,
        year: period.year,
        month: period.month,
        from,
        to,
        status: period.status as PeriodStatus
      },
      layout: {
        version: resolved.view.version,
        source: resolved.view.source,
        accountantConfirmed: resolved.view.accountantConfirmed
      },
      unvalidated: resolved.view.source === PROPOSAL || !resolved.view.accountantConfirmed,
      header: [...book.header],
      rows: book.rows.map(row => [...row]),
      totals: { ...book.totals },
      warnings,
      contentSha256: bookSha256(csv),
      frozen: false
    }
    return { book: view, csv }
  }

  // The sales of the window: the entries of the sale of an order (one per order, by the key of the posting), with what the order kept of
  // its tax and the fiscal document it had at the end of the month of the entry (a document made later is not the book of that month)
  private async saleSources(
    organizationId: string,
    kind: LegalBookKind,
    layout: LegalBookLayout,
    from: string,
    periodFrom: string,
    to: string,
    warnings: BookWarnings
  ): Promise<BookSourceRow[]> {
    const entries = await this.prisma.client.$queryRaw<SaleEntryRow[]>`
      SELECT e.number, e.entry_date, e.idempotency_key, o.id AS order_id, o.order_number,
             d.provider_id, d.document_type, d.external_number, d.sequence_number,
             (d.voided_at IS NOT NULL AND d.voided_at < m.next_month) AS voided
      FROM journal_entries e
      JOIN orders o ON o.id = e.source_id
      JOIN stores s ON s.id = o.store_id AND s.organization_id = e.organization_id
      CROSS JOIN LATERAL (
        SELECT (date_trunc('month', e.entry_date::timestamp) + interval '1 month') AS next_month
      ) m
      -- One document stands for the sale: a document of the sale (never the credit note of a return, which is not the sale's document),
      -- the one still alive at the end of the month, else the newest. A voided document that was replaced does not make the sale a
      -- voided one, and a credit note does not make it a second row.
      LEFT JOIN LATERAL (
        SELECT f.provider_id, f.document_type, f.external_number, f.sequence_number, f.voided_at
        FROM fiscal_documents f
        WHERE f.organization_id = e.organization_id AND f.order_id = o.id
          AND f.kind = ${FiscalDocumentKind.SALE}
          AND f.issued_at IS NOT NULL AND f.issued_at < m.next_month
        ORDER BY (f.voided_at IS NOT NULL AND f.voided_at < m.next_month) ASC,
                 f.issued_at DESC, f.created_at DESC, f.id DESC
        LIMIT 1
      ) d ON TRUE
      WHERE e.organization_id = ${organizationId}
        AND e.type = ${JournalEntryType.SALE} AND e.source_type = ${FinanceSourceType.ORDER}
        AND e.reverses_entry_id IS NULL
        -- A sale whose entry was reversed in its own month is not a sale of that month
        AND NOT EXISTS (
          SELECT 1 FROM journal_entries rv
          WHERE rv.organization_id = e.organization_id AND rv.reverses_entry_id = e.id
            AND rv.entry_date < m.next_month
        )
        AND e.entry_date BETWEEN ${from}::date AND ${to}::date
      ORDER BY e.number`
    const sales = entries.filter(
      entry => entry.idempotency_key === FinancePostingKey.ORDER_SALE(entry.order_id)
    )
    const rows: BookSourceRow[] = []
    const page = 500
    for (let start = 0; start < sales.length; start += page) {
      const slice = sales.slice(start, start + page)
      const orders = await this.prisma.client.order.findMany({
        where: { id: { in: slice.map(entry => entry.order_id) }, store: { organizationId } },
        select: {
          id: true,
          discountCents: true,
          shippingCents: true,
          taxCents: true,
          pricesIncludeTax: true,
          shippingTaxRateBps: true,
          items: {
            select: {
              unitPriceCents: true,
              quantity: true,
              taxTreatment: true,
              taxRateBps: true,
              taxCents: true
            }
          }
        }
      })
      const byId = new Map(orders.map(order => [order.id, order]))
      for (const entry of slice) {
        const order = byId.get(entry.order_id)
        if (order === undefined) continue
        // The rows before the period are read to number the correlative; what could not be listed of them is not this period's
        const inPeriod = isoDay(entry.entry_date) >= periodFrom
        if (order.taxCents === null || order.pricesIncludeTax === null) {
          if (inPeriod) warnings.salesWithoutTaxSnapshot += 1
          continue
        }
        const lines = vatLinesOfOrder({
          discountCents: order.discountCents,
          shippingCents: order.shippingCents,
          taxCents: order.taxCents,
          pricesIncludeTax: order.pricesIncludeTax,
          shippingTaxRateBps: order.shippingTaxRateBps,
          items: order.items.map(item => ({
            unitPriceCents: item.unitPriceCents,
            quantity: item.quantity,
            taxTreatment: item.taxTreatment ?? '',
            taxRateBps: item.taxRateBps,
            taxCents: item.taxCents ?? 0
          }))
        })
        if (lines === null || order.items.some(item => item.taxTreatment === null)) {
          if (inPeriod) warnings.salesNotReadable += 1
          continue
        }
        if (entry.voided === true) {
          if (inPeriod) warnings.voidedDocuments += 1
          continue
        }
        const documentKind = this.bookOfDocument(entry)
        if (documentKind === undefined) {
          if (inPeriod) warnings.unclassifiedDocuments += 1
          continue
        }
        // No document: the sale is listed with the final consumers or left out, as the layout of that book says
        const belongs =
          documentKind === null
            ? kind === LegalBookKind.SALES_CONSUMERS &&
              layout.unissuedSales === LegalBookUnissuedSales.CONSUMERS
            : documentKind === kind
        if (!belongs) continue
        const base = (of: VatLineKind): number =>
          lines.filter(line => line.kind === of).reduce((sum, line) => sum + line.baseCents, 0)
        const tax = lines.reduce((sum, line) => sum + line.taxCents, 0)
        const total = lines.reduce((sum, line) => sum + line.baseCents + line.taxCents, 0)
        const number =
          entry.external_number ??
          (entry.sequence_number === null ? '' : String(entry.sequence_number))
        rows.push({
          entryNumber: Number(entry.number),
          entryDate: isoDay(entry.entry_date),
          documentNumber: number,
          values: {
            [LegalBookField.DOCUMENT_TYPE]: entry.document_type,
            [LegalBookField.DOCUMENT_NUMBER]: number === '' ? null : number,
            [LegalBookField.SOURCE_NUMBER]: entry.order_number,
            [LegalBookField.BASE_TAXED]: base(VatLineKind.TAXED),
            [LegalBookField.BASE_EXEMPT]: base(VatLineKind.EXEMPT),
            [LegalBookField.BASE_NOT_SUBJECT]: base(VatLineKind.NOT_SUBJECT),
            [LegalBookField.BASE_SHIPPING_UNTAXED]: base(VatLineKind.SHIPPING_NOT_TAXED),
            [LegalBookField.TAX]: tax,
            [LegalBookField.TOTAL]: total
          }
        })
      }
    }
    return rows
  }

  // The book a fiscal document belongs to: null when the sale has none (no document), undefined when the provider does not know it
  private bookOfDocument(
    entry: Pick<SaleEntryRow, 'provider_id' | 'document_type'>
  ): LegalBookKind | null | undefined {
    if (entry.provider_id === null || entry.document_type === null) return null
    const provider = this.providers.find(entry.provider_id)
    const declaration =
      provider?.manifest.documentTypes.find(type => type.id === entry.document_type) ?? null
    return saleBookOfDocumentType(declaration) ?? undefined
  }

  // The purchases of the window: the receipts whose entry is in it. The supplier's name and tax id are the ones the supplier has now,
  // which is why the book of a closed month is frozen.
  private async purchaseSources(
    organizationId: string,
    from: string,
    to: string
  ): Promise<BookSourceRow[]> {
    const receipts = await this.prisma.client.$queryRaw<PurchaseRow[]>`
      SELECT e.number, e.entry_date, r.supplier_document_number AS document_number, s.name AS supplier_name,
             s.tax_id AS supplier_tax_id, r.subtotal_cents, r.tax_cents, r.total_cents, r.tax_creditable, r.due_on
      FROM purchase_receipts r
      JOIN journal_entries e ON e.id = r.entry_id AND e.organization_id = r.organization_id
      JOIN suppliers s ON s.id = r.supplier_id AND s.organization_id = r.organization_id
      WHERE r.organization_id = ${organizationId}
        AND e.reverses_entry_id IS NULL
        -- A receipt whose entry was reversed in its own month is not a purchase of that month
        AND NOT EXISTS (
          SELECT 1 FROM journal_entries rv
          WHERE rv.organization_id = e.organization_id AND rv.reverses_entry_id = e.id
            AND rv.entry_date < (date_trunc('month', e.entry_date::timestamp) + interval '1 month')
        )
        AND e.entry_date BETWEEN ${from}::date AND ${to}::date
      ORDER BY e.number`
    return receipts.map(receipt => ({
      entryNumber: Number(receipt.number),
      entryDate: isoDay(receipt.entry_date),
      documentNumber: receipt.document_number ?? '',
      values: {
        [LegalBookField.DOCUMENT_NUMBER]: receipt.document_number,
        [LegalBookField.SUPPLIER_NAME]: receipt.supplier_name,
        [LegalBookField.SUPPLIER_TAX_ID]: receipt.supplier_tax_id,
        [LegalBookField.BASE]: receipt.subtotal_cents,
        [LegalBookField.TAX]: receipt.tax_cents,
        [LegalBookField.TOTAL]: receipt.total_cents,
        [LegalBookField.TAX_CREDITABLE]: receipt.tax_creditable,
        [LegalBookField.DUE_DATE]: isoDay(receipt.due_on)
      }
    }))
  }
}
