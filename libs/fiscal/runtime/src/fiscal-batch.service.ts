import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher } from '@platform/core/crypto'
import { JobContext, PrismaService } from '@platform/core/database'
import {
  FiscalBatchConsultState,
  FiscalBatchFailures,
  FiscalBatchLimits,
  FiscalBatchSendOutcome,
  FiscalBatchStatus,
  FiscalContingencyCodePattern,
  FiscalContingencyStatus,
  type FiscalEnvironment,
  FiscalDocumentStatus,
  FiscalLimits,
  FiscalResourceTypes,
  SealedValueKind
} from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import type {
  BuiltDocument,
  FiscalBatchRequest,
  FiscalBatchVerdict,
  FiscalDocumentProvider,
  ProviderContext,
  StoredFiscalDocument
} from '@platform/fiscal/sdk'

import { FiscalContingencyService } from './fiscal-contingency.service'
import { FiscalDocumentsService } from './fiscal-documents.service'
import { FiscalProviderRegistry } from './fiscal-provider.registry'
import { cappedResponse, record } from './json'
import { openSealed } from './sealed-open'
import { withTimeout } from './with-timeout'

type SubmitBatch = NonNullable<FiscalDocumentProvider['submitBatch']>
type ConsultBatch = NonNullable<FiscalDocumentProvider['consultBatch']>

// What one step of a lot did, for the job that ran it: nothing left to do, or the lot asks again (the job that ran it has queued the next step)
export enum FiscalBatchStepResult {
  NOTHING = 'nothing',
  SENT = 'sent',
  WAITING = 'waiting',
  PROCESSED = 'processed'
}

// The lots of the documents of a reported contingency (D16): sends each one, asks the authority how it went and gives every document its
// verdict the way a document sent alone is decided. One step for each job: the send, then a question every so often until every document has
// its verdict. The authority is reached between two units of work, never inside one. Throws when the authority did not answer or refused
// the lot, so the queue asks again with its backoff (the whole window of the lot); a lot that cannot go forward is told by `last_error`.
@Injectable()
export class FiscalBatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cipher: CredentialCipher,
    private readonly providers: FiscalProviderRegistry,
    private readonly logger: PinoLogger,
    private readonly jobContext: JobContext,
    private readonly contingencies: FiscalContingencyService,
    private readonly documents: FiscalDocumentsService
  ) {
    this.logger.setContext(FiscalBatchService.name)
  }

  private unit<T>(organizationId: string, work: () => Promise<T>): Promise<T> {
    return this.jobContext.inOrganizationOrRequest(organizationId, work, {
      maxWait: FiscalLimits.CONTEXT_MAX_WAIT_MS,
      timeout: FiscalLimits.CONTEXT_TIMEOUT_MS
    })
  }

  async process(organizationId: string, batchId: string): Promise<FiscalBatchStepResult> {
    const lot = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingencyBatch.findFirst({
        where: { id: batchId, organizationId },
        include: { contingency: true }
      })
    )
    if (lot === null || (lot.status as FiscalBatchStatus) === FiscalBatchStatus.PROCESSED) {
      return FiscalBatchStepResult.NOTHING
    }
    const contingency = lot.contingency
    // Only a reported contingency has lots; one that is not (rolled back, never reported) has nothing to send
    if ((contingency.status as FiscalContingencyStatus) !== FiscalContingencyStatus.REPORTED) {
      return FiscalBatchStepResult.NOTHING
    }
    const provider = this.providers.find(contingency.providerId)
    const submitBatch = provider?.submitBatch?.bind(provider)
    const consultBatch = provider?.consultBatch?.bind(provider)
    if (provider === undefined || submitBatch === undefined || consultBatch === undefined) {
      await this.fail(organizationId, batchId, FiscalBatchFailures.PROVIDER_UNAVAILABLE)
      throw new Error('the fiscal provider of the lot cannot send lots')
    }
    const issuer = await this.unit(organizationId, () =>
      this.prisma.client.fiscalIssuer.findUnique({ where: { organizationId } })
    )
    // The lot was made for a provider and an environment: an issuer that changed since is not the one its credentials belong to
    if (
      issuer === null ||
      issuer.providerId !== contingency.providerId ||
      (issuer.environment as FiscalEnvironment) !== (contingency.environment as FiscalEnvironment)
    ) {
      await this.fail(organizationId, batchId, FiscalBatchFailures.ISSUER_CHANGED)
      throw new Error('the issuer changed since the lot was made')
    }
    let credentials: Record<string, unknown> = {}
    if (issuer.credentialsEncrypted !== null) {
      try {
        credentials = openSealed(
          this.cipher,
          this.logger,
          issuer.credentialsEncrypted,
          SealedValueKind.ISSUER_CREDENTIALS,
          { organizationId, batchId }
        )
      } catch {
        await this.fail(organizationId, batchId, FiscalBatchFailures.CREDENTIALS_UNREADABLE)
        throw new Error('the credentials of the issuer cannot be read')
      }
    }
    const held = await this.unit(organizationId, () =>
      this.prisma.client.fiscalDocument.findMany({
        where: { organizationId, batchId },
        orderBy: { sequenceNumber: 'asc' },
        select: {
          id: true,
          status: true,
          documentType: true,
          builtPayloadEncrypted: true,
          providerData: true
        }
      })
    )
    const stored: StoredFiscalDocument[] = []
    const built: BuiltDocument[] = []
    for (const doc of held) {
      if (doc.builtPayloadEncrypted === null) {
        await this.fail(organizationId, batchId, FiscalBatchFailures.DOCUMENT_UNREADABLE)
        throw new Error('a document of the lot cannot be read')
      }
      let payload: Record<string, unknown>
      try {
        payload = openSealed(
          this.cipher,
          this.logger,
          doc.builtPayloadEncrypted,
          SealedValueKind.BUILT_PAYLOAD,
          { organizationId, batchId, documentId: doc.id }
        )
      } catch {
        await this.fail(organizationId, batchId, FiscalBatchFailures.DOCUMENT_UNREADABLE)
        throw new Error('a document of the lot cannot be read')
      }
      stored.push({
        documentType: doc.documentType,
        externalNumber: null,
        providerData: doc.providerData === null ? null : record(doc.providerData),
        payload
      })
      built.push({ documentType: doc.documentType, payload, missingReceiverFields: [] })
    }
    if (stored.length !== lot.documentCount) {
      // Never sent short: a lot that lost a document is not the lot the authority was told of
      await this.fail(organizationId, batchId, FiscalBatchFailures.DOCUMENT_UNREADABLE)
      throw new Error('the lot does not hold the documents it was made with')
    }
    const request: FiscalBatchRequest = { sendId: lot.sendId, documents: stored }
    const issuerInput = this.contingencies.issuerInput(issuer)
    if ((lot.status as FiscalBatchStatus) === FiscalBatchStatus.PENDING) {
      return this.send(
        organizationId,
        lot,
        contingency.windowEndsAt,
        submitBatch,
        request,
        { issuer: issuerInput, credentials },
        held.length
      )
    }
    if (lot.batchCode === null) {
      await this.fail(organizationId, batchId, FiscalBatchFailures.PROVIDER_ANSWER_INVALID)
      throw new Error('a received lot has no code')
    }
    return this.consult(
      organizationId,
      lot,
      consultBatch,
      lot.batchCode,
      request,
      { issuer: issuerInput, credentials },
      held,
      built
    )
  }

  // The send of a lot. Only inside the window the authority gives to send the documents of a reported contingency, counted from the instant it
  // took the event (the seal of the event, not the release of the documents): after it nothing is sent and the lot stays as it is for a person.
  private async send(
    organizationId: string,
    lot: {
      id: string
      contingencyId: string
      sendId: string
      sendAttempts: number
      consultAttempts: number
    },
    windowEndsAt: Date | null,
    submitBatch: SubmitBatch,
    request: FiscalBatchRequest,
    parts: { issuer: ProviderContext['issuer']; credentials: ProviderContext['credentials'] },
    documents: number
  ): Promise<FiscalBatchStepResult> {
    if (windowEndsAt === null || Date.now() > windowEndsAt.getTime()) {
      await this.fail(organizationId, lot.id, FiscalBatchFailures.WINDOW_CLOSED)
      return FiscalBatchStepResult.NOTHING
    }
    const context: ProviderContext = {
      ...parts,
      idempotencyKey: `${organizationId}:batch:${lot.sendId}`,
      attempt: lot.sendAttempts + 1
    }
    await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingencyBatch.updateMany({
        where: { id: lot.id, organizationId, status: FiscalBatchStatus.PENDING },
        data: { sendAttempts: { increment: 1 } }
      })
    )
    let result
    try {
      result = await withTimeout(
        () => submitBatch(request, context),
        FiscalLimits.PROVIDER_CALL_TIMEOUT_MS * Math.max(1, Math.ceil(documents / 10))
      )
    } catch (error) {
      // What a provider throws may carry data of a document: only the name of the error is kept
      this.logger.warn(
        { batchId: lot.id, err: errorName(error) },
        'a fiscal provider failed while sending a lot'
      )
      result = null
    }
    if (result === null || result.outcome === FiscalBatchSendOutcome.UNAVAILABLE) {
      await this.fail(organizationId, lot.id, FiscalBatchFailures.PROVIDER_UNAVAILABLE)
      throw new Error('the fiscal provider did not answer the send of a lot')
    }
    if (result.outcome === FiscalBatchSendOutcome.REJECTED) {
      // A code of the shape of a code; free text (it may carry data of a document) is not kept. The lot stays pending and is sent again with the
      // same send id by the next attempt of the queue: a fault of the moment goes away, a refusal for good is told by its code to whoever reads it.
      await this.fail(
        organizationId,
        lot.id,
        typeof result.reason === 'string' && FiscalContingencyCodePattern.test(result.reason)
          ? result.reason
          : FiscalBatchFailures.LOT_REFUSED,
        result.response
      )
      throw new Error('the fiscal provider refused the lot')
    }
    const code = result.batchCode.trim()
    if (code === '' || code.length > 100) {
      await this.fail(organizationId, lot.id, FiscalBatchFailures.PROVIDER_ANSWER_INVALID)
      throw new Error('the fiscal provider gave a lot a code that cannot be kept')
    }
    const response =
      result.response === undefined
        ? undefined
        : cappedResponse(result.response, FiscalLimits.RESPONSE_MAX_CHARS)
    const taken = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingencyBatch.updateMany({
        where: { id: lot.id, organizationId, status: FiscalBatchStatus.PENDING },
        data: {
          status: FiscalBatchStatus.RECEIVED,
          batchCode: code,
          sentAt: new Date(),
          lastError: null,
          ...(response === undefined ? {} : { response })
        }
      })
    )
    if (taken.count === 0) return FiscalBatchStepResult.NOTHING
    this.audit.log({
      action: AuditAction.FISCAL_BATCH_SENT,
      actor: { system: true },
      organizationId,
      resourceType: FiscalResourceTypes.CONTINGENCY,
      resourceId: lot.contingencyId,
      metadata: { batchId: lot.id, documents }
    })
    // The authority answers a lot some minutes after it took it: asked soon, and again until every document has its verdict
    await this.contingencies.enqueueBatchStep(
      organizationId,
      lot.id,
      lot.sendAttempts + lot.consultAttempts + 1,
      FiscalBatchLimits.CONSULT_DELAY_MS
    )
    return FiscalBatchStepResult.SENT
  }

  private async consult(
    organizationId: string,
    lot: { id: string; contingencyId: string; sendAttempts: number; consultAttempts: number },
    consultBatch: ConsultBatch,
    batchCode: string,
    request: FiscalBatchRequest,
    parts: { issuer: ProviderContext['issuer']; credentials: ProviderContext['credentials'] },
    held: readonly { id: string; status: string }[],
    built: readonly BuiltDocument[]
  ): Promise<FiscalBatchStepResult> {
    // The consultations of a lot that never ends are bounded: after the last one the lot says so and stops asking by itself; the nightly check
    // (through the documents of the lot, `askBatch`) starts the count again, so a lot is asked about for as long as it is unfinished
    if (lot.consultAttempts >= FiscalBatchLimits.CONSULT_MAX_ATTEMPTS) {
      await this.fail(organizationId, lot.id, FiscalBatchFailures.NO_VERDICT)
      return FiscalBatchStepResult.NOTHING
    }
    const context: ProviderContext = {
      ...parts,
      // One key for each question: a provider that answers a repeated key with the first answer would never see the lot finish
      idempotencyKey: `${organizationId}:batch:${lot.id}:consult:${lot.consultAttempts + 1}`,
      attempt: lot.consultAttempts + 1
    }
    let result
    try {
      result = await withTimeout(
        () => consultBatch(batchCode, request, context),
        FiscalLimits.PROVIDER_CALL_TIMEOUT_MS
      )
    } catch (error) {
      this.logger.warn(
        { batchId: lot.id, err: errorName(error) },
        'a fiscal provider failed while asking about a lot'
      )
      result = null
    }
    if (result === null || result.state === FiscalBatchConsultState.UNAVAILABLE) {
      await this.fail(organizationId, lot.id, FiscalBatchFailures.PROVIDER_UNAVAILABLE)
      throw new Error('the fiscal provider did not answer about a lot')
    }
    // Only an answer counts as a question asked (an authority that does not answer is retried by the queue and spends no question), and it
    // clears the error of an earlier attempt: the lot is healthy now
    await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingencyBatch.updateMany({
        where: { id: lot.id, organizationId, status: FiscalBatchStatus.RECEIVED },
        data: { consultAttempts: { increment: 1 }, consultedAt: new Date(), lastError: null }
      })
    )
    const next = lot.sendAttempts + lot.consultAttempts + 1
    if (result.state === FiscalBatchConsultState.PENDING) {
      await this.contingencies.enqueueBatchStep(
        organizationId,
        lot.id,
        next,
        FiscalBatchLimits.CONSULT_DELAY_MS
      )
      return FiscalBatchStepResult.WAITING
    }
    const verdicts = this.checkedVerdicts(result.verdicts, request.documents.length)
    if (verdicts === null) {
      await this.fail(organizationId, lot.id, FiscalBatchFailures.PROVIDER_ANSWER_INVALID)
      throw new Error('the fiscal provider gave verdicts that are not the lot')
    }
    for (const verdict of verdicts) {
      const doc = held[verdict.index]
      const document = built[verdict.index]
      if (doc === undefined || document === undefined) continue
      // A document that is decided already (by an earlier step that did not finish) is skipped; one held, or in flight with a lease that is
      // over, takes its verdict (the claim is compared when it is applied)
      if (
        (doc.status as FiscalDocumentStatus) !== FiscalDocumentStatus.QUEUED &&
        (doc.status as FiscalDocumentStatus) !== FiscalDocumentStatus.SUBMITTED
      ) {
        continue
      }
      await this.documents.settleBatchDocument(organizationId, doc.id, lot.id, document, verdict)
    }
    const left = await this.unit(organizationId, () =>
      this.prisma.client.fiscalDocument.count({
        where: {
          organizationId,
          batchId: lot.id,
          status: { in: [FiscalDocumentStatus.QUEUED, FiscalDocumentStatus.SUBMITTED] }
        }
      })
    )
    if (left > 0) {
      // The authority finished and did not give every document a verdict: the lot is asked about again, and says what is wrong
      await this.fail(organizationId, lot.id, FiscalBatchFailures.NO_VERDICT)
      await this.contingencies.enqueueBatchStep(
        organizationId,
        lot.id,
        next,
        FiscalBatchLimits.CONSULT_DELAY_MS
      )
      return FiscalBatchStepResult.WAITING
    }
    const done = await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingencyBatch.updateMany({
        where: { id: lot.id, organizationId, status: FiscalBatchStatus.RECEIVED },
        data: { status: FiscalBatchStatus.PROCESSED, processedAt: new Date(), lastError: null }
      })
    )
    if (done.count === 1) {
      this.audit.log({
        action: AuditAction.FISCAL_BATCH_PROCESSED,
        actor: { system: true },
        organizationId,
        resourceType: FiscalResourceTypes.CONTINGENCY,
        resourceId: lot.contingencyId,
        metadata: { batchId: lot.id, documents: held.length, verdicts: verdicts.length }
      })
    }
    return FiscalBatchStepResult.PROCESSED
  }

  // The verdicts as the lot can use them: each one for a document of the lot, none twice. A provider that breaks it is not believed
  // for any document (a verdict for the wrong one would decide a document the authority never answered for).
  private checkedVerdicts(
    verdicts: readonly FiscalBatchVerdict[],
    documents: number
  ): readonly FiscalBatchVerdict[] | null {
    const seen = new Set<number>()
    for (const verdict of verdicts) {
      if (
        !Number.isInteger(verdict.index) ||
        verdict.index < 0 ||
        verdict.index >= documents ||
        seen.has(verdict.index)
      ) {
        return null
      }
      seen.add(verdict.index)
    }
    return verdicts
  }

  // What stopped the lot on this attempt: a code, never data; kept for whoever reads the lot
  private async fail(
    organizationId: string,
    batchId: string,
    code: string,
    response?: Readonly<Record<string, unknown>>
  ): Promise<void> {
    const stored =
      response === undefined ? undefined : cappedResponse(response, FiscalLimits.RESPONSE_MAX_CHARS)
    await this.unit(organizationId, () =>
      this.prisma.client.fiscalContingencyBatch.updateMany({
        where: { id: batchId, organizationId, status: { not: FiscalBatchStatus.PROCESSED } },
        data: {
          lastError: code.slice(0, 100),
          ...(stored === undefined ? {} : { response: stored })
        }
      })
    )
  }
}
