import { randomUUID } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher } from '@platform/core/crypto'
import { isUniqueViolation, PrismaService, type PrismaTransaction } from '@platform/core/database'
import {
  FiscalContingencyAlertKind,
  FiscalContingencyConflictReasons,
  FiscalContingencyLimits,
  FiscalContingencyOrigin,
  FiscalContingencyReportOutcome,
  FiscalContingencyStatus,
  type FiscalEnvironment,
  fiscalJobOptions,
  FiscalDocumentStatus,
  FiscalLimits,
  FiscalResourceTypes
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
import {
  JobNames,
  QueueNames,
  reportFiscalContingencyJobId,
  submitFiscalDocumentJobId
} from '@platform/core/queues'
import type {
  BuiltDocument,
  FiscalContingencyDeclaration,
  FiscalDocumentProvider,
  FiscalIssuerInput,
  FiscalVoidParty,
  ProviderContext,
  StoredFiscalDocument
} from '@platform/fiscal/sdk'

import type { FiscalActor } from './fiscal-issuer.service'
import { FiscalProviderRegistry } from './fiscal-provider.registry'
import { cappedResponse, record, toJson } from './json'
import { withTimeout } from './with-timeout'

const HOUR_MS = 3_600_000

export interface FiscalContingencyView {
  id: string
  status: FiscalContingencyStatus
  origin: FiscalContingencyOrigin
  providerId: string
  environment: FiscalEnvironment
  reason: string
  motive: string | null
  startedAt: string
  endedAt: string | null
  reportedAt: string | null
  windowEndsAt: string | null
  // The documents made in it
  documents: number
  reportAttempts: number
  lastReportError: string | null
}

export interface FiscalContingencyEnterBody {
  reason: string
  motive?: string | null
}

export interface FiscalContingencyEndBody {
  responsible?: FiscalVoidParty | null
}

// How a document that is about to be made is routed (see `routeOf`)
export type FiscalContingencyRoute =
  | { kind: 'normal' }
  // An open contingency of its issuer: the document is made in the deferred model and kept
  | {
      kind: 'attach'
      contingency: { id: string; reason: string; motive: string | null }
      mode: FiscalContingencyDeclaration
    }
  // Made in a contingency whose event the authority has taken: it goes out through the queue
  | { kind: 'send'; contingencyId: string }

export type FiscalContingencyAttach = 'attached' | 'closed' | 'full' | 'gone'

// The contingency of an issuer (Step 4B.7c-7, TDD_18 §8.3). While the authority cannot be reached an issuer goes on making documents in
// the deferred model: each is built, signed and kept, not sent. When the contingency ends, the event that reports it (the window, the
// reason and the documents) is sent; once the authority takes it, the documents go out through the queue, inside the time the provider
// declares. Core never reads a reason, a code or a window of its own: the reasons, the time and the size of an event are the provider's.
@Injectable()
export class FiscalContingencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: DomainEvents,
    private readonly cipher: CredentialCipher,
    private readonly providers: FiscalProviderRegistry,
    private readonly logger: PinoLogger,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly queue: Queue
  ) {
    this.logger.setContext(FiscalContingencyService.name)
  }

  // ---------------------------------------------------------------- reads

  // The open contingency of the organization, or null
  async current(organizationId: string): Promise<FiscalContingencyView | null> {
    const row = await this.prisma.client.fiscalContingency.findFirst({
      where: { organizationId, status: FiscalContingencyStatus.OPEN }
    })
    return row === null ? null : this.view(organizationId, row)
  }

  // The latest ones first: what a person looks at to see what was reported and what is waiting
  async list(organizationId: string, limit: number): Promise<FiscalContingencyView[]> {
    const rows = await this.prisma.client.fiscalContingency.findMany({
      where: { organizationId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: Math.min(Math.max(limit, 1), FiscalLimits.LIST_MAX_PAGE_SIZE)
    })
    return Promise.all(rows.map(row => this.view(organizationId, row)))
  }

  async get(organizationId: string, id: string): Promise<FiscalContingencyView> {
    const row = await this.prisma.client.fiscalContingency.findFirst({
      where: { id, organizationId }
    })
    if (row === null) throw this.notFound()
    return this.view(organizationId, row)
  }

  // ---------------------------------------------------------------- the person's actions

  // A person starts a contingency: the documents made from now on are made in the deferred model
  async enter(
    organizationId: string,
    body: FiscalContingencyEnterBody,
    actor: FiscalActor
  ): Promise<FiscalContingencyView> {
    const { issuer, provider, mode } = await this.issuerOf(organizationId)
    if (!mode.reasons.includes(body.reason)) {
      throw this.conflict(
        'the provider does not know that reason',
        FiscalContingencyConflictReasons.UNKNOWN_REASON,
        HttpStatusCodes.BAD_REQUEST
      )
    }
    const motive = this.motiveOf(body.motive)
    const row = await this.open(
      this.prisma.client,
      organizationId,
      provider,
      issuer.environment as FiscalEnvironment,
      FiscalContingencyOrigin.USER,
      body.reason,
      motive,
      actor.userId
    )
    if (row === null) {
      throw this.conflict(
        'there is an open contingency already',
        FiscalContingencyConflictReasons.ALREADY_OPEN
      )
    }
    this.audit.log({
      action: AuditAction.FISCAL_CONTINGENCY_ENTERED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.CONTINGENCY,
      resourceId: row.id,
      metadata: { origin: FiscalContingencyOrigin.USER, reason: body.reason },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.view(organizationId, row)
  }

  // A person ends the open contingency: from here no document is made in it, and the event that reports it is queued. The person who
  // answers for the establishment is given here when the provider's authority asks (the lifecycle may have opened the contingency by
  // itself, so nobody gave it before).
  async end(
    organizationId: string,
    body: FiscalContingencyEndBody,
    actor: FiscalActor
  ): Promise<FiscalContingencyView> {
    const { mode } = await this.issuerOf(organizationId)
    const responsible = body.responsible ?? null
    if (mode.requiresResponsible && responsible === null) {
      throw this.conflict(
        'the authority asks who answers for the establishment',
        FiscalContingencyConflictReasons.RESPONSIBLE_REQUIRED,
        HttpStatusCodes.BAD_REQUEST
      )
    }
    const ended = await this.prisma.transaction(async tx => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM fiscal_contingencies WHERE organization_id = ${organizationId} AND status = ${FiscalContingencyStatus.OPEN} FOR UPDATE`
      const id = rows[0]?.id
      if (id === undefined) return null
      const documents = await tx.fiscalDocument.count({
        where: { organizationId, contingencyId: id }
      })
      const row = await tx.fiscalContingency.update({
        where: { id },
        data: {
          status: FiscalContingencyStatus.CLOSED,
          endedAt: new Date(),
          closedBy: actor.userId,
          ...(responsible === null
            ? {}
            : {
                responsibleEncrypted: new Uint8Array(this.cipher.seal({ ...responsible }))
              })
        }
      })
      return { row, documents }
    })
    if (ended === null) {
      throw this.conflict('there is no open contingency', FiscalContingencyConflictReasons.NOT_OPEN)
    }
    this.audit.log({
      action: AuditAction.FISCAL_CONTINGENCY_ENDED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.CONTINGENCY,
      resourceId: ended.row.id,
      metadata: { documents: ended.documents },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    // A contingency with no document has nothing to report
    if (ended.documents > 0) await this.enqueueReport(organizationId, ended.row.id, 1)
    return this.view(organizationId, ended.row)
  }

  // A person asks again for the report of a contingency whose event was not taken (the authority refused it, or the attempts ran out)
  async reportAgain(
    organizationId: string,
    id: string,
    actor: FiscalActor
  ): Promise<FiscalContingencyView> {
    const row = await this.prisma.client.fiscalContingency.findFirst({
      where: { id, organizationId }
    })
    if (row === null) throw this.notFound()
    if ((row.status as FiscalContingencyStatus) !== FiscalContingencyStatus.CLOSED) {
      throw this.conflict(
        'only an ended contingency that was not reported is reported again',
        FiscalContingencyConflictReasons.NOT_CLOSED
      )
    }
    const updated = await this.prisma.client.fiscalContingency.update({
      where: { id },
      data: { reportAttempts: 0, lastReportError: null }
    })
    // The ask counts in the id of the job: the failed one of the last time stays a week and would drop this one
    await this.enqueueReport(organizationId, id, Date.now())
    this.audit.log({
      action: AuditAction.FISCAL_CONTINGENCY_ENDED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.CONTINGENCY,
      resourceId: id,
      metadata: { reportAskedAgain: true },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.view(organizationId, updated)
  }

  // ---------------------------------------------------------------- the lifecycle

  // How the document that is about to be made is routed. A document made in a contingency stays there; any other goes into the open
  // contingency of its issuer when the provider has the deferred model and the contingency is of this provider and environment.
  async routeOf(
    organizationId: string,
    doc: { contingencyId: string | null },
    provider: FiscalDocumentProvider,
    environment: FiscalEnvironment
  ): Promise<FiscalContingencyRoute> {
    if (doc.contingencyId !== null) {
      return { kind: 'send', contingencyId: doc.contingencyId }
    }
    const mode = provider.manifest.contingencyMode
    if (mode === undefined) return { kind: 'normal' }
    const open = await this.prisma.client.fiscalContingency.findFirst({
      where: {
        organizationId,
        status: FiscalContingencyStatus.OPEN,
        providerId: provider.id,
        environment
      },
      select: { id: true, reason: true, motive: true }
    })
    return open === null ? { kind: 'normal' } : { kind: 'attach', contingency: open, mode }
  }

  // The state of the contingency a document was made in, for the claim of its submission: only a REPORTED one lets the document go
  async releasedOf(organizationId: string, contingencyId: string): Promise<boolean> {
    const row = await this.prisma.client.fiscalContingency.findFirst({
      where: { id: contingencyId, organizationId },
      select: { status: true }
    })
    return (
      row !== null && (row.status as FiscalContingencyStatus) === FiscalContingencyStatus.REPORTED
    )
  }

  // The lifecycle opens a contingency by itself: a document found the authority down in every attempt. Returns false when one is open
  // already (another document opened it a moment ago), which is as good. The person is told.
  async openBySystem(
    organizationId: string,
    provider: FiscalDocumentProvider,
    environment: FiscalEnvironment
  ): Promise<boolean> {
    const mode = provider.manifest.contingencyMode
    if (mode === undefined) return false
    // Not in a transaction: the unique violation of a second open contingency would abort it
    const created = await this.open(
      this.prisma.client,
      organizationId,
      provider,
      environment,
      FiscalContingencyOrigin.SYSTEM,
      mode.authorityDownReason,
      null,
      null
    )
    if (created === null) return false
    await this.prisma.transaction(tx => {
      this.events.publish(tx, Events.FISCAL_CONTINGENCY_ALERT, {
        organizationId,
        contingencyId: created.id,
        kind: FiscalContingencyAlertKind.OPENED_BY_SYSTEM
      })
      return Promise.resolve()
    })
    this.audit.log({
      action: AuditAction.FISCAL_CONTINGENCY_ENTERED,
      actor: { system: true },
      organizationId,
      resourceType: FiscalResourceTypes.CONTINGENCY,
      resourceId: created.id,
      metadata: { origin: FiscalContingencyOrigin.SYSTEM, reason: mode.authorityDownReason }
    })
    return true
  }

  // The document was built and signed in the deferred model: it is kept in the contingency and goes back to the queue, held. Under the lock
  // of the contingency, so that a contingency a person ended a moment ago never takes a document its event does not list.
  async attach(
    organizationId: string,
    documentId: string,
    contingencyId: string,
    built: BuiltDocument,
    providerData: Readonly<Record<string, unknown>> | undefined,
    maxDocuments: number
  ): Promise<FiscalContingencyAttach> {
    const sealed = new Uint8Array(
      this.cipher.seal(toJson(built.payload) as Record<string, unknown>)
    )
    const data =
      providerData === undefined
        ? undefined
        : cappedResponse(providerData, FiscalLimits.PROVIDER_DATA_MAX_CHARS)
    return this.prisma.transaction(async tx => {
      const rows = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM fiscal_contingencies WHERE id = ${contingencyId} AND organization_id = ${organizationId} FOR UPDATE`
      const status = rows[0]?.status
      if (status === undefined) return 'gone' as const
      if ((status as FiscalContingencyStatus) !== FiscalContingencyStatus.OPEN) {
        return 'closed' as const
      }
      const held = await tx.fiscalDocument.count({ where: { organizationId, contingencyId } })
      if (held >= maxDocuments) return 'full' as const
      // Only the attempt that holds the claim of the document keeps it
      const moved = await tx.fiscalDocument.updateMany({
        where: { id: documentId, organizationId, status: FiscalDocumentStatus.SUBMITTED },
        data: {
          status: FiscalDocumentStatus.QUEUED,
          contingencyId,
          documentType: built.documentType,
          builtPayloadEncrypted: sealed,
          attempts: 0,
          ...(data === undefined ? {} : { providerData: data })
        }
      })
      return moved.count === 1 ? ('attached' as const) : ('gone' as const)
    })
  }

  // ---------------------------------------------------------------- the report (worker)

  // Sends the event of an ended contingency. Throws when the authority did not answer, so the queue asks again with its backoff; a decision
  // (taken, refused) returns. The documents of the lot are released to the queue once the authority has taken the event.
  async report(
    organizationId: string,
    contingencyId: string
  ): Promise<'reported' | 'refused' | 'nothing'> {
    const row = await this.prisma.client.fiscalContingency.findFirst({
      where: { id: contingencyId, organizationId }
    })
    if (row === null) return 'nothing'
    if ((row.status as FiscalContingencyStatus) === FiscalContingencyStatus.REPORTED) {
      // Taken already (a second job of the same contingency): the release is asked again, which the job ids keep from doubling
      await this.release(organizationId, contingencyId)
      return 'nothing'
    }
    if ((row.status as FiscalContingencyStatus) !== FiscalContingencyStatus.CLOSED) return 'nothing'
    const provider = this.providers.find(row.providerId)
    const mode = provider?.manifest.contingencyMode
    const reportEvent = provider?.reportContingency?.bind(provider)
    if (provider === undefined || mode === undefined || reportEvent === undefined) {
      await this.markFailed(organizationId, contingencyId, 'provider_unavailable', true)
      return 'refused'
    }
    const issuer = await this.prisma.client.fiscalIssuer.findUnique({ where: { organizationId } })
    // The contingency was made for a provider and an environment: an issuer that changed since is not the one its credentials belong to
    if (
      issuer === null ||
      issuer.providerId !== row.providerId ||
      (issuer.environment as FiscalEnvironment) !== (row.environment as FiscalEnvironment)
    ) {
      await this.markFailed(organizationId, contingencyId, 'issuer_changed', true)
      return 'refused'
    }
    let credentials: Record<string, unknown> = {}
    if (issuer.credentialsEncrypted !== null) {
      try {
        credentials = this.cipher.open(issuer.credentialsEncrypted)
      } catch {
        await this.markFailed(organizationId, contingencyId, 'credentials_unreadable', true)
        return 'refused'
      }
    }
    const held = await this.prisma.client.fiscalDocument.findMany({
      where: {
        organizationId,
        contingencyId,
        status: FiscalDocumentStatus.QUEUED
      },
      orderBy: { sequenceNumber: 'asc' },
      select: { documentType: true, builtPayloadEncrypted: true, providerData: true }
    })
    const documents: StoredFiscalDocument[] = []
    for (const doc of held) {
      if (doc.builtPayloadEncrypted === null) {
        await this.markFailed(organizationId, contingencyId, 'document_unreadable', true)
        return 'refused'
      }
      let payload: Record<string, unknown>
      try {
        payload = this.cipher.open(doc.builtPayloadEncrypted)
      } catch {
        await this.markFailed(organizationId, contingencyId, 'document_unreadable', true)
        return 'refused'
      }
      documents.push({
        documentType: doc.documentType,
        externalNumber: null,
        providerData: doc.providerData === null ? null : record(doc.providerData),
        payload
      })
    }
    // Nothing was made in it after all: nothing to report
    if (documents.length === 0) return 'nothing'
    let responsible: FiscalVoidParty | null = null
    if (row.responsibleEncrypted !== null) {
      try {
        const opened = this.cipher.open(row.responsibleEncrypted)
        const text = (value: unknown): string => (typeof value === 'string' ? value : '')
        responsible = {
          name: text(opened['name']),
          idType: text(opened['idType']),
          idNumber: text(opened['idNumber'])
        }
      } catch {
        await this.markFailed(organizationId, contingencyId, 'responsible_unreadable', true)
        return 'refused'
      }
    }
    if (documents.length > mode.maxDocumentsPerEvent) {
      await this.markFailed(organizationId, contingencyId, 'too_many_documents', true)
      return 'refused'
    }
    const context: ProviderContext = {
      issuer: this.issuerInput(issuer),
      credentials,
      idempotencyKey: `${organizationId}:contingency:${contingencyId}`,
      attempt: row.reportAttempts + 1
    }
    await this.prisma.client.fiscalContingency.update({
      where: { id: contingencyId },
      data: { reportAttempts: { increment: 1 } }
    })
    let result
    try {
      result = await withTimeout(
        () =>
          reportEvent(
            {
              eventId: row.eventCode,
              reason: row.reason,
              motive: row.motive,
              startedAt: row.startedAt.toISOString(),
              endedAt: (row.endedAt ?? new Date()).toISOString(),
              documents,
              responsible
            },
            context
          ),
        FiscalLimits.PROVIDER_CALL_TIMEOUT_MS
      )
    } catch (error) {
      // What a provider throws may carry data of a document: only the name of the error is kept
      this.logger.warn(
        { contingencyId, err: errorName(error) },
        'a fiscal provider failed while reporting a contingency'
      )
      result = null
    }
    if (result === null || result.outcome === FiscalContingencyReportOutcome.UNAVAILABLE) {
      throw new Error('the fiscal provider did not answer the report of a contingency')
    }
    if (result.outcome === FiscalContingencyReportOutcome.REJECTED) {
      await this.markFailed(
        organizationId,
        contingencyId,
        typeof result.reason === 'string' ? result.reason : 'rejected',
        true,
        result.response
      )
      return 'refused'
    }
    const receivedAt = new Date(result.receivedAt)
    if (Number.isNaN(receivedAt.getTime())) {
      await this.markFailed(organizationId, contingencyId, 'provider_answer_invalid', true)
      return 'refused'
    }
    const windowEndsAt = new Date(receivedAt.getTime() + mode.transmitWithinHours * HOUR_MS)
    const providerData =
      result.providerData === undefined
        ? undefined
        : cappedResponse(result.providerData, FiscalLimits.PROVIDER_DATA_MAX_CHARS)
    const response =
      result.response === undefined
        ? undefined
        : cappedResponse(result.response, FiscalLimits.RESPONSE_MAX_CHARS)
    await this.prisma.client.fiscalContingency.update({
      where: { id: contingencyId },
      data: {
        status: FiscalContingencyStatus.REPORTED,
        reportedAt: new Date(),
        windowEndsAt,
        lastReportError: null,
        ...(providerData === undefined ? {} : { providerData }),
        ...(response === undefined ? {} : { response })
      }
    })
    this.audit.log({
      action: AuditAction.FISCAL_CONTINGENCY_REPORTED,
      actor: { system: true },
      organizationId,
      resourceType: FiscalResourceTypes.CONTINGENCY,
      resourceId: contingencyId,
      metadata: { documents: documents.length }
    })
    await this.release(organizationId, contingencyId)
    return 'reported'
  }

  // The last attempt of the report job failed: nobody asks again by itself, so a person is told
  async reportExhausted(organizationId: string, contingencyId: string): Promise<void> {
    try {
      await this.markFailed(organizationId, contingencyId, 'no_answer', false)
    } catch (error) {
      this.logger.error(
        { contingencyId, err: errorName(error) },
        'the notice of a contingency that was not reported was not made'
      )
    }
  }

  // The window to send the documents of a reported contingency is closing and some of them are not accepted yet: the person is told, once
  async warnWindows(organizationId: string, now: Date = new Date()): Promise<number> {
    const rows = await this.prisma.client.fiscalContingency.findMany({
      where: {
        organizationId,
        status: FiscalContingencyStatus.REPORTED,
        warnedAt: null,
        windowEndsAt: { not: null }
      },
      select: { id: true, providerId: true, reportedAt: true, windowEndsAt: true }
    })
    let told = 0
    for (const row of rows) {
      if (row.windowEndsAt === null || row.reportedAt === null) continue
      const total = row.windowEndsAt.getTime() - row.reportedAt.getTime()
      const left = row.windowEndsAt.getTime() - now.getTime()
      if (left > total * FiscalContingencyLimits.WARN_REMAINING_RATIO) continue
      const waiting = await this.prisma.client.fiscalDocument.count({
        where: {
          organizationId,
          contingencyId: row.id,
          status: { in: [FiscalDocumentStatus.QUEUED, FiscalDocumentStatus.SUBMITTED] }
        }
      })
      if (waiting === 0) continue
      const warned = await this.prisma.client.fiscalContingency.updateMany({
        where: { id: row.id, organizationId, warnedAt: null },
        data: { warnedAt: now }
      })
      if (warned.count === 0) continue
      await this.prisma.transaction(tx => {
        this.events.publish(tx, Events.FISCAL_CONTINGENCY_ALERT, {
          organizationId,
          contingencyId: row.id,
          kind: FiscalContingencyAlertKind.WINDOW_CLOSING
        })
        return Promise.resolve()
      })
      told += 1
    }
    return told
  }

  // The contingencies of the organization whose report is owed: ended, listing documents and not taken. The daily check asks for them again.
  async unreported(organizationId: string): Promise<string[]> {
    const rows = await this.prisma.client.fiscalContingency.findMany({
      where: { organizationId, status: FiscalContingencyStatus.CLOSED },
      select: { id: true, reportAttempts: true }
    })
    const owed: string[] = []
    for (const row of rows) {
      if (row.reportAttempts >= FiscalContingencyLimits.REPORT_MAX_ATTEMPTS) continue
      const documents = await this.prisma.client.fiscalDocument.count({
        where: { organizationId, contingencyId: row.id }
      })
      if (documents > 0) owed.push(row.id)
    }
    return owed
  }

  // ---------------------------------------------------------------- internals

  // The documents of a reported contingency go out through the queue (one job each, the job id keeps a repeat from doubling them)
  private async release(organizationId: string, contingencyId: string): Promise<void> {
    const docs = await this.prisma.client.fiscalDocument.findMany({
      where: { organizationId, contingencyId, status: FiscalDocumentStatus.QUEUED },
      select: { id: true, submission: true },
      orderBy: { sequenceNumber: 'asc' }
    })
    for (const doc of docs) {
      const jobId = submitFiscalDocumentJobId(doc.id, doc.submission)
      const earlier = await this.queue.getJob(jobId)
      if (earlier !== undefined && (await earlier.isFailed())) await earlier.remove()
      await this.queue.add(
        JobNames.SUBMIT_FISCAL_DOCUMENT,
        { organizationId, documentId: doc.id },
        { ...fiscalJobOptions(), jobId }
      )
    }
  }

  // The daily check asks again for a report that is owed (one job for each day), so an ended contingency never waits for ever
  async askReport(organizationId: string, contingencyId: string, now: Date): Promise<void> {
    await this.enqueueReport(organizationId, contingencyId, Math.floor(now.getTime() / 86_400_000))
  }

  private async enqueueReport(
    organizationId: string,
    contingencyId: string,
    ask: number
  ): Promise<void> {
    const jobId = reportFiscalContingencyJobId(contingencyId, ask)
    const earlier = await this.queue.getJob(jobId)
    if (earlier !== undefined && (await earlier.isFailed())) await earlier.remove()
    await this.queue.add(
      JobNames.REPORT_FISCAL_CONTINGENCY,
      { organizationId, contingencyId },
      { ...fiscalJobOptions(), jobId }
    )
  }

  // The report did not go through: what failed is a code (never data), and the person is told once
  private async markFailed(
    organizationId: string,
    contingencyId: string,
    code: string,
    keepAttempts: boolean,
    response?: Readonly<Record<string, unknown>>
  ): Promise<void> {
    const kept = code.slice(0, 100)
    const stored =
      response === undefined ? undefined : cappedResponse(response, FiscalLimits.RESPONSE_MAX_CHARS)
    await this.prisma.transaction(async tx => {
      const moved = await tx.fiscalContingency.updateMany({
        where: { id: contingencyId, organizationId, status: FiscalContingencyStatus.CLOSED },
        data: {
          lastReportError: kept,
          ...(stored === undefined ? {} : { response: stored }),
          ...(keepAttempts ? { reportAttempts: FiscalContingencyLimits.REPORT_MAX_ATTEMPTS } : {})
        }
      })
      if (moved.count === 0) return
      this.events.publish(tx, Events.FISCAL_CONTINGENCY_ALERT, {
        organizationId,
        contingencyId,
        kind: FiscalContingencyAlertKind.REPORT_FAILED
      })
    })
  }

  // Opens a contingency; null when the organization has one open already (the database says it: one open per organization)
  private async open(
    client: PrismaTransaction | PrismaService['client'],
    organizationId: string,
    provider: FiscalDocumentProvider,
    environment: FiscalEnvironment,
    origin: FiscalContingencyOrigin,
    reason: string,
    motive: string | null,
    userId: string | null
  ) {
    try {
      return await client.fiscalContingency.create({
        data: {
          organizationId,
          providerId: provider.id,
          environment,
          status: FiscalContingencyStatus.OPEN,
          origin,
          reason,
          motive,
          eventCode: randomUUID(),
          startedAt: new Date(),
          openedBy: userId
        }
      })
    } catch (error) {
      if (isUniqueViolation(error)) return null
      throw error
    }
  }

  private async issuerOf(organizationId: string) {
    const issuer = await this.prisma.client.fiscalIssuer.findUnique({ where: { organizationId } })
    const provider = issuer === null ? undefined : this.providers.find(issuer.providerId)
    const mode = provider?.manifest.contingencyMode
    if (issuer === null || provider === undefined) {
      throw new PlatformException(
        ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
        'the organization has no issuer with a provider of this deployment',
        HttpStatusCodes.CONFLICT
      )
    }
    if (mode === undefined) {
      throw this.conflict(
        'the provider has no contingency mode',
        FiscalContingencyConflictReasons.UNSUPPORTED
      )
    }
    return { issuer, provider, mode }
  }

  private issuerInput(row: {
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
  }): FiscalIssuerInput {
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

  private motiveOf(motive: string | null | undefined): string | null {
    if (motive === undefined || motive === null) return null
    const trimmed = motive.trim()
    if (trimmed === '') return null
    if (trimmed.length > FiscalContingencyLimits.MOTIVE_MAX_LENGTH) {
      throw this.conflict(
        'the motive is too long',
        FiscalContingencyConflictReasons.MOTIVE_TOO_LONG,
        HttpStatusCodes.BAD_REQUEST
      )
    }
    return trimmed
  }

  private conflict(
    message: string,
    reason: string,
    status: number = HttpStatusCodes.CONFLICT
  ): PlatformException {
    return new PlatformException(ErrorCodes.FISCAL_CONTINGENCY_INVALID, message, status, { reason })
  }

  private notFound(): PlatformException {
    return resourceNotFound('contingency')
  }

  private async view(
    organizationId: string,
    row: {
      id: string
      status: string
      origin: string
      providerId: string
      environment: string
      reason: string
      motive: string | null
      startedAt: Date
      endedAt: Date | null
      reportedAt: Date | null
      windowEndsAt: Date | null
      reportAttempts: number
      lastReportError: string | null
    }
  ): Promise<FiscalContingencyView> {
    const documents = await this.prisma.client.fiscalDocument.count({
      where: { organizationId, contingencyId: row.id }
    })
    return {
      id: row.id,
      status: row.status as FiscalContingencyStatus,
      origin: row.origin as FiscalContingencyOrigin,
      providerId: row.providerId,
      environment: row.environment as FiscalEnvironment,
      reason: row.reason,
      motive: row.motive,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
      reportedAt: row.reportedAt?.toISOString() ?? null,
      windowEndsAt: row.windowEndsAt?.toISOString() ?? null,
      documents,
      reportAttempts: row.reportAttempts,
      lastReportError: row.lastReportError
    }
  }
}
