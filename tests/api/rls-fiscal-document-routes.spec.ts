import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { RoleNames } from '@platform/core/auth'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, ensureMembership, type OwnerClient } from '@platform/core/database-testing'
import {
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalEnvironment,
  FiscalIssueOn,
  FiscalRejectionReasons,
  FiscalSweepKind,
  FiscalSweepLimits,
  FiscalVoidConsultState,
  FiscalVoidKind,
  OrderReturnStatus,
  OrderStatus
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { QueueNames } from '@platform/core/queues'
import {
  FISCAL_PROVIDERS,
  FiscalDocumentsService,
  FiscalSweepService
} from '@platform/fiscal/runtime'
import type { FiscalDocumentProvider } from '@platform/fiscal/sdk'
import { SIMULATOR_PROVIDER_ID, simulatorProvider } from '@platform/fiscal/simulator'

import { FiscalSubmissionQueue } from '../../apps/api/src/modules/fiscal/fiscal-submission.queue'
import { createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api, type TestAgent } from '../helpers/http'
import { queueOf } from '../helpers/queue'

type Client = TestAgent

// The answer without the id of the request, which is different every time
const errorOf = (answer: { body: unknown }): unknown => (answer.body as { error: unknown }).error

const OK = 200
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const ASKS_PROVIDER_ID = 'rls-fiscal-routes-test'
const REMEMBERS_PROVIDER_ID = 'rls-fiscal-routes-remembers'
const MINUTE_MS = 60_000
const SERVER_ERROR = 500
const SECRET = 'not-a-real-signing-key-1234567890'
const RECEIVER_TAX_ID = '0614-010101-101-1'

// The simulator with a manifest that says its authority asks for the replacement before an invalidation (what a real provider declares)
function asksProvider(): FiscalDocumentProvider {
  const base = simulatorProvider()
  return Object.create(base, {
    id: { value: ASKS_PROVIDER_ID, enumerable: true },
    manifest: {
      enumerable: true,
      value: {
        ...base.manifest,
        voidInputs: {
          kinds: [FiscalVoidKind.CORRECTION, FiscalVoidKind.RESCISSION],
          requiresParties: false,
          kindsWithReplacement: [FiscalVoidKind.CORRECTION]
        }
      }
    }
  }) as FiscalDocumentProvider
}

// The simulator is stateless: a document it invalidated is a document it knows nothing about when it is asked again. This one remembers
// what it invalidated, as an authority does, and counts the invalidations it received (the key of a request is the same for the same
// invalidation), so a test can say that a request asked again after a failure reached the authority ONCE.
const received: string[] = []
function remembersProvider(): FiscalDocumentProvider {
  const base: FiscalDocumentProvider = simulatorProvider()
  const known = new Set<string>()
  return Object.create(base, {
    id: { value: REMEMBERS_PROVIDER_ID, enumerable: true },
    void: {
      enumerable: true,
      value: (...args: Parameters<FiscalDocumentProvider['void']>) => {
        const key = args[2].idempotencyKey
        received.push(key)
        known.add(key)
        return base.void(...args)
      }
    },
    consultVoid: {
      enumerable: true,
      value: (...args: Parameters<NonNullable<FiscalDocumentProvider['consultVoid']>>) =>
        known.has(args[1].idempotencyKey)
          ? Promise.resolve({
              state: FiscalVoidConsultState.VOIDED,
              response: { voided: true, recovered: true }
            })
          : base.consultVoid?.(...args)
    }
  }) as FiscalDocumentProvider
}

// A fiscal document belongs to the organization in the data but to the store of its sale in its rows. The request of a person who works
// in store A2 on a document of store A (they hold the permission in both) arrives with the context of A2 alone; the trigger of the
// document (`check_fiscal_document_scope`, not SECURITY DEFINER) reads the orders, returns and documents of the store of the DOCUMENT, so
// the five routes of a person must open the context of the organization. The app is the real one, on the role of the api, with the switch
// on and a context required for every query.
// The provider the issuer uses, kept to count what the authority is asked
const simulator = simulatorProvider()

describe('RLS phase 6 (F6-3): the fiscal routes of a person on a document of a sibling store', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  let documents: FiscalDocumentsService
  let emitter: EventEmitter2
  let both: Actor
  let onlyA2: Actor
  let agentInA2: Actor

  beforeAll(async () => {
    owner = ownerClient()
    guarded = new PrismaService({
      databaseUrl: connectionUrls().app,
      poolSize: 8,
      requireContext: true
    })
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(PrismaService)
        .useValue(guarded)
        .overrideProvider(RLS_CONTEXT_ENABLED)
        .useValue(true)
        .overrideProvider(FISCAL_PROVIDERS)
        .useValue([simulator, asksProvider(), remembersProvider()])
    )
    ctx = await seedTestContext(owner, app, prefix)
    documents = app.get(FiscalDocumentsService)
    emitter = app.get(EventEmitter2)
    // Manages the fiscal documents in A and in A2
    both = await createActor(owner, app, {
      prefix,
      name: `both${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.ADMIN]
    })
    await ensureMembership(owner, {
      userId: both.id,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA2.id,
      roleId: ctx.roleIds[RoleNames.ADMIN]
    })
    // Manages them in A2 only: a document of A does not exist for them
    onlyA2 = await createActor(owner, app, {
      prefix,
      name: `onlya2${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA2.id,
      roleId: ctx.roleIds[RoleNames.ADMIN]
    })
    // Manages them in A, but is an agent in A2, where the request is made
    agentInA2 = await createActor(owner, app, {
      prefix,
      name: `agent${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.ADMIN]
    })
    await ensureMembership(owner, {
      userId: agentInA2.id,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA2.id,
      roleId: ctx.roleIds[RoleNames.AGENT]
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await guarded.onModuleDestroy()
    await owner.$disconnect()
  })

  // A failed assertion must not leave a spy or a count for the cases that follow
  beforeEach(() => {
    received.length = 0
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  const asAdminA = () => api(app, ctx.adminA, ctx.storeA)
  const fromA2 = (actor: Actor) => api(app, actor, ctx.storeA2)

  const useIssuer = async (providerId: string, legalName = 'Routes Issuer') => {
    const answer = await asAdminA()
      .put(ApiRoutes.fiscal.issuer)
      .send({
        providerId,
        legalName,
        taxId: 'ISSUER-TAX-ID',
        address: { line1: 'Calle 1', city: 'Ciudad' },
        environment: FiscalEnvironment.SANDBOX,
        issueOn: FiscalIssueOn.DELIVERED,
        credentials: { signingKey: SECRET }
      })
    expect(answer.status).toBe(OK)
  }

  // A delivered order of store A: its sale document is made by the event
  async function sale(options: { taxId?: string; accept?: boolean } = {}) {
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
      where: { orderId: order.id, kind: FiscalDocumentKind.SALE },
      select: { id: true }
    })
    if (options.taxId !== undefined) {
      const fix = await asAdminA()
        .patch(ApiRoutes.fiscal.documents.receiver(document.id))
        .send({ taxId: options.taxId, name: 'Ana Receiver' })
      expect(fix.status).toBe(OK)
    }
    if (options.accept === true) await documents.submit(ctx.orgA.id, document.id)
    return document.id
  }
  const row = (id: string) => owner.fiscalDocument.findUniqueOrThrow({ where: { id } })

  describe('a person who manages the documents in A and in A2, with the header of A2', () => {
    it('fixes the receiver of a document of A', async () => {
      await useIssuer(SIMULATOR_PROVIDER_ID)
      const id = await sale()
      const answer = await fromA2(both)
        .patch(ApiRoutes.fiscal.documents.receiver(id))
        .send({ taxId: RECEIVER_TAX_ID, name: 'Ana Receiver' })
      expect(answer.status).toBe(OK)
    })

    it('retries a document of A that the authority refused', async () => {
      await useIssuer(SIMULATOR_PROVIDER_ID)
      const id = await sale({ taxId: 'REJECT', accept: true })
      expect((await row(id)).status).toBe(FiscalDocumentStatus.REJECTED)
      const answer = await fromA2(both).post(ApiRoutes.fiscal.documents.retry(id))
      expect(answer.status).toBe(OK)
      expect((await row(id)).status).toBe(FiscalDocumentStatus.QUEUED)
    })

    it('confirms the change of issuer of a document of A', async () => {
      await useIssuer(SIMULATOR_PROVIDER_ID)
      const id = await sale({ taxId: 'UNAVAILABLE-3' })
      // An attempt that the authority did not answer, then the issuer changes its identity
      await expect(documents.submit(ctx.orgA.id, id)).rejects.toThrow()
      await useIssuer(SIMULATOR_PROVIDER_ID, 'Moved Issuer')
      await documents.submit(ctx.orgA.id, id)
      const stuck = await row(id)
      expect(stuck.rejectionReason).toBe(FiscalRejectionReasons.ISSUER_CHANGED)
      const answer = await fromA2(both)
        .post(ApiRoutes.fiscal.documents.confirmIssuerChange(id))
        .send({ reason: 'checked with the authority: not there' })
      expect(answer.status).toBe(OK)
      const again = await row(id)
      expect(again.status).toBe(FiscalDocumentStatus.QUEUED)
      expect(again.submission).toBe(stuck.submission + 1)
    })

    it('voids an accepted document of A', async () => {
      await useIssuer(SIMULATOR_PROVIDER_ID)
      const id = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const answer = await fromA2(both)
        .post(ApiRoutes.fiscal.documents.void(id))
        .send({ reason: 'wrong customer' })
      expect(answer.status).toBe(OK)
      expect((await row(id)).status).toBe(FiscalDocumentStatus.VOIDED)
    })

    it('makes the replacement of an accepted document of A', async () => {
      await useIssuer(ASKS_PROVIDER_ID)
      const id = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const answer = await fromA2(both).post(ApiRoutes.fiscal.documents.replace(id))
      expect(answer.status).toBe(OK)
      const made = (answer.body as { data: { id: string } }).data.id
      expect((await row(made)).replacesDocumentId).toBe(id)
    })
  })

  describe('the reach of the person is the same as with the switch off', () => {
    const routes: readonly {
      name: string
      call: (client: Client, id: string) => Promise<{ status: number; body: unknown }>
    }[] = [
      {
        name: 'receiver',
        call: (client, id) =>
          client
            .patch(ApiRoutes.fiscal.documents.receiver(id))
            .send({ taxId: RECEIVER_TAX_ID, name: 'Ana Receiver' })
      },
      { name: 'retry', call: (client, id) => client.post(ApiRoutes.fiscal.documents.retry(id)) },
      {
        name: 'confirmIssuerChange',
        call: (client, id) =>
          client
            .post(ApiRoutes.fiscal.documents.confirmIssuerChange(id))
            .send({ reason: 'checked with the authority: not there' })
      },
      {
        name: 'void',
        call: (client, id) =>
          client.post(ApiRoutes.fiscal.documents.void(id)).send({ reason: 'wrong customer' })
      },
      { name: 'replace', call: (client, id) => client.post(ApiRoutes.fiscal.documents.replace(id)) }
    ]

    it.each(routes)(
      'answers 404 on $name when the person does not manage the documents in the store of the document, and changes nothing',
      async ({ call }) => {
        await useIssuer(SIMULATOR_PROVIDER_ID)
        const id = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
        const before = await row(id)
        // What the authority is asked and what is queued from here on: nothing, for a person who does not reach the document
        const asked = (['build', 'submit', 'consult', 'void', 'consultVoid'] as const).map(method =>
          jest.spyOn(simulator, method)
        )
        const queue = queueOf(app, QueueNames.HEAVY_PROCESSING)
        const queued = queue.jobs.length
        const refused = await call(fromA2(onlyA2), id)
        expect(refused.status).toBe(NOT_FOUND)
        // The same answer as for a document that does not exist and for one of another organization
        const missing = await call(fromA2(onlyA2), randomUUID())
        expect(missing.status).toBe(NOT_FOUND)
        expect(errorOf(refused)).toEqual(errorOf(missing))
        const foreign = await call(api(app, ctx.adminB, ctx.storeB), id)
        expect(foreign.status).toBe(NOT_FOUND)
        expect(errorOf(foreign)).toEqual(errorOf(missing))
        const after = await row(id)
        expect([after.status, after.submission, after.updatedAt]).toEqual([
          before.status,
          before.submission,
          before.updatedAt
        ])
        expect(asked.map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0, 0])
        expect(queue.jobs).toHaveLength(queued)
        asked.forEach(spy => spy.mockRestore())
        // Nothing was written, so nothing is on the trail
        expect(await owner.auditLog.count({ where: { userId: onlyA2.id, resourceId: id } })).toBe(0)
      }
    )

    it('voids once: the second request meets a document that is no longer accepted and writes nothing', async () => {
      await useIssuer(SIMULATOR_PROVIDER_ID)
      const id = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const first = await fromA2(both)
        .post(ApiRoutes.fiscal.documents.void(id))
        .send({ reason: 'wrong customer' })
      expect(first.status).toBe(OK)
      const voided = await row(id)
      const second = await fromA2(both)
        .post(ApiRoutes.fiscal.documents.void(id))
        .send({ reason: 'wrong customer' })
      expect(second.status).toBe(CONFLICT)
      const after = await row(id)
      expect([after.status, after.voidedAt, after.voidClaimKey]).toEqual([
        voided.status,
        voided.voidedAt,
        voided.voidClaimKey
      ])
    })

    it.each(routes)(
      'answers 403 on $name when the permission is missing in the store of the header',
      async ({ call }) => {
        await useIssuer(SIMULATOR_PROVIDER_ID)
        const id = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
        expect((await call(fromA2(agentInA2), id)).status).toBe(FORBIDDEN)
      }
    )
  })

  // The cases that BLOCK turning RLS_CONTEXT on for the fiscal routes of a person (debt (d) of #816): what happens when a unit of a route
  // dies or the queue is down, with the document of one store and the header of its sibling
  describe('a route that fails half way, with the header of the sibling store', () => {
    it('ends an invalidation whose last unit died with ONE invalidation at the authority', async () => {
      await useIssuer(REMEMBERS_PROVIDER_ID)
      const id = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      received.length = 0
      // The authority invalidates the document and the last unit of the route dies before it writes the answer
      const dies = jest
        .spyOn(documents as unknown as { safeResponse: () => unknown }, 'safeResponse')
        .mockImplementationOnce(() => {
          throw new Error('connection lost')
        })
      const first = await fromA2(both)
        .post(ApiRoutes.fiscal.documents.void(id))
        .send({ reason: 'wrong customer' })
      dies.mockRestore()
      expect(first.status).toBe(SERVER_ERROR)
      const stuck = await row(id)
      expect(stuck.status).toBe(FiscalDocumentStatus.ACCEPTED)
      expect(stuck.voidClaimKey).not.toBeNull()
      expect(received).toHaveLength(1)

      // The claim is alive: the same request is the same invalidation and waits for the lease, it never reaches the authority again
      const early = await fromA2(both)
        .post(ApiRoutes.fiscal.documents.void(id))
        .send({ reason: 'wrong customer' })
      expect(early.status).toBe(CONFLICT)
      expect(received).toHaveLength(1)

      // The lease ends: the same key finds the claim, consults the authority and settles the document with what it answered
      await owner.fiscalDocument.update({
        where: { id },
        data: { voidClaimUntil: new Date(Date.now() - 1000) }
      })
      const again = await fromA2(both)
        .post(ApiRoutes.fiscal.documents.void(id))
        .send({ reason: 'wrong customer' })
      expect(again.status).toBe(OK)
      const done = await row(id)
      expect(done.status).toBe(FiscalDocumentStatus.VOIDED)
      expect(done.voidClaimKey).toBeNull()
      expect(done.voidResponse).toEqual({ voided: true, recovered: true })
      expect(received).toHaveLength(1)
    })

    it('refuses a replacement that is not the one made for the document, or none, and asks nobody', async () => {
      await useIssuer(SIMULATOR_PROVIDER_ID)
      const id = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const other = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const asked = (['void', 'consultVoid'] as const).map(method => jest.spyOn(simulator, method))
      for (const replacementDocumentId of [other, randomUUID()]) {
        const refused = await fromA2(both)
          .post(ApiRoutes.fiscal.documents.void(id))
          .send({ reason: 'wrong customer', replacementDocumentId })
        expect(refused.status).toBe(NOT_FOUND)
      }
      expect(asked.map(spy => spy.mock.calls.length)).toEqual([0, 0])
      asked.forEach(spy => spy.mockRestore())
      const after = await row(id)
      expect([after.status, after.voidClaimKey]).toEqual([FiscalDocumentStatus.ACCEPTED, null])
    })

    it('refuses a replacement that belongs to another organization and asks nobody', async () => {
      await useIssuer(SIMULATOR_PROVIDER_ID)
      const id = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      // An accepted sale document of ORGANIZATION B, with the same provider and environment as the one of A
      const mine = await row(id)
      const orderB = await createOrder(owner, { storeId: ctx.storeB.id })
      const foreign = await owner.fiscalDocument.create({
        data: {
          organizationId: ctx.orgB.id,
          storeId: ctx.storeB.id,
          orderId: orderB.id,
          kind: FiscalDocumentKind.SALE,
          sequenceNumber: 1,
          documentType: mine.documentType,
          status: FiscalDocumentStatus.ACCEPTED,
          providerId: mine.providerId,
          environment: mine.environment,
          externalNumber: `FOREIGN-${randomUUID().slice(0, 8)}`,
          issuerSnapshot: {},
          linesSnapshot: [],
          receiverEncrypted: new Uint8Array(mine.receiverEncrypted),
          currency: mine.currency,
          totalCents: mine.totalCents,
          taxCents: mine.taxCents
        },
        select: { id: true }
      })
      const asked = (['void', 'consultVoid'] as const).map(method => jest.spyOn(simulator, method))
      const refused = await fromA2(both)
        .post(ApiRoutes.fiscal.documents.void(id))
        .send({ reason: 'wrong customer', replacementDocumentId: foreign.id })
      expect(refused.status).toBe(NOT_FOUND)
      expect(asked.map(spy => spy.mock.calls.length)).toEqual([0, 0])
      asked.forEach(spy => spy.mockRestore())
      const after = await row(id)
      expect([after.status, after.voidClaimKey]).toEqual([FiscalDocumentStatus.ACCEPTED, null])
    })

    it('makes a voided credit note again from the sibling store, against the live sale', async () => {
      await useIssuer(SIMULATOR_PROVIDER_ID)
      const documentId = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const saleDoc = await row(documentId)
      const orderId = saleDoc.orderId
      const returned = await owner.orderReturn.create({
        data: {
          storeId: ctx.storeA.id,
          orderId,
          type: 'refund',
          reason: 'DEFECTIVE',
          status: OrderReturnStatus.RECEIVED,
          shippingPayer: 'sender',
          createdBy: ctx.adminA.id,
          receivedAt: new Date()
        },
        select: { id: true }
      })
      const item = await owner.orderItem.findFirstOrThrow({
        where: { orderId },
        select: { id: true }
      })
      await owner.orderReturnLine.create({
        data: { storeId: ctx.storeA.id, returnId: returned.id, orderItemId: item.id, quantity: 1 }
      })
      await emitter.emitAsync(Events.RETURN_RECEIVED, {
        storeId: ctx.storeA.id,
        orderId,
        orderNumber: 'N',
        actor: { type: 'system', id: null },
        returnId: returned.id
      })
      const note = await owner.fiscalDocument.findFirstOrThrow({
        where: { returnId: returned.id, kind: FiscalDocumentKind.CREDIT_NOTE }
      })
      await documents.submit(ctx.orgA.id, note.id)
      const voided = await fromA2(both)
        .post(ApiRoutes.fiscal.documents.void(note.id))
        .send({ reason: 'redo' })
      expect(voided.status).toBe(OK)
      expect((await row(note.id)).status).toBe(FiscalDocumentStatus.VOIDED)

      const again = await fromA2(both).post(ApiRoutes.fiscal.documents.replace(note.id))
      expect(again.status).toBe(OK)
      const created = await row((again.body as { data: { id: string } }).data.id)
      expect(created.kind).toBe(FiscalDocumentKind.CREDIT_NOTE)
      expect(created.returnId).toBe(returned.id)
      expect(created.parentDocumentId).toBe(documentId)
      expect(created.storeId).toBe(ctx.storeA.id)
    })

    it('takes no claim and asks nobody when the reach is lost between the first unit and the claim', async () => {
      await useIssuer(SIMULATOR_PROVIDER_ID)
      const id = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const asked = (['void', 'consultVoid'] as const).map(method => jest.spyOn(simulator, method))
      // A guard that lets the first unit through and refuses the second, the one that takes the claim
      let calls = 0
      const guard = (): Promise<void> => {
        calls += 1
        return calls === 1 ? Promise.resolve() : Promise.reject(new Error('the reach was lost'))
      }

      await expect(
        documents.void(
          ctx.orgA.id,
          id,
          'wrong customer',
          { userId: both.id, storeId: ctx.storeA2.id },
          guard
        )
      ).rejects.toThrow('the reach was lost')

      expect(asked.map(spy => spy.mock.calls.length)).toEqual([0, 0])
      asked.forEach(spy => spy.mockRestore())
      const after = await row(id)
      expect([after.status, after.voidClaimKey]).toEqual([FiscalDocumentStatus.ACCEPTED, null])
    })

    it('answers a replacement whose queueing failed, and leaves the document queued for the check of the night', async () => {
      await useIssuer(ASKS_PROVIDER_ID)
      const id = await sale({ taxId: RECEIVER_TAX_ID, accept: true })
      const down = jest
        .spyOn(app.get(FiscalSubmissionQueue), 'enqueue')
        .mockRejectedValue(new Error('the queue is down'))
      let made: string
      try {
        const answer = await fromA2(both).post(ApiRoutes.fiscal.documents.replace(id))
        expect(answer.status).toBe(OK)
        made = (answer.body as { data: { id: string } }).data.id
      } finally {
        down.mockRestore()
      }
      // Committed and not queued: the check of the night lists it once the time of a stall has passed
      const queued = await row(made)
      expect(queued.status).toBe(FiscalDocumentStatus.QUEUED)
      // It was numbered when it was made (the number is the document's, so it is not lost with the job): the check asks for THIS document
      expect(queued.sequenceNumber).not.toBeNull()
      const later = new Date(Date.now() + (FiscalSweepLimits.QUEUED_STALL_MINUTES + 1) * MINUTE_MS)
      const found = await app
        .get(FiscalSweepService)
        .find(ctx.orgA.id, FiscalSweepKind.STALLED_DOCUMENT, { now: later })
      expect(found.data.filter(finding => finding.id === made)).toHaveLength(1)
      expect((await row(made)).sequenceNumber).toBe(queued.sequenceNumber)
      expect(await owner.fiscalDocument.count({ where: { replacesDocumentId: id } })).toBe(1)
    })
  })
})
