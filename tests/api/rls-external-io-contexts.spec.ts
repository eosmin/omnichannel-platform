import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { JobContext, PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, type OwnerClient } from '@platform/core/database-testing'
import {
  CarrierId,
  FinanceCountryCodes,
  FinanceReportLimits,
  JournalEntryType,
  OrderReturnStatus,
  PluginCatalogTypes,
  PluginInstallationStatus,
  PluginPricingModels,
  ShipmentKind,
  ShipmentStatus,
  ShippingPayer
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { CarrierRegistry } from '@platform/plugins/runtime'
import { PluginScopes } from '@platform/plugins/sdk'

import { PluginChallengeService } from '../../apps/api/src/modules/plugins/plugin-challenge.service'
import {
  buildFakeCarrier,
  createCarrierConnection,
  createOrder,
  type FakeCarrier,
  FakeCarrierBehaviors
} from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { type CreatedBody, ordersKit, type OrdersKit } from '../helpers/orders'

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const RENT = '6105'
const CASH = '1101'
const ADDRESS = { line1: 'Calle 1 #23', city: 'San Salvador', state: 'San Salvador', country: 'SV' }

// RLS phase 6, F6-3f: the three routes that call outside the platform (the guide of a carrier, the guide of the way back of a return, the
// HTTPS challenge of an integration plugin) are @NoTenantTransaction, so the interceptor opens nothing for them. With the switch ON and the
// guard of PrismaService ON (a query behind row security with no context throws), each must still work, because each unit of database
// work opens a short context of the store, and the call outside runs with NO context open (a connection is never held while a carrier
// or a plugin answers). The api here is the one of the activation: the interceptor on, the guard on.
describe('RLS phase 6: the routes that call outside run in short contexts', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  let kit: OrdersKit
  let fake: FakeCarrier
  let forzaId = ''
  let counter = 0
  // Whether a tenant context was open at the moment each call outside was made
  const opened: { call: string; tenantOpen: boolean }[] = []
  const challenge = { run: jest.fn<Promise<void>, [string, string]>() }

  beforeAll(async () => {
    owner = ownerClient()
    guarded = new PrismaService({
      databaseUrl: connectionUrls().worker,
      poolSize: 8,
      requireContext: true
    })
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(PrismaService)
        .useValue(guarded)
        .overrideProvider(RLS_CONTEXT_ENABLED)
        .useValue(true)
        .overrideProvider(PluginChallengeService)
        .useValue(challenge)
    )
    ctx = await seedTestContext(owner, app, prefix)
    kit = ordersKit(owner, app, ctx)
    fake = buildFakeCarrier({ id: CarrierId.FORZA, returnShipment: true })
    const create = fake.plugin.createShipment?.bind(fake.plugin)
    if (create === undefined) throw new Error('the fake carrier makes guides')
    app.get(CarrierRegistry, { strict: false }).register({
      ...fake.plugin,
      createShipment: (context, params) => {
        opened.push({ call: 'createShipment', tenantOpen: guarded.hasTenantContext() })
        return create(context, params)
      }
    })
    await owner.warehouse.update({
      where: { id: ctx.warehouseA.id },
      data: { address: { line1: 'Bodega 1', city: 'Soyapango', country: 'SV' } }
    })
    forzaId = (
      await createCarrierConnection(owner, { storeId: ctx.storeA.id, carrierId: CarrierId.FORZA })
    ).id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    opened.length = 0
    fake.state.guides.clear()
    fake.state.create = FakeCarrierBehaviors.OK
    challenge.run.mockReset()
    challenge.run.mockImplementation(() => {
      opened.push({ call: 'challenge', tenantOpen: guarded.hasTenantContext() })
      return Promise.resolve()
    })
  })

  const admin = () => api(app, ctx.adminA, ctx.storeA)

  it('the guard is on: a read with no context is refused, not answered with no row', async () => {
    await expect(
      guarded.client.shipment.findFirst({ where: { storeId: ctx.storeA.id } })
    ).rejects.toThrow(/no tenant context/)
  })

  it('makes a guide with the carrier called outside any context, and the shipment is written and read in contexts of their own', async () => {
    const order = await createOrder(owner, {
      storeId: ctx.storeA.id,
      status: 'CONFIRMED',
      shippingAddress: ADDRESS,
      allocatedAt: ctx.warehouseA.id
    })

    const response = await admin()
      .post(ApiRoutes.shipments.forOrder(order.id))
      .send({ connectionId: forzaId })

    expect(response.status).toBe(CREATED)
    expect(opened).toEqual([{ call: 'createShipment', tenantOpen: false }])
    const rows = await owner.shipment.findMany({ where: { orderId: order.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: ShipmentStatus.LABEL_CREATED, storeId: ctx.storeA.id })
  })

  // A delivered order of 2 units and a return of all of them, approved and paid by the sender
  async function approvedReturn(): Promise<{ orderId: string; returnId: string }> {
    const product = await kit.stocked(10)
    const body = await kit.orderBody({ items: [{ productId: product.id, quantity: 2 }] })
    const created = await admin().post(ApiRoutes.orders.create).send(body)
    expect(created.status).toBe(CREATED)
    const order = (created.body as CreatedBody).order
    await owner.order.update({ where: { id: order.id }, data: { shippingAddress: ADDRESS } })
    for (const next of ['CONFIRMED', 'SHIPPED', 'DELIVERED']) {
      await admin().post(ApiRoutes.orders.status(order.id)).send({ status: next })
    }
    const item = await owner.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
    const opening = await admin()
      .post(ApiRoutes.returns.create)
      .send({
        orderId: order.id,
        type: 'refund',
        reason: 'DEFECTIVE',
        lines: [{ orderItemId: item.id, quantity: 2 }]
      })
    expect(opening.status).toBe(CREATED)
    const returnId = (opening.body as { id: string }).id
    expect((await admin().post(ApiRoutes.returns.approve(returnId)).send({})).status).toBe(OK)
    await owner.orderReturn.update({
      where: { id: returnId },
      data: { shippingPayer: ShippingPayer.SENDER }
    })
    return { orderId: order.id, returnId }
  }

  it('makes the guide of the way back of a return the same way', async () => {
    const { orderId, returnId } = await approvedReturn()
    opened.length = 0

    const response = await admin()
      .post(ApiRoutes.returns.returnShipment(returnId))
      .send({ connectionId: forzaId })

    expect(response.status).toBe(CREATED)
    expect(opened).toEqual([{ call: 'createShipment', tenantOpen: false }])
    const guide = await owner.shipment.findFirstOrThrow({
      where: { orderId, kind: ShipmentKind.RETURN }
    })
    expect(guide.status).toBe(ShipmentStatus.LABEL_CREATED)
    const linked = await owner.orderReturn.findUniqueOrThrow({ where: { id: returnId } })
    expect(linked.status).toBe(OrderReturnStatus.APPROVED)
    expect(linked.returnShipmentId).toBe(guide.id)
  })

  it('records a refusal of the carrier as a failed guide, with the carrier called outside any context, and a retry makes exactly one guide', async () => {
    const order = await createOrder(owner, {
      storeId: ctx.storeA.id,
      status: 'CONFIRMED',
      shippingAddress: ADDRESS,
      allocatedAt: ctx.warehouseA.id
    })
    fake.state.create = FakeCarrierBehaviors.REJECT

    const refused = await admin()
      .post(ApiRoutes.shipments.forOrder(order.id))
      .send({ connectionId: forzaId })

    expect(refused.status).toBe(BAD_REQUEST)
    expect((refused.body as { error: { code: string } }).error.code).toBe(
      ErrorCodes.SHIPPING_CARRIER_REJECTED
    )
    expect(opened).toEqual([{ call: 'createShipment', tenantOpen: false }])
    const failed = await owner.shipment.findMany({ where: { orderId: order.id } })
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({ status: ShipmentStatus.FAILED, guideNumber: null })
    expect(failed[0]?.lastError).toEqual(expect.any(String))

    fake.state.create = FakeCarrierBehaviors.OK
    opened.length = 0
    const retried = await admin()
      .post(ApiRoutes.shipments.forOrder(order.id))
      .send({ connectionId: forzaId })

    expect(retried.status).toBe(CREATED)
    expect(opened).toEqual([{ call: 'createShipment', tenantOpen: false }])
    const rows = await owner.shipment.findMany({ where: { orderId: order.id } })
    expect(rows.filter(row => row.status === String(ShipmentStatus.FAILED))).toHaveLength(1)
    expect(rows.filter(row => row.status === String(ShipmentStatus.LABEL_CREATED))).toHaveLength(1)
    expect(rows).toHaveLength(2)
  })

  it('leaves a return approved when the carrier refuses its guide, and the retry links the new one', async () => {
    const { orderId, returnId } = await approvedReturn()
    opened.length = 0
    fake.state.create = FakeCarrierBehaviors.REJECT

    const refused = await admin()
      .post(ApiRoutes.returns.returnShipment(returnId))
      .send({ connectionId: forzaId })

    expect(refused.status).toBe(BAD_REQUEST)
    expect(opened).toEqual([{ call: 'createShipment', tenantOpen: false }])
    const failed = await owner.shipment.findFirstOrThrow({
      where: { orderId, kind: ShipmentKind.RETURN }
    })
    expect(failed.status).toBe(ShipmentStatus.FAILED)
    // The row of the attempt is linked when it is written (before the carrier is asked), so the failed guide is the last one
    const held = await owner.orderReturn.findUniqueOrThrow({ where: { id: returnId } })
    expect(held.status).toBe(OrderReturnStatus.APPROVED)
    expect(held.returnShipmentId).toBe(failed.id)

    fake.state.create = FakeCarrierBehaviors.OK
    const retried = await admin()
      .post(ApiRoutes.returns.returnShipment(returnId))
      .send({ connectionId: forzaId })

    expect(retried.status).toBe(CREATED)
    const guides = await owner.shipment.findMany({ where: { orderId, kind: ShipmentKind.RETURN } })
    expect(guides.filter(row => row.status === String(ShipmentStatus.LABEL_CREATED))).toHaveLength(
      1
    )
    const relinked = await owner.orderReturn.findUniqueOrThrow({ where: { id: returnId } })
    expect(relinked.returnShipmentId).toBe((retried.body as { id: string }).id)
    expect(relinked.status).toBe(OrderReturnStatus.APPROVED)
  })

  it('installs an integration plugin with the challenge outside any context, and installing again finds it installed', async () => {
    counter += 1
    const id = `${prefix}-p${counter}`
    await admin()
      .post(ApiRoutes.plugins.register)
      .send({
        id,
        version: '1.0.0',
        name: `Plugin ${id}`,
        description: 'Sends the orders of the store to the point of sale',
        author: { name: 'Acme Inc', email: 'support@acme.com' },
        type: PluginCatalogTypes.INTEGRATION,
        pricing: { model: PluginPricingModels.FREE },
        scopes: [PluginScopes.ORDERS_READ],
        webhooks: {
          endpoint: 'https://hooks.acme.com/platform',
          events: ['message.received'],
          signatureHeader: 'X-Platform-Signature'
        },
        ui: { settings: 'https://acme.com/plugin/settings' }
      })
      .expect(CREATED)
    const consent = (await admin().get(ApiRoutes.plugins.consent(id)).expect(OK)).body as {
      scopes: string[]
    }

    const first = await admin()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId: id, scopes: consent.scopes })

    expect(first.status).toBe(CREATED)
    expect(opened).toEqual([{ call: 'challenge', tenantOpen: false }])
    const installation = await owner.pluginInstallation.findFirstOrThrow({
      where: { storeId: ctx.storeA.id, pluginId: id }
    })
    expect(installation.status).toBe(PluginInstallationStatus.PENDING_SETUP)
    // Installed again before the plugin set itself up: the same row, a new code, the challenge asked again
    const second = await admin()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId: id, scopes: consent.scopes })
    expect(second.status).toBe(CREATED)
    expect(
      await owner.pluginInstallation.count({ where: { storeId: ctx.storeA.id, pluginId: id } })
    ).toBe(1)
  })

  // The CSV of the journal is the other route that reads outside the transaction of the request: the count and each page are a unit of
  // the organization, so the file is cut at the highest entry number counted. Here it runs with the guard on and the switch on.
  describe('the journal CSV, read in a unit of the organization per page', () => {
    const FROM = '2026-01-01'
    const TO = '2026-01-31'
    let accountsA: Record<string, string> = {}
    let accountsB: Record<string, string> = {}
    const adminB = () => api(app, ctx.adminB, ctx.storeB)

    async function accountIds(organizationId: string): Promise<Record<string, string>> {
      const rows = await owner.ledgerAccount.findMany({
        where: { organizationId },
        select: { id: true, code: true }
      })
      return Object.fromEntries(rows.map(row => [row.code, row.id]))
    }
    async function post(
      agent: () => ReturnType<typeof admin>,
      accounts: Record<string, string>,
      cents: number
    ): Promise<string> {
      const response = await agent()
        .post(ApiRoutes.finance.entries.manual)
        .send({
          idempotencyKey: `k-${prefix}-${randomUUID()}`,
          entryDate: '2026-01-15',
          type: JournalEntryType.MANUAL,
          memo: 'Entry of the suite',
          lines: [
            { accountId: accounts[RENT], debitCents: cents },
            { accountId: accounts[CASH], creditCents: cents }
          ]
        })
      expect(response.status).toBe(CREATED)
      return (response.body as { id: string }).id
    }
    async function download(agent: () => ReturnType<typeof admin>): Promise<string[][]> {
      const response = await agent()
        .get(ApiRoutes.finance.reports.journalCsv)
        .query({ from: FROM, to: TO })
        .buffer(true)
        .parse((res, done) => {
          let data = ''
          res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')))
          res.on('end', () => done(null, data))
        })
      expect(response.status).toBe(OK)
      // Plain fields (no quote, no comma): the entries of the case have none
      return (response.body as string)
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)
        .filter(line => line !== '')
        .map(line => line.split(','))
    }

    beforeAll(async () => {
      for (const agent of [admin, adminB]) {
        await agent()
          .post(ApiRoutes.finance.setup)
          .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: FROM })
          .expect(CREATED)
      }
      accountsA = await accountIds(ctx.orgA.id)
      accountsB = await accountIds(ctx.orgB.id)
    })

    it('cuts the file at the highest entry counted when an entry arrives between two pages, and the audit row counts the file', async () => {
      const seeded = [await post(admin, accountsA, 1_000)]
      seeded.push(await post(admin, accountsA, 250), await post(admin, accountsA, 75))
      const exported = { organizationId: ctx.orgA.id, action: AuditAction.FINANCE_EXPORTED }
      const before = await owner.auditLog.count({ where: exported })
      // Two lines per page: the three entries take three pages, each a unit of its own
      const limits: { CSV_PAGE_SIZE: number } = FinanceReportLimits
      const pageSize = jest.replaceProperty(limits, 'CSV_PAGE_SIZE', 2)
      // The count is the first unit and the first page the second: once that page is served, an entry is posted, so it takes a number
      // above the one the count saw
      const jobContext = app.get(JobContext)
      const original = jobContext.inOrganization.bind(jobContext)
      let units = 0
      let late = ''
      let lateFailure: unknown = null
      let seeding = false
      // Whether a tenant context was open as each unit of the file began: none may be, a connection is not held while the file goes out
      const open: boolean[] = []
      const spy = jest
        .spyOn(jobContext, 'inOrganization')
        .mockImplementation(async (organizationId, work, options) => {
          if (seeding || organizationId !== ctx.orgA.id)
            return original(organizationId, work, options)
          open.push(guarded.hasTenantContext())
          const result = await original(organizationId, work, options)
          units += 1
          if (units === 2) {
            seeding = true
            try {
              late = await post(admin, accountsA, 40)
            } catch (error) {
              lateFailure = error
            } finally {
              seeding = false
            }
          }
          return result
        })
      let rows: string[][]
      try {
        rows = await download(admin)
      } finally {
        spy.mockRestore()
        pageSize.restore()
      }

      expect(lateFailure).toBeNull()
      expect(late).not.toBe('')
      // The count and four pages (the last empty): were the page size ignored, one page would hold the file and the cut would prove nothing
      expect(units).toBe(5)
      expect(open).toEqual([false, false, false, false, false])
      const [header = [], ...lines] = rows
      const entryIds = new Set(lines.map(line => line[header.indexOf('entry_id')]))
      expect(lines).toHaveLength(6)
      expect(entryIds).toEqual(new Set(seeded))
      expect(entryIds.has(late)).toBe(false)
      // The audit row of THIS request counts the rows of the file: wait for one more than before and read the newest
      const audited = await waitForAuditEntries(owner, exported, before + 1)
      expect(audited).toHaveLength(before + 1)
      expect(audited.at(-1)?.metadata).toMatchObject({ report: 'journal', rows: lines.length })
      // The next download has the late entry, as it was not lost
      const next = await download(admin)
      expect(next.slice(1)).toHaveLength(8)
    })

    it('gives an organization none of the rows of another', async () => {
      const entryB = await post(adminB, accountsB, 500)

      const rowsB = await download(adminB)
      const rowsA = await download(admin)

      const column = (rows: string[][]): Set<string | undefined> =>
        new Set(rows.slice(1).map(line => line[(rows[0] ?? []).indexOf('entry_id')]))
      expect(column(rowsB)).toEqual(new Set([entryB]))
      expect(rowsB.slice(1)).toHaveLength(2)
      expect(column(rowsA).size).toBeGreaterThan(0)
      expect(column(rowsA).has(entryB)).toBe(false)
    })
  })
})
