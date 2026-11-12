import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { OrderGuideFilters, ShipmentStatus } from '@platform/core/domain'

import { createShipment } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const ACCEPTED = 202
const BAD_REQUEST = 400
const FORBIDDEN = 403
const MAX_ORDERS = 100

interface OrderRow {
  id: string
  carrierConnectionId: string | null
}

// The guide and carrier filters of the orders list and the shipments of the orders on a page (Step 4.14)
describe('Orders by carrier and guide', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let agent: ReturnType<typeof api>
  let exporter: ReturnType<typeof api>
  let shippingExporter: ReturnType<typeof api>
  let limited: ReturnType<typeof api>
  let live = { orderId: '', connectionId: '' }
  let cancelled = { orderId: '', connectionId: '' }
  let elsewhere = { orderId: '' }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const member = await actorWithPermissions(owner, app, {
      prefix,
      name: `agent${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.ORDERS_VIEW, Permissions.SHIPPING_VIEW]
    })
    agent = api(app, member, ctx.storeA)
    const exporting = await actorWithPermissions(owner, app, {
      prefix,
      name: `exporter${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.ORDERS_VIEW, Permissions.ORDERS_EXPORT]
    })
    exporter = api(app, exporting, ctx.storeA)
    const fullExporter = await actorWithPermissions(owner, app, {
      prefix,
      name: `fullexp${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.ORDERS_VIEW, Permissions.ORDERS_EXPORT, Permissions.SHIPPING_VIEW]
    })
    shippingExporter = api(app, fullExporter, ctx.storeA)
    live = await createShipment(owner, { storeId: ctx.storeA.id })
    cancelled = await createShipment(owner, {
      storeId: ctx.storeA.id,
      status: ShipmentStatus.CANCELLED
    })
    elsewhere = await createShipment(owner, { storeId: ctx.storeB.id })
    const viewer = await actorWithPermissions(owner, app, {
      prefix,
      name: `viewer${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.ORDERS_VIEW]
    })
    limited = api(app, viewer, ctx.storeA)
    await owner.order.update({
      where: { id: live.orderId },
      data: { carrierConnectionId: live.connectionId }
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const idsOf = (body: unknown): string[] => (body as { data: OrderRow[] }).data.map(row => row.id)

  it('lists the orders with a live guide, and leaves out the one whose guide was cancelled', async () => {
    const response = await agent.get(`${ApiRoutes.orders.list}?guide=${OrderGuideFilters.WITH}`)
    expect(response.status).toBe(OK)
    expect(idsOf(response.body)).toContain(live.orderId)
    expect(idsOf(response.body)).not.toContain(cancelled.orderId)
  })

  it('lists the orders without a live guide: the cancelled one is ready for another', async () => {
    const response = await agent.get(`${ApiRoutes.orders.list}?guide=${OrderGuideFilters.WITHOUT}`)
    expect(response.status).toBe(OK)
    expect(idsOf(response.body)).toContain(cancelled.orderId)
    expect(idsOf(response.body)).not.toContain(live.orderId)
  })

  it('filters by the planned carrier and tells it on each row', async () => {
    const response = await agent.get(
      `${ApiRoutes.orders.list}?carrierConnectionId=${live.connectionId}`
    )
    expect(response.status).toBe(OK)
    expect(idsOf(response.body)).toEqual([live.orderId])
    expect((response.body as { data: OrderRow[] }).data[0]?.carrierConnectionId).toBe(
      live.connectionId
    )
  })

  it('never reads a guide of another store', async () => {
    const response = await agent.get(
      `${ApiRoutes.orders.list}?carrierConnectionId=${elsewhere.orderId}`
    )
    expect(response.status).toBe(OK)
    expect(idsOf(response.body)).toEqual([])
  })

  it('hands the same filters to the export, which keeps them in its row', async () => {
    const query = `guide=${OrderGuideFilters.WITH}&carrierConnectionId=${live.connectionId}`
    // Without the right to export, the filters change nothing: the same refusal as before
    expect((await agent.get(`${ApiRoutes.orders.export}?${query}`)).status).toBe(FORBIDDEN)
    // The right to export is not the right to see the shipping data the filters read
    expect((await exporter.get(`${ApiRoutes.orders.export}?${query}`)).status).toBe(FORBIDDEN)
    const response = await shippingExporter.get(`${ApiRoutes.orders.export}?${query}`)
    expect(response.status).toBe(ACCEPTED)
    const row = await owner.export.findFirstOrThrow({
      where: { storeId: ctx.storeA.id },
      orderBy: { createdAt: 'desc' },
      select: { filters: true }
    })
    expect(row.filters).toMatchObject({
      guide: OrderGuideFilters.WITH,
      carrierConnectionId: live.connectionId
    })
  })

  it('asks shipping:view for the carrier and guide filters, on the list and the export', async () => {
    const guide = `guide=${OrderGuideFilters.WITH}`
    const carrier = `carrierConnectionId=${live.connectionId}`
    for (const query of [guide, carrier]) {
      expect((await limited.get(`${ApiRoutes.orders.list}?${query}`)).status).toBe(FORBIDDEN)
    }
    expect((await limited.get(ApiRoutes.orders.list)).status).toBe(OK)
  })

  it('never finds an order of this store through a carrier connection of another', async () => {
    // An order of store A that points at the connection of store B cannot exist (composite key): the filter finds nothing
    const response = await agent.get(
      `${ApiRoutes.orders.list}?carrierConnectionId=${elsewhere.connectionId}&guide=${OrderGuideFilters.WITH}`
    )
    expect(response.status).toBe(OK)
    expect(idsOf(response.body)).toEqual([])
    const without = await agent.get(`${ApiRoutes.orders.list}?guide=${OrderGuideFilters.WITH}`)
    expect(idsOf(without.body)).not.toContain(elsewhere.orderId)
  })

  it('refuses a guide filter that is not ours', async () => {
    const response = await agent.get(`${ApiRoutes.orders.list}?guide=maybe`)
    expect(response.status).toBe(BAD_REQUEST)
  })

  it('answers the shipments of the orders of a page in one request', async () => {
    const response = await agent.get(
      `${ApiRoutes.shipments.list}?orderIds=${live.orderId},${cancelled.orderId}`
    )
    expect(response.status).toBe(OK)
    const found = (response.body as { data: { orderId: string }[] }).data.map(row => row.orderId)
    expect(found.sort()).toEqual([live.orderId, cancelled.orderId].sort())
  })

  it('does not answer the shipments of an order of another store', async () => {
    const response = await agent.get(`${ApiRoutes.shipments.list}?orderIds=${elsewhere.orderId}`)
    expect(response.status).toBe(OK)
    expect((response.body as { data: unknown[] }).data).toEqual([])
  })

  it('refuses a list that is empty, malformed, too long or next to a single order', async () => {
    const tooMany = Array.from({ length: MAX_ORDERS + 1 }, () => randomUUID()).join(',')
    for (const query of [
      'orderIds=',
      'orderIds=not-an-id',
      `orderIds=${tooMany}`,
      `orderIds=${live.orderId},${live.orderId}`,
      `orderIds=${live.orderId},${live.orderId.toUpperCase()}`,
      `orderIds=${live.orderId}&orderId=${live.orderId}`
    ]) {
      const response = await agent.get(`${ApiRoutes.shipments.list}?${query}`)
      expect(response.status).toBe(BAD_REQUEST)
    }
  })
})
