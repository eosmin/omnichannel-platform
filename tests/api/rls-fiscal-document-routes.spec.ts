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
  FiscalVoidKind,
  OrderStatus
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { FISCAL_PROVIDERS, FiscalDocumentsService } from '@platform/fiscal/runtime'
import type { FiscalDocumentProvider } from '@platform/fiscal/sdk'
import { SIMULATOR_PROVIDER_ID, simulatorProvider } from '@platform/fiscal/simulator'

import { createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api, type TestAgent } from '../helpers/http'

type Client = TestAgent

// The answer without the id of the request, which is different every time
const errorOf = (answer: { body: unknown }): unknown => (answer.body as { error: unknown }).error

const OK = 200
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const ASKS_PROVIDER_ID = 'rls-fiscal-routes-test'
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

// A fiscal document belongs to the organization in the data but to the store of its sale in its rows. The request of a person who works
// in store A2 on a document of store A (they hold the permission in both) arrives with the context of A2 alone; the trigger of the
// document (`check_fiscal_document_scope`, not SECURITY DEFINER) reads the orders, returns and documents of the store of the DOCUMENT, so
// the five routes of a person must open the context of the organization. The app is the real one, on the role of the api, with the switch
// on and a context required for every query.
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
        .useValue([simulatorProvider(), asksProvider()])
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
})
