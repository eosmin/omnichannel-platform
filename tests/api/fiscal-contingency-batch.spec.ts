import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FiscalBatchConsultState,
  FiscalBatchLimits,
  FiscalBatchSendOutcome,
  FiscalBatchStatus,
  FiscalContingencyLimits,
  FiscalContingencyReportOutcome,
  FiscalContingencyStatus,
  FiscalDeferOutcome,
  FiscalDocumentStatus,
  FiscalEnvironment,
  FiscalIssueOn,
  FiscalSubmitOutcome,
  OrderStatus
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { JobNames, processFiscalBatchJobId, QueueNames } from '@platform/core/queues'
import {
  FISCAL_PROVIDERS,
  FiscalBatchService,
  FiscalContingencyService,
  FiscalDocumentsService
} from '@platform/fiscal/runtime'
import type {
  FiscalBatchConsultResult,
  FiscalBatchRequest,
  FiscalBatchSendResult,
  FiscalDocumentProvider
} from '@platform/fiscal/sdk'
import { simulatorProvider } from '@platform/fiscal/simulator'

import { createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

const OK = 200
const HOUR_MS = 3_600_000
const PROVIDER_ID = 'batch-test'
const AUTHORITY_DOWN = 'authority_down'
const RESPONSIBLE = { name: 'Ana Pérez', idType: 'dui', idNumber: '012345678' }

// What the authority under test does, set by each case: how many documents a lot holds, how many lots a contingency may send, and what it
// answers to the send and to the questions about a lot
const control = {
  perBatch: 2,
  maxBatches: 400,
  // The instant the authority "took" the event: now, or a time in the past for the case of a window already closed
  eventTakenAgoMs: 0,
  send: { outcome: FiscalBatchSendOutcome.UNAVAILABLE } as FiscalBatchSendResult,
  consult: (_code: string, _request: FiscalBatchRequest): FiscalBatchConsultResult => ({
    state: FiscalBatchConsultState.UNAVAILABLE
  })
}
const sent: FiscalBatchRequest[] = []
const oneByOne: string[] = []

// The simulator with a deferred model that sends its documents in lots
function batchProvider(): FiscalDocumentProvider {
  const base = simulatorProvider()
  return {
    id: PROVIDER_ID,
    countryCode: base.countryCode,
    manifest: {
      ...base.manifest,
      get contingencyMode() {
        return {
          reasons: [AUTHORITY_DOWN],
          authorityDownReason: AUTHORITY_DOWN,
          transmitWithinHours: 72,
          maxDocumentsPerEvent: 100,
          requiresResponsible: true,
          batch: {
            maxDocumentsPerBatch: control.perBatch,
            maxBatchesPerContingency: control.maxBatches
          }
        }
      }
    },
    validateIssuer: (issuer, credentials) => base.validateIssuer(issuer, credentials),
    validateReceiver: receiver => base.validateReceiver(receiver),
    resolveDocumentType: input => base.resolveDocumentType(input),
    build: input => base.build(input),
    submit: (built, ctx) => {
      oneByOne.push(built.documentType)
      return base.submit(built, ctx)
    },
    consult: (built, ctx) => base.consult(built, ctx),
    void: (doc, reason) => base.void(doc, reason),
    deferDocument: () =>
      Promise.resolve({
        outcome: FiscalDeferOutcome.DEFERRED as const,
        providerData: { signed: 'signed' }
      }),
    reportContingency: () =>
      Promise.resolve({
        outcome: FiscalContingencyReportOutcome.ACCEPTED as const,
        receivedAt: new Date(Date.now() - control.eventTakenAgoMs).toISOString()
      }),
    submitBatch: request => {
      sent.push(request)
      return Promise.resolve(control.send)
    },
    consultBatch: (code, request) => Promise.resolve(control.consult(code, request))
  }
}

describe('The contingency sent in lots (D16)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let documents: FiscalDocumentsService
  let contingencies: FiscalContingencyService
  let batches: FiscalBatchService
  let emitter: EventEmitter2

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(FISCAL_PROVIDERS).useValue([simulatorProvider(), batchProvider()])
    )
    ctx = await seedTestContext(owner, app, prefix)
    documents = app.get(FiscalDocumentsService)
    contingencies = app.get(FiscalContingencyService)
    batches = app.get(FiscalBatchService)
    emitter = app.get(EventEmitter2)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    control.perBatch = 2
    control.maxBatches = 400
    control.eventTakenAgoMs = 0
    control.send = { outcome: FiscalBatchSendOutcome.UNAVAILABLE }
    control.consult = () => ({ state: FiscalBatchConsultState.UNAVAILABLE })
    sent.length = 0
    oneByOne.length = 0
  })

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const jobs = () => queueOf(app, QueueNames.HEAVY_PROCESSING).jobs
  const stepJobs = () => jobs().filter(job => job.name === JobNames.PROCESS_FISCAL_BATCH)
  const row = (id: string) => owner.fiscalDocument.findUniqueOrThrow({ where: { id } })
  const lotRow = (id: string) => owner.fiscalContingencyBatch.findUniqueOrThrow({ where: { id } })
  const lotsOf = (contingencyId: string) =>
    owner.fiscalContingencyBatch.findMany({
      where: { contingencyId },
      orderBy: { sequence: 'asc' }
    })

  async function putIssuer(): Promise<void> {
    const put = await asAdminA()
      .put(ApiRoutes.fiscal.issuer)
      .send({
        providerId: PROVIDER_ID,
        legalName: 'Batch Issuer',
        taxId: 'ISSUER-TAX-ID',
        address: { line1: 'Calle 1', city: 'Ciudad' },
        environment: FiscalEnvironment.SANDBOX,
        issueOn: FiscalIssueOn.DELIVERED,
        credentials: { signingKey: 'not-a-real-signing-key-1234567890' }
      })
    expect(put.status).toBe(OK)
  }

  // A sale delivered in store A: the listener makes its document
  async function sale(): Promise<string> {
    const made = await createOrder(owner, { storeId: ctx.storeA.id })
    await owner.orderItem.update({
      where: { id: made.itemId },
      data: {
        quantity: 2,
        unitPriceCents: 1130,
        taxTreatment: 'taxed',
        taxRateBps: 1300,
        taxCents: 260
      }
    })
    const order = await owner.order.update({
      where: { id: made.id },
      data: {
        status: OrderStatus.DELIVERED,
        subtotalCents: 2260,
        shippingCents: 565,
        totalCents: 2825,
        taxCents: 325,
        pricesIncludeTax: true,
        deliveredAt: new Date()
      },
      select: { id: true, storeId: true, orderNumber: true }
    })
    await emitter.emitAsync(Events.ORDER_STATUS_CHANGED, {
      storeId: order.storeId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      actor: { type: 'system', id: null },
      from: OrderStatus.SHIPPED,
      to: OrderStatus.DELIVERED,
      notifyCustomer: false
    })
    const document = await owner.fiscalDocument.findFirstOrThrow({
      where: { orderId: order.id, organizationId: ctx.orgA.id },
      select: { id: true }
    })
    return document.id
  }

  // A contingency of the issuer with `count` documents kept in it, ended, and its event reported: what the release has to cut into lots
  async function reportedWith(
    count: number
  ): Promise<{ id: string; documentIds: string[]; released: ReturnType<typeof jobs> }> {
    await putIssuer()
    const opened = await asAdminA()
      .post(ApiRoutes.fiscal.contingency.current)
      .send({ reason: AUTHORITY_DOWN })
    const id = (opened.body as { data: { id: string } }).data.id
    const documentIds: string[] = []
    for (let n = 0; n < count; n += 1) {
      const documentId = await sale()
      await documents.submit(ctx.orgA.id, documentId)
      documentIds.push(documentId)
    }
    const ended = await asAdminA()
      .post(ApiRoutes.fiscal.contingency.end)
      .send({ responsible: RESPONSIBLE })
    expect(ended.status).toBe(OK)
    const from = jobs().length
    expect(await contingencies.report(ctx.orgA.id, id)).toBe('reported')
    return { id, documentIds, released: jobs().slice(from) }
  }

  describe('the release of a reported contingency', () => {
    let contingencyId = ''
    let documentIds: string[] = []

    it('cuts the held documents into lots of the size the authority takes, in the order they were made, and queues a job for each lot and none for a document', async () => {
      const made = await reportedWith(5)
      contingencyId = made.id
      documentIds = made.documentIds
      const lots = await lotsOf(contingencyId)
      // 5 documents, 2 a lot: 2, 2 and 1 (a lot is never more than the authority takes, and the last holds what is left)
      expect(lots.map(lot => [lot.sequence, lot.documentCount])).toEqual([
        [1, 2],
        [2, 2],
        [3, 1]
      ])
      const held = await owner.fiscalDocument.findMany({
        where: { contingencyId },
        orderBy: { sequenceNumber: 'asc' },
        select: { id: true, batchId: true }
      })
      expect(held.map(doc => doc.id)).toEqual(documentIds)
      expect(held.map(doc => doc.batchId)).toEqual([
        lots[0]?.id,
        lots[0]?.id,
        lots[1]?.id,
        lots[1]?.id,
        lots[2]?.id
      ])
      const queued = made.released
      expect(queued.filter(job => job.name === JobNames.SUBMIT_FISCAL_DOCUMENT)).toHaveLength(0)
      const steps = queued.filter(job => job.name === JobNames.PROCESS_FISCAL_BATCH)
      expect(steps.map(job => job.opts?.jobId).sort()).toEqual(
        lots.map(lot => processFiscalBatchJobId(lot.id, 0)).sort()
      )
      for (const job of steps) {
        expect(job.opts).toMatchObject({
          attempts: FiscalContingencyLimits.RELEASED_MAX_ATTEMPTS,
          backoff: { type: 'fixed', delay: FiscalContingencyLimits.REPORT_RETRY_DELAY_MS }
        })
      }
      expect(lots.map(lot => lot.status)).toEqual(lots.map(() => String(FiscalBatchStatus.PENDING)))
    })

    it('makes the lots once: a second release finds them and cuts nothing again', async () => {
      const before = (await lotsOf(contingencyId)).map(lot => lot.id)
      expect(await contingencies.report(ctx.orgA.id, contingencyId)).toBe('nothing')
      expect((await lotsOf(contingencyId)).map(lot => lot.id)).toEqual(before)
    })

    it('does not send a document of a lot alone: it asks the lot for its next step instead', async () => {
      const before = stepJobs().length
      await documents.submit(ctx.orgA.id, documentIds[0] as string)
      expect(oneByOne).toHaveLength(0)
      expect((await row(documentIds[0] as string)).status).toBe(FiscalDocumentStatus.QUEUED)
      const asked = stepJobs().slice(before)
      expect(asked).toHaveLength(1)
      const [first] = await lotsOf(contingencyId)
      expect(asked[0]?.data).toEqual({ organizationId: ctx.orgA.id, batchId: first?.id })
    })

    it('sends a lot with its own send id, again with the same id when the authority did not answer, and keeps the code it gives', async () => {
      const [first] = await lotsOf(contingencyId)
      if (first === undefined) throw new Error('no lot')
      control.send = { outcome: FiscalBatchSendOutcome.UNAVAILABLE }
      await expect(batches.process(ctx.orgA.id, first.id)).rejects.toThrow(/did not answer/)
      const failed = await lotRow(first.id)
      expect(failed).toMatchObject({
        status: FiscalBatchStatus.PENDING,
        sendAttempts: 1,
        lastError: 'provider_unavailable',
        batchCode: null
      })
      control.send = { outcome: FiscalBatchSendOutcome.RECEIVED, batchCode: 'CODE-LOT-1' }
      const before = stepJobs().length
      await batches.process(ctx.orgA.id, first.id)
      // The same identifier on both attempts, and the documents as the lot holds them, in order
      expect(sent).toHaveLength(2)
      expect(sent.map(request => request.sendId)).toEqual([first.sendId, first.sendId])
      expect(sent[1]?.documents).toHaveLength(2)
      const received = await lotRow(first.id)
      expect(received).toMatchObject({
        status: FiscalBatchStatus.RECEIVED,
        batchCode: 'CODE-LOT-1',
        sendAttempts: 2,
        lastError: null
      })
      expect(received.sentAt).not.toBeNull()
      // The question comes soon, as a job of the next step
      const next = stepJobs().slice(before)
      expect(next).toHaveLength(1)
      expect(next[0]?.opts).toMatchObject({
        jobId: processFiscalBatchJobId(first.id, 2),
        delay: FiscalBatchLimits.CONSULT_DELAY_MS
      })
    })

    it('refuses a lot as a whole with a code of the authority and keeps asking, never with free text', async () => {
      const lots = await lotsOf(contingencyId)
      const second = lots[1]
      if (second === undefined) throw new Error('no lot')
      control.send = {
        outcome: FiscalBatchSendOutcome.REJECTED,
        reason: 'El receptor Ana Pérez con NIT 0614-010101-101-1 no es válido'
      }
      await expect(batches.process(ctx.orgA.id, second.id)).rejects.toThrow(/refused/)
      const refused = await lotRow(second.id)
      expect(refused.status).toBe(FiscalBatchStatus.PENDING)
      expect(refused.lastError).toBe('lot_refused')
      control.send = { outcome: FiscalBatchSendOutcome.REJECTED, reason: '094' }
      await expect(batches.process(ctx.orgA.id, second.id)).rejects.toThrow(/refused/)
      expect((await lotRow(second.id)).lastError).toBe('094')
    })

    it('waits while the authority has not finished, then gives each document its verdict: accepted with what the authority gave, refused with its code', async () => {
      const [first] = await lotsOf(contingencyId)
      if (first === undefined) throw new Error('no lot')
      control.consult = () => ({ state: FiscalBatchConsultState.PENDING })
      const before = stepJobs().length
      await batches.process(ctx.orgA.id, first.id)
      expect((await lotRow(first.id)).consultAttempts).toBe(1)
      expect(stepJobs().slice(before)[0]?.opts?.delay).toBe(FiscalBatchLimits.CONSULT_DELAY_MS)
      // The lot is asked about with the code and the same documents, in the same order
      control.consult = (code, request) => {
        expect(code).toBe('CODE-LOT-1')
        expect(request.sendId).toBe(first.sendId)
        expect(request.documents).toHaveLength(2)
        return {
          state: FiscalBatchConsultState.DONE,
          verdicts: [
            {
              index: 1,
              outcome: FiscalSubmitOutcome.REJECTED,
              reason: '802',
              response: { codigoMsg: '802' }
            },
            {
              index: 0,
              outcome: FiscalSubmitOutcome.ACCEPTED,
              externalNumber: 'EXT-LOT-1',
              providerData: { seal: 'SEAL-1' }
            }
          ]
        }
      }
      await batches.process(ctx.orgA.id, first.id)
      const [accepted, refused] = await Promise.all(
        [documentIds[0], documentIds[1]].map(id => row(id as string))
      )
      expect(accepted).toMatchObject({
        status: FiscalDocumentStatus.ACCEPTED,
        externalNumber: 'EXT-LOT-1',
        batchId: first.id
      })
      expect(accepted?.providerData).toEqual({ seal: 'SEAL-1' })
      expect(refused).toMatchObject({
        status: FiscalDocumentStatus.REJECTED,
        rejectionReason: '802'
      })
      // A refusal of the authority starts the same 24 hours to correct it as for a document sent alone
      expect(refused?.rejectedAt).not.toBeNull()
      const done = await lotRow(first.id)
      expect(done.status).toBe(FiscalBatchStatus.PROCESSED)
      expect(done.processedAt).not.toBeNull()
      // A finished lot asks nothing more
      const quiet = stepJobs().length
      await batches.process(ctx.orgA.id, first.id)
      expect(stepJobs()).toHaveLength(quiet)
    })

    it('keeps asking for a lot the authority finished without a verdict for every document, and finishes it when it has them', async () => {
      const lots = await lotsOf(contingencyId)
      const second = lots[1]
      if (second === undefined) throw new Error('no lot')
      control.send = { outcome: FiscalBatchSendOutcome.RECEIVED, batchCode: 'CODE-LOT-2' }
      await batches.process(ctx.orgA.id, second.id)
      control.consult = () => ({
        state: FiscalBatchConsultState.DONE,
        verdicts: [
          { index: 0, outcome: FiscalSubmitOutcome.ACCEPTED, externalNumber: 'EXT-LOT-2A' }
        ]
      })
      const before = stepJobs().length
      await batches.process(ctx.orgA.id, second.id)
      const waiting = await lotRow(second.id)
      expect(waiting).toMatchObject({
        status: FiscalBatchStatus.RECEIVED,
        lastError: 'no_verdict'
      })
      expect((await row(documentIds[2] as string)).status).toBe(FiscalDocumentStatus.ACCEPTED)
      expect((await row(documentIds[3] as string)).status).toBe(FiscalDocumentStatus.QUEUED)
      expect(stepJobs().length).toBe(before + 1)
      control.consult = () => ({
        state: FiscalBatchConsultState.DONE,
        verdicts: [
          { index: 0, outcome: FiscalSubmitOutcome.ACCEPTED, externalNumber: 'EXT-LOT-2A' },
          { index: 1, outcome: FiscalSubmitOutcome.ACCEPTED, externalNumber: 'EXT-LOT-2B' }
        ]
      })
      await batches.process(ctx.orgA.id, second.id)
      expect((await lotRow(second.id)).status).toBe(FiscalBatchStatus.PROCESSED)
      expect((await row(documentIds[3] as string)).externalNumber).toBe('EXT-LOT-2B')
      // The document accepted by the first answer was not decided twice
      expect((await row(documentIds[2] as string)).externalNumber).toBe('EXT-LOT-2A')
    })

    it('does not believe verdicts that are not the lot: a place twice or outside it decides nothing', async () => {
      const third = (await lotsOf(contingencyId))[2]
      if (third === undefined) throw new Error('no lot')
      control.send = { outcome: FiscalBatchSendOutcome.RECEIVED, batchCode: 'CODE-LOT-3' }
      await batches.process(ctx.orgA.id, third.id)
      for (const verdicts of [
        [
          { index: 0, outcome: FiscalSubmitOutcome.ACCEPTED as const, externalNumber: 'X' },
          { index: 0, outcome: FiscalSubmitOutcome.ACCEPTED as const, externalNumber: 'Y' }
        ],
        [{ index: 1, outcome: FiscalSubmitOutcome.ACCEPTED as const, externalNumber: 'X' }],
        [{ index: -1, outcome: FiscalSubmitOutcome.ACCEPTED as const, externalNumber: 'X' }]
      ]) {
        control.consult = () => ({ state: FiscalBatchConsultState.DONE, verdicts })
        await expect(batches.process(ctx.orgA.id, third.id)).rejects.toThrow(/not the lot/)
      }
      expect((await row(documentIds[4] as string)).status).toBe(FiscalDocumentStatus.QUEUED)
      expect((await lotRow(third.id)).lastError).toBe('provider_answer_invalid')
    })
  })

  describe('a contingency whose window to send is over, and one that needs more lots than the authority takes', () => {
    it('sends nothing after the window, counted from the seal of the event', async () => {
      // The authority took the event 80 hours ago: the 72 hours are over
      control.eventTakenAgoMs = 80 * HOUR_MS
      const made = await reportedWith(1)
      const [lot] = await lotsOf(made.id)
      if (lot === undefined) throw new Error('no lot')
      control.send = { outcome: FiscalBatchSendOutcome.RECEIVED, batchCode: 'LATE' }
      await batches.process(ctx.orgA.id, lot.id)
      expect(sent).toHaveLength(0)
      expect(await lotRow(lot.id)).toMatchObject({
        status: FiscalBatchStatus.PENDING,
        lastError: 'window_closed',
        batchCode: null
      })
    })

    it('does not cut a lot the authority cannot take', async () => {
      control.perBatch = 1
      control.maxBatches = 2
      await putIssuer()
      const opened = await asAdminA()
        .post(ApiRoutes.fiscal.contingency.current)
        .send({ reason: AUTHORITY_DOWN })
      const id = (opened.body as { data: { id: string } }).data.id
      for (let n = 0; n < 3; n += 1) await documents.submit(ctx.orgA.id, await sale())
      await asAdminA().post(ApiRoutes.fiscal.contingency.end).send({ responsible: RESPONSIBLE })
      await expect(contingencies.report(ctx.orgA.id, id)).rejects.toThrow(/more lots/)
      expect(await lotsOf(id)).toHaveLength(0)
      expect((await owner.fiscalContingency.findUniqueOrThrow({ where: { id } })).status).toBe(
        FiscalContingencyStatus.REPORTED
      )
    })
  })
})
