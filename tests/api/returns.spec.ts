import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { PaymentMethod } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { createCarrierConnection } from '../builders'
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

  // The replacement order of an exchange (PR R1b): made when the return is approved, already confirmed, with the value of what comes
  // back as its discount, so its total is the price difference, and with its own stock reserved wherever the allocator finds it
  describe('an exchange', () => {
    const exchange = (orderId: string, lines: unknown[]) =>
      open(orderId, lines, { type: 'exchange', reason: 'WRONG_ITEM' })

    function replacementOf(productId: string, quantity: number, extra = {}) {
      return {
        replacement: {
          items: [{ productId, quantity }],
          paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
          recipientPhones: ['71234567'],
          ...extra
        }
      }
    }

    async function approvedExchange(options: {
      returned: number
      replacementPriceCents: number
      replacementQuantity: number
      replacementStock?: [number, number]
      extra?: Record<string, unknown>
    }) {
      const { order, itemId, product } = await delivered(4)
      const [first, second] = options.replacementStock ?? [10, 0]
      const other = await kit.stocked(first, second, options.replacementPriceCents)
      const ret = (await exchange(order.id, [{ orderItemId: itemId, quantity: options.returned }]))
        .body as ReturnBody
      const approved = await admin()
        .post(ApiRoutes.returns.approve(ret.id))
        .send(replacementOf(other.id, options.replacementQuantity, options.extra))
      return { order, itemId, product, other, ret, approved }
    }

    it('makes a confirmed replacement whose total is the price difference, when the replacement costs more', async () => {
      // 2 units of 1000 come back (credit 2000); 2 units of 2500 go out (5000): the customer pays 3000
      const { ret, approved, other, order } = await approvedExchange({
        returned: 2,
        replacementPriceCents: 2500,
        replacementQuantity: 2
      })

      expect(approved.status).toBe(OK)
      const view = approved.body as ReturnBody & { replacementOrderId: string }
      expect(view.status).toBe('approved')
      expect(view.replacementOrderId).toEqual(expect.any(String))
      const replacement = (await admin().get(ApiRoutes.orders.byId(view.replacementOrderId)))
        .body as OrderBody
      expect(replacement).toMatchObject({
        status: 'CONFIRMED',
        subtotalCents: 5000,
        discountCents: 2000,
        totalCents: 3000,
        discountReason: `exchange_credit:${ret.id}`,
        priceApprovalStatus: 'not_required',
        customerId: ((await admin().get(ApiRoutes.orders.byId(order.id))).body as OrderBody)
          .customerId
      })
      expect(
        await owner.order.findFirst({
          where: { id: view.replacementOrderId },
          select: { exchangeOfOrderId: true, confirmedVia: true }
        })
      ).toEqual({ exchangeOfOrderId: order.id, confirmedVia: 'other' })
      // Its stock is reserved like any order's
      expect(await kit.level(other.id, ctx.warehouseA.id)).toMatchObject({
        onHand: 10,
        reserved: 2
      })
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.RETURN_APPROVED,
        resourceId: ret.id
      })
      expect(entries[0]?.metadata).toMatchObject({
        replacementOrderId: view.replacementOrderId,
        creditAppliedCents: 2000,
        excessCents: 0
      })
    })

    it('makes a replacement worth nothing to pay, and tells the owner what the credit left over, when it costs less', async () => {
      // 4 units of 1000 come back (credit 4000); 1 unit of 1000 goes out: the total is 0 and 3000 is left to settle by hand
      const { ret, approved } = await approvedExchange({
        returned: 4,
        replacementPriceCents: 1000,
        replacementQuantity: 1
      })

      expect(approved.status).toBe(OK)
      const replacement = (
        await admin().get(
          ApiRoutes.orders.byId(
            (approved.body as { replacementOrderId: string }).replacementOrderId
          )
        )
      ).body as OrderBody
      expect(replacement).toMatchObject({ subtotalCents: 1000, discountCents: 1000, totalCents: 0 })
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.RETURN_APPROVED,
        resourceId: ret.id
      })
      expect(entries[0]?.metadata).toMatchObject({ creditAppliedCents: 1000, excessCents: 3000 })
    })

    it('takes the replacement from another warehouse than the one the returned units go back to', async () => {
      // The replacement is stocked only in the warehouse of priority 2; the returned units were sent from the one of priority 1
      const { approved, other, product, ret, itemId } = await approvedExchange({
        returned: 1,
        replacementPriceCents: 1000,
        replacementQuantity: 3,
        replacementStock: [0, 5]
      })
      expect(approved.status).toBe(OK)
      const replacement = (
        await admin().get(
          ApiRoutes.orders.byId(
            (approved.body as { replacementOrderId: string }).replacementOrderId
          )
        )
      ).body as OrderBody
      expect(replacement.items[0]?.allocations).toEqual([
        { warehouseId: ctx.warehouseASecond.id, quantity: 3 }
      ])
      expect(await kit.level(other.id, ctx.warehouseASecond.id)).toMatchObject({
        onHand: 5,
        reserved: 3
      })

      expect(
        (
          await admin()
            .post(ApiRoutes.returns.receive(ret.id))
            .send({ lines: [{ orderItemId: itemId, condition: 'resellable' }] })
        ).status
      ).toBe(OK)
      // The returned unit is back where it left from, and the stock of the replacement did not move
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 7 })
      expect(await kit.level(other.id, ctx.warehouseASecond.id)).toMatchObject({
        onHand: 5,
        reserved: 3
      })
    })

    it('does not apply the discount limit nor ask for an approval to a credit above it', async () => {
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { preferences: { orders: { discountLimitPercent: 5 } } }
      })
      try {
        // 4000 of credit on a 4000 replacement is a discount of 100%, far above 5%
        const { approved } = await approvedExchange({
          returned: 4,
          replacementPriceCents: 4000,
          replacementQuantity: 1
        })
        expect(approved.status).toBe(OK)
        const replacement = (
          await admin().get(
            ApiRoutes.orders.byId(
              (approved.body as { replacementOrderId: string }).replacementOrderId
            )
          )
        ).body as OrderBody
        expect(replacement).toMatchObject({
          status: 'CONFIRMED',
          discountCents: 4000,
          totalCents: 0,
          priceApprovalStatus: 'not_required'
        })
      } finally {
        await kit.resetSettings()
      }
    })

    it('leaves the return requested and makes no order when the replacement cannot be made', async () => {
      const before = await owner.order.count({ where: { storeId: ctx.storeA.id } })
      // Two units asked, one on the shelf
      const { approved, ret, order } = await approvedExchange({
        returned: 1,
        replacementPriceCents: 1000,
        replacementQuantity: 2,
        replacementStock: [1, 0]
      })

      expect(approved.status).toBe(CONFLICT)
      expect(((await admin().get(ApiRoutes.returns.byId(ret.id))).body as ReturnBody).status).toBe(
        'requested'
      )
      // The delivered order of the helper is the only one made since
      expect(await owner.order.count({ where: { storeId: ctx.storeA.id } })).toBe(before + 1)
      expect(
        await owner.order.count({ where: { storeId: ctx.storeA.id, exchangeOfOrderId: order.id } })
      ).toBe(0)
    })

    it('refuses an exchange without its replacement, a refund with one, and a body that names a discount', async () => {
      const { order, itemId } = await delivered(2)
      const other = await kit.stocked(5, 0, 1000)
      const ex = (await exchange(order.id, [{ orderItemId: itemId, quantity: 1 }]))
        .body as ReturnBody
      expect((await admin().post(ApiRoutes.returns.approve(ex.id)).send()).status).toBe(BAD_REQUEST)
      expect(
        (
          await admin()
            .post(ApiRoutes.returns.approve(ex.id))
            .send(replacementOf(other.id, 1, { discountCents: 500 }))
        ).status
      ).toBe(BAD_REQUEST)
      const refund = await opened(order.id, itemId, 1)
      expect(
        (await admin().post(ApiRoutes.returns.approve(refund.id)).send(replacementOf(other.id, 1)))
          .status
      ).toBe(BAD_REQUEST)
      // Nothing moved
      for (const id of [ex.id, refund.id]) {
        expect(((await admin().get(ApiRoutes.returns.byId(id))).body as ReturnBody).status).toBe(
          'requested'
        )
      }
    })

    it('credits only what the customer paid when the returned order had a discount', async () => {
      // 4 units of 1000 with a discount of 2000: 4000 of products, 2000 paid. Two units come back: they are worth 1000
      const product = await kit.stocked(10)
      const body = await kit.orderBody({
        items: [{ productId: product.id, quantity: 4 }],
        discountCents: 2000,
        discountReason: 'loyal customer'
      })
      const created = await admin().post(ApiRoutes.orders.create).send(body)
      expect(created.status).toBe(CREATED)
      const order = (created.body as CreatedBody).order
      for (const next of ['CONFIRMED', 'SHIPPED', 'DELIVERED']) {
        expect((await orderStatus(order.id, { status: next })).status).toBe(OK)
      }
      const detail = (await admin().get(ApiRoutes.orders.byId(order.id))).body as OrderBody
      const ex = (
        await exchange(order.id, [{ orderItemId: detail.items[0]?.id ?? '', quantity: 2 }])
      ).body as ReturnBody
      const other = await kit.stocked(5, 0, 3000)

      const approved = await admin()
        .post(ApiRoutes.returns.approve(ex.id))
        .send(replacementOf(other.id, 1))

      expect(approved.status).toBe(OK)
      const replacement = (
        await admin().get(
          ApiRoutes.orders.byId(
            (approved.body as { replacementOrderId: string }).replacementOrderId
          )
        )
      ).body as OrderBody
      expect(replacement).toMatchObject({ discountCents: 1000, totalCents: 2000 })
    })

    it('records, by hand, the refund of what the credit left over, and no more', async () => {
      // 4 units come back (credit 4000), a replacement of 1000: 3000 is left over. The order was paid on delivery
      const { ret, order, itemId } = await approvedExchange({
        returned: 4,
        replacementPriceCents: 1000,
        replacementQuantity: 1
      })
      expect(
        (
          await owner.order.update({
            where: { id: order.id },
            data: { paymentStatus: 'COMPLETED' }
          })
        ).paymentStatus
      ).toBe('COMPLETED')
      expect(
        (
          await admin()
            .post(ApiRoutes.returns.receive(ret.id))
            .send({ lines: [{ orderItemId: itemId, condition: 'resellable' }] })
        ).status
      ).toBe(OK)

      const above = await admin()
        .post(ApiRoutes.returns.complete(ret.id))
        .send({ refundAmountCents: 3001 })
      expect(above.status).toBe(CONFLICT)
      expect(errorOf(above).code).toBe(ErrorCodes.RETURN_REFUND_EXCEEDS_PAID)
      expect(errorOf(above).metadata).toMatchObject({ roomCents: 3000 })

      const done = await admin()
        .post(ApiRoutes.returns.complete(ret.id))
        .send({ refundAmountCents: 3000 })
      expect(done.status).toBe(OK)
      expect((done.body as ReturnBody).refundAmountCents).toBe(3000)
      // The returned order keeps its payment: the customer keeps the goods of the replacement
      expect(
        ((await admin().get(ApiRoutes.orders.byId(order.id))).body as OrderBody).paymentStatus
      ).toBe('COMPLETED')
    })

    it('refuses a price of the agent in a line of the replacement, and a member who cannot create and confirm orders', async () => {
      const { order, itemId } = await delivered(2)
      const other = await kit.stocked(5, 0, 1000)
      const ex = (await exchange(order.id, [{ orderItemId: itemId, quantity: 1 }]))
        .body as ReturnBody
      const priced = {
        replacement: {
          ...replacementOf(other.id, 1).replacement,
          items: [{ productId: other.id, quantity: 1, unitPriceCents: 1, priceReason: 'x' }]
        }
      }
      expect((await admin().post(ApiRoutes.returns.approve(ex.id)).send(priced)).status).toBe(
        BAD_REQUEST
      )

      for (const permissions of [
        [Permissions.RETURNS_MANAGE, Permissions.RETURNS_VIEW],
        [Permissions.RETURNS_MANAGE, Permissions.RETURNS_VIEW, Permissions.ORDERS_CREATE]
      ]) {
        const member = await actorWithPermissions(owner, app, {
          prefix,
          name: `exchangeApprover${permissions.length}`,
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          permissions
        })
        const denied = await api(app, member, ctx.storeA)
          .post(ApiRoutes.returns.approve(ex.id))
          .send(replacementOf(other.id, 1))
        expect(denied.status).toBe(FORBIDDEN)
      }
      expect(((await admin().get(ApiRoutes.returns.byId(ex.id))).body as ReturnBody).status).toBe(
        'requested'
      )
    })

    it('refuses a replacement whose shipping fee is out of the range of its carrier', async () => {
      const { order, itemId } = await delivered(2)
      const other = await kit.stocked(5, 0, 1000)
      const connection = await createCarrierConnection(owner, { storeId: ctx.storeA.id })
      await owner.carrierConnection.update({
        where: { id: connection.id },
        data: { minShippingFeeCents: 500 }
      })
      const ex = (await exchange(order.id, [{ orderItemId: itemId, quantity: 1 }]))
        .body as ReturnBody

      const refused = await admin()
        .post(ApiRoutes.returns.approve(ex.id))
        .send(
          replacementOf(other.id, 1, { carrierConnectionId: connection.id, shippingCents: 100 })
        )

      expect(refused.status).toBe(CONFLICT)
      expect(errorOf(refused).code).toBe(ErrorCodes.SHIPPING_FEE_OUT_OF_RANGE)
      expect(((await admin().get(ApiRoutes.returns.byId(ex.id))).body as ReturnBody).status).toBe(
        'requested'
      )
    })

    it('refuses a replacement of a product of another store, and approving it twice makes one order', async () => {
      const { order, itemId } = await delivered(2)
      const ex = (await exchange(order.id, [{ orderItemId: itemId, quantity: 1 }]))
        .body as ReturnBody
      const foreign = await admin()
        .post(ApiRoutes.returns.approve(ex.id))
        .send(replacementOf(randomUUID(), 1))
      expect(foreign.status).toBe(NOT_FOUND)

      const other = await kit.stocked(5, 0, 1000)
      const body = replacementOf(other.id, 1)
      expect((await admin().post(ApiRoutes.returns.approve(ex.id)).send(body)).status).toBe(OK)
      const again = await admin().post(ApiRoutes.returns.approve(ex.id)).send(body)
      expect(again.status).toBe(CONFLICT)
      expect(
        await owner.order.count({ where: { storeId: ctx.storeA.id, exchangeOfOrderId: order.id } })
      ).toBe(1)
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
