import { Injectable } from '@nestjs/common'

import { JobContext, PrismaService } from '@platform/core/database'
import {
  AccountRole,
  FinancePostingKey,
  FiscalContingencyStatus,
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalEntryMismatchField,
  FiscalEvidenceKind,
  FiscalIssueOn,
  FiscalLimits,
  FiscalSweepKind,
  FiscalSweepLimits,
  OrderReturnStatus,
  OrderStatus,
  ShipmentKind
} from '@platform/core/domain'

import { SHIPMENT_STATES_THAT_BACK_GOODS } from './fiscal-rules'

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
// Documents one page of the entry check reads, and the most one call reads before it gives its answer so far (a page with no
// disagreement is not a page with no cursor: the answer says where to go on)

export interface FiscalFinding {
  kind: FiscalSweepKind
  // The row the finding is about: an order, a document or a return (by kind)
  id: string
  orderId: string
  // STALLED_DOCUMENT: the submission the job is asked again for
  submission?: number
  // STALLED_DOCUMENT: the document was kept in a contingency and released, so its job is the one of a released document
  released?: boolean
  status?: FiscalDocumentStatus
  // DELIVERY_MISSING: the store of the document, which the event that is published again names
  storeId?: string
  // ENTRY_MISMATCH: what differs
  fields?: FiscalEntryMismatchField[]
}

// The shape of the other lists of the fiscal documents: `data`, where to go on (null when the kind has nothing more) and whether there is more
export interface FiscalFindingsPage {
  data: FiscalFinding[]
  nextCursor: string | null
  hasMore: boolean
}

const empty = (): FiscalFindingsPage => ({ data: [], nextCursor: null, hasMore: false })
const pageOf = (data: FiscalFinding[], nextCursor: string | null): FiscalFindingsPage => ({
  data,
  nextCursor,
  hasMore: nextCursor !== null
})

// The filter of the stores a caller reaches, or nothing for the whole organization
type StoreReach = { storeId?: { in: string[] } }

export interface FiscalSweepOptions {
  cursor?: string
  limit?: number
  now?: Date
  // The stores the caller reaches (HC-128); absent = the whole organization (the nightly check of the worker)
  storeIds?: readonly string[]
}

// The fiscal documents the lifecycle lost (TDD_18 §8.3, §11; Step 4B.8b-2b). It READS: it says which sales have no document, which
// documents were left in the queue, which returns have no credit note and which documents disagree with their entry. What is done about
// each (a document made, a job queued) belongs to the worker's check, which goes through the lifecycle service and the queue; a person who
// asks for the report gets the same answer and changes nothing (a dry run). Every query is by organization.
//
// An organization that has not issued a document yet has no sweep for sales and returns: the first document is the issuer's go-live (the
// setting has no date of its own), and making a document for every sale of the last 120 days at that moment would issue legal documents
// for a history nobody asked to document. The sweep never reaches before the first sale document the organization made.
@Injectable()
export class FiscalSweepService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext
  ) {}

  async find(
    organizationId: string,
    kind: FiscalSweepKind,
    options: FiscalSweepOptions = {}
  ): Promise<FiscalFindingsPage> {
    const limit = Math.min(
      Math.max(options.limit ?? FiscalSweepLimits.PAGE_SIZE_DEFAULT, 1),
      FiscalSweepLimits.PAGE_SIZE_MAX
    )
    const now = options.now ?? new Date()
    const reach = options.storeIds === undefined ? {} : { storeId: { in: [...options.storeIds] } }
    // One page is one read in one context of the organization (strict: it joins only a context that holds every store of it, so a request
    // that holds the store of the header alone is refused instead of reading one store): the sweep of the worker asks page after page, so a
    // long run never holds a transaction
    return this.jobContext.inOrganization(
      organizationId,
      () => {
        switch (kind) {
          case FiscalSweepKind.SALE_WITHOUT_DOCUMENT:
            return this.salesWithoutDocument(organizationId, now, options.cursor, limit, reach)
          case FiscalSweepKind.STALLED_DOCUMENT:
            return this.stalledDocuments(organizationId, now, options.cursor, limit, reach)
          case FiscalSweepKind.CREDIT_NOTE_MISSING:
            return this.creditNotesMissing(organizationId, now, options.cursor, limit, reach)
          case FiscalSweepKind.ENTRY_MISMATCH:
            return this.entryMismatches(organizationId, now, options.cursor, limit, reach)
          case FiscalSweepKind.DELIVERY_MISSING:
            return this.deliveriesMissing(organizationId, now, options.cursor, limit, reach)
          case FiscalSweepKind.REMISSION_NOTE_MISSING:
            return this.remissionNotesMissing(organizationId, now, options.cursor, limit, reach)
        }
      },
      { maxWait: FiscalLimits.CONTEXT_MAX_WAIT_MS, timeout: FiscalLimits.CONTEXT_TIMEOUT_MS }
    )
  }

  // The earliest date a sale or a return is looked at, with the moment the issuer issues at, or null when the organization has no issuer or
  // has issued nothing yet
  private async window(
    organizationId: string,
    now: Date
  ): Promise<{ since: Date; issueOn: string } | null> {
    const issuer = await this.prisma.client.fiscalIssuer.findUnique({
      where: { organizationId },
      select: { issueOn: true, environment: true }
    })
    if (issuer === null) return null
    // The go-live is the first document of the environment the issuer is in now: a document made in the sandbox is a test, and a
    // switch to production would otherwise make every sale since the test look like one nobody documented
    const first = await this.prisma.client.fiscalDocument.findFirst({
      where: { organizationId, kind: FiscalDocumentKind.SALE, environment: issuer.environment },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true }
    })
    if (first === null) return null
    const lookback = new Date(now.getTime() - FiscalSweepLimits.LOOKBACK_DAYS * DAY_MS)
    return {
      since: first.createdAt.getTime() > lookback.getTime() ? first.createdAt : lookback,
      issueOn: issuer.issueOn
    }
  }

  // Rows are read one more than the limit, to know whether anything is left
  private page<T extends { id: string }>(
    rows: T[],
    limit: number,
    toFinding: (row: T) => FiscalFinding
  ): FiscalFindingsPage {
    const more = rows.length > limit
    const kept = more ? rows.slice(0, limit) : rows
    return pageOf(kept.map(toFinding), more ? (kept.at(-1)?.id ?? null) : null)
  }

  private async salesWithoutDocument(
    organizationId: string,
    now: Date,
    cursor: string | undefined,
    limit: number,
    reach: StoreReach
  ): Promise<FiscalFindingsPage> {
    const window = await this.window(organizationId, now)
    if (window === null) return empty()
    const { since } = window
    // At SHIPPED the document is made when the goods leave; an order that was delivered with no shipped event is documented at DELIVERED
    const recognized =
      window.issueOn === (FiscalIssueOn.SHIPPED as string)
        ? [{ shippedAt: { gte: since } }, { deliveredAt: { gte: since } }]
        : [{ deliveredAt: { gte: since } }]
    const rows = await this.prisma.client.order.findMany({
      where: {
        store: { organizationId },
        ...reach,
        status: { notIn: [OrderStatus.CANCELLED as string] },
        OR: recognized,
        // An order with no tax snapshot makes no document (HC-006): it is not a finding the sweep could ever close
        taxCents: { not: null },
        pricesIncludeTax: { not: null },
        items: { none: { taxCents: null } },
        // Any sale document of the order, voided or not: a voided one is replaced by a person, never by the sweep
        fiscalDocuments: { none: { organizationId, kind: FiscalDocumentKind.SALE } },
        ...(cursor === undefined ? {} : { id: { gt: cursor } })
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: limit + 1
    })
    return this.page(rows, limit, row => ({
      kind: FiscalSweepKind.SALE_WITHOUT_DOCUMENT,
      id: row.id,
      orderId: row.id
    }))
  }

  private async stalledDocuments(
    organizationId: string,
    now: Date,
    cursor: string | undefined,
    limit: number,
    reach: StoreReach
  ): Promise<FiscalFindingsPage> {
    const queuedBefore = new Date(
      now.getTime() - FiscalSweepLimits.QUEUED_STALL_MINUTES * MINUTE_MS
    )
    const submittedBefore = new Date(
      now.getTime() - FiscalSweepLimits.SUBMITTED_STALL_MINUTES * MINUTE_MS
    )
    const rows = await this.prisma.client.fiscalDocument.findMany({
      where: {
        organizationId,
        ...reach,
        OR: [
          { status: FiscalDocumentStatus.QUEUED, updatedAt: { lt: queuedBefore } },
          { status: FiscalDocumentStatus.SUBMITTED, updatedAt: { lt: submittedBefore } }
        ],
        // A document kept in a contingency that has not been reported waits on purpose (Step 4B.7c-7): its contingency is what is
        // checked below, and the release of the report asks the queue for it
        NOT: { contingency: { status: { not: FiscalContingencyStatus.REPORTED } } },
        ...(cursor === undefined ? {} : { id: { gt: cursor } })
      },
      select: { id: true, orderId: true, submission: true, status: true, contingencyId: true },
      orderBy: { id: 'asc' },
      take: limit + 1
    })
    return this.page(rows, limit, row => ({
      kind: FiscalSweepKind.STALLED_DOCUMENT,
      id: row.id,
      orderId: row.orderId,
      submission: row.submission,
      released: row.contingencyId !== null,
      status: row.status as FiscalDocumentStatus
    }))
  }

  // An accepted document whose files were made (a provider that draws none has no such file and owes nothing) and that has no delivery row an
  // hour after it was accepted: the event of its acceptance was lost (the api was down, the bridge dropped it). The worker publishes it again;
  // the delivery is safe to repeat, so a document found twice is one delivery.
  private async deliveriesMissing(
    organizationId: string,
    now: Date,
    cursor: string | undefined,
    limit: number,
    reach: StoreReach
  ): Promise<FiscalFindingsPage> {
    const before = new Date(now.getTime() - FiscalSweepLimits.DELIVERY_GRACE_MINUTES * MINUTE_MS)
    const since = new Date(now.getTime() - FiscalSweepLimits.LOOKBACK_DAYS * DAY_MS)
    const rows = await this.prisma.client.fiscalDocument.findMany({
      where: {
        organizationId,
        ...reach,
        status: FiscalDocumentStatus.ACCEPTED,
        updatedAt: { lt: before },
        createdAt: { gte: since },
        delivery: null,
        evidence: {
          some: {
            fiscalEvidenceKind: {
              in: [FiscalEvidenceKind.REPRESENTATION, FiscalEvidenceKind.DTE_FILE]
            }
          }
        },
        ...(cursor === undefined ? {} : { id: { gt: cursor } })
      },
      select: { id: true, orderId: true, storeId: true },
      orderBy: { id: 'asc' },
      take: limit + 1
    })
    return this.page(rows, limit, row => ({
      kind: FiscalSweepKind.DELIVERY_MISSING,
      id: row.id,
      orderId: row.orderId,
      storeId: row.storeId
    }))
  }

  private async creditNotesMissing(
    organizationId: string,
    now: Date,
    cursor: string | undefined,
    limit: number,
    reach: StoreReach
  ): Promise<FiscalFindingsPage> {
    const window = await this.window(organizationId, now)
    if (window === null) return empty()
    const { since } = window
    const live = { not: FiscalDocumentStatus.VOIDED as string }
    const rows = await this.prisma.client.orderReturn.findMany({
      where: {
        store: { organizationId },
        ...reach,
        receivedAt: { gte: since },
        status: {
          in: [OrderReturnStatus.RECEIVED as string, OrderReturnStatus.COMPLETED as string]
        },
        // The sale was documented (a credit note cancels a document), and the return has none that is alive
        order: {
          fiscalDocuments: {
            some: { organizationId, kind: FiscalDocumentKind.SALE, status: live }
          }
        },
        fiscalDocuments: {
          none: { organizationId, kind: FiscalDocumentKind.CREDIT_NOTE, status: live }
        },
        ...(cursor === undefined ? {} : { id: { gt: cursor } })
      },
      select: { id: true, orderId: true },
      orderBy: { id: 'asc' },
      take: limit + 1
    })
    return this.page(rows, limit, row => ({
      kind: FiscalSweepKind.CREDIT_NOTE_MISSING,
      id: row.id,
      orderId: row.orderId
    }))
  }

  // The guides whose goods are on their way and that have no remission note at all (D3b-3). The event that makes the note is not repeated, so a
  // listener that failed, or a guide made while the issuer made the sale document at the dispatch and was changed to delivery, leaves the goods
  // with none. A voided note is a person's decision and is not a finding; an order whose sale document exists is backed by it. Like the sale
  // sweep it never reaches before the first document of the organization in this environment (a guide of the time before the issuer went
  // live is history nobody asked to document), and it looks at no organization whose issuer makes the sale document at the dispatch.
  private async remissionNotesMissing(
    organizationId: string,
    now: Date,
    cursor: string | undefined,
    limit: number,
    reach: StoreReach
  ): Promise<FiscalFindingsPage> {
    const issuer = await this.prisma.client.fiscalIssuer.findUnique({
      where: { organizationId },
      select: { issueOn: true, environment: true }
    })
    if (issuer === null || issuer.issueOn !== (FiscalIssueOn.DELIVERED as string)) return empty()
    const first = await this.prisma.client.fiscalDocument.findFirst({
      where: { organizationId, environment: issuer.environment },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true }
    })
    if (first === null) return empty()
    const lookback = new Date(now.getTime() - FiscalSweepLimits.LOOKBACK_DAYS * DAY_MS)
    const since = first.createdAt.getTime() > lookback.getTime() ? first.createdAt : lookback
    const rows = await this.prisma.client.shipment.findMany({
      where: {
        store: { organizationId },
        ...reach,
        kind: ShipmentKind.OUTBOUND,
        status: { in: [...SHIPMENT_STATES_THAT_BACK_GOODS] },
        createdAt: { gte: since },
        // Any note of the guide, voided or not
        fiscalDocuments: { none: { organizationId, kind: FiscalDocumentKind.REMISSION_NOTE } },
        order: {
          status: { notIn: [OrderStatus.CANCELLED as string] },
          // An order with no tax snapshot makes no document (HC-006): not a finding the sweep could ever close
          taxCents: { not: null },
          pricesIncludeTax: { not: null },
          items: { none: { taxCents: null } },
          // The sale document backs the goods once it exists
          fiscalDocuments: { none: { organizationId, kind: FiscalDocumentKind.SALE } }
        },
        ...(cursor === undefined ? {} : { id: { gt: cursor } })
      },
      select: { id: true, orderId: true },
      orderBy: { id: 'asc' },
      take: limit + 1
    })
    return this.page(rows, limit, row => ({
      kind: FiscalSweepKind.REMISSION_NOTE_MISSING,
      id: row.id,
      orderId: row.orderId
    }))
  }

  // The total and the tax of a sale document against the entry of the books for the same sale (the revenue, the shipping revenue and the
  // tax of the entry add up to the order's total, `saleAmounts`). Only a document that has an entry is compared: one with no entry yet is the
  // sweep of the books' business. Nothing is corrected from here: which of the two is right is the accountant's.
  private async entryMismatches(
    organizationId: string,
    now: Date,
    cursor: string | undefined,
    limit: number,
    reach: StoreReach
  ): Promise<FiscalFindingsPage> {
    const db = this.prisma.client
    const mappings = await db.accountRoleMapping.findMany({
      where: {
        organizationId,
        role: {
          in: [AccountRole.SALES_REVENUE, AccountRole.SHIPPING_REVENUE, AccountRole.VAT_OUTPUT]
        }
      },
      select: { role: true, accountId: true }
    })
    const revenueAccounts = mappings.map(mapping => mapping.accountId)
    const vatAccount = mappings.find(mapping => mapping.role === (AccountRole.VAT_OUTPUT as string))
    // Without the roles there is no entry that could be read back
    if (vatAccount === undefined || revenueAccounts.length < 3) {
      return empty()
    }
    const since = new Date(now.getTime() - FiscalSweepLimits.LOOKBACK_DAYS * DAY_MS)
    const items: FiscalFinding[] = []
    let after = cursor
    let scanned = 0
    while (items.length < limit && scanned < FiscalSweepLimits.ENTRY_SCAN_MAX) {
      const docs = await db.fiscalDocument.findMany({
        where: {
          organizationId,
          ...reach,
          kind: FiscalDocumentKind.SALE,
          status: { notIn: [FiscalDocumentStatus.VOIDED, FiscalDocumentStatus.DRAFT] },
          createdAt: { gte: since },
          ...(after === undefined ? {} : { id: { gt: after } })
        },
        select: { id: true, orderId: true, totalCents: true, taxCents: true },
        orderBy: { id: 'asc' },
        take: FiscalSweepLimits.ENTRY_SCAN_PAGE
      })
      if (docs.length === 0) return pageOf(items, null)
      scanned += docs.length
      const entries = await db.journalEntry.findMany({
        where: {
          organizationId,
          idempotencyKey: { in: docs.map(doc => FinancePostingKey.ORDER_SALE(doc.orderId)) }
        },
        select: { id: true, idempotencyKey: true }
      })
      const lines = await db.journalLine.groupBy({
        by: ['entryId', 'accountId'],
        where: {
          organizationId,
          entryId: { in: entries.map(entry => entry.id) },
          accountId: { in: revenueAccounts }
        },
        _sum: { debitCents: true, creditCents: true }
      })
      const entryOfKey = new Map(entries.map(entry => [entry.idempotencyKey, entry.id]))
      for (const doc of docs) {
        const entryId = entryOfKey.get(FinancePostingKey.ORDER_SALE(doc.orderId))
        if (entryId === undefined) continue
        let total = 0
        let tax = 0
        for (const line of lines) {
          if (line.entryId !== entryId) continue
          const net = (line._sum.creditCents ?? 0) - (line._sum.debitCents ?? 0)
          total += net
          if (line.accountId === vatAccount.accountId) tax += net
        }
        const fields: FiscalEntryMismatchField[] = []
        if (total !== doc.totalCents) fields.push(FiscalEntryMismatchField.TOTAL)
        if (tax !== doc.taxCents) fields.push(FiscalEntryMismatchField.TAX)
        if (fields.length === 0) continue
        items.push({
          kind: FiscalSweepKind.ENTRY_MISMATCH,
          id: doc.id,
          orderId: doc.orderId,
          fields
        })
        // A page is as long as it was asked for: the cursor is the last document that was read into it
        if (items.length >= limit) return pageOf(items, doc.id)
      }
      after = docs.at(-1)?.id
      if (docs.length < FiscalSweepLimits.ENTRY_SCAN_PAGE) return pageOf(items, null)
    }
    return pageOf(items, after ?? null)
  }
}
