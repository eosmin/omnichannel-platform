import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'

import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import {
  type CreatedBody,
  type ErrorBody,
  type OrderBody,
  ordersKit,
  type OrdersKit
} from '../helpers/orders'

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

interface ReturnBody {
  id: string
  orderId: string
  status: string
  type: string
  refundAmountCents: number | null
  lines: {
    id: string
    orderItemId: string
    quantity: number
    condition: string | null
    restockWarehouseId: string | null
  }[]
}

// The returns of a delivered order (Step 4.12 PR R1): the quantity limits, the machine of states, the stock that each condition
// moves (once, never twice), the order that becomes RETURNED only when every unit is back, and the refund recorded by hand.
describe('The returns of an order', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let kit: OrdersKit

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    kit = ordersKit(owner, app, ctx)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  const admin = () => kit.asAdmin()
  const orderStatus = (orderId: string, body: Record<string, unknown>) =>
    admin().post(ApiRoutes.orders.status(orderId)).send(body)
  const movements = (productId: string) =>
    owner.inventoryMovement.findMany({ where: { productId }, orderBy: { seq: 'asc' } })

  // An order of `quantity` units of a product with 10 in stock, taken to DELIVERED (the stock of the units left the shelf)
  async function delivered(quantity = 4) {
    const product = await kit.stocked(10)
    const body = await kit.orderBody({ items: [{ productId: product.id, quantity }] })
    const created = await admin().post(ApiRoutes.orders.create).send(body)
    expect(created.status).toBe(CREATED)
    const order = (created.body as CreatedBody).order
    for (const next of ['CONFIRMED', 'SHIPPED', 'DELIVERED']) {
      expect((await orderStatus(order.id, { status: next })).status).toBe(OK)
    }
    const detail = (await admin().get(ApiRoutes.orders.byId(order.id))).body as OrderBody & {
      items: { id: string }[]
    }
    return { order, product, itemId: detail.items[0]?.id ?? '' }
  }

  const open = (orderId: string, lines: unknown[], extra: Record<string, unknown> = {}) =>
    admin()
      .post(ApiRoutes.returns.create)
      .send({ orderId, type: 'refund', reason: 'DEFECTIVE', lines, ...extra })

  async function opened(orderId: string, itemId: string, quantity: number) {
    const response = await open(orderId, [{ orderItemId: itemId, quantity }])
    expect(response.status).toBe(CREATED)
    return response.body as ReturnBody
  }

  describe('opening one', () => {
    it('limits each line to what was delivered minus what other returns hold, and a partial return keeps the order delivered', async () => {
      const { order, itemId } = await delivered(4)

      const above = await open(order.id, [{ orderItemId: itemId, quantity: 5 }])
      expect(above.status).toBe(CONFLICT)
      expect(errorOf(above).code).toBe(ErrorCodes.RETURN_QUANTITY_EXCEEDS_DELIVERED)

      const first = await opened(order.id, itemId, 3)
      expect(first.status).toBe('requested')
      const second = await open(order.id, [{ orderItemId: itemId, quantity: 2 }])
      expect(second.status).toBe(CONFLICT)
      expect(errorOf(second).code).toBe(ErrorCodes.RETURN_QUANTITY_EXCEEDS_DELIVERED)
      const last = await open(order.id, [{ orderItemId: itemId, quantity: 1 }])
      expect(last.status).toBe(CREATED)

      // A rejected return gives its units back
      expect((await admin().post(ApiRoutes.returns.reject(first.id)).send({})).status).toBe(OK)
      expect((await open(order.id, [{ orderItemId: itemId, quantity: 3 }])).status).toBe(CREATED)
      // So does a cancelled one: everything is held again (3 + 1), and the unit it frees can be asked for
      const full = await open(order.id, [{ orderItemId: itemId, quantity: 1 }])
      expect(full.status).toBe(CONFLICT)
      expect(
        (
          await admin()
            .post(ApiRoutes.returns.cancel((last.body as ReturnBody).id))
            .send({})
        ).status
      ).toBe(OK)
      expect((await open(order.id, [{ orderItemId: itemId, quantity: 1 }])).status).toBe(CREATED)
      expect(((await admin().get(ApiRoutes.orders.byId(order.id))).body as OrderBody).status).toBe(
        'DELIVERED'
      )
    })

    it('refuses an order that was not delivered, an item of another order, a repeated line and a bad body', async () => {
      const product = await kit.stocked(10)
      const body = await kit.orderBody({ items: [{ productId: product.id, quantity: 1 }] })
      const created = (await admin().post(ApiRoutes.orders.create).send(body)).body as CreatedBody
      const early = await open(created.order.id, [{ orderItemId: randomUUID(), quantity: 1 }])
      expect(early.status).toBe(CONFLICT)
      expect(errorOf(early).code).toBe(ErrorCodes.RETURN_ORDER_NOT_DELIVERED)

      const { order, itemId } = await delivered(2)
      expect((await open(order.id, [{ orderItemId: randomUUID(), quantity: 1 }])).status).toBe(
        BAD_REQUEST
      )
      expect(
        (
          await open(order.id, [
            { orderItemId: itemId, quantity: 1 },
            { orderItemId: itemId, quantity: 1 }
          ])
        ).status
      ).toBe(BAD_REQUEST)
      expect((await open(order.id, [{ orderItemId: itemId, quantity: 0 }])).status).toBe(
        BAD_REQUEST
      )
      expect((await open(order.id, [])).status).toBe(BAD_REQUEST)
      expect(
        (await open(order.id, [{ orderItemId: itemId, quantity: 1 }], { storeId: 'x' })).status
      ).toBe(BAD_REQUEST)
      // An exchange waits for PR R1b
      expect(
        (await open(order.id, [{ orderItemId: itemId, quantity: 1 }], { type: 'exchange' })).status
      ).toBe(BAD_REQUEST)
    })
  })

  describe('the notes', () => {
    it('keeps the note of the request when a decision adds its own', async () => {
      const { order, itemId } = await delivered(2)
      const ret = (
        await open(order.id, [{ orderItemId: itemId, quantity: 1 }], {
          notes: 'box arrived crushed'
        })
      ).body as ReturnBody

      const rejected = await admin()
        .post(ApiRoutes.returns.reject(ret.id))
        .send({ notes: 'duplicate' })

      expect(rejected.status).toBe(OK)
      expect((rejected.body as ReturnBody & { notes: string }).notes).toBe(
        'box arrived crushed\nduplicate'
      )
    })
  })

  describe('the machine of states', () => {
    it('moves forward only, and a receipt needs an approval first', async () => {
      const { order, itemId } = await delivered(2)
      const ret = await opened(order.id, itemId, 1)
      const line = [{ orderItemId: itemId, condition: 'resellable' }]

      const early = await admin().post(ApiRoutes.returns.receive(ret.id)).send({ lines: line })
      expect(early.status).toBe(CONFLICT)
      expect(errorOf(early).code).toBe(ErrorCodes.RETURN_INVALID_STATUS_TRANSITION)

      expect((await admin().post(ApiRoutes.returns.approve(ret.id)).send()).status).toBe(OK)
      const again = await admin().post(ApiRoutes.returns.approve(ret.id)).send()
      expect(again.status).toBe(CONFLICT)
      expect(errorOf(again).code).toBe(ErrorCodes.RETURN_INVALID_STATUS_TRANSITION)
      expect((await admin().post(ApiRoutes.returns.inTransit(ret.id)).send()).status).toBe(OK)
      const cancelled = await admin().post(ApiRoutes.returns.cancel(ret.id)).send({})
      expect(cancelled.status).toBe(CONFLICT)
      expect(errorOf(cancelled).code).toBe(ErrorCodes.RETURN_INVALID_STATUS_TRANSITION)
      expect(
        (await admin().post(ApiRoutes.returns.receive(ret.id)).send({ lines: line })).status
      ).toBe(OK)
      expect((await admin().post(ApiRoutes.returns.complete(ret.id)).send({})).status).toBe(OK)
      const done = await admin().post(ApiRoutes.returns.complete(ret.id)).send({})
      expect(done.status).toBe(CONFLICT)
      expect(errorOf(done).code).toBe(ErrorCodes.RETURN_INVALID_STATUS_TRANSITION)
    })
  })

  describe('the notice', () => {
    it('tells the members who receive returns, but not who marked it, once the goods are on their way', async () => {
      const { order, itemId } = await delivered(2)
      const ret = await opened(order.id, itemId, 1)
      await admin().post(ApiRoutes.returns.approve(ret.id)).send()
      const receiver = await actorWithPermissions(owner, app, {
        prefix,
        name: `rr${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.RETURNS_MANAGE, Permissions.RETURNS_VIEW]
      })
      // Without the permission to read the screen the notice links to, nobody is told
      const blind = await actorWithPermissions(owner, app, {
        prefix,
        name: `rb${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.RETURNS_MANAGE]
      })

      expect((await admin().post(ApiRoutes.returns.inTransit(ret.id)).send()).status).toBe(OK)

      // The event leaves after the commit and the listener works on its own: the notice is awaited, not assumed
      let told: { userId: string }[] = []
      for (let attempt = 0; attempt < 50 && told.length === 0; attempt += 1) {
        told = await owner.notification.findMany({
          where: { storeId: ctx.storeA.id, resourceId: ret.id, type: 'return.awaiting_receipt' }
        })
        if (told.length === 0) await new Promise(resolve => setTimeout(resolve, 100))
      }
      // The rows come one per recipient: after the first, the others get a moment to arrive before "nobody else" is asserted
      await new Promise(resolve => setTimeout(resolve, 500))
      told = await owner.notification.findMany({
        where: { storeId: ctx.storeA.id, resourceId: ret.id, type: 'return.awaiting_receipt' }
      })
      const users = told.map(row => row.userId)
      expect(users).toContain(receiver.id)
      expect(users).not.toContain(ctx.adminA.id)
      expect(users).not.toContain(blind.id)
    })
  })

  describe('the receipt', () => {
    it('adds a resellable unit back to the shelf once, in the warehouse it left from, and keeps a partial return delivered', async () => {
      const { order, product, itemId } = await delivered(4)
      const ret = await opened(order.id, itemId, 1)
      await admin().post(ApiRoutes.returns.approve(ret.id)).send()
      const line = [{ orderItemId: itemId, condition: 'resellable' }]

      expect(
        (await admin().post(ApiRoutes.returns.receive(ret.id)).send({ lines: line })).status
      ).toBe(OK)
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 7 })
      expect((await movements(product.id)).map(row => row.type)).toEqual([
        'receipt',
        'reserve',
        'issue',
        'return_in'
      ])
      // A retry of the same receipt does not count it twice
      expect(
        (await admin().post(ApiRoutes.returns.receive(ret.id)).send({ lines: line })).status
      ).toBe(CONFLICT)
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 7 })
      expect(((await admin().get(ApiRoutes.orders.byId(order.id))).body as OrderBody).status).toBe(
        'DELIVERED'
      )
      const stored = (await admin().get(ApiRoutes.returns.byId(ret.id))).body as ReturnBody
      expect(stored.status).toBe('received')
      expect(stored.lines[0]).toMatchObject({
        condition: 'resellable',
        restockWarehouseId: ctx.warehouseA.id
      })
    })

    it('adds a defective unit and discards it, so the net stock does not change and the ledger shows both', async () => {
      const { order, product, itemId } = await delivered(4)
      const ret = await opened(order.id, itemId, 2)
      await admin().post(ApiRoutes.returns.approve(ret.id)).send()

      const response = await admin()
        .post(ApiRoutes.returns.receive(ret.id))
        .send({ lines: [{ orderItemId: itemId, condition: 'defective' }] })

      expect(response.status).toBe(OK)
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 6 })
      const rows = await movements(product.id)
      expect(rows.map(row => row.type)).toEqual([
        'receipt',
        'reserve',
        'issue',
        'return_in',
        'adjustment_out'
      ])
      expect(rows.at(-1)).toMatchObject({ reason: 'damaged', quantity: 2, referenceType: 'return' })
    })

    it('puts units in the warehouse the person chose, and refuses one the store does not sell from', async () => {
      const { order, product, itemId } = await delivered(2)
      const ret = await opened(order.id, itemId, 1)
      await admin().post(ApiRoutes.returns.approve(ret.id)).send()

      const foreign = await admin()
        .post(ApiRoutes.returns.receive(ret.id))
        .send({
          lines: [
            { orderItemId: itemId, condition: 'resellable', restockWarehouseId: ctx.warehouseB.id }
          ]
        })
      expect(foreign.status).toBe(CONFLICT)
      expect(errorOf(foreign).code).toBe(ErrorCodes.INVENTORY_WAREHOUSE_NOT_LINKED)
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 8 })

      const chosen = await admin()
        .post(ApiRoutes.returns.receive(ret.id))
        .send({
          lines: [
            {
              orderItemId: itemId,
              condition: 'resellable',
              restockWarehouseId: ctx.warehouseASecond.id
            }
          ]
        })
      expect(chosen.status).toBe(OK)
      expect(await kit.level(product.id, ctx.warehouseASecond.id)).toMatchObject({ onHand: 1 })
    })

    it('needs every line of the return named once', async () => {
      const { order, itemId } = await delivered(2)
      const ret = await opened(order.id, itemId, 1)
      await admin().post(ApiRoutes.returns.approve(ret.id)).send()

      for (const lines of [
        [],
        [{ orderItemId: randomUUID(), condition: 'resellable' }],
        [
          { orderItemId: itemId, condition: 'resellable' },
          { orderItemId: itemId, condition: 'damaged' }
        ]
      ]) {
        const response = await admin().post(ApiRoutes.returns.receive(ret.id)).send({ lines })
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('returns the order when the units that are back cover every one, and not before', async () => {
      const { order, itemId } = await delivered(2)
      const line = [{ orderItemId: itemId, condition: 'resellable' }]
      const first = await opened(order.id, itemId, 1)
      const second = await opened(order.id, itemId, 1)
      for (const ret of [first, second])
        await admin().post(ApiRoutes.returns.approve(ret.id)).send()

      await admin().post(ApiRoutes.returns.receive(first.id)).send({ lines: line })
      expect(((await admin().get(ApiRoutes.orders.byId(order.id))).body as OrderBody).status).toBe(
        'DELIVERED'
      )
      await admin().post(ApiRoutes.returns.receive(second.id)).send({ lines: line })
      expect(((await admin().get(ApiRoutes.orders.byId(order.id))).body as OrderBody).status).toBe(
        'RETURNED'
      )
    })

    it('stops a hand-made RETURNED while a return holds units', async () => {
      const { order, itemId } = await delivered(2)
      await opened(order.id, itemId, 1)

      const response = await orderStatus(order.id, { status: 'RETURNED', restock: true })

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.ORDER_HAS_ACTIVE_RETURNS)
    })
  })

  describe('the refund', () => {
    it('is recorded by hand, never passes what was paid, and refunds the payment when it equals the total', async () => {
      const { order, itemId } = await delivered(2)
      expect(
        (
          await admin()
            .post(ApiRoutes.orders.payment(order.id))
            .send({ method: 'CASH', status: 'COMPLETED' })
        ).status
      ).toBe(OK)
      const detail = (await admin().get(ApiRoutes.orders.byId(order.id))).body as OrderBody
      const ret = await opened(order.id, itemId, 2)
      await admin().post(ApiRoutes.returns.approve(ret.id)).send()
      await admin()
        .post(ApiRoutes.returns.receive(ret.id))
        .send({ lines: [{ orderItemId: itemId, condition: 'resellable' }] })

      const above = await admin()
        .post(ApiRoutes.returns.complete(ret.id))
        .send({ refundAmountCents: detail.totalCents + 1 })
      expect(above.status).toBe(CONFLICT)
      expect(errorOf(above).code).toBe(ErrorCodes.RETURN_REFUND_EXCEEDS_PAID)

      const done = await admin()
        .post(ApiRoutes.returns.complete(ret.id))
        .send({ refundAmountCents: detail.totalCents })
      expect(done.status).toBe(OK)
      expect((done.body as ReturnBody).refundAmountCents).toBe(detail.totalCents)
      expect(
        ((await admin().get(ApiRoutes.orders.byId(order.id))).body as OrderBody).paymentStatus
      ).toBe('REFUNDED')
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.RETURN_REFUND_RECORDED,
        resourceId: ret.id
      })
      expect(entries[0]?.metadata).toMatchObject({ refundAmountCents: detail.totalCents })
    })
  })

  describe('who may', () => {
    it('lets a viewer read and nobody of another store see or move a return', async () => {
      const { order, itemId } = await delivered(2)
      const ret = await opened(order.id, itemId, 1)
      const viewer = await actorWithPermissions(owner, app, {
        prefix,
        name: `rv${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.RETURNS_VIEW]
      })
      const asViewer = api(app, viewer, ctx.storeA)
      expect((await asViewer.get(ApiRoutes.returns.byId(ret.id))).status).toBe(OK)
      expect((await asViewer.get(ApiRoutes.returns.list)).status).toBe(OK)
      expect((await asViewer.post(ApiRoutes.returns.approve(ret.id)).send()).status).toBe(FORBIDDEN)
      expect(
        (await asViewer.post(ApiRoutes.returns.create).send({ orderId: order.id })).status
      ).toBe(FORBIDDEN)

      const other = api(app, ctx.adminB, ctx.storeB)
      expect((await other.get(ApiRoutes.returns.byId(ret.id))).status).toBe(NOT_FOUND)
      expect((await other.post(ApiRoutes.returns.approve(ret.id)).send()).status).toBe(NOT_FOUND)
      const list = await other.get(ApiRoutes.returns.list)
      expect((list.body as { data: { id: string }[] }).data.map(row => row.id)).not.toContain(
        ret.id
      )
      const foreignOrder = await other.post(ApiRoutes.returns.create).send({
        orderId: order.id,
        type: 'refund',
        reason: 'DEFECTIVE',
        lines: [{ orderItemId: itemId, quantity: 1 }]
      })
      expect(foreignOrder.status).toBe(NOT_FOUND)
    })
  })
})
