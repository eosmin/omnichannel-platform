import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions, RoleNames } from '@platform/core/auth'
import { PrismaService, RLS_CONTEXT_ENABLED } from '@platform/core/database'
import { connectionUrls, ensureMembership, type OwnerClient } from '@platform/core/database-testing'
import {
  FinanceCountryCodes,
  InventoryReferenceType,
  PurchaseConflicts,
  PurchaseOrderStatus
} from '@platform/core/domain'

import { createInventoryLevel, createProduct } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api, type Actor } from '../helpers/http'

interface OrderBody {
  id: string
  status: string
  lines: { id: string; storeId: string; receivedQuantity: number }[]
}

const OK = 200
const NOT_FOUND = 404
const UNIT_COST_CENTS = 500
const CREATED = 201
const BAD_REQUEST = 400
const CONFLICT = 409
const STOCK = 10
const QUANTITY = 6
const TODAY = new Date().toISOString().slice(0, 10)

// RLS phase 6: with the switch ON the context of a request holds the store of X-Store-Id alone. A purchase order of an organization
// carries lines of SEVERAL of its stores (TDD_18 §2.1) and receiving it raises the stock of each of them (`inventory_levels` and
// `inventory_movements` are tables of a STORE; the purchase tables themselves are of the organization). Written in the context of one
// store, the receipt wrote the levels of the sibling store outside it and the policy refused it (42501): the person who belongs to
// both stores could not receive an order that spans them. The app below is the real one, on the role of the api, with the switch on
// and a context required for every query.
describe('RLS phase 6: purchase orders with lines of several stores of one organization', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let guarded: PrismaService
  let owner: OwnerClient
  let ctx: TestContext
  let vatId = ''
  // Admin of store A and of its sibling A2: the person the flow is made for
  let both: Actor
  // Holds the purchases permission in store A only (an Agent of A2)
  let half: Actor

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
    )
    ctx = await seedTestContext(owner, app, prefix)
    const setup = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.finance.setup)
      .send({ countryCode: FinanceCountryCodes.EL_SALVADOR, accountingStartDate: '2020-01-01' })
    expect(setup.status).toBe(CREATED)
    vatId = (
      await owner.taxRate.findFirstOrThrow({ where: { organizationId: ctx.orgA.id, code: 'IVA' } })
    ).id
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
    half = await createActor(owner, app, {
      prefix,
      name: `half${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.ADMIN]
    })
    await ensureMembership(owner, {
      userId: half.id,
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

  const asBoth = () => api(app, both, ctx.storeA)
  const asHalf = () => api(app, half, ctx.storeA)
  const key = (): string => `k${randomUUID().replaceAll('-', '')}`

  // A product of the store with STOCK units in the warehouse of store A, written as the owner (the fixture is not under test)
  async function stocked(storeId: string) {
    const product = await createProduct(owner, { storeId })
    await createInventoryLevel(owner, {
      storeId,
      productId: product.id,
      warehouseId: ctx.warehouseA.id,
      onHand: STOCK
    })
    return { storeId, productId: product.id }
  }
  const onHand = async (item: { storeId: string; productId: string }) =>
    (
      await owner.inventoryLevel.findFirst({
        where: { storeId: item.storeId, productId: item.productId, warehouseId: ctx.warehouseA.id }
      })
    )?.onHand ?? 0
  const valueOf = async (item: { storeId: string; productId: string }) =>
    (
      await owner.inventoryLevel.findFirstOrThrow({
        where: { storeId: item.storeId, productId: item.productId, warehouseId: ctx.warehouseA.id }
      })
    ).valueCents
  const movements = (item: { storeId: string; productId: string }) =>
    owner.inventoryMovement.count({
      where: {
        storeId: item.storeId,
        productId: item.productId,
        referenceType: InventoryReferenceType.PURCHASE_RECEIPT
      }
    })

  // A placed order of one line of store A and one of store A2, made by the person of both
  async function mixedOrder() {
    const mine = await stocked(ctx.storeA.id)
    const theirs = await stocked(ctx.storeA2.id)
    const seller = await asBoth()
      .post(ApiRoutes.suppliers.create)
      .send({ name: `Supplier ${randomUUID().slice(0, 8)}`, paymentTermsDays: 30 })
    expect(seller.status).toBe(CREATED)
    const created = await asBoth()
      .post(ApiRoutes.purchaseOrders.create)
      .send({
        idempotencyKey: key(),
        supplierId: (seller.body as { id: string }).id,
        warehouseId: ctx.warehouseA.id,
        lines: [mine, theirs].map(item => ({
          productId: item.productId,
          quantity: QUANTITY,
          unitCostCents: UNIT_COST_CENTS,
          taxRateId: vatId
        }))
      })
    expect(created.status).toBe(CREATED)
    const placed = await asBoth().post(
      ApiRoutes.purchaseOrders.order((created.body as OrderBody).id)
    )
    expect(placed.status).toBe(CREATED)
    return { mine, theirs, order: placed.body as OrderBody }
  }
  const receiveAll = (order: OrderBody, who: () => ReturnType<typeof api>, extra = {}) =>
    who()
      .post(ApiRoutes.purchaseOrders.receive(order.id))
      .send({
        idempotencyKey: key(),
        receivedOn: TODAY,
        lines: order.lines.map(line => ({ orderLineId: line.id, quantity: QUANTITY })),
        ...extra
      })

  it('receives the units of BOTH stores, or none', async () => {
    const { mine, theirs, order } = await mixedOrder()
    const before = { mine: await valueOf(mine), theirs: await valueOf(theirs) }

    const response = await receiveAll(order, asBoth)

    expect(response.status).toBe(CREATED)
    // Same stock and same value in both stores as with the switch off: the unit cost goes to the level of each line unchanged
    expect(await valueOf(mine)).toEqual(before.mine + BigInt(QUANTITY * UNIT_COST_CENTS))
    expect(await valueOf(theirs)).toEqual(before.theirs + BigInt(QUANTITY * UNIT_COST_CENTS))
    expect(await onHand(mine)).toBe(STOCK + QUANTITY)
    expect(await onHand(theirs)).toBe(STOCK + QUANTITY)
    expect(await movements(mine)).toBe(1)
    expect(await movements(theirs)).toBe(1)
    const lines = await owner.purchaseOrderLine.findMany({ where: { purchaseOrderId: order.id } })
    expect(lines.map(line => line.receivedQuantity)).toEqual([QUANTITY, QUANTITY])
  })

  it('refuses a caller with the permission in store A only, and moves nothing', async () => {
    const { mine, theirs, order } = await mixedOrder()

    const before = { mine: await valueOf(mine), theirs: await valueOf(theirs) }

    const response = await receiveAll(order, asHalf)

    expect(response.status).toBe(CONFLICT)
    expect((response.body as { error: { metadata?: unknown } }).error.metadata).toMatchObject({
      conflict: PurchaseConflicts.LINE_STORE_NOT_VISIBLE
    })
    expect(await valueOf(mine)).toBe(before.mine)
    expect(await valueOf(theirs)).toBe(before.theirs)
    expect(await owner.purchaseReceipt.count({ where: { purchaseOrderId: order.id } })).toBe(0)
    expect(await onHand(mine)).toBe(STOCK)
    expect(await onHand(theirs)).toBe(STOCK)
    expect(await movements(mine)).toBe(0)
    expect(await movements(theirs)).toBe(0)
    const stored = await owner.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })
    expect(stored.status).toBe(PurchaseOrderStatus.ORDERED)
  })

  it('shows a caller with the permission in store A only the lines of store A, and does not let them cancel the mixed order', async () => {
    const { order } = await mixedOrder()

    const read = await asHalf().get(ApiRoutes.purchaseOrders.byId(order.id))
    expect(read.status).toBe(OK)
    expect((read.body as OrderBody).lines.map(line => line.storeId)).toEqual([ctx.storeA.id])

    const cancelled = await asHalf().post(ApiRoutes.purchaseOrders.cancel(order.id)).send({})
    expect(cancelled.status).toBe(CONFLICT)
    expect((await owner.purchaseOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      PurchaseOrderStatus.ORDERED
    )
  })

  it('ignores the store and the organization the client sends', async () => {
    const { mine, theirs, order } = await mixedOrder()
    const lines = order.lines.map(line => ({ orderLineId: line.id, quantity: QUANTITY }))

    // In the body the schema is strict: a store or an organization of the client is refused, and nothing moves
    const refused = await asBoth()
      .post(ApiRoutes.purchaseOrders.receive(order.id))
      .send({ idempotencyKey: key(), receivedOn: TODAY, storeIds: [ctx.storeB.id], lines })
    expect(refused.status).toBe(BAD_REQUEST)
    expect(await onHand(mine)).toBe(STOCK)
    expect(await onHand(theirs)).toBe(STOCK)

    // In the query of a route that reads none it is not read: the stores are the ones of the organization of the guard
    const response = await asBoth()
      .post(ApiRoutes.purchaseOrders.receive(order.id))
      .query({ storeIds: ctx.storeB.id, organizationId: ctx.orgB.id, storeId: ctx.storeB.id })
      .send({ idempotencyKey: key(), receivedOn: TODAY, lines })
    expect(response.status).toBe(CREATED)
    expect(await onHand(mine)).toBe(STOCK + QUANTITY)
    expect(await onHand(theirs)).toBe(STOCK + QUANTITY)
    expect(
      await owner.inventoryMovement.count({
        where: { storeId: ctx.storeB.id, referenceType: InventoryReferenceType.PURCHASE_RECEIPT }
      })
    ).toBe(0)
  })

  it('does not show or move the order to a member of another organization', async () => {
    const { mine, theirs, order } = await mixedOrder()
    const outsider = api(
      app,
      await actorWithPermissions(owner, app, {
        prefix,
        name: `outsider${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgB.id,
        storeId: ctx.storeB.id,
        permissions: [Permissions.FINANCE_MANAGE_PURCHASES]
      }),
      ctx.storeB
    )

    const read = await outsider.get(ApiRoutes.purchaseOrders.byId(order.id))
    const moved = await receiveAll(order, () => outsider)

    expect(read.status).toBe(NOT_FOUND)
    expect(moved.status).toBe(NOT_FOUND)
    expect(await onHand(mine)).toBe(STOCK)
    expect(await onHand(theirs)).toBe(STOCK)
  })

  it('audits the receipt with the store of the header', async () => {
    const { order } = await mixedOrder()

    const response = await receiveAll(order, asBoth)
    expect(response.status).toBe(CREATED)

    const entries = await waitForAuditEntries(owner, {
      action: AuditAction.PURCHASE_ORDER_RECEIVED,
      organizationId: ctx.orgA.id,
      metadata: { path: ['purchaseOrderId'], equals: order.id }
    })
    expect(entries.map(entry => entry.storeId)).toEqual([ctx.storeA.id])
  })

  it('still reads the order for the person of both stores', async () => {
    const { order } = await mixedOrder()

    const read = await asBoth().get(ApiRoutes.purchaseOrders.byId(order.id))

    expect(read.status).toBe(OK)
    expect((read.body as OrderBody).lines.map(line => line.storeId).sort()).toEqual(
      [ctx.storeA.id, ctx.storeA2.id].sort()
    )
  })
})
