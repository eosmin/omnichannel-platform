import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import {
  JobContext,
  JobContextError,
  JobContextGoneError,
  PrismaService
} from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import {
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalEnvironment,
  FiscalIssueOn,
  FiscalSweepKind,
  OrderStatus
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import {
  FISCAL_PROVIDERS,
  FiscalContingencyService,
  FiscalDocumentsService,
  FiscalSweepService
} from '@platform/fiscal/runtime'
import type { FiscalDocumentProvider } from '@platform/fiscal/sdk'
import { simulatorProvider } from '@platform/fiscal/simulator'

import { FiscalReconciler } from '../../apps/worker/src/finance/fiscal-reconciler.service'
import { createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'

const OK = 200
const RECORDING_PROVIDER_ID = 'rls-fiscal-recording'
const SECRET = 'not-a-real-signing-key-1234567890'
const NO_SUCH_ORGANIZATION = '00000000-0000-4000-8000-000000000000'

interface Observation {
  call: 'build' | 'consult' | 'submit'
  contextOpen: boolean
  tenantOpen: boolean
}

// RLS phase 5, PR D2: the fiscal lifecycle of the worker runs in the context of ONE organization, one short unit at a time, and the call
// to the authority is never inside one. The worker role still skips row security, so what proves "every access is in a context" is the
// guard of PrismaService (`requireContext`): a query behind row security with no context throws instead of reading no row. The services come
// from an app whose database is the worker role with the guard ON; the issuers and the sales are set up through a plain app.
describe('RLS phase 5: the fiscal lifecycle of the worker runs in the context of its organization', () => {
  const prefix = newRunPrefix()
  let setupApp: INestApplication
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  let jobs: JobContext
  let documents: FiscalDocumentsService
  let contingencies: FiscalContingencyService
  let sweep: FiscalSweepService
  const seen: Observation[] = []

  // The simulator, numbering by document type (so the series of the organization is used), that says whether a context was open when the
  // authority was called
  function recordingProvider(): FiscalDocumentProvider {
    const base = simulatorProvider()
    const observe = (call: Observation['call']) => {
      seen.push({
        call,
        contextOpen: jobs.isOpen(),
        tenantOpen: guarded.hasTenantContext()
      })
    }
    return {
      id: RECORDING_PROVIDER_ID,
      countryCode: base.countryCode,
      manifest: { ...base.manifest, sequence: { perDocumentType: true } },
      validateIssuer: (issuer, credentials) => base.validateIssuer(issuer, credentials),
      validateReceiver: receiver => base.validateReceiver(receiver),
      resolveDocumentType: input => base.resolveDocumentType(input),
      build: input => {
        observe('build')
        return base.build(input)
      },
      submit: (document, context) => {
        observe('submit')
        return base.submit(document, context)
      },
      consult: (document, context) => {
        observe('consult')
        return base.consult(document, context)
      },
      void: (doc, reason) => base.void(doc, reason)
    }
  }
  const providers = () => [simulatorProvider(), recordingProvider()]

  beforeAll(async () => {
    owner = ownerClient()
    setupApp = await createTestApp([], builder =>
      builder.overrideProvider(FISCAL_PROVIDERS).useValue(providers())
    )
    ctx = await seedTestContext(owner, setupApp, prefix)
    for (const [user, store] of [
      [ctx.adminA, ctx.storeA],
      [ctx.adminB, ctx.storeB]
    ] as const) {
      const put = await api(setupApp, user, store)
        .put(ApiRoutes.fiscal.issuer)
        .send({
          providerId: RECORDING_PROVIDER_ID,
          legalName: 'Rls Fiscal Issuer',
          taxId: 'ISSUER-TAX-ID',
          address: { line1: 'Calle 1', city: 'Ciudad' },
          environment: FiscalEnvironment.SANDBOX,
          issueOn: FiscalIssueOn.DELIVERED,
          credentials: { signingKey: SECRET }
        })
      expect(put.status).toBe(OK)
    }
    guarded = new PrismaService({
      databaseUrl: connectionUrls().worker,
      poolSize: 8,
      requireContext: true
    })
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(PrismaService)
        .useValue(guarded)
        .overrideProvider(FISCAL_PROVIDERS)
        .useValue(providers())
    )
    jobs = app.get(JobContext)
    documents = app.get(FiscalDocumentsService)
    contingencies = app.get(FiscalContingencyService)
    sweep = app.get(FiscalSweepService)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await setupApp.close()
    await owner.$disconnect()
  })

  // A delivered sale whose document the listener of the plain app makes
  async function documentedSale(
    organizationId: string,
    store: { id: string }
  ): Promise<{ orderId: string; documentId: string }> {
    const made = await createOrder(owner, { storeId: store.id })
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
    await setupApp.get(EventEmitter2).emitAsync(Events.ORDER_STATUS_CHANGED, {
      storeId: order.storeId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      actor: { type: 'system', id: null },
      from: OrderStatus.SHIPPED,
      to: OrderStatus.DELIVERED,
      notifyCustomer: false
    })
    const document = await owner.fiscalDocument.findFirstOrThrow({
      where: { orderId: order.id, organizationId, kind: FiscalDocumentKind.SALE },
      select: { id: true }
    })
    return { orderId: order.id, documentId: document.id }
  }
  const row = (documentId: string) =>
    owner.fiscalDocument.findUniqueOrThrow({ where: { id: documentId } })

  it('the guard is on: a read of the fiscal documents with no context is refused, not answered with no row', async () => {
    await expect(
      guarded.client.fiscalDocument.findFirst({ where: { organizationId: ctx.orgA.id } })
    ).rejects.toThrow(/no tenant context/)
  })

  it('a submission claims, calls the authority with no context open, and writes the answer in a unit of its own', async () => {
    const sale = await documentedSale(ctx.orgA.id, ctx.storeA)
    seen.length = 0
    await documents.submit(ctx.orgA.id, sale.documentId)
    expect((await row(sale.documentId)).status).toBe(FiscalDocumentStatus.ACCEPTED)
    // The provider was reached (it built and sent the document) and at no call was a context or a transaction open
    expect(seen.map(entry => entry.call)).toEqual(expect.arrayContaining(['build', 'submit']))
    expect(seen.every(entry => !entry.contextOpen && !entry.tenantOpen)).toBe(true)
    // Nothing stays open after the work: the next read with no context is refused again
    expect(jobs.isOpen()).toBe(false)
    expect(guarded.hasTenantContext()).toBe(false)
    // The evidence of the accepted document was kept (the store of the document is inside the context of its organization)
    expect(
      await owner.media.count({ where: { fiscalDocumentId: sale.documentId } })
    ).toBeGreaterThan(0)
  })

  it('takes the next number of the series of the organization with its own upsert, never another organization series', async () => {
    const first = await documentedSale(ctx.orgA.id, ctx.storeA)
    const second = await documentedSale(ctx.orgA.id, ctx.storeA)
    const other = await documentedSale(ctx.orgB.id, ctx.storeB)
    await documents.submit(ctx.orgA.id, first.documentId)
    await documents.submit(ctx.orgA.id, second.documentId)
    await documents.submit(ctx.orgB.id, other.documentId)
    const [one, two, mine] = await Promise.all([
      row(first.documentId),
      row(second.documentId),
      row(other.documentId)
    ])
    // The upsert (INSERT ... ON CONFLICT DO UPDATE of fiscal_sequences) ran in a unit of the organization: consecutive in a series
    expect(one.correlative).not.toBeNull()
    expect(two.correlative).toBe((one.correlative ?? 0) + 1)
    // The other organization numbers in a series of its own, which a document of A never advanced
    const scopes = await owner.$queryRaw<{ organization_id: string }[]>`
      SELECT organization_id FROM fiscal_sequences WHERE organization_id IN (${ctx.orgA.id}, ${ctx.orgB.id})`
    expect(scopes.map(scope => scope.organization_id).sort()).toEqual(
      [ctx.orgA.id, ctx.orgB.id].sort()
    )
    expect(mine.correlative).not.toBeNull()
  })

  it('the sweep, the contingencies and the notice of exhaustion open their own context', async () => {
    const page = await sweep.find(ctx.orgA.id, FiscalSweepKind.STALLED_DOCUMENT)
    expect(Array.isArray(page.data)).toBe(true)
    await expect(contingencies.current(ctx.orgA.id)).resolves.toBeNull()
    await expect(contingencies.unreported(ctx.orgA.id)).resolves.toEqual([])
    await expect(contingencies.warnWindows(ctx.orgA.id)).resolves.toBe(0)
    const sale = await documentedSale(ctx.orgA.id, ctx.storeA)
    await expect(documents.reportExhausted(ctx.orgA.id, sale.documentId)).resolves.toBeUndefined()
    expect(jobs.isOpen()).toBe(false)
  })

  it('the nightly check goes through its pages and findings under the guard, and refuses a narrower context', async () => {
    const logger = {
      setContext: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined
    } as unknown as PinoLogger
    const heavy = new CapturedQueue()
    const reconciler = new FiscalReconciler(
      guarded,
      sweep,
      documents,
      contingencies,
      heavy as never,
      { set: () => undefined } as never,
      app.get(DomainEvents),
      logger,
      jobs
    )
    await expect(reconciler.reconcile(ctx.orgA.id)).resolves.toEqual(
      expect.objectContaining({ truncated: false })
    )
    // The context of one store is narrower than the organization: the check refuses it instead of reading the rest as no rows
    await jobs.forStore(ctx.storeA.id, async () => {
      await expect(reconciler.reconcile(ctx.orgA.id)).rejects.toBeInstanceOf(JobContextError)
    })
  })

  it('an organization that does not exist is a subject that is gone, not an empty report', async () => {
    await expect(
      sweep.find(NO_SUCH_ORGANIZATION, FiscalSweepKind.STALLED_DOCUMENT)
    ).rejects.toBeInstanceOf(JobContextGoneError)
  })
})
