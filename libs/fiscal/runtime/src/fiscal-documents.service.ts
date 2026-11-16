import { createHash } from 'node:crypto'

import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher } from '@platform/core/crypto'
import { isUniqueViolation, PrismaService, type PrismaTransaction } from '@platform/core/database'
import {
  FinancePostingKey,
  FiscalConflictReasons,
  FiscalConsultState,
  FiscalDocumentKind,
  FiscalDocumentStatus,
  type FiscalEnvironment,
  FiscalPendingDocumentType,
  FiscalIssueOn,
  FiscalLimits,
  FiscalRejectionReasons,
  FiscalResourceTypes,
  FiscalSubmitOutcome,
  FiscalVoidConsultState,
  hasReceivedUnits,
  OrderReturnStatus,
  OrderStatus
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
  StoredFiscalDocument,
  VoidResult
} from '@platform/fiscal/sdk'

import { FiscalEvidenceService } from './fiscal-evidence.service'
import type { FiscalActor } from './fiscal-issuer.service'
import { FiscalProviderRegistry } from './fiscal-provider.registry'
import {
  canTransition,
  creditNoteSaleOf,
  documentDetailOf,
  documentLines,
  type FiscalDocumentDetail,
  isImmutable,
  maskTaxId,
  originalStateOf,
  receiverEditable,
  receiverOf,
  receiverRecord,
  receiverWithFiscalData,
  retryable,
  saleAddsUp,
  shippingTaxFits,
  saleOf,
  sameIssuer
} from './fiscal-rules'
import { cappedResponse, type Json, plainText, record, toJson } from './json'
import { withTimeout } from './with-timeout'

// The fields of an issuer that a provider is told about (the row of the issuer and the snapshot a document keeps of it)
interface IssuerRow {
  legalName: string
  taxId: string
  registrationId: string | null
  address: unknown
  activityCode: string | null
  establishmentCode: string | null
  environment: string
}

// The attempt did not run because another one holds the document or its sale document is not accepted yet: a claim that is alive may still
// decide the document, so the exhaustion of this job is not the exhaustion of the document
export class FiscalDocumentBusyError extends Error {}

// An acceptance has a number: what a provider returns is not trusted to
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
  attempts: number
  voidReason: string | null
  voidedAt: string | null
  issuedAt: string | null
  createdAt: string
  // Customer data, minimized: the name and the tax id masked. The full data is read only by the provider, at issue time.
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
  attempts: true,
  voidReason: true,
  voidedAt: true,
  issuedAt: true,
  createdAt: true,
  receiverEncrypted: true
} as const

// The lifecycle of the fiscal document of a sale (TDD_18 §8.3). Core owns it and the link to the ledger; the provider owns what is
// legal. The sale amounts are the order's own (the tax snapshot of Step 4B.3b), copied into the document once and never recomputed.
@Injectable()
export class FiscalDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly cipher: CredentialCipher,
    private readonly providers: FiscalProviderRegistry,
    private readonly evidence: FiscalEvidenceService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FiscalDocumentsService.name)
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
    }
  ): Promise<FiscalDocumentPage> {
    const rows = await this.prisma.client.fiscalDocument.findMany({
      where: {
        organizationId,
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
    return {
      data: page.map(row => this.view(row)),
      nextCursor: hasMore && last !== undefined ? String(last.sequenceNumber) : null,
      hasMore
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
    return this.prisma.transaction(async tx => {
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
            taxCents: true
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
    const receiver = receiverWithFiscalData(
      contact,
      // A customer that was erased or merged into another has no fiscal data to copy: it must not come back in a new document
      !withFiscalData || order.customer.erasedAt !== null || order.customer.mergedIntoId !== null
        ? null
        : await this.customerFiscalReceiver(tx, order.storeId, order.customerId)
    )
    return {
      storeId: order.storeId,
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
        orderNumber: order.orderNumber
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
      return receiverOf(this.cipher.open(row.dataEncrypted))
    } catch (error) {
      // The name of the error only, so a key that no longer opens rows shows in the logs
      this.logger.error({ err: errorName(error) }, 'the fiscal data of a customer cannot be opened')
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
      this.prisma.transaction(async tx => {
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
    return this.prisma.transaction(async tx => {
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
      return await make()
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
        ? await tx.fiscalDocument.findFirst({
            where: {
              organizationId,
              orderId,
              kind: FiscalDocumentKind.SALE,
              status: { not: FiscalDocumentStatus.VOIDED }
            },
            select: { id: true, receiverEncrypted: true }
          })
        : await tx.fiscalDocument.findFirst({
            where: { id: parentOverride.id, organizationId },
            select: { id: true, receiverEncrypted: true }
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
        items: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            productName: true,
            variantName: true,
            quantity: true,
            unitPriceCents: true,
            taxRateBps: true,
            taxCents: true
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
          taxCents: item.taxCents
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
        orderNumber: order.orderNumber
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
      await this.reject(doc.id, organizationId, FiscalRejectionReasons.ORIGINAL_VOIDED, {
        beforeSending: true
      })
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
        issuer === null || provider === undefined
          ? FiscalRejectionReasons.PROVIDER_UNAVAILABLE
          : FiscalRejectionReasons.ISSUER_CHANGED,
        { beforeSending: true }
      )
      return
    }
    const credentials =
      issuer.credentialsEncrypted === null ? {} : this.openCredentials(issuer.credentialsEncrypted)
    if (credentials === null) {
      await this.reject(doc.id, organizationId, FiscalRejectionReasons.CREDENTIALS_UNREADABLE, {
        beforeSending: true
      })
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
    const receiver = this.openReceiver(doc.receiverEncrypted)
    const parts = record(doc.linesSnapshot)
    const sale = saleOf(doc, parts)
    // The provider never sees a sale whose parts do not add up to what the order took
    // The bound of the tax of the shipping is asked only of a sale that was never sent: one that may already be at the authority is consulted
    // below and is not refused here for a rule it was not built under
    if (!saleAddsUp(sale) || (original === null && doc.attempts === 0 && !shippingTaxFits(sale))) {
      await this.reject(doc.id, organizationId, FiscalRejectionReasons.SALE_INCONSISTENT, {
        beforeSending: true
      })
      return
    }
    // A credit note with nothing in it is a return that did not fit its sale (made so on purpose, to be seen): it is never sent
    if (original !== null && sale.lines.length === 0) {
      await this.reject(doc.id, organizationId, FiscalRejectionReasons.RETURN_INCONSISTENT, {
        beforeSending: true
      })
      return
    }
    const built = await this.attempt('build', doc.id, () =>
      provider.build({
        kind: doc.kind as FiscalDocumentKind,
        credited: original === null ? null : this.creditedOf(original),
        sequenceNumber: doc.sequenceNumber,
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
        taxCents: sale.taxCents
      })
    )
    if (built === null) {
      await this.reject(doc.id, organizationId, FiscalRejectionReasons.BUILD_FAILED, {
        beforeSending: true
      })
      return
    }
    if (built.missingReceiverFields.length > 0) {
      await this.reject(doc.id, organizationId, FiscalRejectionReasons.RECEIVER_INCOMPLETE, {
        built,
        beforeSending: true
      })
      return
    }
    // An earlier attempt of this submission may have reached the authority before it was cut short: ask before sending a second document.
    // A consultation that gets no answer is not "never received": the document goes back to the queue and the consultation is asked again.
    if (doc.attempts > 0) {
      const consulted = await this.attempt('consult', doc.id, () =>
        provider.consult(built, context)
      )
      if (consulted === null) {
        return this.requeueAndFail(
          organizationId,
          doc.id,
          'the fiscal provider did not answer the consultation'
        )
      }
      if (consulted?.state === FiscalConsultState.ACCEPTED) {
        if (!hasNumber(consulted.externalNumber)) {
          await this.reject(doc.id, organizationId, FiscalRejectionReasons.PROVIDER_ANSWER_INVALID)
          return
        }
        await this.accept(doc.id, organizationId, built, consulted)
        return
      }
      if (consulted?.state === FiscalConsultState.REJECTED) {
        await this.reject(doc.id, organizationId, consulted.reason, {
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
        await this.reject(doc.id, organizationId, FiscalRejectionReasons.PROVIDER_ANSWER_INVALID)
        return
      }
      await this.accept(doc.id, organizationId, built, result)
      return
    }
    if (result.outcome === FiscalSubmitOutcome.REJECTED) {
      await this.reject(
        doc.id,
        organizationId,
        typeof result.reason === 'string' ? result.reason : '',
        { built, response: result.response, byAuthority: true }
      )
      return
    }
    // The authority did not answer: back to the queue, and the job fails so that the backoff of the queue spaces the next attempt
    await this.requeueAndFail(organizationId, doc.id, 'the fiscal provider did not answer')
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
    await this.prisma.transaction(async tx => {
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
    message: string
  ): Promise<never> {
    await this.prisma.client.fiscalDocument.updateMany({
      where: { id: documentId, organizationId, status: FiscalDocumentStatus.SUBMITTED },
      data: { status: FiscalDocumentStatus.QUEUED }
    })
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
      this.logger.warn(
        { documentId, operation, err: errorName(error) },
        'a fiscal provider call failed'
      )
      return null
    }
  }

  // QUEUED -> SUBMITTED under a row lock, counting the attempt. Anything else is not this job's: a duplicate job finds the document
  // already moved and does nothing. A document that is SUBMITTED was claimed by an attempt that is alive (it claimed less than the lease
  // ago: this one waits) or dead (its worker died after the claim: this one takes it over).
  private async claim(organizationId: string, documentId: string) {
    return this.prisma.transaction(async tx => {
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
      const issuer = await tx.fiscalIssuer.findUnique({ where: { organizationId } })
      const provider = this.providers.find(doc.providerId)
      // A credit note goes only after the sale document it cancels was accepted. While that one is on its way the note waits (its job fails
      // and the queue asks again), and when it was voided the note is refused for a person to retry once the sale is replaced.
      let original:
        | { externalNumber: string; issuedAt: Date; documentType: string; providerData: unknown }
        | null
        | 'voided' = null
      let receiverEncrypted: Uint8Array<ArrayBuffer> | undefined
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
        }
      }
      const updated = await tx.fiscalDocument.update({
        where: { id: doc.id },
        data: {
          status: FiscalDocumentStatus.SUBMITTED,
          attempts: { increment: 1 },
          ...(receiverEncrypted === undefined ? {} : { receiverEncrypted })
        }
      })
      return { doc: { ...updated, attempts: doc.attempts }, issuer, provider, original }
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
    const accepted = await this.prisma.transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM fiscal_documents WHERE id = ${documentId} AND organization_id = ${organizationId} FOR UPDATE`
      const doc = await tx.fiscalDocument.findFirstOrThrow({
        where: { id: documentId, organizationId },
        select: { orderId: true, kind: true, returnId: true, status: true, createdAt: true }
      })
      // Another attempt decided first (this one was taken over): what is decided is not decided twice
      if (doc.status !== (FiscalDocumentStatus.SUBMITTED as string)) {
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
          documentType: built.documentType,
          externalNumber: plainText(result.externalNumber),
          providerData,
          builtPayloadEncrypted: sealedPayload,
          response,
          rejectionReason: null,
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
    await this.prisma.transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM fiscal_documents WHERE id = ${documentId} AND organization_id = ${organizationId} FOR UPDATE`
      const doc = await tx.fiscalDocument.findFirstOrThrow({
        where: { id: documentId, organizationId }
      })
      // Another attempt decided first (this one was taken over): what is decided is not decided twice
      if (doc.status !== (FiscalDocumentStatus.SUBMITTED as string)) {
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
          rejectionReason: kept,
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
        | 'economicActivity',
        string | null
      >
    > & {
      address?: Record<string, string> | null
    },
    actor: FiscalActor
  ): Promise<FiscalDocumentView> {
    await this.prisma.transaction(async tx => {
      const doc = await this.lock(tx, organizationId, id)
      if (!receiverEditable(doc.status as FiscalDocumentStatus, doc.attempts)) {
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
      const current = this.openReceiver(doc.receiverEncrypted)
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
            : (current.economicActivity ?? null)
      }
      await tx.fiscalDocument.update({
        where: { id },
        data: { receiverEncrypted: new Uint8Array(this.cipher.seal(receiverRecord(next))) }
      })
    })
    this.audit.log({
      action: AuditAction.FISCAL_DOCUMENT_RECEIVER_CHANGED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.DOCUMENT,
      resourceId: id,
      metadata: { fields: Object.keys(patch) },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.get(organizationId, id)
  }

  // A refused (or stuck) document goes back to the queue; the caller enqueues the job. Returns the id.
  async retry(
    organizationId: string,
    id: string,
    actor: FiscalActor
  ): Promise<{ id: string; submission: number }> {
    const submission = await this.prisma.transaction(async tx => {
      const doc = await this.lock(tx, organizationId, id)
      const status = doc.status as FiscalDocumentStatus
      if (!retryable(status)) throw this.invalid(status)
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
          const live = await tx.fiscalDocument.findFirst({
            where: {
              organizationId,
              orderId: doc.orderId,
              kind: FiscalDocumentKind.SALE,
              status: { not: FiscalDocumentStatus.VOIDED }
            },
            select: { id: true }
          })
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
            parentDocumentId,
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
      return doc.submission
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
    return { id, submission }
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
    actor: FiscalActor
  ): Promise<{ id: string; submission: number }> {
    const submission = await this.prisma.transaction(async tx => {
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
        const live = await tx.fiscalDocument.findFirst({
          where: {
            organizationId,
            orderId: doc.orderId,
            kind: FiscalDocumentKind.SALE,
            status: { not: FiscalDocumentStatus.VOIDED }
          },
          select: { id: true }
        })
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
          parentDocumentId,
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
    actor: FiscalActor
  ): Promise<FiscalDocumentView> {
    const doc = await this.prisma.client.fiscalDocument.findFirst({ where: { id, organizationId } })
    if (doc === null) throw resourceNotFound('fiscal document')
    if (doc.status !== (FiscalDocumentStatus.ACCEPTED as string)) {
      throw this.invalid(doc.status as FiscalDocumentStatus)
    }
    // A sale document with a credit note that may be at the authority cannot be voided: the note names it, so the notes go first. That is
    // an accepted one, one being sent, and one that was sent and not answered (back in the queue with an attempt counted: the authority may
    // have it). A note that never left core (waiting, or refused by core or by the authority, which resets its attempts) is refused when
    // it is sent for a voided original and a person retries it once the sale is replaced, so it never makes the sale unvoidable.
    const notes = await this.prisma.client.fiscalDocument.count({
      where: {
        organizationId,
        parentDocumentId: id,
        OR: [
          { status: { in: [FiscalDocumentStatus.ACCEPTED, FiscalDocumentStatus.SUBMITTED] } },
          {
            status: { in: [FiscalDocumentStatus.QUEUED, FiscalDocumentStatus.REJECTED] },
            attempts: { gt: 0 }
          }
        ]
      }
    })
    if (notes > 0) {
      throw new PlatformException(
        ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
        'a document with credit notes that are not voided cannot be voided',
        HttpStatusCodes.CONFLICT,
        { reason: FiscalConflictReasons.HAS_CREDIT_NOTES }
      )
    }
    const issuer = await this.prisma.client.fiscalIssuer.findUnique({ where: { organizationId } })
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
      issuer.credentialsEncrypted === null ? {} : this.openCredentials(issuer.credentialsEncrypted)
    if (credentials === null) {
      throw new PlatformException(
        ErrorCodes.FISCAL_ISSUER_INVALID,
        'the credentials of the issuer cannot be read',
        HttpStatusCodes.CONFLICT
      )
    }
    // The document as it was built is what the invalidation is about: a provider is never asked to invalidate an empty one
    const payload =
      doc.builtPayloadEncrypted === null ? null : this.openCredentials(doc.builtPayloadEncrypted)
    if (payload === null || payload['unreadable'] === true) {
      throw new PlatformException(
        ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
        'the evidence of the document cannot be read',
        HttpStatusCodes.CONFLICT
      )
    }
    const stored: StoredFiscalDocument = {
      documentType: doc.documentType,
      externalNumber: doc.externalNumber,
      providerData: doc.providerData === null ? null : record(doc.providerData),
      payload
    }
    const contextOf = (attempt: number): ProviderContext => ({
      issuer: this.issuerOfSnapshot(doc.issuerSnapshot),
      credentials,
      // One key per document and reason: a double click, or a request asked again after an answer that was lost, is the same
      // invalidation for the provider; one that was refused and is asked again with another reason is a new one
      idempotencyKey: `${organizationId}:${id}:void:${createHash('sha256').update(reason).digest('hex').slice(0, 16)}`,
      attempt
    })
    // The authority may have the document invalidated already (an earlier request whose answer was lost, or a void made elsewhere):
    // asked first, so that a second invalidation is never sent for it. A provider that cannot tell leaves it to the answer of `void`.
    // `recovered`: the authority had it invalidated before this request sent anything (or answered only to the consultation); the audit
    // trail says so, so the act is not read as this person's invalidation alone
    let recovered = false
    let outcome: VoidResult | null = await this.consultedVoid(provider, id, stored, contextOf(1))
    if (outcome !== null) recovered = true
    else {
      outcome = await this.attempt('void', id, () => provider.void(stored, reason, contextOf(1)))
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
      throw new PlatformException(
        ErrorCodes.FISCAL_DOCUMENT_INVALID_TRANSITION,
        'the provider did not accept the invalidation',
        HttpStatusCodes.CONFLICT,
        { reason: (outcome.reason ?? '').slice(0, FiscalLimits.REASON_MAX_LENGTH) || null }
      )
    }
    await this.prisma.transaction(async tx => {
      const locked = await this.lock(tx, organizationId, id)
      if (locked.status !== (FiscalDocumentStatus.ACCEPTED as string)) {
        throw this.invalid(locked.status as FiscalDocumentStatus)
      }
      await tx.fiscalDocument.update({
        where: { id },
        data: {
          status: FiscalDocumentStatus.VOIDED,
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
      metadata: { externalNumber: doc.externalNumber, recoveredFromAuthority: recovered },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    // The answer to the invalidation is evidence too (the acceptance's was kept when it was accepted, or is made now if it was not). After
    // the audit entry: a slow bucket never delays or loses the trail of a decision that is made
    await this.evidence.keepAll(organizationId, id)
    return this.get(organizationId, id)
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
    actor: FiscalActor
  ): Promise<{ id: string; creditNoteIds: string[] }> {
    // A voided credit note is made again with the same rules, against the sale document that is live now (its sale was not voided)
    const kind = await this.prisma.client.fiscalDocument.findFirst({
      where: { id, organizationId },
      select: { kind: true }
    })
    if (kind?.kind === (FiscalDocumentKind.CREDIT_NOTE as string)) {
      return this.reissueCreditNote(organizationId, id, actor)
    }
    const made = await this.prisma
      .transaction(async tx => {
        const old = await this.lock(tx, organizationId, id)
        if (
          old.status !== (FiscalDocumentStatus.VOIDED as string) ||
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
        // One live sale document per order: the index says it too, this gives the answer a person can read
        const live = await tx.fiscalDocument.findFirst({
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
        const sale = await this.readSale(tx, organizationId, old.orderId, false)
        if (sale === null) throw resourceNotFound('order')
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
            attempts: 0
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
        for (const returnId of targets) {
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
    actor: FiscalActor
  ): Promise<{ id: string; creditNoteIds: string[] }> {
    const made = await this.prisma
      .transaction(async tx => {
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
        const live = await tx.fiscalDocument.findFirst({
          where: {
            organizationId,
            orderId: old.orderId,
            kind: FiscalDocumentKind.SALE,
            status: { not: FiscalDocumentStatus.VOIDED }
          },
          select: { id: true }
        })
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
  private openReceiver(sealed: Uint8Array): FiscalReceiver {
    try {
      return receiverOf(this.cipher.open(sealed))
    } catch {
      return receiverOf({})
    }
  }

  private openCredentials(sealed: Uint8Array): Record<string, unknown> | null {
    try {
      return this.cipher.open(sealed)
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
    attempts: number
    voidReason: string | null
    voidedAt: Date | null
    issuedAt: Date | null
    createdAt: Date
    receiverEncrypted: Uint8Array
  }): FiscalDocumentView {
    const receiver = this.openReceiver(row.receiverEncrypted)
    return {
      id: row.id,
      storeId: row.storeId,
      orderId: row.orderId,
      kind: row.kind as FiscalDocumentKind,
      returnId: row.returnId,
      parentDocumentId: row.parentDocumentId,
      replacesDocumentId: row.replacesDocumentId,
      journalEntryId: row.journalEntryId,
      sequenceNumber: row.sequenceNumber,
      documentType: row.documentType,
      status: row.status as FiscalDocumentStatus,
      providerId: row.providerId,
      environment: row.environment as FiscalEnvironment,
      externalNumber: row.externalNumber,
      currency: row.currency,
      totalCents: row.totalCents,
      taxCents: row.taxCents,
      rejectionReason: row.rejectionReason,
      attempts: row.attempts,
      voidReason: row.voidReason,
      voidedAt: row.voidedAt?.toISOString() ?? null,
      issuedAt: row.issuedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      receiver: {
        name: receiver.name,
        taxIdMasked: maskTaxId(receiver.taxId),
        complete: receiver.name !== null
      }
    }
  }
}

export type { FiscalDocumentProvider }
