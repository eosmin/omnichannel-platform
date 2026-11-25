import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  FiscalConflictReasons,
  FiscalDocumentKind,
  FiscalEnvironment,
  FiscalIssueOn,
  OrderStatus
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { FiscalDocumentsService, FiscalProviderRegistry } from '@platform/fiscal/runtime'
import {
  FiscalAnnexError,
  type FiscalAnnexDocument,
  type FiscalAnnexExporter
} from '@platform/fiscal/sdk'
import { SIMULATOR_PROVIDER_ID } from '@platform/fiscal/simulator'

import { createOrder } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}

const ANNEX_ID = 'fake-annex'
const RECEIVER_TAX_ID = '0614-010101-101-1'
const ISSUER = {
  providerId: SIMULATOR_PROVIDER_ID,
  legalName: 'Annex Issuer',
  taxId: 'ISSUER-TAX-ID',
  address: { line1: 'Calle 1', city: 'Ciudad' },
  environment: FiscalEnvironment.SANDBOX,
  issueOn: FiscalIssueOn.DELIVERED,
  credentials: { signingKey: 'not-a-real-signing-key-1234567890' }
}

// The annexes of the periodic return (D4a): who may take the file out, that it is made from the documents of the organization alone, that
// it is audited without a row of it, and that a month that cannot be made is refused. The simulator makes no annex, so the provider the
// runtime finds is the simulator with an exporter of the spec's own that records what it was handed: the columns of the real one are
// pinned by `libs/fiscal/sv/src/sv-annexes.spec.ts`.
// Isolation from the other specs of this run: the documents counted are the ones the database holds for each organization of THIS run
// (the prefix is its own), never a constant, and the exporter sees only what the service hands it.
describe('The annexes of the periodic return (D4a)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let documents: FiscalDocumentsService
  let emitter: EventEmitter2
  let handed: FiscalAnnexDocument[][]
  let exporterBehaviour: 'rows' | 'refuse'

  const exporter: FiscalAnnexExporter = {
    ids: [ANNEX_ID],
    build(id, period, received) {
      handed.push([...received])
      if (exporterBehaviour === 'refuse') throw new FiscalAnnexError('cause_code')
      return {
        id,
        filename: `fake-${period.year}-${period.month}.csv`,
        rows: received.length,
        content: received.map(() => 'row').join('\r\n')
      }
    }
  }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    documents = app.get(FiscalDocumentsService)
    emitter = app.get(EventEmitter2)
    const registry = app.get(FiscalProviderRegistry)
    const real = registry.find.bind(registry)
    jest.spyOn(registry, 'find').mockImplementation(id => {
      const provider = real(id)
      return provider === undefined || provider.id !== SIMULATOR_PROVIDER_ID
        ? provider
        : (Object.create(provider, { annexes: { value: exporter } }) as typeof provider)
    })
    expect(
      (await api(app, ctx.adminA, ctx.storeA).put(ApiRoutes.fiscal.issuer).send(ISSUER)).status
    ).toBe(OK)
    expect(
      (await api(app, ctx.adminB, ctx.storeB).put(ApiRoutes.fiscal.issuer).send(ISSUER)).status
    ).toBe(OK)
  })
  afterAll(async () => {
    jest.restoreAllMocks()
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    handed = []
    exporterBehaviour = 'rows'
  })

  async function acceptedSale(organizationId: string, store: { id: string }) {
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
    const asAdmin = store.id === ctx.storeA.id ? ctx.adminA : ctx.adminB
    const fix = await api(app, asAdmin, store)
      .patch(ApiRoutes.fiscal.documents.receiver(document.id))
      .send({ taxId: RECEIVER_TAX_ID, name: 'Ana Receiver' })
    expect(fix.status).toBe(OK)
    await documents.submit(organizationId, document.id)
    return document.id
  }

  const now = new Date()
  const query = `?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`
  const annexUrl = (id = ANNEX_ID) => `${ApiRoutes.fiscal.annex(id)}${query}`

  // A person who reads the fiscal documents of every store of organization A and takes financial files out
  async function reachingEveryStore(name: string) {
    const permissions = [
      Permissions.FISCAL_VIEW,
      Permissions.FINANCE_VIEW,
      Permissions.FINANCE_EXPORT
    ]
    const first = await actorWithPermissions(owner, app, {
      prefix,
      name,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions
    })
    await actorWithPermissions(owner, app, {
      prefix,
      name,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA2.id,
      permissions
    })
    return first
  }

  it('hands the provider the accepted documents of the organization alone, whichever store the header names, and answers a file that no cache keeps', async () => {
    await acceptedSale(ctx.orgA.id, ctx.storeA)
    await acceptedSale(ctx.orgA.id, ctx.storeA)
    await acceptedSale(ctx.orgB.id, ctx.storeB)
    const reader = await reachingEveryStore('annex-reader')
    const inA = await owner.fiscalDocument.count({ where: { organizationId: ctx.orgA.id } })
    const inB = await owner.fiscalDocument.count({ where: { organizationId: ctx.orgB.id } })
    expect(inA).toBeGreaterThanOrEqual(2)
    expect(inB).toBeGreaterThanOrEqual(1)

    // The store of the header is the other store of the organization: the file is still the organization's
    const fromA2 = await api(app, reader, ctx.storeA2).get(annexUrl())
    expect(fromA2.status).toBe(OK)
    expect(fromA2.headers['content-type']).toContain('text/csv')
    expect(fromA2.headers['cache-control']).toContain('no-store')
    expect(fromA2.headers['content-disposition']).toContain('attachment; filename="fake-')
    const seenByA = handed.at(-1) ?? []
    expect(seenByA).toHaveLength(inA)
    expect(
      seenByA.every(document => document.payload !== null && document.issuedAt instanceof Date)
    ).toBe(true)

    // Organization B's own administrator gets B's documents, none of A's
    const adminBReach = await actorWithPermissions(owner, app, {
      prefix,
      name: 'annex-reader-b',
      organizationId: ctx.orgB.id,
      storeId: ctx.storeB.id,
      permissions: [Permissions.FISCAL_VIEW, Permissions.FINANCE_VIEW, Permissions.FINANCE_EXPORT]
    })
    const fromB = await api(app, adminBReach, ctx.storeB).get(annexUrl())
    expect(fromB.status).toBe(OK)
    expect(handed.at(-1)).toHaveLength(inB)
  })

  it('audits who took the file out, the month, the annex and the count of rows, never a row or a customer', async () => {
    const reader = await reachingEveryStore('annex-audited')
    const asked = await api(app, reader, ctx.storeA).get(annexUrl())
    expect(asked.status).toBe(OK)
    const [entry] = await waitForAuditEntries(owner, {
      action: AuditAction.FISCAL_ANNEX_EXPORTED,
      userId: reader.id
    })
    expect(entry?.organizationId).toBe(ctx.orgA.id)
    expect(entry?.metadata).toEqual({
      annex: ANNEX_ID,
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      rows: expect.any(Number) as number
    })
    expect(JSON.stringify(entry)).not.toContain(RECEIVER_TAX_ID)
    expect(JSON.stringify(entry)).not.toContain('Ana Receiver')
  })

  it('asks for the fiscal documents and for the two financial permissions, and for the documents of every store', async () => {
    const lacking = [
      [Permissions.FINANCE_VIEW, Permissions.FINANCE_EXPORT],
      [Permissions.FISCAL_VIEW, Permissions.FINANCE_EXPORT],
      [Permissions.FISCAL_VIEW, Permissions.FINANCE_VIEW]
    ] as const
    for (const [index, permissions] of lacking.entries()) {
      const actor = await actorWithPermissions(owner, app, {
        prefix,
        name: `annex-lacking-${index}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions
      })
      expect((await api(app, actor, ctx.storeA).get(annexUrl())).status).toBe(FORBIDDEN)
    }
    // Every permission, but in one of the two stores of the organization only: a file of part of the stores is a wrong declaration
    const oneStore = await actorWithPermissions(owner, app, {
      prefix,
      name: 'annex-one-store',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.FISCAL_VIEW, Permissions.FINANCE_VIEW, Permissions.FINANCE_EXPORT]
    })
    const partial = await api(app, oneStore, ctx.storeA).get(annexUrl())
    expect(partial.status).toBe(FORBIDDEN)
    expect(handed).toHaveLength(0)
  })

  it('answers 404 to an annex the provider does not make, 400 to a month that is not one, and 409 with the cause when the provider refuses the month', async () => {
    const reader = await reachingEveryStore('annex-errors')
    const as = () => api(app, reader, ctx.storeA)
    expect((await as().get(annexUrl('no-such-annex'))).status).toBe(NOT_FOUND)
    expect((await as().get(`${ApiRoutes.fiscal.annex(ANNEX_ID)}?year=2026&month=13`)).status).toBe(
      BAD_REQUEST
    )
    expect((await as().get(`${ApiRoutes.fiscal.annex(ANNEX_ID)}?year=2026`)).status).toBe(
      BAD_REQUEST
    )
    expect((await as().get(`${ApiRoutes.fiscal.annex('Bad_Id')}?year=2026&month=1`)).status).toBe(
      BAD_REQUEST
    )

    exporterBehaviour = 'refuse'
    const refused = await as().get(annexUrl())
    expect(refused.status).toBe(CONFLICT)
    expect((refused.body as ErrorBody).error.metadata).toEqual({
      reason: FiscalConflictReasons.ANNEX_REFUSED,
      code: 'cause_code'
    })
    // A refused file leaves no audit row of an export
    const exported = await owner.auditLog.count({
      where: { action: AuditAction.FISCAL_ANNEX_EXPORTED, userId: reader.id }
    })
    expect(exported).toBe(0)
  })

  it('asks for a session', async () => {
    const anonymous = await api(app, { ...ctx.adminA, token: 'not-a-token' }, ctx.storeA).get(
      annexUrl()
    )
    expect([401, 403]).toContain(anonymous.status)
  })
})
