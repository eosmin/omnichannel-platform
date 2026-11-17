import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FiscalContingencyAlertKind,
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
import { JobNames, QueueNames } from '@platform/core/queues'
import {
  FISCAL_PROVIDERS,
  FiscalContingencyService,
  FiscalDocumentsService
} from '@platform/fiscal/runtime'
import type {
  BuiltDocument,
  FiscalBuildInput,
  FiscalContingencyEvent,
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
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

// What an answer carries: the data of a success and the metadata of a refusal, read once and typed
interface Answer {
  body: unknown
}
interface ContingencyBody {
  id: string
}
const dataOf = (answer: Answer): unknown => (answer.body as { data?: unknown }).data
const viewOf = (answer: Answer): ContingencyBody => dataOf(answer) as ContingencyBody
const metaOf = (answer: Answer): Record<string, unknown> | undefined =>
  (answer.body as { error?: { metadata?: Record<string, unknown> } }).error?.metadata

const PROVIDER_ID = 'contingency-test'
const AUTHORITY_DOWN = 'authority_down'
const REASONS = [AUTHORITY_DOWN, 'issuer_down', 'other']
const WINDOW_HOURS = 72
const RESPONSIBLE = { name: 'Ana Pérez', idType: 'dui', idNumber: '012345678' }

// What the provider under test does, set by each case: the authority is down (a submission is not answered), what the report answers
const control = {
  down: false,
  report: FiscalContingencyReportOutcome.ACCEPTED as FiscalContingencyReportOutcome,
  maxDocuments: 1000,
  // The instant the authority "took" the event
  receivedAt: '2026-11-18T12:00:00.000Z',
  // What the authority says when it refuses the event
  refusal: 'event_refused'
}
const builds: FiscalBuildInput[] = []
const submitted: BuiltDocument[] = []
const reported: FiscalContingencyEvent[] = []

// The simulator with a manifest that declares a deferred model, and an authority that can be told to be down
function contingencyProvider(): FiscalDocumentProvider {
  const base = simulatorProvider()
  return {
    id: PROVIDER_ID,
    countryCode: base.countryCode,
    manifest: {
      ...base.manifest,
      get contingencyMode() {
        return {
          reasons: REASONS,
          authorityDownReason: AUTHORITY_DOWN,
          transmitWithinHours: WINDOW_HOURS,
          maxDocumentsPerEvent: control.maxDocuments,
          requiresResponsible: true
        }
      }
    },
    validateIssuer: (issuer, credentials) => base.validateIssuer(issuer, credentials),
    validateReceiver: receiver => base.validateReceiver(receiver),
    resolveDocumentType: input => base.resolveDocumentType(input),
    build: input => {
      builds.push(input)
      return base.build(input)
    },
    submit: (built, ctx) => {
      if (control.down)
        return Promise.resolve({ outcome: FiscalSubmitOutcome.UNAVAILABLE as const })
      submitted.push(built)
      return base.submit(built, ctx)
    },
    consult: (built, ctx) => base.consult(built, ctx),
    void: (doc, reason) => base.void(doc, reason),
    deferDocument: built =>
      Promise.resolve({
        outcome: FiscalDeferOutcome.DEFERRED as const,
        providerData: { signed: `signed-${String(built.documentType)}` }
      }),
    reportContingency: event => {
      reported.push(event)
      if (control.report === FiscalContingencyReportOutcome.UNAVAILABLE) {
        return Promise.resolve({ outcome: FiscalContingencyReportOutcome.UNAVAILABLE as const })
      }
      if (control.report === FiscalContingencyReportOutcome.REJECTED) {
        return Promise.resolve({
          outcome: FiscalContingencyReportOutcome.REJECTED as const,
          reason: control.refusal
        })
      }
      return Promise.resolve({
        outcome: FiscalContingencyReportOutcome.ACCEPTED as const,
        receivedAt: control.receivedAt,
        providerData: { seal: 'event-seal' }
      })
    }
  }
}

describe('The contingency of the fiscal documents (Step 4B.7c-7)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let documents: FiscalDocumentsService
  let contingencies: FiscalContingencyService
  let emitter: EventEmitter2
  const alerts: {
    organizationId: string
    contingencyId: string
    kind: FiscalContingencyAlertKind
  }[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(FISCAL_PROVIDERS)
        .useValue([simulatorProvider(), contingencyProvider()])
    )
    ctx = await seedTestContext(owner, app, prefix)
    documents = app.get(FiscalDocumentsService)
    contingencies = app.get(FiscalContingencyService)
    emitter = app.get(EventEmitter2)
    emitter.on(Events.FISCAL_CONTINGENCY_ALERT, payload => {
      alerts.push(payload as (typeof alerts)[number])
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    control.down = false
    control.report = FiscalContingencyReportOutcome.ACCEPTED
    control.maxDocuments = 1000
    control.refusal = 'event_refused'
    alerts.length = 0
  })

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const jobs = () => queueOf(app, QueueNames.HEAVY_PROCESSING).jobs
  const putIssuer = (providerId: string) =>
    asAdminA()
      .put(ApiRoutes.fiscal.issuer)
      .send({
        providerId,
        legalName: 'Contingency Issuer',
        taxId: 'ISSUER-TAX-ID',
        address: { line1: 'Calle 1', city: 'Ciudad' },
        environment: FiscalEnvironment.SANDBOX,
        issueOn: FiscalIssueOn.DELIVERED,
        credentials: { signingKey: 'not-a-real-signing-key-1234567890' }
      })
  const enter = (body: Record<string, unknown> = { reason: AUTHORITY_DOWN }) =>
    asAdminA().post(ApiRoutes.fiscal.contingency.current).send(body)
  const end = (body: Record<string, unknown> = { responsible: RESPONSIBLE }) =>
    asAdminA().post(ApiRoutes.fiscal.contingency.end).send(body)
  const row = (id: string) => owner.fiscalDocument.findUniqueOrThrow({ where: { id } })
  const contingencyRow = (id: string) =>
    owner.fiscalContingency.findUniqueOrThrow({ where: { id } })

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

  describe('who may ask, and for what', () => {
    it('refuses a provider with no deferred model', async () => {
      expect((await putIssuer(simulatorProvider().id)).status).toBe(OK)
      const refused = await enter()
      expect(refused.status).toBe(CONFLICT)
      expect(metaOf(refused)).toMatchObject({ reason: 'contingency_unsupported' })
    })

    it('refuses a reason the provider does not know, and an end with nobody open', async () => {
      expect((await putIssuer(PROVIDER_ID)).status).toBe(OK)
      const unknown = await enter({ reason: 'meteor' })
      expect(unknown.status).toBe(BAD_REQUEST)
      expect(metaOf(unknown)).toMatchObject({ reason: 'contingency_unknown_reason' })
      const none = await end()
      expect(none.status).toBe(CONFLICT)
      expect(metaOf(none)).toMatchObject({ reason: 'contingency_not_open' })
    })

    it('needs the permission to manage, and the one to view for the reads', async () => {
      const asViewer = (method: 'get' | 'post', path: string) =>
        api(app, ctx.viewerA, ctx.storeA)[method](path)
      expect(
        (
          await asViewer('post', ApiRoutes.fiscal.contingency.current).send({
            reason: AUTHORITY_DOWN
          })
        ).status
      ).toBe(FORBIDDEN)
      expect((await asViewer('post', ApiRoutes.fiscal.contingency.end).send({})).status).toBe(
        FORBIDDEN
      )
      expect(
        (await asViewer('post', ApiRoutes.fiscal.contingency.report('x')).send({})).status
      ).toBe(FORBIDDEN)
      expect(
        (await api(app, ctx.agentA, ctx.storeA).get(ApiRoutes.fiscal.contingency.list)).status
      ).toBe(FORBIDDEN)
    })
  })

  describe('a contingency from start to report', () => {
    let contingencyId = ''
    let heldId = ''
    let secondId = ''

    it('opens once for the organization, and tells who and why', async () => {
      const opened = await enter({ reason: AUTHORITY_DOWN, motive: '  La autoridad no responde  ' })
      expect(opened.status).toBe(CREATED)
      contingencyId = viewOf(opened).id
      expect(dataOf(opened)).toMatchObject({
        status: FiscalContingencyStatus.OPEN,
        origin: 'user',
        reason: AUTHORITY_DOWN,
        motive: 'La autoridad no responde',
        documents: 0
      })
      const again = await enter()
      expect(again.status).toBe(CONFLICT)
      expect(metaOf(again)).toMatchObject({ reason: 'contingency_already_open' })
      expect(viewOf(await asAdminA().get(ApiRoutes.fiscal.contingency.current)).id).toBe(
        contingencyId
      )
    })

    it('makes a document in the deferred model, keeps it signed and does not send it', async () => {
      heldId = await sale()
      builds.length = 0
      submitted.length = 0
      await documents.submit(ctx.orgA.id, heldId)
      const held = await row(heldId)
      expect(held.status).toBe(FiscalDocumentStatus.QUEUED)
      expect(held.contingencyId).toBe(contingencyId)
      expect(held.builtPayloadEncrypted).not.toBeNull()
      expect(held.attempts).toBe(0)
      expect(JSON.stringify(held.providerData)).toContain('signed')
      expect(builds.at(-1)?.contingency).toEqual({
        reason: AUTHORITY_DOWN,
        motive: 'La autoridad no responde'
      })
      expect(submitted).toHaveLength(0)
      // A second attempt finds it held and does nothing: nothing is built or sent
      builds.length = 0
      await documents.submit(ctx.orgA.id, heldId)
      expect(builds).toHaveLength(0)
      expect(submitted).toHaveLength(0)
      expect((await row(heldId)).status).toBe(FiscalDocumentStatus.QUEUED)
    })

    it('does not let the receiver of a kept document change, and does not count it as stalled', async () => {
      const patched = await asAdminA()
        .patch(ApiRoutes.fiscal.documents.receiver(heldId))
        .send({ name: 'Otro' })
      expect(patched.status).toBe(CONFLICT)
      const sweep = await asAdminA().get(`${ApiRoutes.fiscal.reconciliation}?kind=stalled_document`)
      expect(sweep.status).toBe(OK)
      expect((dataOf(sweep) as { id: string }[]).map(item => item.id)).not.toContain(heldId)
    })

    it('asks for the person who answers for the establishment when it ends, and queues the report', async () => {
      secondId = await sale()
      await documents.submit(ctx.orgA.id, secondId)
      const missing = await end({})
      expect(missing.status).toBe(BAD_REQUEST)
      expect(metaOf(missing)).toMatchObject({
        reason: 'contingency_responsible_required'
      })
      const before = jobs().length
      const ended = await end()
      expect(ended.status).toBe(OK)
      expect(dataOf(ended)).toMatchObject({
        status: FiscalContingencyStatus.CLOSED,
        documents: 2
      })
      const queued = jobs()
        .slice(before)
        .filter(job => job.name === JobNames.REPORT_FISCAL_CONTINGENCY)
      expect(queued).toHaveLength(1)
      expect(queued[0]?.data).toEqual({ organizationId: ctx.orgA.id, contingencyId })
      // The responsible is sealed: not in the row in the clear
      const sealed = await contingencyRow(contingencyId)
      expect(JSON.stringify(sealed)).not.toContain('012345678')
      // A document made now is not in it: no contingency is open
      expect(dataOf(await asAdminA().get(ApiRoutes.fiscal.contingency.current))).toBeNull()
    })

    it('keeps the report asked again when the authority does not answer, and tells a person when it is refused', async () => {
      control.report = FiscalContingencyReportOutcome.UNAVAILABLE
      await expect(contingencies.report(ctx.orgA.id, contingencyId)).rejects.toThrow(
        /did not answer/
      )
      expect((await contingencyRow(contingencyId)).reportAttempts).toBe(1)
      control.report = FiscalContingencyReportOutcome.REJECTED
      // Free text (it may carry the data of a document) is not kept as the reason: only a code is
      control.refusal = 'El receptor Ana Pérez con NIT 0614-010101-101-1 no es válido'
      expect(await contingencies.report(ctx.orgA.id, contingencyId)).toBe('refused')
      const refused = await contingencyRow(contingencyId)
      expect(refused).toMatchObject({
        status: FiscalContingencyStatus.CLOSED,
        lastReportError: 'rejected',
        reportAttempts: FiscalContingencyLimits.REPORT_MAX_ATTEMPTS
      })
      expect(JSON.stringify(refused.lastReportError)).not.toContain('Ana')
      // A second refusal of the same contingency says the same thing and tells nobody again
      expect(await contingencies.report(ctx.orgA.id, contingencyId)).toBe('refused')
      expect(
        alerts.filter(alert => alert.kind === FiscalContingencyAlertKind.REPORT_FAILED)
      ).toHaveLength(1)
      expect(alerts).toContainEqual({
        organizationId: ctx.orgA.id,
        contingencyId,
        kind: FiscalContingencyAlertKind.REPORT_FAILED
      })
      // Documents are still held
      expect((await row(heldId)).status).toBe(FiscalDocumentStatus.QUEUED)
      expect(submitted).toHaveLength(0)
    })

    it('asks again for the report when a person says so, from the start of its attempts', async () => {
      const before = jobs().length
      const again = await asAdminA()
        .post(ApiRoutes.fiscal.contingency.report(contingencyId))
        .send({})
      expect(again.status).toBe(OK)
      expect(dataOf(again)).toMatchObject({ reportAttempts: 0, lastReportError: null })
      expect(
        jobs()
          .slice(before)
          .filter(job => job.name === JobNames.REPORT_FISCAL_CONTINGENCY)
      ).toHaveLength(1)
    })

    it('reports the event with the documents, opens the window and releases them to the queue', async () => {
      control.report = FiscalContingencyReportOutcome.ACCEPTED
      reported.length = 0
      const before = jobs().length
      expect(await contingencies.report(ctx.orgA.id, contingencyId)).toBe('reported')
      const taken = await contingencyRow(contingencyId)
      expect(taken.status).toBe(FiscalContingencyStatus.REPORTED)
      expect(taken.windowEndsAt?.toISOString()).toBe('2026-11-21T12:00:00.000Z')
      expect(taken.providerData).toEqual({ seal: 'event-seal' })
      expect(reported).toHaveLength(1)
      expect(reported[0]).toMatchObject({
        eventId: taken.eventCode,
        reason: AUTHORITY_DOWN,
        motive: 'La autoridad no responde',
        responsible: RESPONSIBLE
      })
      expect(reported[0]?.documents).toHaveLength(2)
      const released = jobs()
        .slice(before)
        .filter(job => job.name === JobNames.SUBMIT_FISCAL_DOCUMENT)
        .map(job => (job.data as { documentId: string }).documentId)
      expect(released.sort()).toEqual([heldId, secondId].sort())
      // A second report of the same contingency does nothing more
      reported.length = 0
      expect(await contingencies.report(ctx.orgA.id, contingencyId)).toBe('nothing')
      expect(reported).toHaveLength(0)
    })

    it('sends the document as it was kept, and the authority accepts it', async () => {
      builds.length = 0
      submitted.length = 0
      const kept = await row(heldId)
      await documents.submit(ctx.orgA.id, heldId)
      // Not made again: what the receiver was handed is what is sent
      expect(builds).toHaveLength(0)
      expect(submitted).toHaveLength(1)
      expect(submitted[0]?.documentType).toBe(kept.documentType)
      const accepted = await row(heldId)
      expect(accepted.status).toBe(FiscalDocumentStatus.ACCEPTED)
      expect(accepted.contingencyId).toBe(contingencyId)
      // An accepted document keeps its contingency for ever (the database says it)
      await expect(
        owner.fiscalDocument.update({ where: { id: heldId }, data: { contingencyId: null } })
      ).rejects.toThrow(/immutable/)
    })

    it('tells a person once when the window is closing and a document is still waiting', async () => {
      const early = new Date('2026-11-19T00:00:00.000Z')
      expect(await contingencies.warnWindows(ctx.orgA.id, early)).toBe(0)
      const late = new Date('2026-11-21T00:00:00.000Z')
      expect(await contingencies.warnWindows(ctx.orgA.id, late)).toBe(1)
      expect(alerts).toContainEqual({
        organizationId: ctx.orgA.id,
        contingencyId,
        kind: FiscalContingencyAlertKind.WINDOW_CLOSING
      })
      expect(await contingencies.warnWindows(ctx.orgA.id, late)).toBe(0)
      await documents.submit(ctx.orgA.id, secondId)
    })

    it('never deletes a contingency, never moves it back and never opens a second one', async () => {
      await expect(
        owner.fiscalContingency.delete({ where: { id: contingencyId } })
      ).rejects.toThrow(/never deleted/)
      await expect(
        owner.fiscalContingency.update({
          where: { id: contingencyId },
          data: { status: FiscalContingencyStatus.CLOSED, reportedAt: null, windowEndsAt: null }
        })
      ).rejects.toThrow()
      expect((await enter()).status).toBe(CREATED)
      await expect(
        owner.fiscalContingency.create({
          data: {
            organizationId: ctx.orgA.id,
            providerId: PROVIDER_ID,
            environment: FiscalEnvironment.SANDBOX,
            status: FiscalContingencyStatus.OPEN,
            origin: 'user',
            reason: AUTHORITY_DOWN,
            eventCode: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
            startedAt: new Date()
          }
        })
      ).rejects.toThrow(/unique/i)
      // An empty contingency has nothing to report and no job
      const before = jobs().length
      expect((await end()).status).toBe(OK)
      expect(
        jobs()
          .slice(before)
          .filter(job => job.name === JobNames.REPORT_FISCAL_CONTINGENCY)
      ).toHaveLength(0)
    })
  })

  describe('a contingency the lifecycle opens by itself', () => {
    it('opens after the attempts that find the authority down, tells a person, and keeps the document in it', async () => {
      control.down = true
      const id = await sale()
      for (
        let attempt = 1;
        attempt < FiscalContingencyLimits.AUTO_OPEN_AFTER_ATTEMPTS;
        attempt += 1
      ) {
        await expect(documents.submit(ctx.orgA.id, id)).rejects.toThrow(/did not answer/)
        expect((await row(id)).contingencyId).toBeNull()
      }
      await documents.submit(ctx.orgA.id, id)
      const kept = await row(id)
      expect(kept.status).toBe(FiscalDocumentStatus.QUEUED)
      expect(kept.contingencyId).not.toBeNull()
      const opened = await contingencyRow(kept.contingencyId ?? '')
      expect(opened).toMatchObject({
        status: FiscalContingencyStatus.OPEN,
        origin: 'system',
        reason: AUTHORITY_DOWN,
        openedBy: null
      })
      expect(alerts).toContainEqual({
        organizationId: ctx.orgA.id,
        contingencyId: opened.id,
        kind: FiscalContingencyAlertKind.OPENED_BY_SYSTEM
      })
      // The next documents are made in it at once, with no attempts at the authority
      const next = await sale()
      submitted.length = 0
      await documents.submit(ctx.orgA.id, next)
      expect((await row(next)).contingencyId).toBe(opened.id)
      expect(submitted).toHaveLength(0)
    })

    it('holds a document back, and fails its job, when the open contingency holds the most an event takes', async () => {
      const open = await owner.fiscalContingency.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, status: FiscalContingencyStatus.OPEN }
      })
      const held = await owner.fiscalDocument.count({ where: { contingencyId: open.id } })
      control.maxDocuments = held
      const id = await sale()
      await expect(documents.submit(ctx.orgA.id, id)).rejects.toThrow(
        /most documents an event takes/
      )
      const full = await row(id)
      expect(full.contingencyId).toBeNull()
      expect(full.status).toBe(FiscalDocumentStatus.QUEUED)
    })
  })

  describe('the daily check', () => {
    it('asks again, with one job for each day, for an ended contingency whose report is owed', async () => {
      // The ones of the cases above are not open any more: this one is ended with a document in it and never reported
      expect((await end()).status).toBe(OK)
      const open = await enter()
      expect(open.status).toBe(CREATED)
      const id = await sale()
      await documents.submit(ctx.orgA.id, id)
      expect((await row(id)).contingencyId).toBe(viewOf(open).id)
      expect((await end()).status).toBe(OK)
      expect(await contingencies.unreported(ctx.orgA.id)).toContain(viewOf(open).id)
      const before = jobs().length
      const day = new Date('2026-11-18T03:00:00.000Z')
      await contingencies.askReport(ctx.orgA.id, viewOf(open).id, day)
      await contingencies.askReport(
        ctx.orgA.id,
        viewOf(open).id,
        new Date('2026-11-18T21:00:00.000Z')
      )
      const asked = jobs().slice(before)
      // One job for a contingency, however it is asked: a second one never runs beside the first
      expect(asked.map(job => job.opts?.jobId)).toEqual([
        `${JobNames.REPORT_FISCAL_CONTINGENCY}-${viewOf(open).id}-1`,
        `${JobNames.REPORT_FISCAL_CONTINGENCY}-${viewOf(open).id}-1`
      ])
      // One that was refused or ran out of attempts is not asked again by the night: a person asks
      await owner.fiscalContingency.update({
        where: { id: viewOf(open).id },
        data: { reportAttempts: FiscalContingencyLimits.REPORT_MAX_ATTEMPTS }
      })
      expect(await contingencies.unreported(ctx.orgA.id)).not.toContain(viewOf(open).id)
    })
  })

  describe('a report that cannot go through', () => {
    it('lets a person give it up: the documents leave the contingency and go out the normal way', async () => {
      // None may be open here, or one the cases above left: either way the next one starts clean
      await end()
      const opened = await enter()
      expect(opened.status).toBe(CREATED)
      const id = await sale()
      await documents.submit(ctx.orgA.id, id)
      expect((await row(id)).contingencyId).toBe(viewOf(opened).id)
      expect((await end()).status).toBe(OK)
      control.report = FiscalContingencyReportOutcome.REJECTED
      expect(await contingencies.report(ctx.orgA.id, viewOf(opened).id)).toBe('refused')
      // Held for good: nothing moves it by itself
      expect((await row(id)).status).toBe(FiscalDocumentStatus.QUEUED)
      expect(await contingencies.unreported(ctx.orgA.id)).not.toContain(viewOf(opened).id)

      const before = jobs().length
      const given = await asAdminA()
        .post(ApiRoutes.fiscal.contingency.abandon(viewOf(opened).id))
        .send({})
      expect(given.status).toBe(OK)
      expect(dataOf(given)).toMatchObject({ status: FiscalContingencyStatus.CLOSED, documents: 0 })
      expect((await row(id)).contingencyId).toBeNull()
      const queued = jobs()
        .slice(before)
        .filter(job => job.name === JobNames.SUBMIT_FISCAL_DOCUMENT)
        .map(job => (job.data as { documentId: string }).documentId)
      expect(queued).toEqual([id])
      // It is sent the normal way: built again, in the previous model, and accepted
      builds.length = 0
      control.report = FiscalContingencyReportOutcome.ACCEPTED
      await documents.submit(ctx.orgA.id, id)
      expect(builds.at(-1)?.contingency).toBeUndefined()
      expect((await row(id)).status).toBe(FiscalDocumentStatus.ACCEPTED)
      // A second time there is nothing to give up, and a reported one is not given up
      expect((await contingencyRow(viewOf(opened).id)).status).toBe(FiscalContingencyStatus.CLOSED)
      const reported = await owner.fiscalContingency.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id, status: FiscalContingencyStatus.REPORTED }
      })
      const refused = await asAdminA()
        .post(ApiRoutes.fiscal.contingency.abandon(reported.id))
        .send({})
      expect(refused.status).toBe(CONFLICT)
      expect(metaOf(refused)).toMatchObject({ reason: 'contingency_not_closed' })
    })

    it('does not reset or give up a report that has not failed', async () => {
      // None may be open here, or one the cases above left: either way the next one starts clean
      await end()
      const opened = await enter()
      const id = await sale()
      await documents.submit(ctx.orgA.id, id)
      expect((await end()).status).toBe(OK)
      // Ended and waiting for its report: nothing failed, so nothing is asked again or given up under it
      const again = await asAdminA()
        .post(ApiRoutes.fiscal.contingency.report(viewOf(opened).id))
        .send({})
      expect(again.status).toBe(CONFLICT)
      expect(metaOf(again)).toMatchObject({ reason: 'contingency_report_not_failed' })
      const given = await asAdminA()
        .post(ApiRoutes.fiscal.contingency.abandon(viewOf(opened).id))
        .send({})
      expect(given.status).toBe(CONFLICT)
      expect(metaOf(given)).toMatchObject({ reason: 'contingency_report_not_failed' })
      expect((await row(id)).contingencyId).toBe(viewOf(opened).id)
      // Report it so it does not stay in the way of the cases that follow
      expect(await contingencies.report(ctx.orgA.id, viewOf(opened).id)).toBe('reported')
    })

    it('can always be ended, even when the issuer left the provider it was opened with', async () => {
      const opened = await enter()
      expect(opened.status).toBe(CREATED)
      expect((await putIssuer(simulatorProvider().id)).status).toBe(OK)
      // The rule is the one of the provider the contingency was opened with, not of the issuer of today
      const missing = await end({})
      expect(missing.status).toBe(BAD_REQUEST)
      expect(metaOf(missing)).toMatchObject({ reason: 'contingency_responsible_required' })
      expect((await end()).status).toBe(OK)
      expect((await contingencyRow(viewOf(opened).id)).status).toBe(FiscalContingencyStatus.CLOSED)
      expect((await putIssuer(PROVIDER_ID)).status).toBe(OK)
    })
  })

  describe('a contingency that is open for another environment', () => {
    it('does not take the document, and the lifecycle does not call itself for ever', async () => {
      await owner.fiscalContingency.updateMany({
        where: { organizationId: ctx.orgA.id, status: FiscalContingencyStatus.OPEN },
        data: { status: FiscalContingencyStatus.CLOSED, endedAt: new Date() }
      })
      const foreign = await owner.fiscalContingency.create({
        data: {
          organizationId: ctx.orgA.id,
          providerId: PROVIDER_ID,
          environment: FiscalEnvironment.PRODUCTION,
          status: FiscalContingencyStatus.OPEN,
          origin: 'user',
          reason: AUTHORITY_DOWN,
          eventCode: 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2',
          startedAt: new Date()
        }
      })
      control.down = true
      const id = await sale()
      for (
        let attempt = 0;
        attempt < FiscalContingencyLimits.AUTO_OPEN_AFTER_ATTEMPTS + 1;
        attempt += 1
      ) {
        await expect(documents.submit(ctx.orgA.id, id)).rejects.toThrow(/did not answer/)
      }
      expect((await row(id)).contingencyId).toBeNull()
      expect(await owner.fiscalContingency.count({ where: { id: foreign.id } })).toBe(1)
      await owner.fiscalContingency.update({
        where: { id: foreign.id },
        data: { status: FiscalContingencyStatus.CLOSED, endedAt: new Date() }
      })
    })
  })

  describe('another organization', () => {
    it('sees none of it, and cannot end it, report it or read it by id', async () => {
      const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
      const current = await asAdminB().get(ApiRoutes.fiscal.contingency.current)
      expect(current.status).toBe(OK)
      expect(dataOf(current)).toBeNull()
      const listed = await asAdminB().get(ApiRoutes.fiscal.contingency.list)
      expect(dataOf(listed)).toEqual([])
      const open = await owner.fiscalContingency.findFirstOrThrow({
        where: { organizationId: ctx.orgA.id }
      })
      expect(
        (await asAdminB().post(ApiRoutes.fiscal.contingency.report(open.id)).send({})).status
      ).toBe(NOT_FOUND)
      const heldBefore = await owner.fiscalDocument.count({ where: { contingencyId: open.id } })
      expect(
        (await asAdminB().post(ApiRoutes.fiscal.contingency.abandon(open.id)).send({})).status
      ).toBe(NOT_FOUND)
      // Nothing of organization A was detached by it
      expect(await owner.fiscalDocument.count({ where: { contingencyId: open.id } })).toBe(
        heldBefore
      )
      await expect(contingencies.get(ctx.orgB.id, open.id)).rejects.toThrow(/not found/)
      expect(await contingencies.report(ctx.orgB.id, open.id)).toBe('nothing')
      expect(
        (await asAdminB().post(ApiRoutes.fiscal.contingency.end).send({ responsible: RESPONSIBLE }))
          .status
      ).not.toBe(OK)
      expect((await contingencyRow(open.id)).status).toBe(open.status)
    })
  })
})
