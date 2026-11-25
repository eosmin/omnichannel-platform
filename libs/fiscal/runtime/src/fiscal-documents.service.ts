import { createHash } from 'node:crypto'

import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher } from '@platform/core/crypto'
import {
  inSavepoint,
  isUniqueViolation,
  JobContext,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import {
  FinancePostingKey,
  FiscalConflictReasons,
  FiscalConsultState,
  FiscalContingencyAttachResult,
  FiscalContingencyLimits,
  FiscalDeferOutcome,
  FiscalDocumentKind,
  FiscalDocumentStatus,
  type FiscalEnvironment,
  FiscalPendingDocumentType,
  FiscalIssueOn,
  FiscalLimits,
  FiscalRejectionDeadlineState,
  FiscalWindowKind,
  fiscalSubmitMaxAttempts,
  FiscalRejectionReasons,
  FiscalRejectionRetry,
  FiscalSweepLimits,
  FiscalResourceTypes,
  FiscalSubmitOutcome,
  FiscalVoidConsultState,
  type FiscalVoidKind,
  hasReceivedUnits,
  OrderReturnStatus,
  OrderStatus,
  SealedValueKind
} from '@platform/core/domain'
import {
  ErrorCodes,
  errorName,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import type {
  BuiltDocument,
  FiscalCreditedDocument,
  FiscalDocumentProvider,
  FiscalIssuerInput,
  FiscalReceiver,
  ProviderContext,
  FiscalVoidDetails,
  FiscalVoidParty,
  StoredFiscalDocument,
  VoidResult
} from '@platform/fiscal/sdk'

import { type ClaimToken, newClaimToken } from './claim-token'
import { type FiscalContingencyRoute, FiscalContingencyService } from './fiscal-contingency.service'
import { FiscalEvidenceService } from './fiscal-evidence.service'
import type { FiscalActor } from './fiscal-issuer.service'
import { FiscalProviderRegistry } from './fiscal-provider.registry'
import {
  allowedActionsOf,
  canTransition,
  creditNoteSaleOf,
  declaresSequence,
  documentDetailOf,
  documentLines,
  type FiscalDocumentDetail,
  fiscalDocumentUuid,
  type FiscalDocumentActions,
  fiscalSequenceKey,
  isImmutable,
  isStuck,
  maskColumnsOf,
  maskedReceiverView,
  originalStateOf,
  paymentOfSnapshot,
  receiverEditable,
  receiverOf,
  receiverRecord,
  receiverWithFiscalData,
  rejectionDeadline,
  retryable,
  saleAddsUp,
  shippingTaxFits,
  saleOf,
  sameIssuer
} from './fiscal-rules'
import { cappedResponse, type Json, plainText, record, toJson } from './json'
import { openSealed, type SealedRef } from './sealed-open'
import { withTimeout } from './with-timeout'

// The fields of an issuer that a provider is told about (the row of the issuer and the snapshot a document keeps of it)
interface IssuerRow {
  legalName: string
  taxId: string
  registrationId: string | null
  address: unknown
  activityCode: string | null
  establishmentCode: string | null
  establishmentType: string | null
  pointOfSaleCode: string | null
  phone: string | null
  email: string | null
  environment: string
}

// The attempt did not run because another one holds the document or its sale document is not accepted yet: a claim that is alive may still
// decide the document, so the exhaustion of this job is not the exhaustion of the document
export class FiscalDocumentBusyError extends Error {}

// The series a document is numbered in has no number left: thrown inside the transaction that took one, so it rolls back
class FiscalSequenceExhaustedError extends Error {}

// An acceptance has a number: what a provider returns is not trusted to
// The fields a person sends to write a receiver again when the stored one cannot be read (null leaves one empty). The type, the activity
// and the document type of the receiver are not sent by the form: a rewrite leaves them empty, as a new receiver does
const WHOLE_RECEIVER_FIELDS = [
  'name',
  'taxId',
  'registrationId',
  'email',
  'phone',
  'address'
] as const

const hasNumber = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

export interface FiscalDocumentView {
  id: string
  storeId: string
  orderId: string
  // A sale document, or the credit note of a return; a credit note names its return (null for an order that came back as a whole) and
  // the sale document it cancels (part of), and a sale document made again names the voided one it replaces
  kind: FiscalDocumentKind
  returnId: string | null
  parentDocumentId: string | null
  replacesDocumentId: string | null
  // The newest document that replaces this one (a voided document is replaced once, so it is the only one the api lets exist); null when
  // nobody did
  replacedByDocumentId: string | null
  journalEntryId: string | null
  sequenceNumber: number
  documentType: string
  status: FiscalDocumentStatus
  providerId: string
  environment: FiscalEnvironment
  externalNumber: string | null
  currency: string
  totalCents: number
  taxCents: number
  rejectionReason: string | null
  // The window to correct and send again a document the authority refused (D14): null when it has none
  rejectionDeadline: { endsAt: string; state: FiscalRejectionDeadlineState } | null
  // The same for an invalidation the authority refused (D14b): the document stays accepted; null when it has none
  voidRejectionDeadline: { endsAt: string; state: FiscalRejectionDeadlineState } | null
  attempts: number
  // Queued with every attempt of its job spent: only a person moves it
  stuck: boolean
  // What its state allows a person to do (the permission is the route's; a call can still be refused for something outside the document)
  allowedActions: FiscalDocumentActions
  voidReason: string | null
  voidedAt: string | null
  issuedAt: string | null
  createdAt: string
  // Customer data, minimized: the name and the tax id masked (the first letters of the name, the last characters of the id). The full data is read only by the provider, at issue time.
  receiver: { name: string | null; taxIdMasked: string | null; complete: boolean }
}

// The document with what it was sealed with: the lines, the tax by rate and the issuer as it was (never a credential, never the raw
// snapshot). Only the detail route returns it; the list and the changes answer the light view.
export interface FiscalDocumentDetailView extends FiscalDocumentView {
  detail: FiscalDocumentDetail
}

export interface FiscalDocumentPage {
  data: FiscalDocumentView[]
  nextCursor: string | null
  hasMore: boolean
  // What needs a person, counted over the whole organization (not the page, the filters or the period): the page shows at most its own size
  attention: { rejected: number; stuck: number }
}

// The sealed receiver of a document with the masks that describe it: a document that copies the receiver of another copies the masks with it
const RECEIVER_AND_MASKS = {
  receiverEncrypted: true,
  receiverNameMasked: true,
  receiverTaxIdMasked: true,
  receiverMaskedAt: true
} as const
interface SaleReceiver {
  id: string
  receiverEncrypted: Uint8Array
  receiverNameMasked: string | null
  receiverTaxIdMasked: string | null
  receiverMaskedAt: Date | null
}
function copiedMasksOf(row: Omit<SaleReceiver, 'id'>): {
  receiverNameMasked: string | null
  receiverTaxIdMasked: string | null
  receiverMaskedAt: Date | null
} {
  return {
    receiverNameMasked: row.receiverNameMasked,
    receiverTaxIdMasked: row.receiverTaxIdMasked,
    receiverMaskedAt: row.receiverMaskedAt
  }
}

const SELECT = {
  id: true,
  storeId: true,
  orderId: true,
  kind: true,
  returnId: true,
  parentDocumentId: true,
  replacesDocumentId: true,
  journalEntryId: true,
  sequenceNumber: true,
  documentType: true,
  status: true,
  providerId: true,
  environment: true,
  externalNumber: true,
  currency: true,
  totalCents: true,
  taxCents: true,
  rejectionReason: true,
  rejectedAt: true,
  voidRejectedAt: true,
  attempts: true,
  contingencyId: true,
  voidReason: true,
  voidedAt: true,
  issuedAt: true,
  createdAt: true,
  receiverEncrypted: true,
  receiverNameMasked: true,
  receiverTaxIdMasked: true,
  receiverMaskedAt: true,
  // The newest document that replaces it: the view names it, and says whether a voided document can still be replaced
  replacedBy: { select: { id: true }, orderBy: { sequenceNumber: 'desc' }, take: 1 }
} as const

// The lifecycle of the fiscal document of a sale (TDD_18 §8.3). Core owns it and the link to the ledger; the provider owns what is
// legal. The sale amounts are the order's own (the tax snapshot of Step 4B.3b), copied into the document once and never recomputed.
// The people of a request as the key counts them: without the blanks around the words, as a provider reads them
const partyKey = (party: FiscalVoidParty | undefined): string[] | null =>
  party === undefined ? null : [party.name.trim(), party.idType.trim(), party.idNumber.trim()]

// What a person gives to invalidate a document besides the reason (the screen draws the fields from the manifest of the provider)
export interface FiscalVoidInput {
  readonly kind?: FiscalVoidKind
  readonly responsible?: FiscalVoidParty
  readonly requester?: FiscalVoidParty
  readonly replacementDocumentId?: string
}

// The check of the reach of the person (HC-128) that the caller hands to the routes of a person. The service runs it INSIDE the unit that
// writes (or reads what a write is decided from). A void checks it before the authority is asked and in the unit that takes the claim; the
// last unit (VOIDED) is deliberately not checked again: the authority has invalidated the document already and the write must record it.
// It throws the not-found answer of a document out of reach.
export type FiscalReachGuard = () => Promise<void>

@Injectable()
export class FiscalDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly cipher: CredentialCipher,
    private readonly providers: FiscalProviderRegistry,
    private readonly evidence: FiscalEvidenceService,
    private readonly contingencies: FiscalContingencyService,
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext
  ) {
    this.logger.setContext(FiscalDocumentsService.name)
  }

  // One unit of fiscal work is one transaction in ONE short context of the organization: the whole organization, joined only when a context
  // that wide is open (a listener or a job), opened here otherwise (a person's route is @NoTenantTransaction). The call to the authority
  // (build, consult, submit of the provider) is never inside one: it runs between two units, so the database is held for the rows only, and
  // what the authority answered is written by the next unit
  private inTx<T>(organizationId: string, work: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    return this.jobContext.inOrganization(organizationId, () => this.prisma.transaction(work), {
      maxWait: FiscalLimits.CONTEXT_MAX_WAIT_MS,
      timeout: FiscalLimits.CONTEXT_TIMEOUT_MS
    })
  }

  // The same for a single statement of the client
  private inUnit<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    return this.jobContext.inOrganization(organizationId, work, {
      maxWait: FiscalLimits.CONTEXT_MAX_WAIT_MS,
      timeout: FiscalLimits.CONTEXT_TIMEOUT_MS
    })
  }

  // The view of a document read in a unit of its own, for the route that is not one transaction
  viewOf(organizationId: string, id: string): Promise<FiscalDocumentView> {
    return this.inUnit(organizationId, () => this.get(organizationId, id))
  }

  // ---------------------------------------------------------------- reads

  async list(
    organizationId: string,
    query: {
      status?: FiscalDocumentStatus
      orderId?: string
      cursor?: string
      limit: number
      from?: string
      to?: string
    },
    // The stores the caller reaches (HC-128): a document of another store is not listed nor counted. Absent = the whole organization
    // (the jobs of the worker, which are the organization's).
    storeIds?: readonly string[]
  ): Promise<FiscalDocumentPage> {
    const reach = storeIds === undefined ? {} : { storeId: { in: [...storeIds] } }
    const rows = await this.prisma.client.fiscalDocument.findMany({
      where: {
        organizationId,
        ...reach,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
        ...(query.from === undefined && query.to === undefined
          ? {}
          : {
              createdAt: {
                ...(query.from === undefined ? {} : { gte: new Date(query.from) }),
                ...(query.to === undefined ? {} : { lte: new Date(query.to) })
              }
            }),
        ...(query.cursor === undefined ? {} : { sequenceNumber: { lt: Number(query.cursor) } })
      },
      select: SELECT,
      orderBy: { sequenceNumber: 'desc' },
      take: Math.min(query.limit, FiscalLimits.LIST_MAX_PAGE_SIZE) + 1
    })
    const size = Math.min(query.limit, FiscalLimits.LIST_MAX_PAGE_SIZE)
    const hasMore = rows.length > size
    const page = hasMore ? rows.slice(0, size) : rows
    const last = page.at(-1)
    // Two counts of the organization, by its index (organization, status): the banner of the screen says how many, not how many of the page
    const [rejected, stuck] = await Promise.all([
      this.prisma.client.fiscalDocument.count({
        where: { organizationId, ...reach, status: FiscalDocumentStatus.REJECTED }
      }),
      this.prisma.client.fiscalDocument.count({
        where: {
          organizationId,
          ...reach,
          status: FiscalDocumentStatus.QUEUED,
          // The same rule as `isStuck`: a document kept in a contingency has the attempts of the window of its lot
          OR: [
            { contingencyId: null, attempts: { gte: fiscalSubmitMaxAttempts(false) } },
            { contingencyId: { not: null }, attempts: { gte: fiscalSubmitMaxAttempts(true) } }
          ]
        }
      })
    ])
    return {
      data: page.map(row => this.view(row)),
      nextCursor: hasMore && last !== undefined ? String(last.sequenceNumber) : null,
      hasMore,
      attention: { rejected, stuck }
    }
  }

  async get(organizationId: string, id: string): Promise<FiscalDocumentView> {
    const row = await this.prisma.client.fiscalDocument.findFirst({
      where: { id, organizationId },
      select: SELECT
    })
    if (row === null) throw resourceNotFound('fiscal document')
    return this.view(row)
  }

  // The same read with the sealed snapshot: organization-scoped like every read here (another organization's id is a not found)
  async getDetail(organizationId: string, id: string): Promise<FiscalDocumentDetailView> {
    const row = await this.prisma.client.fiscalDocument.findFirst({
      where: { id, organizationId },
      select: { ...SELECT, linesSnapshot: true, issuerSnapshot: true }
    })
    if (row === null) throw resourceNotFound('fiscal document')
    return {
      ...this.view(row),
      detail: documentDetailOf(row, row.linesSnapshot, row.issuerSnapshot)
    }
  }

  // ---------------------------------------------------------------- the sale makes a document

  // Called when the sale is recognized. No issuer set up = no document (the organization does not issue yet). One document per order:
  // asking twice answers the same one (the unique index decides when two requests race). Returns the id to enqueue, or null.
  async createForOrder(
    organizationId: string,
    orderId: string,
    moment: FiscalIssueOn
  ): Promise<string | null> {
    return this.inTx(organizationId, async tx => {
      const issuer = await tx.fiscalIssuer.findUnique({ where: { organizationId } })
      // Made at the moment the issuer chose; an issuer that chose SHIPPED also makes it at DELIVERED when the order never went through a
      // shipped event (one document per order: a second call finds the first and does nothing)
      const due =
        issuer?.issueOn === moment ||
        (moment === FiscalIssueOn.DELIVERED && issuer?.issueOn === FiscalIssueOn.SHIPPED)
      if (issuer === null || !due) return null
      // Any sale document of the order, voided or not: a voided one is replaced by a person (`replace`), never by the next event
      const existing = await tx.fiscalDocument.findFirst({
        where: { organizationId, orderId, kind: FiscalDocumentKind.SALE },
        select: { id: true }
      })
      if (existing !== null) return null
      const sale = await this.readSale(tx, organizationId, orderId)
      if (sale === null) return null
      if (sale.taxSnapshotMissing) {
        // No number is taken and no document is made: the tax of the order must be completed first, then the sale is asked again
        this.logger.warn({ orderId }, 'no sale document was made: the order has no tax snapshot')
        return null
      }
      const sequenceNumber = await this.takeSequence(tx, organizationId)
      const entry = await tx.journalEntry.findFirst({
        where: { organizationId, idempotencyKey: FinancePostingKey.ORDER_SALE(orderId) },
        select: { id: true }
      })
      const created = await tx.fiscalDocument.create({
        data: {
          organizationId,
          storeId: sale.storeId,
          orderId,
          journalEntryId: entry?.id ?? null,
          sequenceNumber,
          // The type is the provider's rule, applied when it builds: until then it is a placeholder core never reads
          documentType: FiscalPendingDocumentType,
          status: FiscalDocumentStatus.QUEUED,
          providerId: issuer.providerId,
          environment: issuer.environment,
          issuerSnapshot: toJson(this.issuerInput(issuer)),
          linesSnapshot: sale.linesSnapshot,
          receiverEncrypted: new Uint8Array(this.cipher.seal(receiverRecord(sale.receiver))),
          ...maskColumnsOf(sale.receiver),
          currency: sale.currency,
          totalCents: sale.totalCents,
          taxCents: sale.taxCents
        },
        select: { id: true }
      })
      return created.id
    })
  }

  // The sale as the order has it now: the lines with the tax snapshot of Step 4B.3b, the amounts of the order and its customer as the
  // receiver. The amounts are the order's own, never recomputed here.
  // `withFiscalData` is false where the receiver is not taken from the sale (a retry keeps the receiver of the document, a replacement the one
  // of the voided document): the customer's sealed data is not opened for nothing
  private async readSale(
    tx: PrismaTransaction,
    organizationId: string,
    orderId: string,
    withFiscalData = true
  ) {
    const order = await tx.order.findFirst({
      where: { id: orderId, store: { organizationId } },
      select: {
        id: true,
        storeId: true,
        orderNumber: true,
        currency: true,
        shippingCents: true,
        discountCents: true,
        totalCents: true,
        taxCents: true,
        pricesIncludeTax: true,
        paymentMethod: true,
        paymentStatus: true,
        paymentReference: true,
        shippingAddress: true,
        customerId: true,
        customer: {
          select: { name: true, email: true, phone: true, erasedAt: true, mergedIntoId: true }
        },
        items: {
          orderBy: { id: 'asc' },
          select: {
            productName: true,
            variantName: true,
            quantity: true,
            unitPriceCents: true,
            taxRateBps: true,
            taxCents: true,
            taxTreatment: true
          }
        }
      }
    })
    if (order === null) return null
    const lines = documentLines(order.items)
    const orderTax = order.taxCents ?? 0
    const linesTax = lines.reduce((sum, line) => sum + line.taxCents, 0)
    const address: Record<string, string> = {}
    for (const [key, value] of Object.entries(record(order.shippingAddress))) {
      if (typeof value === 'string' && value !== '') address[key] = value
    }
    const contact: FiscalReceiver = {
      name: order.customer.name,
      taxId: null,
      registrationId: null,
      address: Object.keys(address).length > 0 ? address : null,
      email: order.customer.email,
      phone: order.customer.phone
    }
    // The fiscal data of the customer, as it is at this moment, is copied into the receiver: the document keeps its own sealed copy and a
    // later change of the customer's data never reaches it
    const taxSnapshotMissing =
      order.taxCents === null ||
      order.pricesIncludeTax === null ||
      order.items.some(item => item.taxCents === null)
    const receiver = receiverWithFiscalData(
      contact,
      // A customer that was erased or merged into another has no fiscal data to copy: it must not come back in a new document. Nor is the
      // sealed data opened for an order that makes no document (no tax snapshot): a key that changed must not hide that answer
      !withFiscalData ||
        taxSnapshotMissing ||
        order.customer.erasedAt !== null ||
        order.customer.mergedIntoId !== null
        ? null
        : await this.customerFiscalReceiver(tx, order.storeId, order.customerId)
    )
    return {
      storeId: order.storeId,
      // An order made before the tax snapshot (HC-006): its tax is not known, so no document is made of it with a tax of 0. The credit
      // note, the legal books and the entry of the sale refuse such an order too (TAX_MISSING)
      taxSnapshotMissing,
      currency: order.currency,
      totalCents: order.totalCents,
      taxCents: Math.min(orderTax, order.totalCents),
      receiver,
      linesSnapshot: toJson({
        lines,
        shippingCents: order.shippingCents,
        shippingTaxCents: Math.max(0, orderTax - linesTax),
        discountCents: order.discountCents,
        // null on an order made before the tax columns: its prices are read as tax included, like the order does
        pricesIncludeTax: order.pricesIncludeTax ?? true,
        orderNumber: order.orderNumber,
        // How the order was paid when the document was made, kept with it so every attempt builds the same document
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        paymentReference: order.paymentReference
      })
    }
  }

  // The fiscal data of a customer of the store, opened. What cannot be opened (a key that changed) stops the document: made without it, a
  // customer who has a tax id would be invoiced as a consumer, a legal document that says less than the customer asked for.
  private async customerFiscalReceiver(
    tx: PrismaTransaction,
    storeId: string,
    customerId: string
  ): Promise<FiscalReceiver | null> {
    const row = await tx.customerFiscalData.findFirst({
      where: { storeId, customerId },
      select: { dataEncrypted: true }
    })
    if (row === null) return null
    try {
      return receiverOf(
        openSealed(this.cipher, this.logger, row.dataEncrypted, SealedValueKind.CUSTOMER_DATA, {
          customerId
        })
      )
    } catch {
      // `openSealed` logged the name of the error, the cause and the ids
      throw new PlatformException(
        ErrorCodes.FISCAL_CUSTOMER_DATA_INVALID,
        'the fiscal data of the customer cannot be read: write it again',
        HttpStatusCodes.CONFLICT,
        { reason: 'unreadable' }
      )
    }
  }

  // The correlative: an atomic increment, so two documents never share a number
  private async takeSequence(tx: PrismaTransaction, organizationId: string): Promise<number> {
    const taken = await tx.fiscalIssuer.update({
      where: { organizationId },
      data: { nextSequence: { increment: 1 } },
      select: { nextSequence: true }
    })
    return taken.nextSequence - 1
  }

  // The key of the entry of the books a document belongs to: the sale, or the return its credit note is for. The link is made by this key,
  // never by copying amounts.
  private entryKeyOf(doc: { kind: string; orderId: string; returnId: string | null }): string {
    if (doc.kind !== (FiscalDocumentKind.CREDIT_NOTE as string)) {
      return FinancePostingKey.ORDER_SALE(doc.orderId)
    }
    return doc.returnId === null
      ? FinancePostingKey.ORDER_RETURN(doc.orderId)
      : FinancePostingKey.RETURN_RESTOCK(doc.returnId)
  }

  // ---------------------------------------------------------------- a return makes a credit note

  // A return was received: the credit note of its units, linked to the sale document it cancels (part of). No issuer, or no sale document
  // that is not voided (the sale was never documented), is no credit note: there is nothing to cancel. One credit note per return: asking
  // twice answers nothing the second time. Returns the id to enqueue, or null.
  async createCreditNoteForReturn(
    organizationId: string,
    returnId: string
  ): Promise<string | null> {
    return this.onceOnly(() =>
      this.inTx(organizationId, async tx => {
        const found = await tx.orderReturn.findFirst({
          where: { id: returnId, store: { organizationId } },
          select: { id: true, storeId: true, orderId: true, status: true, receivedAt: true }
        })
        if (
          found === null ||
          found.receivedAt === null ||
          !hasReceivedUnits(found.status as OrderReturnStatus)
        ) {
          return null
        }
        return this.makeCreditNote(tx, organizationId, found.orderId, found.id)
      })
    )
  }

  // An order that came back as a whole with no return row (a parcel that came back, a delivered order an agent put back): every unit is
  // back. An order whose returns were received has a credit note per return instead, so this makes none for it.
  async createCreditNoteForOrder(organizationId: string, orderId: string): Promise<string | null> {
    return this.onceOnly(() => this.makeOrderCreditNote(organizationId, orderId))
  }

  private makeOrderCreditNote(organizationId: string, orderId: string): Promise<string | null> {
    return this.inTx(organizationId, async tx => {
      const order = await tx.order.findFirst({
        where: { id: orderId, store: { organizationId } },
        select: { id: true, storeId: true, status: true }
      })
      // Like the entry of the books: an order that is not returned (the event was late, or came twice) has no credit note
      if (order === null || order.status !== (OrderStatus.RETURNED as string)) return null
      const withReturns = await tx.orderReturn.count({
        where: {
          storeId: order.storeId,
          orderId,
          // The same predicate as the entry of the books, so the note and the entry agree on what the order is
          status: { in: [OrderReturnStatus.RECEIVED, OrderReturnStatus.COMPLETED] }
        }
      })
      if (withReturns > 0) return null
      return this.makeCreditNote(tx, organizationId, orderId, null)
    })
  }

  // Two events for the same return (a repeated one, or the whole-order one next to a return) race the partial unique indexes: the one that
  // loses finds the note already made, which is the answer, not a fault
  private async onceOnly(make: () => Promise<string | null>): Promise<string | null> {
    try {
      return await inSavepoint(make)
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Said, not swallowed: another unique rule of the table would be hidden here otherwise
        this.logger.warn('a credit note was not made again: the database says it already exists')
        return null
      }
      throw error
    }
  }

  // The credit note, in the transaction of its caller. `returnId` null is the order as a whole. A credit note whose units do not fit the
  // sale is made REJECTED with the reason, so a person sees it and retries it, instead of being dropped in silence.
  private async makeCreditNote(
    tx: PrismaTransaction,
    organizationId: string,
    orderId: string,
    returnId: string | null,
    parentOverride?: { id: string }
  ): Promise<string | null> {
    const issuer = await tx.fiscalIssuer.findUnique({ where: { organizationId } })
    if (issuer === null) return null
    const parent =
      parentOverride === undefined
        ? await this.soleLiveSale(tx, organizationId, orderId)
        : await tx.fiscalDocument.findFirst({
            where: { id: parentOverride.id, organizationId },
            select: { id: true, ...RECEIVER_AND_MASKS }
          })
    if (parent === null) return null
    const live = await tx.fiscalDocument.findFirst({
      where: {
        organizationId,
        kind: FiscalDocumentKind.CREDIT_NOTE,
        status: { not: FiscalDocumentStatus.VOIDED },
        ...(returnId === null ? { orderId, returnId: null } : { returnId })
      },
      select: { id: true }
    })
    if (live !== null) return null
    const note = await this.readCreditNote(tx, organizationId, orderId, returnId)
    if (note === null) return null
    const sequenceNumber = await this.takeSequence(tx, organizationId)
    const entry = await tx.journalEntry.findFirst({
      where: {
        organizationId,
        idempotencyKey: this.entryKeyOf({
          kind: FiscalDocumentKind.CREDIT_NOTE,
          orderId,
          returnId
        })
      },
      select: { id: true }
    })
    const created = await tx.fiscalDocument.create({
      data: {
        organizationId,
        storeId: note.storeId,
        orderId,
        kind: FiscalDocumentKind.CREDIT_NOTE,
        returnId,
        parentDocumentId: parent.id,
        journalEntryId: entry?.id ?? null,
        sequenceNumber,
        documentType: FiscalPendingDocumentType,
        status: note.ok ? FiscalDocumentStatus.QUEUED : FiscalDocumentStatus.REJECTED,
        rejectionReason: note.ok ? null : FiscalRejectionReasons.RETURN_INCONSISTENT,
        providerId: issuer.providerId,
        environment: issuer.environment,
        issuerSnapshot: toJson(this.issuerInput(issuer)),
        linesSnapshot: note.linesSnapshot,
        // The receiver of a credit note is the one of the sale document it cancels
        receiverEncrypted: new Uint8Array(parent.receiverEncrypted),
        ...copiedMasksOf(parent),
        currency: note.currency,
        totalCents: note.totalCents,
        taxCents: note.taxCents
      },
      select: { id: true }
    })
    if (!note.ok) {
      this.announce(
        tx,
        { id: created.id, organizationId, storeId: note.storeId, orderId },
        FiscalRejectionReasons.RETURN_INCONSISTENT
      )
      return null
    }
    return created.id
  }

  // What the credit note is for, from the order as it is and the returns received before this one (the same running total the books use
  // for the entry of the return, so the note and the entry agree to the cent). `ok: false` keeps an empty document for a person to see.
  private async readCreditNote(
    tx: PrismaTransaction,
    organizationId: string,
    orderId: string,
    returnId: string | null
  ) {
    const order = await tx.order.findFirst({
      where: { id: orderId, store: { organizationId } },
      select: {
        storeId: true,
        orderNumber: true,
        currency: true,
        subtotalCents: true,
        shippingCents: true,
        discountCents: true,
        totalCents: true,
        taxCents: true,
        pricesIncludeTax: true,
        paymentMethod: true,
        paymentStatus: true,
        paymentReference: true,
        items: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            productName: true,
            variantName: true,
            quantity: true,
            unitPriceCents: true,
            taxRateBps: true,
            taxCents: true,
            taxTreatment: true
          }
        }
      }
    })
    if (order === null) return null
    // An order made before the tax snapshot has nothing to credit by line: the books cannot reverse it either (TAX_MISSING, listed for a
    // person there), so no document is made that could never be sent
    if (
      order.taxCents === null ||
      order.pricesIncludeTax === null ||
      order.items.some(item => item.taxCents === null)
    ) {
      this.logger.warn({ orderId }, 'no credit note was made: the order has no tax snapshot')
      return null
    }
    let before = new Map<string, number>()
    let returned = new Map<string, number>(order.items.map(item => [item.id, item.quantity]))
    if (returnId !== null) {
      const found = await tx.orderReturn.findFirst({
        where: { id: returnId, orderId, storeId: order.storeId },
        select: {
          id: true,
          receivedAt: true,
          lines: { select: { orderItemId: true, quantity: true } }
        }
      })
      if (found === null || found.receivedAt === null) return null
      const earlier = await tx.orderReturn.findMany({
        where: {
          storeId: order.storeId,
          orderId,
          status: { in: [OrderReturnStatus.RECEIVED, OrderReturnStatus.COMPLETED] },
          receivedAt: { not: null },
          OR: [
            { receivedAt: { lt: found.receivedAt } },
            { receivedAt: found.receivedAt, id: { lt: found.id } }
          ]
        },
        select: { lines: { select: { orderItemId: true, quantity: true } } }
      })
      const unitsBy = (lines: readonly { orderItemId: string; quantity: number }[]) => {
        const units = new Map<string, number>()
        for (const line of lines) {
          units.set(line.orderItemId, (units.get(line.orderItemId) ?? 0) + line.quantity)
        }
        return units
      }
      before = unitsBy(earlier.flatMap(row => row.lines))
      returned = unitsBy(found.lines)
    }
    const credit = creditNoteSaleOf(
      {
        subtotalCents: order.subtotalCents,
        discountCents: order.discountCents,
        shippingCents: order.shippingCents,
        totalCents: order.totalCents,
        taxCents: order.taxCents,
        pricesIncludeTax: order.pricesIncludeTax,
        lines: order.items.map(item => ({
          orderItemId: item.id,
          productName: item.productName,
          variantName: item.variantName,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          taxRateBps: item.taxRateBps,
          taxCents: item.taxCents,
          taxTreatment: item.taxTreatment
        }))
      },
      before,
      returned
    )
    const sale = credit.ok
      ? credit.sale
      : {
          lines: [],
          shippingCents: 0,
          shippingTaxCents: 0,
          discountCents: 0,
          pricesIncludeTax: order.pricesIncludeTax ?? true,
          totalCents: 0,
          taxCents: 0
        }
    return {
      ok: credit.ok,
      storeId: order.storeId,
      currency: order.currency,
      totalCents: sale.totalCents,
      taxCents: sale.taxCents,
      linesSnapshot: toJson({
        lines: sale.lines,
        shippingCents: sale.shippingCents,
        shippingTaxCents: sale.shippingTaxCents,
        discountCents: sale.discountCents,
        pricesIncludeTax: sale.pricesIncludeTax,
        orderNumber: order.orderNumber,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        paymentReference: order.paymentReference
      })
    }
  }

  // ---------------------------------------------------------------- the worker submits it

  // One attempt, run by the worker. Returns normally when the document reached a state a person or the authority decided (accepted,
  // rejected) and throws when the provider could not answer, so the queue tries again with its backoff. Safe to repeat: a document that
  // is not waiting (or whose previous attempt was cut short) is consulted before anything is sent again.
  async submit(organizationId: string, documentId: string): Promise<void> {
    const claimed = await this.claim(organizationId, documentId)
    if (claimed === null) return
    if (claimed === 'busy') {
      // Another attempt claimed it a moment ago: this job fails so that the backoff of the queue asks again after the lease
      throw new FiscalDocumentBusyError('the fiscal document is being submitted by another attempt')
    }
    if (claimed === 'waiting') {
      // A credit note whose sale document has not been accepted yet: nothing was claimed, the queue asks again with its backoff
      throw new FiscalDocumentBusyError('the sale document of this credit note is not accepted yet')
    }
    const { doc, issuer, provider, original } = claimed
    if (original === 'voided') {
      await this.reject(
        doc.id,
        organizationId,
        doc.claimToken,
        FiscalRejectionReasons.ORIGINAL_VOIDED,
        {
          beforeSending: true
        }
      )
      return
    }
    // The document was made for a provider and an environment: an issuer that changed since (and has not been remade by a retry) is
    // not the one it was made for, and its credentials are not this document's to use
    if (
      issuer === null ||
      provider === undefined ||
      issuer.providerId !== doc.providerId ||
      !sameIssuer(record(doc.issuerSnapshot), issuer)
    ) {
      await this.reject(
        doc.id,
        organizationId,
        doc.claimToken,
        issuer === null || provider === undefined
          ? FiscalRejectionReasons.PROVIDER_UNAVAILABLE
          : FiscalRejectionReasons.ISSUER_CHANGED,
        { beforeSending: true }
      )
      return
    }
    const credentials =
      issuer.credentialsEncrypted === null
        ? {}
        : this.openCredentials(issuer.credentialsEncrypted, SealedValueKind.ISSUER_CREDENTIALS, {
            organizationId
          })
    if (credentials === null) {
      await this.reject(
        doc.id,
        organizationId,
        doc.claimToken,
        FiscalRejectionReasons.CREDENTIALS_UNREADABLE,
        {
          beforeSending: true
        }
      )
      return
    }
    // The identity of the issuer is the one the document was made with
    const issuerInput = this.issuerOfSnapshot(doc.issuerSnapshot)
    const context: ProviderContext = {
      issuer: issuerInput,
      credentials,
      // One key per submission: the same on every attempt of it, new when the authority refused the document and a person fixed it
      idempotencyKey: `${organizationId}:${documentId}:${doc.submission}`,
      attempt: doc.attempts + 1
    }
    // A document made in a contingency goes out as it was kept (what the receiver was handed is what the authority gets), after the event
    // that lists it was taken (the claim above lets it through only then)
    if (doc.contingencyId !== null) {
      await this.sendKept(organizationId, doc, provider, context)
      return
    }
    const receiver = this.openReceiver(doc.receiverEncrypted, doc.id)
    const parts = record(doc.linesSnapshot)
    const sale = saleOf(doc, parts)
    // The provider never sees a sale whose parts do not add up to what the order took
    // The bound of the tax of the shipping is asked only of a sale that was never sent: one that may already be at the authority is consulted
    // below and is not refused here for a rule it was not built under
    if (!saleAddsUp(sale) || (original === null && doc.attempts === 0 && !shippingTaxFits(sale))) {
      await this.reject(
        doc.id,
        organizationId,
        doc.claimToken,
        FiscalRejectionReasons.SALE_INCONSISTENT,
        {
          beforeSending: true
        }
      )
      return
    }
    // A credit note with nothing in it is a return that did not fit its sale (made so on purpose, to be seen): it is never sent
    if (original !== null && sale.lines.length === 0) {
      await this.reject(
        doc.id,
        organizationId,
        doc.claimToken,
        FiscalRejectionReasons.RETURN_INCONSISTENT,
        {
          beforeSending: true
        }
      )
      return
    }
    // The number the document carries: the next one of the series the provider's manifest names, kept for this document from now on (a
    // document refused and corrected keeps its number), or the correlative of the organization when the provider declares no series
    const numbered = await this.correlativeOf(organizationId, doc, provider, issuerInput, receiver)
    if (numbered === null) {
      await this.reject(
        doc.id,
        organizationId,
        doc.claimToken,
        FiscalRejectionReasons.BUILD_FAILED,
        {
          beforeSending: true
        }
      )
      return
    }
    // Another attempt took the document over and decided it: nothing is left for this one to do
    if (numbered === 'stale') return
    if (numbered === 'exhausted') {
      await this.reject(
        doc.id,
        organizationId,
        doc.claimToken,
        FiscalRejectionReasons.SEQUENCE_EXHAUSTED,
        {
          beforeSending: true
        }
      )
      return
    }
    const payment = paymentOfSnapshot(
      parts,
      sale.totalCents,
      doc.kind === (FiscalDocumentKind.CREDIT_NOTE as string)
    )
    // An open contingency of this issuer (the provider has the deferred model): the document is made in it
    const route = await this.contingencies.routeOf(
      organizationId,
      provider,
      issuerInput.environment
    )
    const built = await this.attempt('build', doc.id, () =>
      provider.build({
        ...(route.kind === 'attach'
          ? {
              contingency: {
                reason: route.contingency.reason,
                motive: route.contingency.motive
              }
            }
          : {}),
        kind: doc.kind as FiscalDocumentKind,
        credited: original === null ? null : this.creditedOf(original),
        sequenceNumber: doc.sequenceNumber,
        correlative: numbered.correlative,
        documentUuid: fiscalDocumentUuid(organizationId, doc.id),
        payments: payment.payments,
        condition: payment.condition,
        // Fixed when the document was made: every attempt of every submission builds the same document
        issuedAt: doc.createdAt.toISOString(),
        orderNumber: typeof parts['orderNumber'] === 'string' ? parts['orderNumber'] : '',
        currency: doc.currency,
        issuer: issuerInput,
        receiver,
        lines: sale.lines,
        shippingCents: sale.shippingCents,
        shippingTaxCents: sale.shippingTaxCents,
        discountCents: sale.discountCents,
        totalCents: sale.totalCents,
        taxCents: sale.taxCents,
        pricesIncludeTax: sale.pricesIncludeTax
      })
    )
    if (built === null) {
      await this.reject(
        doc.id,
        organizationId,
        doc.claimToken,
        FiscalRejectionReasons.BUILD_FAILED,
        {
          beforeSending: true
        }
      )
      return
    }
    // The series was chosen from the type the provider said the document is: a document of another type would carry a number of a series
    // that is not its own, so it is never sent
    if (numbered.documentType !== null && built.documentType !== numbered.documentType) {
      await this.reject(
        doc.id,
        organizationId,
        doc.claimToken,
        FiscalRejectionReasons.BUILD_FAILED,
        {
          beforeSending: true
        }
      )
      return
    }
    if (built.missingReceiverFields.length > 0) {
      await this.reject(
        doc.id,
        organizationId,
        doc.claimToken,
        FiscalRejectionReasons.RECEIVER_INCOMPLETE,
        {
          built,
          beforeSending: true
        }
      )
      return
    }
    if (route.kind === 'attach') {
      await this.keepInContingency(organizationId, doc, provider, built, context, route)
      return
    }
    await this.deliver(organizationId, doc, provider, built, context)
  }

  // A document made in a contingency: signed by the provider and kept with the contingency, not sent. The consultation of an attempt
  // that may have reached the authority is not asked: the authority is what is down, and a document that was there is found when it is sent
  // (the same code answers "duplicate" and the consultation follows).
  private async keepInContingency(
    organizationId: string,
    doc: { id: string; claimToken: ClaimToken },
    provider: FiscalDocumentProvider,
    built: BuiltDocument,
    context: ProviderContext,
    route: Extract<FiscalContingencyRoute, { kind: 'attach' }>
  ): Promise<void> {
    // A contingency that holds the most an event takes does not get a document signed for nothing
    if (
      await this.contingencies.isFull(
        organizationId,
        route.contingency.id,
        route.mode.maxDocumentsPerEvent
      )
    ) {
      return this.requeueAndFail(
        organizationId,
        doc.id,
        doc.claimToken,
        'the open contingency holds the most documents an event takes'
      )
    }
    const deferred = await this.attempt('defer', doc.id, () =>
      Promise.resolve().then(() => provider.deferDocument?.(built, context))
    )
    if (
      deferred === null ||
      deferred === undefined ||
      deferred.outcome === FiscalDeferOutcome.UNAVAILABLE
    ) {
      return this.requeueAndFail(
        organizationId,
        doc.id,
        doc.claimToken,
        'the fiscal provider could not sign the document in contingency'
      )
    }
    if (deferred.outcome === FiscalDeferOutcome.REJECTED) {
      await this.reject(
        doc.id,
        organizationId,
        doc.claimToken,
        typeof deferred.reason === 'string' ? deferred.reason : '',
        { built, beforeSending: true }
      )
      return
    }
    const kept = await this.contingencies.attach(
      organizationId,
      doc.id,
      doc.claimToken,
      route.contingency.id,
      built,
      deferred.providerData,
      route.mode.maxDocumentsPerEvent
    )
    if (kept === FiscalContingencyAttachResult.ATTACHED) return
    // Ended a moment ago, full, or gone: the document goes back to the queue and is made again, by the rule of the moment
    return this.requeueAndFail(
      organizationId,
      doc.id,
      doc.claimToken,
      kept === FiscalContingencyAttachResult.FULL
        ? 'the open contingency holds the most documents an event takes'
        : 'the contingency ended while the document was made'
    )
  }

  // A document of a reported contingency: the kept document goes to the provider as it was
  private async sendKept(
    organizationId: string,
    doc: {
      id: string
      claimToken: ClaimToken
      documentType: string
      builtPayloadEncrypted: Uint8Array | null
      attempts: number
      contingencyId: string | null
    },
    provider: FiscalDocumentProvider,
    context: ProviderContext
  ): Promise<void> {
    let payload: Record<string, unknown> | null = null
    if (doc.builtPayloadEncrypted !== null)
      payload = this.openCredentials(doc.builtPayloadEncrypted, SealedValueKind.BUILT_PAYLOAD, {
        documentId: doc.id
      })
    if (payload === null) {
      await this.reject(
        doc.id,
        organizationId,
        doc.claimToken,
        FiscalRejectionReasons.BUILD_FAILED,
        {
          beforeSending: true
        }
      )
      return
    }
    const built: BuiltDocument = {
      documentType: doc.documentType,
      payload,
      missingReceiverFields: []
    }
    await this.deliver(organizationId, doc, provider, built, context)
  }

  // The authority did not answer on every attempt the lifecycle waits for, and the provider has a deferred model: a contingency opens (the
  // person is told) and the document is made again in it, by the rule of the moment. A document of a contingency never opens another.
  // Returns whether the document was taken up again.
  private async openContingencyAndRetry(
    organizationId: string,
    doc: { id: string; claimToken: ClaimToken; attempts: number; contingencyId?: string | null },
    provider: FiscalDocumentProvider,
    context: ProviderContext
  ): Promise<boolean> {
    if (
      doc.contingencyId != null ||
      provider.manifest.contingencyMode === undefined ||
      doc.attempts + 1 < FiscalContingencyLimits.AUTO_OPEN_AFTER_ATTEMPTS
    ) {
      return false
    }
    await this.contingencies.openBySystem(organizationId, provider, context.issuer.environment)
    // One that is open for another provider or environment (the issuer changed since) does not take this document: it goes on as it did,
    // and nothing here calls itself again for ever
    const route = await this.contingencies.routeOf(
      organizationId,
      provider,
      context.issuer.environment
    )
    if (route.kind !== 'attach') return false
    await this.inUnit(organizationId, () =>
      this.prisma.client.fiscalDocument.updateMany({
        where: {
          id: doc.id,
          organizationId,
          status: FiscalDocumentStatus.SUBMITTED,
          claimToken: doc.claimToken
        },
        data: { status: FiscalDocumentStatus.QUEUED, claimToken: null }
      })
    )
    await this.submit(organizationId, doc.id)
    return true
  }

  // Sends a built document and decides what the provider answered: the consultation of an earlier attempt, the submission, and what each
  // answer does to the document
  private async deliver(
    organizationId: string,
    doc: { id: string; claimToken: ClaimToken; attempts: number; contingencyId?: string | null },
    provider: FiscalDocumentProvider,
    built: BuiltDocument,
    context: ProviderContext
  ): Promise<void> {
    // An earlier attempt of this submission may have reached the authority before it was cut short: ask before sending a second document.
    // A consultation that gets no answer is not "never received": the document goes back to the queue and the consultation is asked again.
    if (doc.attempts > 0) {
      const consulted = await this.attempt('consult', doc.id, () =>
        provider.consult(built, context)
      )
      if (consulted === null) {
        if (await this.openContingencyAndRetry(organizationId, doc, provider, context)) return
        return this.requeueAndFail(
          organizationId,
          doc.id,
          doc.claimToken,
          'the fiscal provider did not answer the consultation'
        )
      }
      if (consulted?.state === FiscalConsultState.ACCEPTED) {
        if (!hasNumber(consulted.externalNumber)) {
          await this.reject(
            doc.id,
            organizationId,
            doc.claimToken,
            FiscalRejectionReasons.PROVIDER_ANSWER_INVALID
          )
          return
        }
        await this.accept(doc.id, organizationId, doc.claimToken, built, consulted)
        return
      }
      if (consulted?.state === FiscalConsultState.REJECTED) {
        await this.reject(doc.id, organizationId, doc.claimToken, consulted.reason, {
          built,
          response: consulted.response,
          byAuthority: true
        })
        return
      }
    }
    const result = (await this.attempt('submit', doc.id, () =>
      provider.submit(built, context)
    )) ?? {
      outcome: FiscalSubmitOutcome.UNAVAILABLE as const
    }
    if (result.outcome === FiscalSubmitOutcome.ACCEPTED) {
      // An acceptance with no number could never be invalidated: it is not kept as one
      if (!hasNumber(result.externalNumber)) {
        await this.reject(
          doc.id,
          organizationId,
          doc.claimToken,
          FiscalRejectionReasons.PROVIDER_ANSWER_INVALID
        )
        return
      }
      await this.accept(doc.id, organizationId, doc.claimToken, built, result)
      return
    }
    if (result.outcome === FiscalSubmitOutcome.REJECTED) {
      await this.reject(
        doc.id,
        organizationId,
        doc.claimToken,
        typeof result.reason === 'string' ? result.reason : '',
        result.neverSent === true
          ? { built, response: result.response, beforeSending: true }
          : { built, response: result.response, byAuthority: true }
      )
      return
    }
    // The authority did not answer on every attempt the lifecycle waits for: a contingency opens and the document is made again in it
    if (await this.openContingencyAndRetry(organizationId, doc, provider, context)) return
    // The authority did not answer: back to the queue, and the job fails so that the backoff of the queue spaces the next attempt
    await this.requeueAndFail(
      organizationId,
      doc.id,
      doc.claimToken,
      'the fiscal provider did not answer'
    )
  }

  // The number a document carries in the series its provider's manifest declares (`FiscalSequenceDeclaration`). A provider that declares
  // no series numbers by the correlative of the organization, taken when the document was made. Otherwise the series is the provider, the
  // environment and what the manifest names (the type of the document, the establishment, the point of sale): the first attempt takes the
  // next number of it and keeps it on the document, and every later attempt and submission of the same document builds with that number.
  // Only when the series changes (a receiver fixed after a refusal makes another type of document) the document takes the next number of
  // the new series; the number of the old one stays unused (the books of the accountant see the gap: debt (a) of Step 4B.7c-1).
  // Returns null when the provider cannot say which type the document is or the issuer lacks a part of the series the manifest declares,
  // 'exhausted' when the series has no number left, and 'stale' when the document is no longer the one this attempt claimed (another
  // attempt took it over and decided it): nothing is taken then, so a late attempt never spends a number.
  private async correlativeOf(
    organizationId: string,
    doc: { id: string; kind: string; sequenceNumber: number; claimToken: ClaimToken },
    provider: FiscalDocumentProvider,
    issuer: FiscalIssuerInput,
    receiver: FiscalReceiver
  ): Promise<{ correlative: number; documentType: string | null } | null | 'exhausted' | 'stale'> {
    const scope = provider.manifest.sequence
    if (!declaresSequence(scope)) return { correlative: doc.sequenceNumber, documentType: null }
    // A series the manifest declares by establishment or point of sale needs that code: with none, every document would share one series
    // and the numbers would start again the day the owner sets it
    if (
      (scope?.perEstablishment === true && issuer.establishmentCode === null) ||
      (scope?.perPointOfSale === true && issuer.pointOfSaleCode === null)
    ) {
      return null
    }
    let documentType = ''
    if (scope?.perDocumentType === true) {
      const resolved = await this.attempt('resolve', doc.id, () =>
        Promise.resolve().then(() =>
          provider.resolveDocumentType?.({ kind: doc.kind as FiscalDocumentKind, receiver })
        )
      )
      if (typeof resolved !== 'string' || resolved.trim() === '') return null
      documentType = resolved
    }
    const parts = {
      providerId: provider.id,
      environment: issuer.environment,
      documentType,
      establishmentCode: issuer.establishmentCode,
      pointOfSaleCode: issuer.pointOfSaleCode
    }
    const key = fiscalSequenceKey(scope, parts)
    if (key === null) return { correlative: doc.sequenceNumber, documentType: null }
    const resolvedType = scope?.perDocumentType === true ? documentType : null
    return this.inTx(organizationId, async tx => {
      await tx.$queryRaw`SELECT id FROM fiscal_documents WHERE id = ${doc.id} AND organization_id = ${organizationId} FOR UPDATE`
      const current = await tx.fiscalDocument.findFirst({
        where: { id: doc.id, organizationId },
        select: { correlative: true, correlativeScopeKey: true, status: true, claimToken: true }
      })
      if (current === null) return null
      // Only the attempt that holds the claim numbers a document
      if (
        current.status !== (FiscalDocumentStatus.SUBMITTED as string) ||
        current.claimToken !== doc.claimToken
      ) {
        return 'stale' as const
      }
      // Already numbered in this series (an earlier attempt, a corrected document of the same type): the same number
      if (current.correlative !== null && current.correlativeScopeKey === key) {
        return { correlative: current.correlative, documentType: resolvedType }
      }
      const described = toJson({
        providerId: parts.providerId,
        environment: parts.environment,
        ...(scope?.perDocumentType === true ? { documentType } : {}),
        ...(scope?.perEstablishment === true ? { establishmentCode: parts.establishmentCode } : {}),
        ...(scope?.perPointOfSale === true ? { pointOfSaleCode: parts.pointOfSaleCode } : {})
      })
      // An atomic upsert: the first document of a series creates it at 2 and takes 1, any other adds one and takes the one before. Two
      // documents of the same series never share a number, and the lock of the document above keeps the same document from taking two.
      const rows = await tx.$queryRaw<{ taken: number }[]>`
        INSERT INTO fiscal_sequences (organization_id, scope_key, scope, next_value, updated_at)
        VALUES (${organizationId}, ${key}, ${JSON.stringify(described)}::jsonb, 2, now())
        ON CONFLICT (organization_id, scope_key)
        DO UPDATE SET next_value = fiscal_sequences.next_value + 1, updated_at = now()
        RETURNING next_value - 1 AS taken`
      const taken = rows[0]?.taken
      if (taken === undefined) throw new Error('the series did not answer a number')
      // Past the INTEGER of the document: the transaction is rolled back, so the counter stays where it was and nothing is written
      if (taken > FiscalLimits.MAX_CORRELATIVE) throw new FiscalSequenceExhaustedError()
      await tx.fiscalDocument.update({
        where: { id: doc.id },
        data: { correlative: taken, correlativeScopeKey: key }
      })
      return { correlative: taken, documentType: resolvedType }
    }).catch((error: unknown) => {
      if (error instanceof FiscalSequenceExhaustedError) return 'exhausted' as const
      throw error
    })
  }

  // The last attempt of the job failed and the document is still waiting for the provider (QUEUED or SUBMITTED): nobody retries it any
  // more, so a person is told (Step 4B.7b-2). A document that was decided, or that is gone, says nothing. Safe to repeat: the notice is
  // deduplicated until it is read.
  async reportExhausted(
    organizationId: string,
    documentId: string,
    claimMayBeAlive = false
  ): Promise<void> {
    try {
      await this.reportExhaustedOnce(organizationId, documentId, claimMayBeAlive)
    } catch (error) {
      // Said in the log, never thrown: the error that matters is the one of the attempt that failed
      this.logger.error(
        { documentId, err: errorName(error) },
        'the notice of a fiscal document that ran out of attempts was not made'
      )
    }
  }

  private async reportExhaustedOnce(
    organizationId: string,
    documentId: string,
    claimMayBeAlive: boolean
  ): Promise<void> {
    await this.inTx(organizationId, async tx => {
      const doc = await tx.fiscalDocument.findFirst({
        where: {
          id: documentId,
          organizationId,
          status: { in: [FiscalDocumentStatus.QUEUED, FiscalDocumentStatus.SUBMITTED] },
          // The job failed because another attempt holds the claim: a claim that is alive (less than the lease ago) may still decide the
          // document, so it is not stuck. Any other failure of the last attempt leaves a claim that nobody will take over.
          ...(claimMayBeAlive
            ? {
                OR: [
                  { status: FiscalDocumentStatus.QUEUED },
                  { updatedAt: { lt: new Date(Date.now() - FiscalLimits.CLAIM_LEASE_MS) } }
                ]
              }
            : {})
        },
        select: { id: true, organizationId: true, storeId: true, orderId: true, attempts: true }
      })
      if (doc === null) return
      this.events.publish(tx, Events.FISCAL_DOCUMENT_STUCK, {
        organizationId: doc.organizationId,
        storeId: doc.storeId,
        documentId: doc.id,
        orderId: doc.orderId,
        attempts: Math.max(1, doc.attempts)
      })
    })
  }

  private async requeueAndFail(
    organizationId: string,
    documentId: string,
    claimToken: ClaimToken,
    message: string
  ): Promise<never> {
    await this.inUnit(organizationId, () =>
      this.prisma.client.fiscalDocument.updateMany({
        where: {
          id: documentId,
          organizationId,
          status: FiscalDocumentStatus.SUBMITTED,
          claimToken
        },
        data: { status: FiscalDocumentStatus.QUEUED, claimToken: null }
      })
    )
    throw new Error(message)
  }

  // A call to a provider, awaited inside the try: a provider may throw before it returns a promise as well as reject it. What it throws
  // is not kept (it may carry the receiver's data); the caller reads null as "no answer".
  // Only the name of the error is logged (never its message, which may carry the receiver), with the document and the call, so that a
  // fault of a provider can be found. A call that does not answer in time is no answer either.
  private async attempt<T>(
    operation: string,
    documentId: string,
    call: () => Promise<T>
  ): Promise<T | null> {
    try {
      const answer = await withTimeout(call, FiscalLimits.PROVIDER_CALL_TIMEOUT_MS)
      if (answer === null) {
        this.logger.warn({ documentId, operation }, 'a fiscal provider did not answer in time')
      }
      return answer
    } catch (error) {
      // A provider that refuses with a coded error (`code`, a short text of its own that never carries a value) has it logged: it is what an
      // operator reads to tell one refusal from another
      const code = (error as { code?: unknown } | null)?.code
      this.logger.warn(
        {
          documentId,
          operation,
          err: errorName(error),
          ...(typeof code === 'string' && code.length <= 64 ? { providerCode: code } : {})
        },
        'a fiscal provider call failed'
      )
      return null
    }
  }

  // QUEUED -> SUBMITTED under a row lock, counting the attempt. Anything else is not this job's: a duplicate job finds the document
  // already moved and does nothing. A document that is SUBMITTED was claimed by an attempt that is alive (it claimed less than the lease
  // ago: this one waits) or dead (its worker died after the claim: this one takes it over).
  private async claim(organizationId: string, documentId: string) {
    return this.inTx(organizationId, async tx => {
      await tx.$queryRaw`SELECT id FROM fiscal_documents WHERE id = ${documentId} AND organization_id = ${organizationId} FOR UPDATE`
      const doc = await tx.fiscalDocument.findFirst({ where: { id: documentId, organizationId } })
      if (doc === null) return null
      const status = doc.status as FiscalDocumentStatus
      if (status !== FiscalDocumentStatus.QUEUED && status !== FiscalDocumentStatus.SUBMITTED) {
        return null
      }
      if (
        status === FiscalDocumentStatus.SUBMITTED &&
        Date.now() - doc.updatedAt.getTime() < FiscalLimits.CLAIM_LEASE_MS
      ) {
        return 'busy' as const
      }
      // A document made in a contingency is held until the authority has taken the event that lists it (Step 4B.7c-7): nothing is claimed,
      // and the release of the contingency asks the queue for it
      if (
        doc.contingencyId !== null &&
        !(await this.contingencies.releasedOf(organizationId, doc.contingencyId, tx))
      ) {
        return null
      }
      const issuer = await tx.fiscalIssuer.findUnique({ where: { organizationId } })
      const provider = this.providers.find(doc.providerId)
      // A credit note goes only after the sale document it cancels was accepted. While that one is on its way the note waits (its job fails
      // and the queue asks again), and when it was voided the note is refused for a person to retry once the sale is replaced.
      let original:
        | { externalNumber: string; issuedAt: Date; documentType: string; providerData: unknown }
        | null
        | 'voided' = null
      let receiverEncrypted: Uint8Array<ArrayBuffer> | undefined
      let copiedMasks: ReturnType<typeof copiedMasksOf> | undefined
      if (doc.kind === (FiscalDocumentKind.CREDIT_NOTE as string)) {
        const parent =
          doc.parentDocumentId === null
            ? null
            : await tx.fiscalDocument.findFirst({
                where: { id: doc.parentDocumentId, organizationId }
              })
        const state =
          parent === null ? 'voided' : originalStateOf(parent.status as FiscalDocumentStatus)
        if (state === 'waiting') return 'waiting' as const
        if (parent === null || state === 'voided') original = 'voided'
        else if (parent.externalNumber === null || parent.issuedAt === null)
          return 'waiting' as const
        else {
          original = {
            externalNumber: parent.externalNumber,
            issuedAt: parent.issuedAt,
            documentType: parent.documentType,
            providerData: parent.providerData
          }
          // The receiver of the note is the one of the document it cancels, as that document has it now
          receiverEncrypted = new Uint8Array(parent.receiverEncrypted)
          copiedMasks = copiedMasksOf(parent)
        }
      }
      // The owner token is written by the same statement that moves the document, and only over the state this attempt read: a claim that
      // changed since is not taken twice. Every later write of this attempt compares the token.
      const claimToken = newClaimToken()
      const taken = await tx.fiscalDocument.updateMany({
        where: { id: doc.id, organizationId, status: doc.status, claimToken: doc.claimToken },
        data: {
          status: FiscalDocumentStatus.SUBMITTED,
          attempts: { increment: 1 },
          claimToken,
          // The receiver of the note changes to the parent's, and so do the masks: they are the ones of the same bytes
          ...(receiverEncrypted === undefined || copiedMasks === undefined
            ? {}
            : { receiverEncrypted, ...copiedMasks })
        }
      })
      if (taken.count !== 1) return 'busy' as const
      const updated = await tx.fiscalDocument.findFirstOrThrow({
        where: { id: doc.id, organizationId }
      })
      return {
        doc: { ...updated, attempts: doc.attempts, claimToken },
        issuer,
        provider,
        original
      }
    })
  }

  // What the provider decided is kept even when part of it cannot be stored: the authority has issued the document, and a payload the
  // database refuses is replaced by a note instead of making the acceptance fail (and be asked again for ever)
  private safeJson(value: unknown): Json {
    try {
      return toJson(value)
    } catch {
      return { unreadable: true }
    }
  }

  private async accept(
    documentId: string,
    organizationId: string,
    claimToken: ClaimToken,
    built: BuiltDocument,
    result: {
      externalNumber: string
      providerData?: Readonly<Record<string, unknown>>
      response?: Readonly<Record<string, unknown>>
    }
  ): Promise<void> {
    const providerData =
      result.providerData === undefined
        ? undefined
        : this.safeResponse(result.providerData, FiscalLimits.PROVIDER_DATA_MAX_CHARS)
    const response = result.response === undefined ? undefined : this.safeResponse(result.response)
    const sealedPayload = this.sealPayload(built.payload)
    const accepted = await this.inTx(organizationId, async tx => {
      await tx.$queryRaw`SELECT id FROM fiscal_documents WHERE id = ${documentId} AND organization_id = ${organizationId} FOR UPDATE`
      const doc = await tx.fiscalDocument.findFirstOrThrow({
        where: { id: documentId, organizationId },
        select: {
          orderId: true,
          kind: true,
          returnId: true,
          status: true,
          createdAt: true,
          claimToken: true
        }
      })
      // Another attempt decided first (this one was taken over): what is decided is not decided twice
      if (
        doc.status !== (FiscalDocumentStatus.SUBMITTED as string) ||
        doc.claimToken !== claimToken
      ) {
        this.logger.warn(
          { documentId },
          'the acceptance of a fiscal document was skipped: it was not being submitted'
        )
        return false
      }
      // The sale entry may have posted after the document was made: the link is made now, never by copying its amounts
      const entry = await tx.journalEntry.findFirst({
        where: { organizationId, idempotencyKey: this.entryKeyOf(doc) },
        select: { id: true }
      })
      await tx.fiscalDocument.update({
        where: { id: documentId },
        data: {
          status: FiscalDocumentStatus.ACCEPTED,
          claimToken: null,
          documentType: built.documentType,
          externalNumber: plainText(result.externalNumber),
          providerData,
          builtPayloadEncrypted: sealedPayload,
          response,
          rejectionReason: null,
          rejectedAt: null,
          rejectionWarnedAt: null,
          issuedAt: doc.createdAt,
          ...(entry === null ? {} : { journalEntryId: entry.id })
        }
      })
      return true
    })
    // The evidence is kept once the acceptance is committed; it never decides the document (`keepAll` swallows its own failures)
    if (accepted) await this.evidence.keepAll(organizationId, documentId)
  }

  private safeResponse(
    response: Readonly<Record<string, unknown>>,
    max: number = FiscalLimits.RESPONSE_MAX_CHARS
  ): Json {
    try {
      const json = cappedResponse(response, max)
      if (typeof json === 'object' && !Array.isArray(json) && json['truncated'] === true) {
        this.logger.error({ max }, 'what a fiscal provider returned is larger than what is kept')
      }
      return json
    } catch {
      return { unreadable: true }
    }
  }

  // The document as the provider built it holds the receiver's data (name, tax id, address): it is sealed like the receiver
  private sealPayload(payload: Readonly<Record<string, unknown>>): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.cipher.seal(this.safeJson(payload) as Record<string, unknown>))
  }

  // `byAuthority`: the authority (not core) refused this submission, so the next one is a new submission with a new key and a fresh
  // count of attempts. A refusal core raised before the provider was reached keeps the key: nothing was ever sent under it.
  private async reject(
    documentId: string,
    organizationId: string,
    claimToken: ClaimToken,
    reason: string,
    options: {
      built?: BuiltDocument
      response?: Readonly<Record<string, unknown>>
      byAuthority?: boolean
      // Refused by core before anything was sent to the provider: the claim of this attempt is given back, so that a document that never
      // left core never reads as one that may be at the authority
      beforeSending?: boolean
    } = {}
  ): Promise<void> {
    const sealedPayload =
      options.built === undefined ? undefined : this.sealPayload(options.built.payload)
    const response =
      options.response === undefined ? undefined : this.safeResponse(options.response)
    await this.inTx(organizationId, async tx => {
      await tx.$queryRaw`SELECT id FROM fiscal_documents WHERE id = ${documentId} AND organization_id = ${organizationId} FOR UPDATE`
      const doc = await tx.fiscalDocument.findFirstOrThrow({
        where: { id: documentId, organizationId }
      })
      // Another attempt decided first (this one was taken over): what is decided is not decided twice
      if (
        doc.status !== (FiscalDocumentStatus.SUBMITTED as string) ||
        doc.claimToken !== claimToken
      ) {
        this.logger.warn(
          { documentId },
          'the rejection of a fiscal document was skipped: it was not being submitted'
        )
        return
      }
      const clean = plainText(reason).trim()
      const kept = (clean === '' ? FiscalRejectionReasons.PROVIDER_UNAVAILABLE : clean).slice(
        0,
        FiscalLimits.REASON_MAX_LENGTH
      )
      await tx.fiscalDocument.update({
        where: { id: documentId },
        data: {
          status: FiscalDocumentStatus.REJECTED,
          claimToken: null,
          rejectionReason: kept,
          // The refusal of the authority starts the window to send it again; one core made before sending has none
          ...(options.byAuthority === true
            ? { rejectedAt: new Date(), rejectionWarnedAt: null }
            : { rejectedAt: null, rejectionWarnedAt: null }),
          ...(options.built === undefined
            ? {}
            : { documentType: options.built.documentType, builtPayloadEncrypted: sealedPayload }),
          ...(response === undefined ? {} : { response }),
          ...(options.byAuthority === true ? { submission: { increment: 1 }, attempts: 0 } : {}),
          ...(options.beforeSending === true ? { attempts: { decrement: 1 } } : {})
        }
      })
      this.announce(tx, doc, kept)
    })
  }

  // The window of a document that is refused, as the screen reads it
  private deadlineView(
    status: FiscalDocumentStatus,
    rejectedAt: Date | null,
    now: Date = new Date()
  ): { endsAt: string; state: FiscalRejectionDeadlineState } | null {
    if (status !== FiscalDocumentStatus.REJECTED) return null
    const deadline = rejectionDeadline(rejectedAt, now)
    return deadline === null
      ? null
      : { endsAt: deadline.endsAt.toISOString(), state: deadline.state }
  }

  // The window of an invalidation the authority refused: the document is still accepted
  private voidDeadlineView(
    status: FiscalDocumentStatus,
    voidRejectedAt: Date | null,
    now: Date = new Date()
  ): { endsAt: string; state: FiscalRejectionDeadlineState } | null {
    if (status !== FiscalDocumentStatus.ACCEPTED) return null
    const deadline = rejectionDeadline(voidRejectedAt, now)
    return deadline === null
      ? null
      : { endsAt: deadline.endsAt.toISOString(), state: deadline.state }
  }

  // The window to correct and send again a refused document, or a refused invalidation of an accepted one, is closing or over (D14, D14b): the
  // person is told, once for each refusal. The hourly check asks; the mark and its alert are one transaction, so a failure in between leaves
  // neither. Returns how many were told.
  async warnRejectionDeadlines(organizationId: string, now: Date = new Date()): Promise<number> {
    return (
      (await this.warnWindows(organizationId, now, FiscalWindowKind.DOCUMENT)) +
      (await this.warnWindows(organizationId, now, FiscalWindowKind.INVALIDATION))
    )
  }

  private async warnWindows(
    organizationId: string,
    now: Date,
    kind: FiscalWindowKind
  ): Promise<number> {
    const warnFrom = new Date(
      now.getTime() - (FiscalRejectionRetry.WINDOW_MS - FiscalRejectionRetry.WARN_BEFORE_MS)
    )
    const invalidation = kind === FiscalWindowKind.INVALIDATION
    // A document is refused (status REJECTED), an invalidation is refused for a document that stays ACCEPTED
    const status = invalidation ? FiscalDocumentStatus.ACCEPTED : FiscalDocumentStatus.REJECTED
    let told = 0
    for (;;) {
      const rows = await this.inTx(organizationId, async tx => {
        const found = await tx.fiscalDocument.findMany({
          where: {
            organizationId,
            status,
            ...(invalidation
              ? { voidRejectedAt: { not: null, lte: warnFrom }, voidRejectionWarnedAt: null }
              : { rejectedAt: { not: null, lte: warnFrom }, rejectionWarnedAt: null })
          },
          select: {
            id: true,
            storeId: true,
            orderId: true,
            rejectedAt: true,
            voidRejectedAt: true
          },
          orderBy: { id: 'asc' },
          take: FiscalSweepLimits.RUN_PAGE_SIZE
        })
        const warned: string[] = []
        for (const doc of found) {
          const deadline = rejectionDeadline(
            invalidation ? doc.voidRejectedAt : doc.rejectedAt,
            now
          )
          if (deadline === null || deadline.state === FiscalRejectionDeadlineState.OPEN) continue
          // The same condition the page was read with: a run that marked it first (or a document that moved on) leaves nothing to mark
          const marked = await tx.fiscalDocument.updateMany({
            where: {
              id: doc.id,
              organizationId,
              status,
              ...(invalidation ? { voidRejectionWarnedAt: null } : { rejectionWarnedAt: null })
            },
            data: invalidation ? { voidRejectionWarnedAt: now } : { rejectionWarnedAt: now }
          })
          if (marked.count === 0) continue
          this.events.publish(
            tx,
            invalidation
              ? Events.FISCAL_VOID_RETRANSMIT_DEADLINE
              : Events.FISCAL_RETRANSMIT_DEADLINE,
            {
              organizationId,
              storeId: doc.storeId,
              documentId: doc.id,
              orderId: doc.orderId,
              expired: deadline.state === FiscalRejectionDeadlineState.EXPIRED
            }
          )
          warned.push(doc.id)
        }
        return { read: found.length, warned }
      })
      told += rows.warned.length
      // A page that told nobody (all marked by another run, or none closing) is the end: it would read the same rows again
      if (rows.read < FiscalSweepLimits.RUN_PAGE_SIZE || rows.warned.length === 0) break
    }
    return told
  }

  private announce(
    tx: PrismaTransaction,
    doc: { id: string; organizationId: string; storeId: string; orderId: string },
    reason: string
  ): void {
    this.events.publish(tx, Events.FISCAL_DOCUMENT_REJECTED, {
      organizationId: doc.organizationId,
      storeId: doc.storeId,
      documentId: doc.id,
      orderId: doc.orderId,
      reason
    })
  }

  // ---------------------------------------------------------------- a person acts

  // The receiver of a document that is waiting or was refused: the person fixes the data the authority refused. Merged over what is
  // stored (a field sent as null is removed). The audit entry names the fields, never the values.
  async updateReceiver(
    organizationId: string,
    id: string,
    patch: Partial<
      Record<
        | 'name'
        | 'taxId'
        | 'registrationId'
        | 'email'
        | 'phone'
        | 'taxpayerType'
        | 'economicActivity'
        | 'documentType',
        string | null
      >
    > & {
      address?: Record<string, string> | null
    },
    actor: FiscalActor,
    guard: FiscalReachGuard
  ): Promise<FiscalDocumentView> {
    let replacedUnreadable = false
    await this.inTx(organizationId, async tx => {
      // The reach of the person (HC-128) is checked in the unit that writes, before the row is touched
      await guard()
      const doc = await this.lock(tx, organizationId, id)
      // A document kept in a contingency is the one the receiver was handed: its receiver changes only after the authority refused it
      if (
        !receiverEditable(doc.status as FiscalDocumentStatus, doc.attempts) ||
        (doc.contingencyId !== null && doc.status !== (FiscalDocumentStatus.REJECTED as string))
      ) {
        throw this.immutable(doc.status as FiscalDocumentStatus)
      }
      // The receiver of a credit note is the one of the document it cancels: it is fixed there, and the note takes it when it is sent
      if (doc.kind === (FiscalDocumentKind.CREDIT_NOTE as string)) {
        throw new PlatformException(
          ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
          'the receiver of a credit note is the one of the document it cancels',
          HttpStatusCodes.CONFLICT,
          { reason: FiscalConflictReasons.CREDIT_NOTE_RECEIVER }
        )
      }
      // A receiver that cannot be opened is not merged over: the change would be laid on an empty one and drop what was stored. The
      // person then writes the whole receiver (every field sent, null to leave one empty), or the api refuses with a reason.
      const opened = this.tryOpenReceiver(doc.receiverEncrypted, doc.id)
      if (opened === null && !WHOLE_RECEIVER_FIELDS.every(field => field in patch)) {
        throw new PlatformException(
          ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
          'the stored receiver cannot be read: the whole receiver must be sent',
          HttpStatusCodes.CONFLICT,
          { reason: FiscalConflictReasons.RECEIVER_UNREADABLE }
        )
      }
      replacedUnreadable = opened === null
      const current = opened ?? receiverOf({})
      const next: FiscalReceiver = {
        name: 'name' in patch ? (patch.name ?? null) : current.name,
        taxId: 'taxId' in patch ? (patch.taxId ?? null) : current.taxId,
        registrationId:
          'registrationId' in patch ? (patch.registrationId ?? null) : current.registrationId,
        email: 'email' in patch ? (patch.email ?? null) : current.email,
        phone: 'phone' in patch ? (patch.phone ?? null) : current.phone,
        address: 'address' in patch ? (patch.address ?? null) : current.address,
        taxpayerType:
          'taxpayerType' in patch ? (patch.taxpayerType ?? null) : (current.taxpayerType ?? null),
        economicActivity:
          'economicActivity' in patch
            ? (patch.economicActivity ?? null)
            : (current.economicActivity ?? null),
        documentType:
          'documentType' in patch ? (patch.documentType ?? null) : (current.documentType ?? null)
      }
      await tx.fiscalDocument.update({
        where: { id },
        data: {
          receiverEncrypted: new Uint8Array(this.cipher.seal(receiverRecord(next))),
          ...maskColumnsOf(next)
        }
      })
    })
    this.audit.log({
      action: AuditAction.FISCAL_DOCUMENT_RECEIVER_CHANGED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.DOCUMENT,
      resourceId: id,
      metadata: {
        fields: Object.keys(patch),
        ...(replacedUnreadable ? { replacedUnreadable: true } : {})
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.viewOf(organizationId, id)
  }

  // A refused (or stuck) document goes back to the queue; the caller enqueues the job. Returns the id.
  async retry(
    organizationId: string,
    id: string,
    actor: FiscalActor,
    guard: FiscalReachGuard
  ): Promise<{ id: string; submission: number; released: boolean }> {
    const { submission, released } = await this.inTx(organizationId, async tx => {
      await guard()
      const doc = await this.lock(tx, organizationId, id)
      const status = doc.status as FiscalDocumentStatus
      if (!retryable(status)) throw this.invalid(status)
      // A document that waits in the queue and is still kept in a contingency (released) is asked again with the retries of its window; a
      // refused one is made again as any other and leaves the contingency
      const released = status === FiscalDocumentStatus.QUEUED && doc.contingencyId !== null
      // The document is made again with the issuer as it is now (its provider, its environment, its identity): a retry is how a person
      // gets past an issuer that changed after the document was made. A document that is only waiting keeps the issuer it was made with.
      const issuer = await tx.fiscalIssuer.findUnique({ where: { organizationId } })
      if (status === FiscalDocumentStatus.REJECTED) {
        const moved =
          issuer !== null &&
          (issuer.providerId !== doc.providerId || !sameIssuer(record(doc.issuerSnapshot), issuer))
        // A document that may be at the authority (an attempt was sent and not answered) is not moved to another provider, another
        // environment or another identity: the consultation would go to the new one and the same number would be sent there. A person
        // decides it with the accountant and confirms it (`confirmIssuerChange`, Step 4B.7b-2).
        if (moved && doc.attempts > 0) {
          throw new PlatformException(
            ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
            'the document may be at the issuer it was made with and cannot move to another',
            HttpStatusCodes.CONFLICT,
            // A person who checked with the authority that it is not there confirms it (`confirmIssuerChange`)
            { reason: FiscalConflictReasons.ISSUER_CHANGED_IN_FLIGHT }
          )
        }
        const isNote = doc.kind === (FiscalDocumentKind.CREDIT_NOTE as string)
        // A credit note names the sale document that is live now: the one it was made for may have been voided and replaced since
        let parentDocumentId = doc.parentDocumentId
        if (isNote) {
          const live = await this.soleLiveSaleOrThrow(tx, organizationId, doc.orderId)
          if (live === null) {
            throw new PlatformException(
              ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
              'the sale document of this credit note was voided and has no replacement yet',
              HttpStatusCodes.CONFLICT,
              { reason: FiscalConflictReasons.ORIGINAL_VOIDED }
            )
          }
          parentDocumentId = live.id
        }
        // A sale that did not add up is read again from the order: a person may have corrected it since
        const inconsistent =
          doc.rejectionReason === FiscalRejectionReasons.SALE_INCONSISTENT ||
          doc.rejectionReason === FiscalRejectionReasons.RETURN_INCONSISTENT
        const sale = !inconsistent
          ? null
          : isNote
            ? await this.readCreditNote(tx, organizationId, doc.orderId, doc.returnId)
            : await this.readSale(tx, organizationId, doc.orderId, false)
        // The same answer as `replace`: a sale read again with no tax snapshot is not queued to be refused again with the same snapshot
        if (!isNote && sale !== null && 'taxSnapshotMissing' in sale && sale.taxSnapshotMissing) {
          throw new PlatformException(
            ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
            'the order has no tax snapshot: no document can be made of it',
            HttpStatusCodes.CONFLICT,
            { reason: FiscalConflictReasons.TAX_SNAPSHOT_MISSING }
          )
        }
        if (isNote && inconsistent && (sale === null || ('ok' in sale && !sale.ok))) {
          throw new PlatformException(
            ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
            'the units of this return still do not fit its sale',
            HttpStatusCodes.CONFLICT,
            { reason: FiscalConflictReasons.RETURN_INCONSISTENT }
          )
        }
        await tx.fiscalDocument.update({
          where: { id },
          data: {
            status: FiscalDocumentStatus.QUEUED,
            rejectionReason: null,
            rejectedAt: null,
            rejectionWarnedAt: null,
            parentDocumentId,
            // A refused document made in a contingency is made again as any other: the contingency is over for it
            contingencyId: null,
            ...(sale === null
              ? {}
              : {
                  linesSnapshot: sale.linesSnapshot,
                  currency: sale.currency,
                  totalCents: sale.totalCents,
                  taxCents: sale.taxCents
                }),
            ...(issuer === null
              ? {}
              : {
                  providerId: issuer.providerId,
                  environment: issuer.environment,
                  issuerSnapshot: toJson(this.issuerInput(issuer))
                })
          }
        })
      }
      return { submission: doc.submission, released }
    })
    this.audit.log({
      action: AuditAction.FISCAL_DOCUMENT_RETRIED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.DOCUMENT,
      resourceId: id,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return { id, submission, released }
  }

  // A refused document that may be at the issuer it was made with (an attempt was sent and not answered) while the issuer was changed
  // since (its provider, its environment or its identity): `retry` refuses it, because the same number could end up at two authorities. A
  // person who has checked with the authority of the first issuer (with the accountant) that the document is NOT there says so, with the
  // reason, and the document is made again with the issuer as it is now: a new submission, a new key, a fresh count of attempts. This is
  // the person's decision and not core's (core cannot know what the old authority has), so it is a HIGH-tier action with a reason that is
  // written in the audit trail. Only a document that is in that very situation can be confirmed. The caller enqueues the job.
  async confirmIssuerChange(
    organizationId: string,
    id: string,
    reason: string,
    actor: FiscalActor,
    guard: FiscalReachGuard
  ): Promise<{ id: string; submission: number }> {
    const submission = await this.inTx(organizationId, async tx => {
      await guard()
      const doc = await this.lock(tx, organizationId, id)
      const issuer = await tx.fiscalIssuer.findUnique({ where: { organizationId } })
      // The same test as `retry`: the two routes never disagree about what a moved issuer is
      const moved =
        issuer !== null &&
        (issuer.providerId !== doc.providerId || !sameIssuer(record(doc.issuerSnapshot), issuer))
      // Three different answers: the document is not refused (or never reached the issuer: a retry is what it needs), the issuer did not
      // change, or the issuer it would go to is not one this deployment has (the confirmation would be spent on a document that cannot go)
      if (doc.status !== (FiscalDocumentStatus.REJECTED as string) || doc.attempts === 0) {
        throw this.invalid(doc.status as FiscalDocumentStatus)
      }
      if (issuer === null || !moved) {
        throw new PlatformException(
          ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
          'the issuer of the document is the one it was made with',
          HttpStatusCodes.CONFLICT,
          { reason: FiscalConflictReasons.NO_ISSUER_CHANGE }
        )
      }
      if (this.providers.find(issuer.providerId) === undefined) {
        throw new PlatformException(
          ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
          'the provider of the issuer is not available',
          HttpStatusCodes.CONFLICT
        )
      }
      // A credit note names the sale document that is live now
      let parentDocumentId = doc.parentDocumentId
      if (doc.kind === (FiscalDocumentKind.CREDIT_NOTE as string)) {
        const live = await this.soleLiveSaleOrThrow(tx, organizationId, doc.orderId)
        if (live === null) {
          throw new PlatformException(
            ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
            'the sale document of this credit note was voided and has no replacement yet',
            HttpStatusCodes.CONFLICT,
            { reason: FiscalConflictReasons.ORIGINAL_VOIDED }
          )
        }
        parentDocumentId = live.id
      }
      await tx.fiscalDocument.update({
        where: { id },
        data: {
          status: FiscalDocumentStatus.QUEUED,
          rejectionReason: null,
          rejectedAt: null,
          rejectionWarnedAt: null,
          parentDocumentId,
          contingencyId: null,
          // A new submission for the authority of the new issuer: its own key and a fresh count
          submission: { increment: 1 },
          attempts: 0,
          providerId: issuer.providerId,
          environment: issuer.environment,
          issuerSnapshot: toJson(this.issuerInput(issuer))
        }
      })
      return doc.submission + 1
    })
    this.audit.log({
      action: AuditAction.FISCAL_ISSUER_CHANGE_CONFIRMED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.DOCUMENT,
      resourceId: id,
      // The reason is the person's (it names no receiver: the form asks for what was checked, not for customer data)
      metadata: { reason: plainText(reason).slice(0, FiscalLimits.VOID_REASON_MAX_LENGTH) },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return { id, submission }
  }

  // The invalidation of an accepted document, through the provider (HIGH-tier: the route asks for the confirmation). The provider
  // decides whether the authority accepts it; only then does the document become VOIDED.
  async void(
    organizationId: string,
    id: string,
    reason: string,
    actor: FiscalActor,
    guard: FiscalReachGuard,
    input: FiscalVoidInput = {}
  ): Promise<FiscalDocumentView> {
    // Everything that is read before the authority is asked is ONE short unit; the call to the authority is never inside one
    const { doc, replacement, provider, credentials, stored } = await this.inUnit(
      organizationId,
      async () => {
        await guard()
        const doc = await this.prisma.client.fiscalDocument.findFirst({
          where: { id, organizationId }
        })
        if (doc === null) throw resourceNotFound('fiscal document')
        if (doc.status !== (FiscalDocumentStatus.ACCEPTED as string)) {
          throw this.invalid(doc.status as FiscalDocumentStatus)
        }
        // The document that takes the place of this one, when the person names it: one of the same organization, accepted, and another one
        let replacement: StoredFiscalDocument | undefined
        if (input.replacementDocumentId !== undefined) {
          const other =
            input.replacementDocumentId === id
              ? null
              : await this.prisma.client.fiscalDocument.findFirst({
                  where: {
                    id: input.replacementDocumentId,
                    organizationId,
                    status: FiscalDocumentStatus.ACCEPTED,
                    // A replacement is a document of the same kind (a sale, not a credit note) made with the same provider in the same environment:
                    // never one of another authority or of the test environment
                    kind: doc.kind,
                    providerId: doc.providerId,
                    environment: doc.environment,
                    // The replacement is the one that was made for THIS document: the authority is told its generation code as the
                    // document that takes its place
                    replacesDocumentId: id
                  }
                })
          if (other === null) throw resourceNotFound('replacement fiscal document')
          const stored = this.storedOf(other)
          if (stored === null) {
            throw new PlatformException(
              ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
              'the evidence of the replacement document cannot be read',
              HttpStatusCodes.CONFLICT
            )
          }
          replacement = stored
        }
        // A sale document with a credit note that may be at the authority cannot be voided: the note names it, so the notes go first. That is
        // an accepted one, one being sent, and one that was sent and not answered (back in the queue with an attempt counted: the authority may
        // have it). A note that never left core (waiting, or refused by core or by the authority, which resets its attempts) is refused when
        // it is sent for a voided original and a person retries it once the sale is replaced, so it never makes the sale unvoidable.
        const notes = await this.notesAtAuthority(this.prisma.client, organizationId, id)
        if (notes > 0) {
          throw new PlatformException(
            ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
            'a document with credit notes that are not voided cannot be voided',
            HttpStatusCodes.CONFLICT,
            { reason: FiscalConflictReasons.HAS_CREDIT_NOTES }
          )
        }
        const issuer = await this.prisma.client.fiscalIssuer.findUnique({
          where: { organizationId }
        })
        const provider = this.providers.find(doc.providerId)
        // The invalidation goes to the provider and the environment that accepted the document, with their credentials: an issuer that was
        // changed since cannot invalidate it
        if (
          issuer === null ||
          provider === undefined ||
          issuer.providerId !== doc.providerId ||
          !sameIssuer(record(doc.issuerSnapshot), issuer)
        ) {
          throw new PlatformException(
            ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
            'the provider of this document is not available',
            HttpStatusCodes.CONFLICT
          )
        }
        const credentials =
          issuer.credentialsEncrypted === null
            ? {}
            : this.openCredentials(
                issuer.credentialsEncrypted,
                SealedValueKind.ISSUER_CREDENTIALS,
                {
                  organizationId
                }
              )
        if (credentials === null) {
          throw new PlatformException(
            ErrorCodes.FISCAL_ISSUER_INVALID,
            'the credentials of the issuer cannot be read',
            HttpStatusCodes.CONFLICT
          )
        }
        // The document as it was built is what the invalidation is about: a provider is never asked to invalidate an empty one
        const stored = this.storedOf(doc)
        if (stored === null) {
          throw new PlatformException(
            ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
            'the evidence of the document cannot be read',
            HttpStatusCodes.CONFLICT
          )
        }
        return { doc, replacement, provider, credentials, stored }
      }
    )
    const details: FiscalVoidDetails = {
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.responsible === undefined ? {} : { responsible: input.responsible }),
      ...(input.requester === undefined ? {} : { requester: input.requester }),
      ...(replacement === undefined ? {} : { replacement })
    }
    const contextOf = (attempt: number): ProviderContext => ({
      issuer: this.issuerOfSnapshot(doc.issuerSnapshot),
      credentials,
      // One key per document and reason: a double click, or a request asked again after an answer that was lost, is the same
      // invalidation for the provider; one that was refused and is asked again with another reason is a new one
      idempotencyKey: `${organizationId}:${id}:void:${createHash('sha256')
        .update(
          // The reason, the kind, the people and the replacement: a request corrected in any of them is a new one for the provider
          JSON.stringify([
            reason,
            input.kind ?? null,
            partyKey(input.responsible),
            partyKey(input.requester),
            input.replacementDocumentId ?? null
          ])
        )
        .digest('hex')
        .slice(0, 16)}`,
      attempt
    })
    // The authority may have the document invalidated already (an earlier request whose answer was lost, or a void made elsewhere):
    // asked first, so that a second invalidation is never sent for it. A provider that cannot tell leaves it to the answer of `void`.
    // `recovered`: the authority had it invalidated before this request sent anything (or answered only to the consultation); the audit
    // trail says so, so the act is not read as this person's invalidation alone
    // One invalidation at a time per document (HC-205): the key above carries the reason, so two requests with different reasons would
    // reach the authority at once. The claim is taken under the row lock before the provider is asked; a request with the same key (a double
    // click, an answer that was lost) is the same invalidation and goes on, any other waits for the lease or for the answer of this one.
    const voidKey = contextOf(1).idempotencyKey
    await this.claimVoid(organizationId, id, voidKey, guard)
    let recovered = false
    let outcome: VoidResult | null = null
    outcome = await this.consultedVoid(provider, id, stored, contextOf(1))
    if (outcome !== null) recovered = true
    else {
      outcome = await this.attempt('void', id, () =>
        provider.void(stored, reason, contextOf(1), details)
      )
      // No answer to the invalidation: it may have reached the authority, so it is asked once before the person is told to try again
      if (outcome === null) {
        outcome = await this.consultedVoid(provider, id, stored, contextOf(2))
        recovered = outcome !== null
      }
    }
    if (outcome === null) {
      throw new PlatformException(
        ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
        'the provider did not answer the invalidation',
        HttpStatusCodes.CONFLICT
      )
    }
    if (!outcome.voided) {
      // Only a refusal frees the document at once: with no answer the invalidation may still be at the authority, and the claim is
      // kept until its lease ends
      await this.releaseVoidClaim(
        organizationId,
        id,
        voidKey,
        outcome.byAuthority === true ? new Date() : undefined
      )
      throw new PlatformException(
        ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
        'the provider did not accept the invalidation',
        HttpStatusCodes.CONFLICT,
        { reason: (outcome.reason ?? '').slice(0, FiscalLimits.REASON_MAX_LENGTH) || null }
      )
    }
    await this.inTx(organizationId, async tx => {
      const locked = await this.lock(tx, organizationId, id)
      if (locked.status !== (FiscalDocumentStatus.ACCEPTED as string)) {
        throw this.invalid(locked.status as FiscalDocumentStatus)
      }
      await tx.fiscalDocument.update({
        where: { id },
        data: {
          status: FiscalDocumentStatus.VOIDED,
          voidClaimKey: null,
          voidClaimUntil: null,
          // The window of a refused invalidation ends with the invalidation that was accepted
          voidRejectedAt: null,
          voidRejectionWarnedAt: null,
          voidReason: plainText(reason).slice(0, FiscalLimits.VOID_REASON_MAX_LENGTH),
          voidedBy: actor.userId,
          voidedAt: new Date(),
          // What the authority answered to the invalidation: the evidence of the void, apart from the response to the acceptance (that row
          // cannot change any more)
          voidResponse:
            outcome.response === undefined ? undefined : this.safeResponse(outcome.response)
        }
      })
    })
    this.audit.log({
      action: AuditAction.FISCAL_DOCUMENT_VOIDED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.DOCUMENT,
      resourceId: id,
      metadata: {
        externalNumber: doc.externalNumber,
        recoveredFromAuthority: recovered,
        // What the person declared (the numbers of the identity documents stay out of the trail: they are customer data)
        ...(input.kind === undefined ? {} : { voidKind: input.kind }),
        ...(input.replacementDocumentId === undefined
          ? {}
          : { replacementDocumentId: input.replacementDocumentId }),
        partiesDeclared: input.responsible !== undefined && input.requester !== undefined
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    // The answer to the invalidation is evidence too (the acceptance's was kept when it was accepted, or is made now if it was not). After
    // the audit entry: a slow bucket never delays or loses the trail of a decision that is made
    await this.evidence.keepAll(organizationId, id)
    return this.viewOf(organizationId, id)
  }

  // The sale document of an order that is alive, for what names it (a credit note): `sale` is the one, and `pair` says there are two (a
  // replacement made first stands beside its original, both alive on purpose until the original is invalidated). In that window no document
  // is THE live one: a note made then would name one of two documents, and a note naming the original would stop it from being invalidated.
  // The live document is locked and read again, so a replacement made first at the same time is seen by whichever transaction comes second.
  private async liveSaleOf(
    tx: PrismaTransaction,
    organizationId: string,
    orderId: string
  ): Promise<{ sale: SaleReceiver | null; pair: boolean }> {
    const read = (): Promise<SaleReceiver[]> =>
      tx.fiscalDocument.findMany({
        where: {
          organizationId,
          orderId,
          kind: FiscalDocumentKind.SALE,
          status: { not: FiscalDocumentStatus.VOIDED }
        },
        select: { id: true, ...RECEIVER_AND_MASKS },
        take: 2
      })
    let live = await read()
    if (live.length === 1 && live[0] !== undefined) {
      await tx.$queryRaw`SELECT id FROM fiscal_documents WHERE id = ${live[0].id} AND organization_id = ${organizationId} FOR UPDATE`
      live = await read()
    }
    return { sale: live.length === 1 ? (live[0] ?? null) : null, pair: live.length > 1 }
  }

  // The live sale document, or null when there is none or when two stand (nothing is named then: the note of a return is made later, and
  // the sweep names the ones that wait)
  private async soleLiveSale(
    tx: PrismaTransaction,
    organizationId: string,
    orderId: string
  ): Promise<SaleReceiver | null> {
    return (await this.liveSaleOf(tx, organizationId, orderId)).sale
  }

  // The same, for what a person asks for (a retry, a reissue): two live documents are told as such, the invalidation of the original comes first
  private async soleLiveSaleOrThrow(
    tx: PrismaTransaction,
    organizationId: string,
    orderId: string
  ): Promise<SaleReceiver | null> {
    const { sale, pair } = await this.liveSaleOf(tx, organizationId, orderId)
    if (pair) {
      throw new PlatformException(
        ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
        'the sale has a replacement that was made first: invalidate the original first',
        HttpStatusCodes.CONFLICT,
        { reason: FiscalConflictReasons.REPLACEMENT_PENDING }
      )
    }
    return sale
  }

  // What a replacement made before the invalidation needs (the original is accepted, so it is at the authority): the provider asks for it,
  // the original has no credit note that the authority may have (the notes go first, as for a void), and the issuer is the one the original
  // was made with (the invalidation that follows needs it). Throws the conflict a person can read.
  private async assertReplaceFirst(
    tx: PrismaTransaction,
    organizationId: string,
    old: {
      id: string
      orderId: string
      providerId: string
      issuerSnapshot: unknown
      replacesDocumentId: string | null
    },
    issuer: Parameters<typeof sameIssuer>[1] & { providerId: string }
  ): Promise<void> {
    // A replacement is not replaced first: it is invalidated, or its original is, and the document is replaced after that (the table keeps one
    // live replacement per order, so the answer would be a false 'already replaced')
    if (old.replacesDocumentId !== null) {
      throw new PlatformException(
        ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
        'a replacement is not replaced before it is invalidated',
        HttpStatusCodes.CONFLICT,
        { reason: FiscalConflictReasons.REPLACE_FIRST_UNAVAILABLE }
      )
    }
    const asks = this.providers.find(old.providerId)?.manifest.voidInputs?.kindsWithReplacement
    if (asks === undefined || asks.length === 0 || issuer.providerId !== old.providerId) {
      throw new PlatformException(
        ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
        'the provider does not ask for a replacement before an invalidation',
        HttpStatusCodes.CONFLICT,
        { reason: FiscalConflictReasons.REPLACE_FIRST_UNAVAILABLE }
      )
    }
    // The original is the only live sale document of its order: not a replacement that waits for its own original to be invalidated, and
    // not one that already has its replacement (a third live document is never made)
    const alive = await tx.fiscalDocument.count({
      where: {
        organizationId,
        orderId: old.orderId,
        kind: FiscalDocumentKind.SALE,
        status: { not: FiscalDocumentStatus.VOIDED }
      }
    })
    if (alive !== 1) {
      throw new PlatformException(
        ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
        'the sale already has a replacement that was made first',
        HttpStatusCodes.CONFLICT,
        { reason: FiscalConflictReasons.REPLACEMENT_PENDING }
      )
    }
    // Any credit note that is not voided, waiting or sent: the notes name the original, and none is moved or made while both stand
    const notes = await tx.fiscalDocument.count({
      where: {
        organizationId,
        parentDocumentId: old.id,
        kind: FiscalDocumentKind.CREDIT_NOTE,
        status: { not: FiscalDocumentStatus.VOIDED }
      }
    })
    if (notes > 0) {
      throw new PlatformException(
        ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
        'a document with credit notes that are not voided cannot be replaced first',
        HttpStatusCodes.CONFLICT,
        { reason: FiscalConflictReasons.HAS_CREDIT_NOTES }
      )
    }
    if (!sameIssuer(record(old.issuerSnapshot), issuer)) {
      throw new PlatformException(
        ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
        'the issuer changed since the document was made',
        HttpStatusCodes.CONFLICT
      )
    }
  }

  // The credit notes of a sale document that the authority may have: an accepted one, one being sent, and one that was sent and not
  // answered (back in the queue with an attempt counted). A note that never left core is not one of them.
  private notesAtAuthority(
    db: Pick<PrismaService['client'], 'fiscalDocument'>,
    organizationId: string,
    saleId: string
  ): Promise<number> {
    return db.fiscalDocument.count({
      where: {
        organizationId,
        parentDocumentId: saleId,
        OR: [
          { status: { in: [FiscalDocumentStatus.ACCEPTED, FiscalDocumentStatus.SUBMITTED] } },
          {
            status: { in: [FiscalDocumentStatus.QUEUED, FiscalDocumentStatus.REJECTED] },
            attempts: { gt: 0 }
          },
          // A note kept in a contingency is signed and listed in its event: it names this document and is as good as sent
          { contingencyId: { not: null }, status: FiscalDocumentStatus.QUEUED }
        ]
      }
    })
  }

  // A document as a provider is shown it: what was built, readable; null when the sealed copy cannot be opened
  private storedOf(doc: {
    id: string
    documentType: string
    externalNumber: string | null
    providerData: unknown
    builtPayloadEncrypted: Uint8Array | null
  }): StoredFiscalDocument | null {
    const payload =
      doc.builtPayloadEncrypted === null
        ? null
        : this.openCredentials(doc.builtPayloadEncrypted, SealedValueKind.BUILT_PAYLOAD, {
            documentId: doc.id
          })
    if (payload === null || payload['unreadable'] === true) return null
    return {
      documentType: doc.documentType,
      externalNumber: doc.externalNumber,
      providerData: doc.providerData === null ? null : record(doc.providerData),
      payload
    }
  }

  // A void the authority has made already, as a void result; null when the provider cannot tell, does not have it voided or did not answer
  private async consultedVoid(
    provider: FiscalDocumentProvider,
    documentId: string,
    stored: StoredFiscalDocument,
    ctx: ProviderContext
  ): Promise<VoidResult | null> {
    const consulted = await this.attempt('consult_void', documentId, async () =>
      provider.consultVoid?.(stored, ctx)
    )
    if (consulted?.state !== FiscalVoidConsultState.VOIDED) return null
    return consulted.response === undefined
      ? { voided: true }
      : { voided: true, response: consulted.response }
  }

  // The sale document made again after the one before was voided (the invalidation is the authority's, the new document is a new
  // submission with a new number: a voided document is never edited). It keeps the receiver the voided one had (what a person corrected),
  // takes the sale as the order is now, and names the document it replaces. The credit notes that were voided with it are made again, to
  // name the new document: they wait for it to be accepted. Returns the ids to enqueue, the sale document first.
  async replace(
    organizationId: string,
    id: string,
    actor: FiscalActor,
    guard: FiscalReachGuard
  ): Promise<{ id: string; creditNoteIds: string[] }> {
    // A voided credit note is made again with the same rules, against the sale document that is live now (its sale was not voided)
    const kind = await this.inUnit(organizationId, async () => {
      await guard()
      return this.prisma.client.fiscalDocument.findFirst({
        where: { id, organizationId },
        select: { kind: true }
      })
    })
    if (kind?.kind === (FiscalDocumentKind.CREDIT_NOTE as string)) {
      return this.reissueCreditNote(organizationId, id, actor, guard)
    }
    const made = await this.inTx(organizationId, async tx => {
      await guard()
      const old = await this.lock(tx, organizationId, id)
      // The replacement of a voided document, or (when the provider's authority asks for the replacement before an invalidation) the
      // replacement of an accepted one, made first: the invalidation then names it
      const first = old.status === (FiscalDocumentStatus.ACCEPTED as string)
      if (
        (old.status !== (FiscalDocumentStatus.VOIDED as string) && !first) ||
        old.kind !== (FiscalDocumentKind.SALE as string)
      ) {
        throw this.invalid(old.status as FiscalDocumentStatus)
      }
      const issuer = await tx.fiscalIssuer.findUnique({ where: { organizationId } })
      if (issuer === null || this.providers.find(issuer.providerId) === undefined) {
        throw new PlatformException(
          ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
          'the organization has no issuer set up',
          HttpStatusCodes.CONFLICT
        )
      }
      // A document is replaced once, even when its replacement was voided later (a person replaces the last one then)
      const replacement = await tx.fiscalDocument.findFirst({
        where: { organizationId, replacesDocumentId: old.id },
        select: { id: true }
      })
      if (replacement !== null) {
        throw new PlatformException(
          ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
          'the document was already replaced',
          HttpStatusCodes.CONFLICT,
          { reason: FiscalConflictReasons.ALREADY_REPLACED }
        )
      }
      if (first) await this.assertReplaceFirst(tx, organizationId, old, issuer)
      // One live sale document per order: the index says it too, this gives the answer a person can read. The replacement made first has
      // the original alive beside it on purpose (the index leaves it out, and the one-replacement index keeps it single)
      const live = first
        ? null
        : await tx.fiscalDocument.findFirst({
            where: {
              organizationId,
              orderId: old.orderId,
              kind: FiscalDocumentKind.SALE,
              status: { not: FiscalDocumentStatus.VOIDED }
            },
            select: { id: true }
          })
      if (live !== null) {
        throw new PlatformException(
          ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
          'the sale already has a live document',
          HttpStatusCodes.CONFLICT,
          { reason: FiscalConflictReasons.ALREADY_REPLACED }
        )
      }
      const sale = await this.readSale(tx, organizationId, old.orderId, false)
      if (sale === null) throw resourceNotFound('order')
      if (sale.taxSnapshotMissing) {
        throw new PlatformException(
          ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
          'the order has no tax snapshot: no document can be made of it',
          HttpStatusCodes.CONFLICT,
          { reason: FiscalConflictReasons.TAX_SNAPSHOT_MISSING }
        )
      }
      const sequenceNumber = await this.takeSequence(tx, organizationId)
      const entry = await tx.journalEntry.findFirst({
        where: {
          organizationId,
          idempotencyKey: this.entryKeyOf({
            kind: FiscalDocumentKind.SALE,
            orderId: old.orderId,
            returnId: null
          })
        },
        select: { id: true }
      })
      const created = await tx.fiscalDocument.create({
        data: {
          organizationId,
          storeId: sale.storeId,
          orderId: old.orderId,
          kind: FiscalDocumentKind.SALE,
          replacesDocumentId: old.id,
          journalEntryId: entry?.id ?? null,
          sequenceNumber,
          documentType: FiscalPendingDocumentType,
          status: FiscalDocumentStatus.QUEUED,
          providerId: issuer.providerId,
          environment: issuer.environment,
          issuerSnapshot: toJson(this.issuerInput(issuer)),
          linesSnapshot: sale.linesSnapshot,
          receiverEncrypted: new Uint8Array(old.receiverEncrypted),
          ...copiedMasksOf(old),
          currency: sale.currency,
          totalCents: sale.totalCents,
          taxCents: sale.taxCents
        },
        select: { id: true }
      })
      // The notes that never left core (waiting, or refused) and name the voided document follow the replacement: they are the notes of the
      // same returns, and a person would otherwise retry each one to move it
      const movable = await tx.fiscalDocument.findMany({
        where: {
          organizationId,
          parentDocumentId: old.id,
          kind: FiscalDocumentKind.CREDIT_NOTE,
          status: { in: [FiscalDocumentStatus.QUEUED, FiscalDocumentStatus.REJECTED] },
          attempts: 0,
          // Not one kept in a contingency: its payload names the document it was made for
          contingencyId: null
        },
        select: { id: true, status: true }
      })
      if (movable.length > 0) {
        await tx.fiscalDocument.updateMany({
          where: { id: { in: movable.map(note => note.id) }, organizationId },
          data: { parentDocumentId: created.id }
        })
      }
      // Every return the order has received needs a note against the sale that is live now: the ones that were voided with the old document,
      // and the ones whose return was received while the sale had none (no note could be made then). One that already has a live note is
      // left as it is. An order that came back as a whole with no return row gets its one note.
      const returns = await tx.orderReturn.findMany({
        where: {
          orderId: old.orderId,
          storeId: old.storeId,
          status: { in: [OrderReturnStatus.RECEIVED, OrderReturnStatus.COMPLETED] },
          receivedAt: { not: null }
        },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
        select: { id: true }
      })
      const order = await tx.order.findFirst({
        where: { id: old.orderId },
        select: { status: true }
      })
      // The whole-order note follows the rule of `createCreditNoteForOrder`: only an order with no received return at all (by status, as
      // the books count them)
      const withReturns = await tx.orderReturn.count({
        where: {
          orderId: old.orderId,
          storeId: old.storeId,
          status: { in: [OrderReturnStatus.RECEIVED, OrderReturnStatus.COMPLETED] }
        }
      })
      const targets: (string | null)[] = returns.map(row => row.id)
      if (withReturns === 0 && order?.status === (OrderStatus.RETURNED as string)) {
        targets.push(null)
      }
      // The notes to send once the replacement is accepted: the ones moved that were waiting (their job may be spent) and the new ones
      const creditNoteIds: string[] = movable
        .filter(note => note.status === (FiscalDocumentStatus.QUEUED as string))
        .map(note => note.id)
      // Made first, the replacement makes no note: the original stands beside it with none, and the notes of the returns wait until the
      // original is voided (the sweep names them)
      for (const returnId of first ? [] : targets) {
        const again = await this.makeCreditNote(tx, organizationId, old.orderId, returnId, {
          id: created.id
        })
        if (again !== null) creditNoteIds.push(again)
      }
      return { id: created.id, creditNoteIds, moved: movable.length }
    })
      // Two requests that race for the same replacement (or a return event that makes its note at the same time) meet a unique index:
      // the loser is told the document was already replaced, never a fault
      .catch((error: unknown) => {
        if (!isUniqueViolation(error)) throw error
        this.logger.warn({ documentId: id }, 'a replacement met a unique rule of the table')
        throw new PlatformException(
          ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
          'the document was already replaced',
          HttpStatusCodes.CONFLICT,
          { reason: FiscalConflictReasons.ALREADY_REPLACED }
        )
      })
    this.audit.log({
      action: AuditAction.FISCAL_DOCUMENT_REPLACED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.DOCUMENT,
      resourceId: made.id,
      // The notes made again and the notes that now name the replacement: the chain of documents can be read from the audit
      metadata: { replaces: id, creditNotes: made.creditNoteIds.length, movedNotes: made.moved },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return { id: made.id, creditNoteIds: made.creditNoteIds }
  }

  // A credit note that was voided, made again for the same return (or the same order that came back as a whole) against the sale document
  // that is live now: a new document with a new number, queued by the caller; the voided one is never edited. Before this, a note voided
  // while its sale stood had no way back (only `replace` of the sale made the notes again). The note is refused while its return has a
  // live note, while the sale document was voided (replace the sale first) and when the units of the return do not fit the sale.
  private async reissueCreditNote(
    organizationId: string,
    id: string,
    actor: FiscalActor,
    guard: FiscalReachGuard
  ): Promise<{ id: string; creditNoteIds: string[] }> {
    const made = await this.inTx(organizationId, async tx => {
      await guard()
      const old = await this.lock(tx, organizationId, id)
      if (
        old.kind !== (FiscalDocumentKind.CREDIT_NOTE as string) ||
        old.status !== (FiscalDocumentStatus.VOIDED as string)
      ) {
        throw new PlatformException(
          ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
          'only a voided credit note is made again',
          HttpStatusCodes.CONFLICT,
          { reason: FiscalConflictReasons.NOTE_NOT_VOIDED }
        )
      }
      const live = await this.soleLiveSaleOrThrow(tx, organizationId, old.orderId)
      if (live === null) {
        throw new PlatformException(
          ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
          'the sale document of this credit note was voided and has no replacement yet',
          HttpStatusCodes.CONFLICT,
          { reason: FiscalConflictReasons.ORIGINAL_VOIDED }
        )
      }
      const liveNote = await tx.fiscalDocument.findFirst({
        where: {
          organizationId,
          kind: FiscalDocumentKind.CREDIT_NOTE,
          status: { not: FiscalDocumentStatus.VOIDED },
          ...(old.returnId === null
            ? { orderId: old.orderId, returnId: null }
            : { returnId: old.returnId })
        },
        select: { id: true }
      })
      if (liveNote !== null) {
        throw new PlatformException(
          ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
          'the return already has a live credit note',
          HttpStatusCodes.CONFLICT,
          { reason: FiscalConflictReasons.NOTE_ALREADY_REPLACED }
        )
      }
      const issuer = await tx.fiscalIssuer.findUnique({ where: { organizationId } })
      if (issuer === null || this.providers.find(issuer.providerId) === undefined) {
        throw new PlatformException(
          ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
          'the organization has no issuer set up',
          HttpStatusCodes.CONFLICT
        )
      }
      const created = await this.makeCreditNote(tx, organizationId, old.orderId, old.returnId, {
        id: live.id
      })
      // Nothing made, or made REJECTED for units that do not fit the sale (that row is rolled back with the error: a person sees why)
      if (created === null) {
        // A request that made the live note between the check and the call is the other answer
        const raced = await tx.fiscalDocument.findFirst({
          where: {
            organizationId,
            kind: FiscalDocumentKind.CREDIT_NOTE,
            status: { not: FiscalDocumentStatus.VOIDED },
            ...(old.returnId === null
              ? { orderId: old.orderId, returnId: null }
              : { returnId: old.returnId })
          },
          select: { id: true }
        })
        if (raced !== null) {
          throw new PlatformException(
            ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
            'the return already has a live credit note',
            HttpStatusCodes.CONFLICT,
            { reason: FiscalConflictReasons.NOTE_ALREADY_REPLACED }
          )
        }
        throw new PlatformException(
          ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
          'the units of this return do not fit its sale',
          HttpStatusCodes.CONFLICT,
          { reason: FiscalConflictReasons.RETURN_INCONSISTENT }
        )
      }
      return created
    })
      // Two requests for the same note meet a unique index: the loser is told the note exists, never a fault
      .catch((error: unknown) => {
        if (!isUniqueViolation(error)) throw error
        throw new PlatformException(
          ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
          'the return already has a live credit note',
          HttpStatusCodes.CONFLICT,
          { reason: FiscalConflictReasons.NOTE_ALREADY_REPLACED }
        )
      })
    this.audit.log({
      action: AuditAction.FISCAL_DOCUMENT_REPLACED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.DOCUMENT,
      resourceId: made,
      metadata: { replaces: id, creditNotes: 0, movedNotes: 0 },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return { id: made, creditNoteIds: [] }
  }

  // ---------------------------------------------------------------- helpers

  // Takes the claim of the invalidation of a document, under its row lock (see `void`). Refused when the document is no longer accepted,
  // when it has credit notes that are not voided (read again under the lock: one may have been made since), or when ANY request holds a
  // live claim, this one's key included: a double click is the same invalidation, and the first request is already asking the provider.
  // The lease is read and written with the clock of the database, one for every instance.
  private async claimVoid(
    organizationId: string,
    id: string,
    key: string,
    guard: FiscalReachGuard
  ): Promise<void> {
    await this.inTx(organizationId, async tx => {
      // The reach is checked again in the unit that takes the claim, beside the write
      await guard()
      const locked = await this.lock(tx, organizationId, id)
      if (locked.status !== (FiscalDocumentStatus.ACCEPTED as string)) {
        throw this.invalid(locked.status as FiscalDocumentStatus)
      }
      if ((await this.notesAtAuthority(tx, organizationId, id)) > 0) {
        throw new PlatformException(
          ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
          'a document with credit notes that are not voided cannot be voided',
          HttpStatusCodes.CONFLICT,
          { reason: FiscalConflictReasons.HAS_CREDIT_NOTES }
        )
      }
      const held = await tx.$queryRaw<{ held: boolean }[]>`
        SELECT (void_claim_until IS NOT NULL AND void_claim_until > now()) AS held
        FROM fiscal_documents WHERE id = ${id} AND organization_id = ${organizationId}`
      if (held[0]?.held === true) {
        throw new PlatformException(
          ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
          'another invalidation of this document is in progress',
          HttpStatusCodes.CONFLICT,
          { reason: FiscalConflictReasons.VOID_IN_PROGRESS }
        )
      }
      const leaseSeconds = FiscalLimits.VOID_CLAIM_LEASE_MS / 1000
      await tx.$executeRaw`
        UPDATE fiscal_documents
        SET void_claim_key = ${key}, void_claim_until = now() + make_interval(secs => ${leaseSeconds})
        WHERE id = ${id} AND organization_id = ${organizationId}`
    })
  }

  // Frees the claim of this request, only if it is still the one that holds it. `refusedAt`: the moment the AUTHORITY refused the invalidation,
  // which starts the 24 hours to correct and send it again (D14b), once for each refusal (the warning is cleared with it).
  private async releaseVoidClaim(
    organizationId: string,
    id: string,
    key: string,
    refusedAt?: Date
  ): Promise<void> {
    try {
      await this.inUnit(organizationId, () =>
        this.prisma.client.fiscalDocument.updateMany({
          where: {
            id,
            organizationId,
            status: FiscalDocumentStatus.ACCEPTED,
            voidClaimKey: key
          },
          data: {
            voidClaimKey: null,
            voidClaimUntil: null,
            ...(refusedAt === undefined
              ? {}
              : { voidRejectedAt: refusedAt, voidRejectionWarnedAt: null })
          }
        })
      )
    } catch (error) {
      // A refusal whose moment was not kept leaves no 24-hour window and no warning: that is a deadline lost, not only a claim left to expire
      const fields = { documentId: id, err: errorName(error) }
      if (refusedAt === undefined) {
        this.logger.warn(fields, 'the claim of an invalidation was not released')
      } else {
        this.logger.error(
          fields,
          'the refusal of an invalidation was not kept: its 24-hour window has no start'
        )
      }
    }
  }

  private async lock(tx: PrismaTransaction, organizationId: string, id: string) {
    await tx.$queryRaw`SELECT id FROM fiscal_documents WHERE id = ${id} AND organization_id = ${organizationId} FOR UPDATE`
    const doc = await tx.fiscalDocument.findFirst({ where: { id, organizationId } })
    if (doc === null) throw resourceNotFound('fiscal document')
    return doc
  }

  private immutable(status: FiscalDocumentStatus): PlatformException {
    return new PlatformException(
      isImmutable(status)
        ? ErrorCodes.FISCAL_DOCUMENT_IMMUTABLE
        : ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
      'the document cannot change in that state',
      HttpStatusCodes.CONFLICT
    )
  }

  private invalid(status: FiscalDocumentStatus): PlatformException {
    return new PlatformException(
      isImmutable(status) && status === FiscalDocumentStatus.VOIDED
        ? ErrorCodes.FISCAL_DOCUMENT_IMMUTABLE
        : ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
      'the document cannot move from that state',
      HttpStatusCodes.CONFLICT,
      { allowed: canTransition(status, FiscalDocumentStatus.QUEUED) }
    )
  }

  // A row whose receiver cannot be opened reads as an empty receiver: one bad row never breaks the list, and the document that holds
  // it is refused for its missing data until a person writes the receiver again
  private openReceiver(sealed: Uint8Array, documentId: string, quiet = false): FiscalReceiver {
    return this.tryOpenReceiver(sealed, documentId, quiet) ?? receiverOf({})
  }

  // The receiver, or null when it cannot be opened (a rotated key, a damaged row)
  private tryOpenReceiver(
    sealed: Uint8Array,
    documentId: string,
    quiet = false
  ): FiscalReceiver | null {
    try {
      return receiverOf(
        openSealed(
          this.cipher,
          this.logger,
          sealed,
          SealedValueKind.RECEIVER,
          { documentId },
          quiet
        )
      )
    } catch {
      return null
    }
  }

  private openCredentials(
    sealed: Uint8Array,
    what: SealedValueKind,
    ref: SealedRef
  ): Record<string, unknown> | null {
    try {
      return openSealed(this.cipher, this.logger, sealed, what, ref)
    } catch {
      return null
    }
  }

  // The issuer as the document kept it when it was made
  private issuerOfSnapshot(snapshot: unknown): FiscalIssuerInput {
    const kept = record(snapshot)
    const optional = (key: string): string | null => {
      const value = kept[key]
      return typeof value === 'string' ? value : null
    }
    const text = (key: string): string => optional(key) ?? ''
    return this.issuerInput({
      legalName: text('legalName'),
      taxId: text('taxId'),
      registrationId: optional('registrationId'),
      address: kept['address'],
      activityCode: optional('activityCode'),
      establishmentCode: optional('establishmentCode'),
      // Absent from a snapshot made before they were kept: the same as empty (see `sameIssuer`)
      establishmentType: optional('establishmentType'),
      pointOfSaleCode: optional('pointOfSaleCode'),
      phone: optional('phone'),
      email: optional('email'),
      environment: text('environment')
    })
  }

  private issuerInput(row: IssuerRow): FiscalIssuerInput {
    return {
      legalName: row.legalName,
      taxId: row.taxId,
      registrationId: row.registrationId,
      address: record(row.address),
      activityCode: row.activityCode,
      establishmentCode: row.establishmentCode,
      establishmentType: row.establishmentType,
      pointOfSaleCode: row.pointOfSaleCode,
      phone: row.phone,
      email: row.email,
      environment: row.environment as FiscalEnvironment
    }
  }

  // The sale document a credit note cancels (part of), in the words the provider gave it when it accepted it
  private creditedOf(original: {
    externalNumber: string
    issuedAt: Date
    documentType: string
    providerData: unknown
  }): FiscalCreditedDocument {
    return {
      documentType: original.documentType,
      externalNumber: original.externalNumber,
      issuedAt: original.issuedAt.toISOString(),
      providerData: original.providerData === null ? null : record(original.providerData)
    }
  }

  private view(row: {
    id: string
    storeId: string
    orderId: string
    kind: string
    returnId: string | null
    parentDocumentId: string | null
    replacesDocumentId: string | null
    journalEntryId: string | null
    sequenceNumber: number
    documentType: string
    status: string
    providerId: string
    environment: string
    externalNumber: string | null
    currency: string
    totalCents: number
    taxCents: number
    rejectionReason: string | null
    rejectedAt: Date | null
    voidRejectedAt: Date | null
    attempts: number
    contingencyId: string | null
    voidReason: string | null
    voidedAt: Date | null
    issuedAt: Date | null
    createdAt: Date
    receiverEncrypted: Uint8Array
    receiverNameMasked: string | null
    receiverTaxIdMasked: string | null
    receiverMaskedAt: Date | null
    replacedBy: { id: string }[]
  }): FiscalDocumentView {
    // A row with its masks calculated opens no sealed value (a page of documents opens none); a row without them is opened as before
    const receiverView =
      row.receiverMaskedAt === null
        ? maskedReceiverView(this.openReceiver(row.receiverEncrypted, row.id, true))
        : {
            name: row.receiverNameMasked,
            taxIdMasked: row.receiverTaxIdMasked,
            complete: row.receiverNameMasked !== null
          }
    const kind = row.kind as FiscalDocumentKind
    const status = row.status as FiscalDocumentStatus
    const replacedByDocumentId = row.replacedBy[0]?.id ?? null
    return {
      id: row.id,
      storeId: row.storeId,
      orderId: row.orderId,
      kind,
      returnId: row.returnId,
      parentDocumentId: row.parentDocumentId,
      replacesDocumentId: row.replacesDocumentId,
      replacedByDocumentId,
      journalEntryId: row.journalEntryId,
      sequenceNumber: row.sequenceNumber,
      documentType: row.documentType,
      status,
      providerId: row.providerId,
      environment: row.environment as FiscalEnvironment,
      externalNumber: row.externalNumber,
      currency: row.currency,
      totalCents: row.totalCents,
      taxCents: row.taxCents,
      rejectionReason: row.rejectionReason,
      rejectionDeadline: this.deadlineView(status, row.rejectedAt),
      voidRejectionDeadline: this.voidDeadlineView(status, row.voidRejectedAt),
      attempts: row.attempts,
      stuck: isStuck(status, row.attempts, row.contingencyId !== null),
      allowedActions: allowedActionsOf({
        kind,
        status,
        attempts: row.attempts,
        rejectionReason: row.rejectionReason,
        replacedByDocumentId
      }),
      voidReason: row.voidReason,
      voidedAt: row.voidedAt?.toISOString() ?? null,
      issuedAt: row.issuedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      receiver: receiverView
    }
  }
}

export type { FiscalDocumentProvider }
