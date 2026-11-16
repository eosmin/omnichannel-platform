import { createHash } from 'node:crypto'

import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService, type PrismaTransaction } from '@platform/core/database'
import {
  FinancePostingKey,
  FiscalConsultState,
  FiscalDocumentStatus,
  type FiscalEnvironment,
  FiscalPendingDocumentType,
  FiscalIssueOn,
  FiscalLimits,
  FiscalRejectionReasons,
  FiscalResourceTypes,
  FiscalSubmitOutcome
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
  FiscalDocumentProvider,
  FiscalIssuerInput,
  FiscalReceiver,
  ProviderContext
} from '@platform/fiscal/sdk'

import type { FiscalActor } from './fiscal-issuer.service'
import { FiscalProviderRegistry } from './fiscal-provider.registry'
import {
  canTransition,
  documentLines,
  isImmutable,
  maskTaxId,
  receiverEditable,
  receiverOf,
  receiverRecord,
  retryable,
  saleAddsUp,
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

export interface FiscalDocumentView {
  id: string
  storeId: string
  orderId: string
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

export interface FiscalDocumentPage {
  data: FiscalDocumentView[]
  nextCursor: string | null
  hasMore: boolean
}

const SELECT = {
  id: true,
  storeId: true,
  orderId: true,
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
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FiscalDocumentsService.name)
  }

  // ---------------------------------------------------------------- reads

  async list(
    organizationId: string,
    query: { status?: FiscalDocumentStatus; orderId?: string; cursor?: string; limit: number }
  ): Promise<FiscalDocumentPage> {
    const rows = await this.prisma.client.fiscalDocument.findMany({
      where: {
        organizationId,
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
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
      const existing = await tx.fiscalDocument.findUnique({
        where: { organizationId_orderId: { organizationId, orderId } },
        select: { id: true }
      })
      if (existing !== null) return null
      const sale = await this.readSale(tx, organizationId, orderId)
      if (sale === null) return null
      // The correlative: an atomic increment, so two documents never share a number
      const taken = await tx.fiscalIssuer.update({
        where: { organizationId },
        data: { nextSequence: { increment: 1 } },
        select: { nextSequence: true }
      })
      const sequenceNumber = taken.nextSequence - 1
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
  private async readSale(tx: PrismaTransaction, organizationId: string, orderId: string) {
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
        customer: { select: { name: true, email: true, phone: true } },
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
    const receiver: FiscalReceiver = {
      name: order.customer.name,
      taxId: null,
      registrationId: null,
      address: Object.keys(address).length > 0 ? address : null,
      email: order.customer.email,
      phone: order.customer.phone
    }
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

  // ---------------------------------------------------------------- the worker submits it

  // One attempt, run by the worker. Returns normally when the document reached a state a person or the authority decided (accepted,
  // rejected) and throws when the provider could not answer, so the queue tries again with its backoff. Safe to repeat: a document that
  // is not waiting (or whose previous attempt was cut short) is consulted before anything is sent again.
  async submit(organizationId: string, documentId: string): Promise<void> {
    const claimed = await this.claim(organizationId, documentId)
    if (claimed === null) return
    if (claimed === 'busy') {
      // Another attempt claimed it a moment ago: this job fails so that the backoff of the queue asks again after the lease
      throw new Error('the fiscal document is being submitted by another attempt')
    }
    const { doc, issuer, provider } = claimed
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
    if (!saleAddsUp(sale)) {
      await this.reject(doc.id, organizationId, FiscalRejectionReasons.SALE_INCONSISTENT, {
        beforeSending: true
      })
      return
    }
    const built = await this.attempt('build', doc.id, () =>
      provider.build({
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
        return this.requeueAndFail(doc.id, 'the fiscal provider did not answer the consultation')
      }
      if (consulted?.state === FiscalConsultState.ACCEPTED) {
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
      await this.accept(doc.id, organizationId, built, result)
      return
    }
    if (result.outcome === FiscalSubmitOutcome.REJECTED) {
      await this.reject(
        doc.id,
        organizationId,
        result.reason.trim() === '' ? FiscalRejectionReasons.PROVIDER_UNAVAILABLE : result.reason,
        { built, response: result.response, byAuthority: true }
      )
      return
    }
    // The authority did not answer: back to the queue, and the job fails so that the backoff of the queue spaces the next attempt
    await this.requeueAndFail(doc.id, 'the fiscal provider did not answer')
  }

  private async requeueAndFail(documentId: string, message: string): Promise<never> {
    await this.prisma.client.fiscalDocument.updateMany({
      where: { id: documentId, status: FiscalDocumentStatus.SUBMITTED },
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
      const updated = await tx.fiscalDocument.update({
        where: { id: doc.id },
        data: { status: FiscalDocumentStatus.SUBMITTED, attempts: { increment: 1 } }
      })
      return { doc: { ...updated, attempts: doc.attempts }, issuer, provider }
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
    await this.prisma.transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM fiscal_documents WHERE id = ${documentId} AND organization_id = ${organizationId} FOR UPDATE`
      const doc = await tx.fiscalDocument.findFirstOrThrow({
        where: { id: documentId, organizationId },
        select: { orderId: true, status: true, createdAt: true }
      })
      // Another attempt decided first (this one was taken over): what is decided is not decided twice
      if (doc.status !== (FiscalDocumentStatus.SUBMITTED as string)) {
        this.logger.warn(
          { documentId },
          'the acceptance of a fiscal document was skipped: it was not being submitted'
        )
        return
      }
      // The sale entry may have posted after the document was made: the link is made now, never by copying its amounts
      const entry = await tx.journalEntry.findFirst({
        where: { organizationId, idempotencyKey: FinancePostingKey.ORDER_SALE(doc.orderId) },
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
    })
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
      Record<'name' | 'taxId' | 'registrationId' | 'email' | 'phone', string | null>
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
      const current = this.openReceiver(doc.receiverEncrypted)
      const next: FiscalReceiver = {
        name: 'name' in patch ? (patch.name ?? null) : current.name,
        taxId: 'taxId' in patch ? (patch.taxId ?? null) : current.taxId,
        registrationId:
          'registrationId' in patch ? (patch.registrationId ?? null) : current.registrationId,
        email: 'email' in patch ? (patch.email ?? null) : current.email,
        phone: 'phone' in patch ? (patch.phone ?? null) : current.phone,
        address: 'address' in patch ? (patch.address ?? null) : current.address
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
        // decides it with the accountant (Step 4B.7b).
        if (moved && doc.attempts > 0) {
          throw new PlatformException(
            ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
            'the document may be at the issuer it was made with and cannot move to another',
            HttpStatusCodes.CONFLICT
          )
        }
        // A sale that did not add up is read again from the order: a person may have corrected it since
        const sale =
          doc.rejectionReason === FiscalRejectionReasons.SALE_INCONSISTENT
            ? await this.readSale(tx, organizationId, doc.orderId)
            : null
        await tx.fiscalDocument.update({
          where: { id },
          data: {
            status: FiscalDocumentStatus.QUEUED,
            rejectionReason: null,
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
    const outcome = await this.attempt('void', id, () =>
      provider.void(
        {
          documentType: doc.documentType,
          externalNumber: doc.externalNumber,
          providerData: doc.providerData === null ? null : record(doc.providerData),
          payload
        },
        reason,
        {
          issuer: this.issuerOfSnapshot(doc.issuerSnapshot),
          credentials,
          // One key per document and reason: a double click, or a request asked again after an answer that was lost, is the same
          // invalidation for the provider; one that was refused and is asked again with another reason is a new one
          idempotencyKey: `${organizationId}:${id}:void:${createHash('sha256').update(reason).digest('hex').slice(0, 16)}`,
          attempt: 1
        }
      )
    )
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
      metadata: { externalNumber: doc.externalNumber },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.get(organizationId, id)
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

  private view(row: {
    id: string
    storeId: string
    orderId: string
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
