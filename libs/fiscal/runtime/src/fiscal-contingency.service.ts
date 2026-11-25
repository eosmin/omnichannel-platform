import { randomUUID } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
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
  FiscalContingencyAlertKind,
  FiscalContingencyAttachResult,
  FiscalContingencyCodePattern,
  FiscalContingencyFailures,
  FiscalContingencyReportResult,
  FiscalContingencyConflictReasons,
  FiscalContingencyLimits,
  FiscalContingencyOrigin,
  FiscalContingencyReportOutcome,
  FiscalContingencyStatus,
  type FiscalEnvironment,
  fiscalReleasedJobOptions,
  fiscalReportJobOptions,
  FiscalDocumentStatus,
  FiscalLimits,
  FiscalResourceTypes,
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

import { type ClaimToken } from './claim-token'
import type { FiscalActor } from './fiscal-issuer.service'
import { FiscalProviderRegistry } from './fiscal-provider.registry'
import { reportDeadlineIsClosing } from './fiscal-rules'
import { cappedResponse, record, toJson } from './json'
import { openSealed } from './sealed-open'
import { withTimeout } from './with-timeout'

const HOUR_MS = 3_600_000
// Jobs one call to the queue adds
const ENQUEUE_CHUNK = 100

interface ViewRow {
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

export type FiscalContingencyAttach = FiscalContingencyAttachResult

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
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly queue: Queue,
    private readonly jobContext: JobContext
  ) {
    this.logger.setContext(FiscalContingencyService.name)
  }

  // One unit of the work on a contingency is one short context of the organization (a request joins its own). The call to the authority and
  // the queue are reached between two units, never inside one
  private inTx<T>(organizationId: string, work: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    return this.jobContext.inOrganizationOrRequest(
      organizationId,
      () => this.prisma.transaction(work),
      { maxWait: FiscalLimits.CONTEXT_MAX_WAIT_MS, timeout: FiscalLimits.CONTEXT_TIMEOUT_MS }
    )
  }

  private unit<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    return this.jobContext.inOrganizationOrRequest(organizationId, work, {
      maxWait: FiscalLimits.CONTEXT_MAX_WAIT_MS,
      timeout: FiscalLimits.CONTEXT_TIMEOUT_MS
    })
  }

  // ---------------------------------------------------------------- reads

  // The open contingency of the organization, or null
  async current(organizationId: string): Promise<FiscalContingencyView | null> {
    const row = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingency.findFirst({
        where: { organizationId, status: FiscalContingencyStatus.OPEN }
      })
    )
    return row === null ? null : this.view(organizationId, row)
  }

  // The latest ones first: what a person looks at to see what was reported and what is waiting
  async list(organizationId: string, limit: number): Promise<FiscalContingencyView[]> {
    const rows = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingency.findMany({
        where: { organizationId },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: Math.min(Math.max(limit, 1), FiscalLimits.LIST_MAX_PAGE_SIZE)
      })
    )
    const counts = await this.documentCounts(
      organizationId,
      rows.map(row => row.id)
    )
    return rows.map(row => this.toView(row, counts.get(row.id) ?? 0))
  }

  async get(organizationId: string, id: string): Promise<FiscalContingencyView> {
    const row = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingency.findFirst({
        where: { id, organizationId }
      })
    )
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
    const responsible = body.responsible ?? null
    const ended = await this.inTx(organizationId, async tx => {
      const rows = await tx.$queryRaw<{ id: string; provider_id: string }[]>`
        SELECT id, provider_id FROM fiscal_contingencies WHERE organization_id = ${organizationId} AND status = ${FiscalContingencyStatus.OPEN} FOR UPDATE`
      const found = rows[0]
      if (found === undefined) return null
      // What the authority asks is read from the provider the contingency was opened with, not from today's issuer (it may have changed,
      // or be gone): a contingency can always be ended
      const asks =
        this.providers.find(found.provider_id)?.manifest.contingencyMode?.requiresResponsible ===
        true
      if (asks && responsible === null) {
        throw this.conflict(
          'the authority asks who answers for the establishment',
          FiscalContingencyConflictReasons.RESPONSIBLE_REQUIRED,
          HttpStatusCodes.BAD_REQUEST
        )
      }
      const id = found.id
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
    // (a queue that is down does not undo an end that was made: the daily check asks for the report that is owed)
    if (ended.documents > 0) await this.tryEnqueueReport(organizationId, ended.row.id, 1)
    return this.view(organizationId, ended.row)
  }

  // A person asks again for the report of a contingency whose event was not taken (the authority refused it, or the attempts ran out)
  async reportAgain(
    organizationId: string,
    id: string,
    actor: FiscalActor
  ): Promise<FiscalContingencyView> {
    const row = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingency.findFirst({
        where: { id, organizationId }
      })
    )
    if (row === null) throw this.notFound()
    if ((row.status as FiscalContingencyStatus) !== FiscalContingencyStatus.CLOSED) {
      throw this.conflict(
        'only an ended contingency that was not reported is reported again',
        FiscalContingencyConflictReasons.NOT_CLOSED
      )
    }
    // Only while it is still ended and not reported: a report that took it a moment ago is not touched
    const reset = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingency.updateMany({
        // Only one whose last report failed (an error is recorded): a healthy one is not touched, and its attempts are not reset
        where: {
          id,
          organizationId,
          status: FiscalContingencyStatus.CLOSED,
          lastReportError: { not: null }
        },
        data: { reportAttempts: 0, lastReportError: null }
      })
    )
    if (reset.count === 0) {
      throw this.conflict(
        'only an ended contingency whose report failed is reported again',
        FiscalContingencyConflictReasons.NOT_FAILED
      )
    }
    const updated = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingency.findFirstOrThrow({
        where: { id, organizationId }
      })
    )
    // The ask counts in the id of the job: the failed one of the last time stays a week and would drop this one
    await this.tryEnqueueReport(organizationId, id, Date.now())
    this.audit.log({
      action: AuditAction.FISCAL_CONTINGENCY_REPORT_ASKED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.CONTINGENCY,
      resourceId: id,
      metadata: {},
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.view(organizationId, updated)
  }

  // A person gives up the report of an ended contingency that cannot go through (the authority refused the event for good, or the issuer
  // changed): the documents held in it leave it and go out the normal way, made again in the model of the moment. The contingency stays
  // as the record of what happened, with nothing held in it.
  async abandon(
    organizationId: string,
    id: string,
    actor: FiscalActor
  ): Promise<FiscalContingencyView> {
    const detached = await this.inTx(organizationId, async tx => {
      const rows = await tx.$queryRaw<
        { status: string; last_report_error: string | null; report_attempts: number }[]
      >`
        SELECT status, last_report_error, report_attempts FROM fiscal_contingencies WHERE id = ${id} AND organization_id = ${organizationId} FOR UPDATE`
      const found = rows[0]
      if (found === undefined) throw this.notFound()
      if ((found.status as FiscalContingencyStatus) !== FiscalContingencyStatus.CLOSED) {
        throw this.conflict(
          'only an ended contingency that was not reported is given up',
          FiscalContingencyConflictReasons.NOT_CLOSED
        )
      }
      // Only one whose report failed (an error is recorded): one that is on its way, or waiting for its attempts, is not given up under it
      // and with no attempt left: a report with attempts left may be on its way (or asked again by the night), and the documents it lists
      // are not taken from under it
      if (
        found.last_report_error === null ||
        found.report_attempts < FiscalContingencyLimits.REPORT_MAX_ATTEMPTS
      ) {
        throw this.conflict(
          'only an ended contingency whose report failed is given up',
          FiscalContingencyConflictReasons.NOT_FAILED
        )
      }
      const held = await tx.fiscalDocument.findMany({
        where: { organizationId, contingencyId: id, status: FiscalDocumentStatus.QUEUED },
        select: { id: true, submission: true },
        orderBy: { sequenceNumber: 'asc' }
      })
      await tx.fiscalDocument.updateMany({
        where: { organizationId, contingencyId: id, status: FiscalDocumentStatus.QUEUED },
        data: { contingencyId: null }
      })
      return held
    })
    this.audit.log({
      action: AuditAction.FISCAL_CONTINGENCY_ABANDONED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.CONTINGENCY,
      resourceId: id,
      metadata: { documents: detached.length },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    // The decision is recorded first; a queue that is down does not undo it (the check of stalled documents finds what was not queued)
    try {
      await this.enqueueSubmissions(organizationId, detached)
    } catch (error) {
      this.logger.error(
        { contingencyId: id, err: errorName(error) },
        'the documents of a contingency given up could not be queued: the check of stalled documents asks for them'
      )
    }
    const row = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingency.findFirstOrThrow({
        where: { id, organizationId }
      })
    )
    return this.view(organizationId, row)
  }

  // ---------------------------------------------------------------- the lifecycle

  // How the document that is about to be made is routed. A document made in a contingency stays there; any other goes into the open
  // contingency of its issuer when the provider has the deferred model and the contingency is of this provider and environment.
  async routeOf(
    organizationId: string,
    provider: FiscalDocumentProvider,
    environment: FiscalEnvironment
  ): Promise<FiscalContingencyRoute> {
    // A document made in a contingency never comes here: `submit` sends what was kept before it asks for a route
    const mode = provider.manifest.contingencyMode
    if (mode === undefined) return { kind: 'normal' }
    const open = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingency.findFirst({
        where: {
          organizationId,
          status: FiscalContingencyStatus.OPEN,
          providerId: provider.id,
          environment
        },
        select: { id: true, reason: true, motive: true }
      })
    )
    return open === null ? { kind: 'normal' } : { kind: 'attach', contingency: open, mode }
  }

  // The state of the contingency a document was made in, for the claim of its submission: only a REPORTED one lets the document go
  async releasedOf(
    organizationId: string,
    contingencyId: string,
    client: PrismaTransaction | PrismaService['client'] = this.prisma.client
  ): Promise<boolean> {
    const row = await client.fiscalContingency.findFirst({
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
    // One transaction for the row and its alert, so that a contingency never opens without the person being told. The insert does nothing
    // when one is open already (the partial unique index), so the transaction is not aborted by the conflict.
    const id = randomUUID()
    const created = await this.inTx(organizationId, async tx => {
      const inserted = await tx.$executeRaw`
        INSERT INTO fiscal_contingencies (id, organization_id, provider_id, environment, status, origin, reason, event_code, started_at, updated_at)
        VALUES (${id}, ${organizationId}, ${provider.id}, ${environment}, ${FiscalContingencyStatus.OPEN}, ${FiscalContingencyOrigin.SYSTEM}, ${mode.authorityDownReason}, ${randomUUID()}, now(), now())
        ON CONFLICT DO NOTHING`
      if (inserted === 0) return false
      this.events.publish(tx, Events.FISCAL_CONTINGENCY_ALERT, {
        organizationId,
        contingencyId: id,
        kind: FiscalContingencyAlertKind.OPENED_BY_SYSTEM
      })
      return true
    })
    if (!created) return false
    this.audit.log({
      action: AuditAction.FISCAL_CONTINGENCY_ENTERED,
      actor: { system: true },
      organizationId,
      resourceType: FiscalResourceTypes.CONTINGENCY,
      resourceId: id,
      metadata: { origin: FiscalContingencyOrigin.SYSTEM, reason: mode.authorityDownReason }
    })
    return true
  }

  // The document was built and signed in the deferred model: it is kept in the contingency and goes back to the queue, held. Under the lock
  // of the contingency, so that a contingency a person ended a moment ago never takes a document its event does not list.
  async attach(
    organizationId: string,
    documentId: string,
    claimToken: ClaimToken,
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
    return this.inTx(organizationId, async tx => {
      const rows = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM fiscal_contingencies WHERE id = ${contingencyId} AND organization_id = ${organizationId} FOR UPDATE`
      const status = rows[0]?.status
      if (status === undefined) return FiscalContingencyAttachResult.GONE
      if ((status as FiscalContingencyStatus) !== FiscalContingencyStatus.OPEN) {
        return FiscalContingencyAttachResult.CLOSED
      }
      const held = await tx.fiscalDocument.count({ where: { organizationId, contingencyId } })
      if (held >= maxDocuments) return FiscalContingencyAttachResult.FULL
      // Only the attempt that holds the claim of the document keeps it
      const moved = await tx.fiscalDocument.updateMany({
        where: {
          id: documentId,
          organizationId,
          status: FiscalDocumentStatus.SUBMITTED,
          claimToken
        },
        data: {
          status: FiscalDocumentStatus.QUEUED,
          claimToken: null,
          contingencyId,
          documentType: built.documentType,
          builtPayloadEncrypted: sealed,
          attempts: 0,
          ...(data === undefined ? {} : { providerData: data })
        }
      })
      return moved.count === 1
        ? FiscalContingencyAttachResult.ATTACHED
        : FiscalContingencyAttachResult.GONE
    })
  }

  // Whether the contingency already holds the most documents an event takes (asked before a document is signed for it)
  async isFull(
    organizationId: string,
    contingencyId: string,
    maxDocuments: number
  ): Promise<boolean> {
    const held = await this.unit(organizationId, () =>
      this.prisma.client.fiscalDocument.count({
        where: { organizationId, contingencyId }
      })
    )
    return held >= maxDocuments
  }

  // ---------------------------------------------------------------- the report (worker)

  // Sends the event of an ended contingency. Throws when the authority did not answer, so the queue asks again with its backoff; a decision
  // (taken, refused) returns. The documents of the lot are released to the queue once the authority has taken the event.
  async report(
    organizationId: string,
    contingencyId: string
  ): Promise<FiscalContingencyReportResult> {
    const row = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingency.findFirst({
        where: { id: contingencyId, organizationId }
      })
    )
    if (row === null) return FiscalContingencyReportResult.NOTHING
    if ((row.status as FiscalContingencyStatus) === FiscalContingencyStatus.REPORTED) {
      // Taken already (a second job of the same contingency): the release is asked again, which the job ids keep from doubling
      await this.release(organizationId, contingencyId)
      return FiscalContingencyReportResult.NOTHING
    }
    if ((row.status as FiscalContingencyStatus) !== FiscalContingencyStatus.CLOSED)
      return FiscalContingencyReportResult.NOTHING
    const provider = this.providers.find(row.providerId)
    const mode = provider?.manifest.contingencyMode
    const reportEvent = provider?.reportContingency?.bind(provider)
    if (provider === undefined || mode === undefined || reportEvent === undefined) {
      await this.markFailed(
        organizationId,
        contingencyId,
        FiscalContingencyFailures.PROVIDER_UNAVAILABLE,
        true
      )
      return FiscalContingencyReportResult.REFUSED
    }
    const issuer = await this.unit(organizationId, () =>
      this.prisma.client.fiscalIssuer.findUnique({ where: { organizationId } })
    )
    // The contingency was made for a provider and an environment: an issuer that changed since is not the one its credentials belong to
    if (
      issuer === null ||
      issuer.providerId !== row.providerId ||
      (issuer.environment as FiscalEnvironment) !== (row.environment as FiscalEnvironment)
    ) {
      await this.markFailed(
        organizationId,
        contingencyId,
        FiscalContingencyFailures.ISSUER_CHANGED,
        true
      )
      return FiscalContingencyReportResult.REFUSED
    }
    let credentials: Record<string, unknown> = {}
    if (issuer.credentialsEncrypted !== null) {
      try {
        credentials = openSealed(
          this.cipher,
          this.logger,
          issuer.credentialsEncrypted,
          SealedValueKind.ISSUER_CREDENTIALS,
          {
            organizationId,
            contingencyId
          }
        )
      } catch {
        await this.markFailed(
          organizationId,
          contingencyId,
          FiscalContingencyFailures.CREDENTIALS_UNREADABLE,
          true
        )
        return FiscalContingencyReportResult.REFUSED
      }
    }
    const held = await this.unit(organizationId, () =>
      this.prisma.client.fiscalDocument.findMany({
        where: {
          organizationId,
          contingencyId,
          status: FiscalDocumentStatus.QUEUED
        },
        orderBy: { sequenceNumber: 'asc' },
        select: { id: true, documentType: true, builtPayloadEncrypted: true, providerData: true }
      })
    )
    const documents: StoredFiscalDocument[] = []
    for (const doc of held) {
      if (doc.builtPayloadEncrypted === null) {
        await this.markFailed(
          organizationId,
          contingencyId,
          FiscalContingencyFailures.DOCUMENT_UNREADABLE,
          true
        )
        return FiscalContingencyReportResult.REFUSED
      }
      let payload: Record<string, unknown>
      try {
        payload = openSealed(
          this.cipher,
          this.logger,
          doc.builtPayloadEncrypted,
          SealedValueKind.BUILT_PAYLOAD,
          {
            organizationId,
            contingencyId,
            documentId: doc.id
          }
        )
      } catch {
        await this.markFailed(
          organizationId,
          contingencyId,
          FiscalContingencyFailures.DOCUMENT_UNREADABLE,
          true
        )
        return FiscalContingencyReportResult.REFUSED
      }
      documents.push({
        documentType: doc.documentType,
        externalNumber: null,
        providerData: doc.providerData === null ? null : record(doc.providerData),
        payload
      })
    }
    // Nothing was made in it after all: nothing to report
    if (documents.length === 0) return FiscalContingencyReportResult.NOTHING
    let responsible: FiscalVoidParty | null = null
    if (row.responsibleEncrypted !== null) {
      try {
        const opened = openSealed(
          this.cipher,
          this.logger,
          row.responsibleEncrypted,
          SealedValueKind.RESPONSIBLE,
          {
            organizationId,
            contingencyId
          }
        )
        const text = (value: unknown): string => (typeof value === 'string' ? value : '')
        responsible = {
          name: text(opened['name']),
          idType: text(opened['idType']),
          idNumber: text(opened['idNumber'])
        }
      } catch {
        await this.markFailed(
          organizationId,
          contingencyId,
          FiscalContingencyFailures.RESPONSIBLE_UNREADABLE,
          true
        )
        return FiscalContingencyReportResult.REFUSED
      }
    }
    if (documents.length > mode.maxDocumentsPerEvent) {
      await this.markFailed(
        organizationId,
        contingencyId,
        FiscalContingencyFailures.TOO_MANY_DOCUMENTS,
        true
      )
      return FiscalContingencyReportResult.REFUSED
    }
    const context: ProviderContext = {
      issuer: this.issuerInput(issuer),
      credentials,
      idempotencyKey: `${organizationId}:contingency:${contingencyId}`,
      attempt: row.reportAttempts + 1
    }
    await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingency.updateMany({
        where: { id: contingencyId, organizationId, status: FiscalContingencyStatus.CLOSED },
        data: { reportAttempts: { increment: 1 } }
      })
    )
    // The report is asked again every 15 minutes while the authority does not answer: each time, the person is told once if the time the
    // authority gives to send the event is closing
    // A failure of the warning never costs an attempt to reach the authority
    try {
      await this.warnReportDeadline(organizationId, row, mode, new Date())
    } catch (error) {
      this.logger.error(
        { contingencyId, err: errorName(error) },
        'the warning of the time to send a contingency event was not made'
      )
    }
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
        // A code of the shape of a code; free text (it may carry data of a document) is not kept, the capped response is
        typeof result.reason === 'string' && FiscalContingencyCodePattern.test(result.reason)
          ? result.reason
          : FiscalContingencyFailures.REJECTED,
        true,
        result.response
      )
      return FiscalContingencyReportResult.REFUSED
    }
    const receivedAt = new Date(result.receivedAt)
    if (Number.isNaN(receivedAt.getTime())) {
      await this.markFailed(
        organizationId,
        contingencyId,
        FiscalContingencyFailures.PROVIDER_ANSWER_INVALID,
        true
      )
      return FiscalContingencyReportResult.REFUSED
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
    // Only the run that finds it still ended takes it: another one that got there first has released the documents already
    const taken = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingency.updateMany({
        where: { id: contingencyId, organizationId, status: FiscalContingencyStatus.CLOSED },
        data: {
          status: FiscalContingencyStatus.REPORTED,
          reportedAt: new Date(),
          windowEndsAt,
          // The warning of the time to send the event (above) is not the one of the window of the lot: that one is told again
          warnedAt: null,
          lastReportError: null,
          ...(providerData === undefined ? {} : { providerData }),
          ...(response === undefined ? {} : { response })
        }
      })
    )
    if (taken.count === 0) return FiscalContingencyReportResult.NOTHING
    this.audit.log({
      action: AuditAction.FISCAL_CONTINGENCY_REPORTED,
      actor: { system: true },
      organizationId,
      resourceType: FiscalResourceTypes.CONTINGENCY,
      resourceId: contingencyId,
      metadata: { documents: documents.length }
    })
    await this.release(organizationId, contingencyId)
    return FiscalContingencyReportResult.REPORTED
  }

  // The last attempt of the report job failed: nobody asks again by itself, so a person is told
  async reportExhausted(organizationId: string, contingencyId: string): Promise<void> {
    try {
      await this.markFailed(
        organizationId,
        contingencyId,
        FiscalContingencyFailures.NO_ANSWER,
        false
      )
    } catch (error) {
      this.logger.error(
        { contingencyId, err: errorName(error) },
        'the notice of a contingency that was not reported was not made'
      )
    }
  }

  // The window to send the documents of a reported contingency is closing and some of them are not accepted yet: the person is told, once
  async warnWindows(organizationId: string, now: Date = new Date()): Promise<number> {
    const told = await this.warnReportDeadlines(organizationId, now)
    return told + (await this.warnLotWindows(organizationId, now))
  }

  // An ended contingency whose event is not taken yet and whose time to send it is closing (the rules of the authority: 24 hours after the
  // situation ended). The report job tells it too on each attempt; this is for the one whose job is gone.
  private async warnReportDeadlines(organizationId: string, now: Date): Promise<number> {
    // Only an event that is still owed (the same ones the daily check asks for): one that was refused, or has no document left, is not
    // told again as closing
    const owed = await this.unreported(organizationId)
    if (owed.length === 0) return 0
    const rows = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingency.findMany({
        where: {
          id: { in: owed },
          organizationId,
          status: FiscalContingencyStatus.CLOSED,
          lastReportError: null,
          warnedAt: null,
          endedAt: { not: null }
        },
        select: { id: true, providerId: true, endedAt: true }
      })
    )
    let told = 0
    for (const row of rows) {
      const mode = this.providers.find(row.providerId)?.manifest.contingencyMode
      if (await this.warnReportDeadline(organizationId, row, mode, now)) told += 1
    }
    return told
  }

  // Tells the person, once, that the time to send the event is closing (or passed). The event is owed still when it passed: only the
  // provider that declares the time is watched. Returns whether it told.
  private async warnReportDeadline(
    organizationId: string,
    row: { id: string; endedAt: Date | null },
    mode: Pick<FiscalContingencyDeclaration, 'reportWithinHours'> | undefined,
    now: Date
  ): Promise<boolean> {
    const hours = mode?.reportWithinHours
    if (hours === undefined || row.endedAt === null) return false
    if (
      !reportDeadlineIsClosing(
        row.endedAt,
        hours,
        now,
        FiscalContingencyLimits.WARN_REMAINING_RATIO
      )
    ) {
      return false
    }
    // The mark and its alert in one transaction: a failure in between leaves neither. Only a contingency that is still waiting for its event.
    return this.inTx(organizationId, async tx => {
      const marked = await tx.fiscalContingency.updateMany({
        where: {
          id: row.id,
          organizationId,
          status: FiscalContingencyStatus.CLOSED,
          warnedAt: null
        },
        data: { warnedAt: now }
      })
      if (marked.count === 0) return false
      this.events.publish(tx, Events.FISCAL_CONTINGENCY_ALERT, {
        organizationId,
        contingencyId: row.id,
        kind: FiscalContingencyAlertKind.WINDOW_CLOSING
      })
      return true
    })
  }

  private async warnLotWindows(organizationId: string, now: Date): Promise<number> {
    const rows = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingency.findMany({
        where: {
          organizationId,
          status: FiscalContingencyStatus.REPORTED,
          warnedAt: null,
          windowEndsAt: { not: null }
        },
        select: { id: true, providerId: true, reportedAt: true, windowEndsAt: true }
      })
    )
    let told = 0
    for (const row of rows) {
      if (row.windowEndsAt === null || row.reportedAt === null) continue
      const total = row.windowEndsAt.getTime() - row.reportedAt.getTime()
      const left = row.windowEndsAt.getTime() - now.getTime()
      if (left > total * FiscalContingencyLimits.WARN_REMAINING_RATIO) continue
      const waiting = await this.unit(organizationId, () =>
        this.prisma.client.fiscalDocument.count({
          where: {
            organizationId,
            contingencyId: row.id,
            status: { in: [FiscalDocumentStatus.QUEUED, FiscalDocumentStatus.SUBMITTED] }
          }
        })
      )
      if (waiting === 0) continue
      // The mark and its alert in one transaction: a failure in between leaves neither
      const warned = await this.inTx(organizationId, async tx => {
        const marked = await tx.fiscalContingency.updateMany({
          where: { id: row.id, organizationId, warnedAt: null },
          data: { warnedAt: now }
        })
        if (marked.count === 0) return false
        this.events.publish(tx, Events.FISCAL_CONTINGENCY_ALERT, {
          organizationId,
          contingencyId: row.id,
          kind: FiscalContingencyAlertKind.WINDOW_CLOSING
        })
        return true
      })
      if (!warned) continue
      told += 1
    }
    return told
  }

  // The contingencies of the organization whose report is owed: ended, listing documents and not taken. The daily check asks for them again.
  async unreported(organizationId: string): Promise<string[]> {
    const rows = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingency.findMany({
        where: { organizationId, status: FiscalContingencyStatus.CLOSED },
        select: { id: true, reportAttempts: true }
      })
    )
    const asking = rows.filter(
      row => row.reportAttempts < FiscalContingencyLimits.REPORT_MAX_ATTEMPTS
    )
    // Only the documents still held count: one that was moved out (refused, detached) is not a report owed
    const counts = await this.documentCounts(
      organizationId,
      asking.map(row => row.id),
      FiscalDocumentStatus.QUEUED
    )
    const owed = asking.filter(row => (counts.get(row.id) ?? 0) > 0).map(row => row.id)
    return owed
  }

  // ---------------------------------------------------------------- internals

  // The documents of a reported contingency go out through the queue (one job each, the job id keeps a repeat from doubling them)
  private async release(organizationId: string, contingencyId: string): Promise<void> {
    const docs = await this.unit(organizationId, () =>
      this.prisma.client.fiscalDocument.findMany({
        where: { organizationId, contingencyId, status: FiscalDocumentStatus.QUEUED },
        select: { id: true, submission: true },
        orderBy: { sequenceNumber: 'asc' }
      })
    )
    await this.enqueueSubmissions(organizationId, docs)
  }

  private async enqueueSubmissions(
    organizationId: string,
    docs: readonly { id: string; submission: number }[]
  ): Promise<void> {
    // After the REAL commit: the jobs read documents that this unit (or the request that joined it) has not committed when this line
    // runs. The failure reaches the caller after the commit, as a queue that is down always did
    await this.prisma.afterCommitStep(this.prisma.client, async () => {
      // In chunks: the failed jobs of the last time are removed together and the new ones are added in one call, not one round trip each
      for (let start = 0; start < docs.length; start += ENQUEUE_CHUNK) {
        const chunk = docs.slice(start, start + ENQUEUE_CHUNK)
        const jobs = chunk.map(doc => ({
          doc,
          jobId: submitFiscalDocumentJobId(doc.id, doc.submission)
        }))
        await Promise.all(
          jobs.map(async ({ jobId }) => {
            const earlier = await this.queue.getJob(jobId)
            if (earlier !== undefined && (await earlier.isFailed())) await earlier.remove()
          })
        )
        await this.queue.addBulk(
          jobs.map(({ doc, jobId }) => ({
            name: JobNames.SUBMIT_FISCAL_DOCUMENT,
            data: { organizationId, documentId: doc.id },
            opts: { ...fiscalReleasedJobOptions(), jobId }
          }))
        )
      }
    })
  }

  // The queue may be down (it is often the very outage that made the contingency): a report that cannot be queued now is asked for again by
  // the daily check, which finds it owed, and the person's action is not undone for it
  private async tryEnqueueReport(
    organizationId: string,
    contingencyId: string,
    ask: number
  ): Promise<void> {
    await this.enqueueReport(organizationId, contingencyId, ask, true)
  }

  // The daily check asks again for a report that is owed (one job for each day), so an ended contingency never waits for ever
  async askReport(organizationId: string, contingencyId: string, now: Date): Promise<void> {
    await this.enqueueReport(
      organizationId,
      contingencyId,
      Math.floor(now.getTime() / 86_400_000),
      false
    )
  }

  // After the REAL commit: the job reads the contingency. `swallow`: the failure is told in the log where it happens (after the commit
  // when a transaction is open) and never reaches the caller
  private async enqueueReport(
    organizationId: string,
    contingencyId: string,
    ask: number,
    swallow: boolean
  ): Promise<void> {
    // One job for a contingency: a job that waits, runs or backs off keeps a second one from being added (the same id), so a report never
    // runs twice at once and the attempts are not spent twice as fast. `ask` stays for the callers that told one ask from another.
    void ask
    const jobId = reportFiscalContingencyJobId(contingencyId, 1)
    await this.prisma.afterCommitStep(this.prisma.client, async () => {
      try {
        const earlier = await this.queue.getJob(jobId)
        if (earlier !== undefined && (await earlier.isFailed())) await earlier.remove()
        await this.queue.add(
          JobNames.REPORT_FISCAL_CONTINGENCY,
          { organizationId, contingencyId },
          { ...fiscalReportJobOptions(), jobId }
        )
      } catch (error) {
        if (!swallow) throw error
        this.logger.error(
          { contingencyId, err: errorName(error) },
          'the report of a contingency could not be queued: the daily check asks for it again'
        )
      }
    })
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
    const data = {
      lastReportError: kept,
      ...(stored === undefined ? {} : { response: stored }),
      ...(keepAttempts ? { reportAttempts: FiscalContingencyLimits.REPORT_MAX_ATTEMPTS } : {})
    }
    await this.inTx(organizationId, async tx => {
      // The person is told once for each failure: the first mark of an error is the one that says it, and a later run that fails the same
      // way only refreshes it (a person who asks again clears the error, so the next failure is told again)
      const where = { id: contingencyId, organizationId, status: FiscalContingencyStatus.CLOSED }
      const first = await tx.fiscalContingency.updateMany({
        where: { ...where, lastReportError: null },
        data
      })
      if (first.count === 0) {
        await tx.fiscalContingency.updateMany({ where, data })
        return
      }
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
      return await inSavepoint(() =>
        client.fiscalContingency.create({
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
      )
    } catch (error) {
      if (isUniqueViolation(error)) return null
      throw error
    }
  }

  private async issuerOf(organizationId: string) {
    const issuer = await this.unit(organizationId, () =>
      this.prisma.client.fiscalIssuer.findUnique({ where: { organizationId } })
    )
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
    return resourceNotFound(FiscalResourceTypes.CONTINGENCY)
  }

  private async view(organizationId: string, row: ViewRow): Promise<FiscalContingencyView> {
    const counts = await this.documentCounts(organizationId, [row.id])
    return this.toView(row, counts.get(row.id) ?? 0)
  }

  // How many documents each contingency holds, in one query
  private async documentCounts(
    organizationId: string,
    ids: readonly string[],
    status?: FiscalDocumentStatus
  ): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map()
    const grouped = await this.unit(organizationId, () =>
      this.prisma.client.fiscalDocument.groupBy({
        by: ['contingencyId'],
        where: {
          organizationId,
          contingencyId: { in: [...ids] },
          ...(status === undefined ? {} : { status })
        },
        _count: { _all: true }
      })
    )
    const counts = new Map<string, number>()
    for (const group of grouped) {
      if (group.contingencyId !== null) counts.set(group.contingencyId, group._count._all)
    }
    return counts
  }

  private toView(row: ViewRow, documents: number): FiscalContingencyView {
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
