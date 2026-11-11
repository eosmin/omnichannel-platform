import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { calendarDayIn, nextCalendarDay, PriceApprovalStatus } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Events } from '@platform/core/events'
import { NotificationTypes } from '@platform/core/notifications'
import { QueueNames } from '@platform/core/queues'

import { createProduct } from '../builders'
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
  type OrdersKit,
  type PageBody
} from '../helpers/orders'
import { CapturedQueue } from '../helpers/queue'

const OK = 200
const CREATED = 201
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

// The life of an order (Step 4.3 PR B): the changes of status and the stock that goes with each one (TDD_16 §4.1),
// the decisions on a price, the edits by field, the three notes, the payments recorded by hand and the filters of the
// scheduled delivery.
describe('The life of an order', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let kit: OrdersKit
  const pushQueue = new CapturedQueue()

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(getQueueToken(QueueNames.NOTIFICATIONS)).useValue(pushQueue)
    )
    ctx = await seedTestContext(owner, app, prefix)
    kit = ordersKit(owner, app, ctx)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  afterEach(async () => {
    await kit.resetSettings()
    await owner.store.update({
      where: { id: ctx.storeA.id },
      data: { timezone: 'America/El_Salvador' }
    })
    await owner.notification.deleteMany({ where: { storeId: ctx.storeA.id } })
  })

  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  async function member(
    name: string,
    permissions: Parameters<typeof actorWithPermissions>[2]['permissions']
  ) {
    const actor = await actorWithPermissions(owner, app, {
      prefix,
      name: `${name}${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions
    })
    return { actor, agent: api(app, actor, ctx.storeA) }
  }
  async function placed(extra: Record<string, unknown> = {}, quantity = 2) {
    const product = await kit.stocked(10)
    const body = await kit.orderBody({ items: [{ productId: product.id, quantity }], ...extra })
    const response = await kit.asAdmin().post(ApiRoutes.orders.create).send(body)
    expect(response.status).toBe(CREATED)
    return { order: (response.body as CreatedBody).order, product, body }
  }
  const status = (orderId: string, body: Record<string, unknown>, agent = kit.asAdmin()) =>
    agent.post(ApiRoutes.orders.status(orderId)).send(body)
  const edit = (orderId: string, body: Record<string, unknown>, agent = kit.asAdmin()) =>
    agent.patch(ApiRoutes.orders.byId(orderId)).send(body)
  const get = async (orderId: string) =>
    (await kit.asAdmin().get(ApiRoutes.orders.byId(orderId))).body as OrderBody
  const movements = (productId: string) =>
    owner.inventoryMovement.findMany({ where: { productId }, orderBy: { seq: 'asc' } })

  describe('the status', () => {
    it('refuses a transition the machine does not have, and confirming twice', async () => {
      const { order } = await placed()

      const skip = await status(order.id, { status: 'SHIPPED' })
      expect(skip.status).toBe(CONFLICT)
      expect(errorOf(skip).code).toBe(ErrorCodes.ORDER_INVALID_STATUS_TRANSITION)

      expect((await status(order.id, { status: 'CONFIRMED' })).status).toBe(OK)
      const again = await status(order.id, { status: 'CONFIRMED' })
      expect(again.status).toBe(CONFLICT)
      expect(errorOf(again).code).toBe(ErrorCodes.ORDER_ALREADY_CONFIRMED)

      expect(
        (await status(order.id, { status: 'CANCELLED', cancellationReason: 'changed mind' })).status
      ).toBe(OK)
      const back = await status(order.id, { status: 'CONFIRMED' })
      expect(back.status).toBe(CONFLICT)
    })

    it('needs the permission of the target: confirming and cancelling have their own, also through the status route', async () => {
      const { order } = await placed()
      const mover = await member('mover', [
        Permissions.ORDERS_VIEW,
        Permissions.ORDERS_CHANGE_STATUS
      ])

      const confirm = await status(order.id, { status: 'CONFIRMED' }, mover.agent)
      const cancel = await status(
        order.id,
        { status: 'CANCELLED', cancellationReason: 'x' },
        mover.agent
      )
      const viaRoute = await mover.agent
        .post(ApiRoutes.orders.confirm(order.id))
        .send({ via: 'call' })
      const viaCancel = await mover.agent
        .post(ApiRoutes.orders.cancel(order.id))
        .send({ cancellationReason: 'x' })

      for (const response of [confirm, cancel, viaRoute, viaCancel]) {
        expect(response.status).toBe(FORBIDDEN)
      }
      expect((await get(order.id)).status).toBe('PENDING_CONFIRMATION')
      // Once confirmed by someone who may, the mover prepares it
      await status(order.id, { status: 'CONFIRMED' })
      expect((await status(order.id, { status: 'PREPARING' }, mover.agent)).status).toBe(OK)
    })

    it('confirms with how the customer confirmed, and the creation moment is not a way to confirm later', async () => {
      const { order } = await placed()

      const bad = await kit
        .asAdmin()
        .post(ApiRoutes.orders.confirm(order.id))
        .send({ via: 'at_creation' })
      expect(bad.status).toBe(BAD_REQUEST)
      const ok = await kit.asAdmin().post(ApiRoutes.orders.confirm(order.id)).send({ via: 'call' })

      expect(ok.status).toBe(OK)
      expect((ok.body as OrderBody).confirmedVia).toBe('call')
      const row = await owner.order.findFirstOrThrow({ where: { id: order.id } })
      expect(row).toMatchObject({ confirmedBy: ctx.adminA.id, status: 'CONFIRMED' })
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_CONFIRMED,
        resourceId: order.id
      })
      expect(entries[0]?.metadata).toMatchObject({ via: 'call' })
    })

    it('asks for the reason of a cancellation, and refuses the fields of another status', async () => {
      const { order } = await placed()

      expect((await status(order.id, { status: 'CANCELLED' })).status).toBe(BAD_REQUEST)
      expect(
        (await status(order.id, { status: 'CONFIRMED', cancellationReason: 'x' })).status
      ).toBe(BAD_REQUEST)
      expect((await status(order.id, { status: 'CONFIRMED', restock: true })).status).toBe(
        BAD_REQUEST
      )
      expect((await kit.asAdmin().post(ApiRoutes.orders.cancel(order.id)).send({})).status).toBe(
        BAD_REQUEST
      )
    })

    it('is audited with the status before and after', async () => {
      const { order } = await placed()
      await status(order.id, { status: 'CONFIRMED' })
      await status(order.id, { status: 'PREPARING' })

      const entries = await waitForAuditEntries(
        owner,
        { action: AuditAction.ORDER_STATUS_CHANGED, resourceId: order.id },
        2
      )

      expect(entries.map(entry => entry.metadata)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ from: 'PENDING_CONFIRMATION', to: 'CONFIRMED' }),
          expect.objectContaining({ from: 'CONFIRMED', to: 'PREPARING' })
        ])
      )
    })
  })

  describe('the stock that goes with each change (TDD_16 §4.1)', () => {
    it('gives the reservation back when the order is cancelled before it ships', async () => {
      const { order, product } = await placed()
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({
        onHand: 10,
        reserved: 2
      })

      const response = await kit
        .asAdmin()
        .post(ApiRoutes.orders.cancel(order.id))
        .send({ cancellationReason: 'customer request' })

      expect(response.status).toBe(OK)
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({
        onHand: 10,
        reserved: 0
      })
      expect((await movements(product.id)).map(row => row.type)).toEqual([
        'receipt',
        'reserve',
        'release'
      ])
      const row = await owner.order.findFirstOrThrow({ where: { id: order.id } })
      expect(row).toMatchObject({
        status: 'CANCELLED',
        cancellationReason: 'customer request',
        cancelledBy: ctx.adminA.id
      })
      expect(row.cancelledAt).not.toBeNull()
    })

    it('issues the stock when the order ships: it leaves and its reservation is consumed, once', async () => {
      const { order, product } = await placed()
      await status(order.id, { status: 'CONFIRMED' })

      const response = await status(order.id, { status: 'SHIPPED' })

      expect(response.status).toBe(OK)
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({
        onHand: 8,
        reserved: 0
      })
      expect((await movements(product.id)).map(row => row.type)).toEqual([
        'receipt',
        'reserve',
        'issue'
      ])
      // Shipping twice is not a transition, and no second issue is made
      expect((await status(order.id, { status: 'SHIPPED' })).status).toBe(CONFLICT)
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({
        onHand: 8,
        reserved: 0
      })
    })

    it('does not cancel an order that already shipped', async () => {
      const { order } = await placed()
      await status(order.id, { status: 'CONFIRMED' })
      await status(order.id, { status: 'SHIPPED' })

      const response = await kit
        .asAdmin()
        .post(ApiRoutes.orders.cancel(order.id))
        .send({ cancellationReason: 'x' })

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.ORDER_CANNOT_BE_CANCELLED)
    })

    it('does nothing to the stock when the order is delivered', async () => {
      const { order, product } = await placed()
      await status(order.id, { status: 'CONFIRMED' })
      await status(order.id, { status: 'SHIPPED' })
      const before = (await movements(product.id)).length

      const response = await status(order.id, { status: 'DELIVERED' })

      expect(response.status).toBe(OK)
      expect((await movements(product.id)).length).toBe(before)
    })

    it('puts the units back on the shelf of the warehouse they left from when a return is restocked, and only then', async () => {
      const { order, product } = await placed()
      await status(order.id, { status: 'CONFIRMED' })
      await status(order.id, { status: 'SHIPPED' })
      await status(order.id, { status: 'DELIVERED' })

      const response = await status(order.id, { status: 'RETURNED', restock: true })

      expect(response.status).toBe(OK)
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({
        onHand: 10,
        reserved: 0
      })
      expect((await movements(product.id)).map(row => row.type)).toEqual([
        'receipt',
        'reserve',
        'issue',
        'return_in'
      ])
      const other = await placed()
      await status(other.order.id, { status: 'CONFIRMED' })
      await status(other.order.id, { status: 'SHIPPED' })
      await status(other.order.id, { status: 'RETURNED' })
      expect(await kit.level(other.product.id, ctx.warehouseA.id)).toMatchObject({
        onHand: 8,
        reserved: 0
      })
    })

    it('needs a permission over stock to put a return back on the shelf, and audits the choice', async () => {
      const { order, product } = await placed()
      await status(order.id, { status: 'CONFIRMED' })
      await status(order.id, { status: 'SHIPPED' })
      const mover = await member('returner', [
        Permissions.ORDERS_VIEW,
        Permissions.ORDERS_CHANGE_STATUS
      ])

      const denied = await status(order.id, { status: 'RETURNED', restock: true }, mover.agent)
      expect(denied.status).toBe(FORBIDDEN)
      expect((await get(order.id)).status).toBe('SHIPPED')
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 8 })

      const plain = await status(order.id, { status: 'RETURNED' }, mover.agent)
      expect(plain.status).toBe(OK)
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_STATUS_CHANGED,
        resourceId: order.id,
        metadata: { path: ['to'], equals: 'RETURNED' }
      })
      expect(entries[0]?.metadata).toMatchObject({ from: 'SHIPPED', to: 'RETURNED' })
    })

    it('applies each effect per allocation, in the warehouse of each', async () => {
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { allowSplitFulfillment: true }
      })
      const product = await kit.stocked(6, 8)
      const body = await kit.orderBody({ items: [{ productId: product.id, quantity: 10 }] })
      const created = (await kit.asAdmin().post(ApiRoutes.orders.create).send(body))
        .body as CreatedBody
      await status(created.order.id, { status: 'CONFIRMED' })

      await status(created.order.id, { status: 'SHIPPED' })

      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({
        onHand: 0,
        reserved: 0
      })
      expect(await kit.level(product.id, ctx.warehouseASecond.id)).toMatchObject({
        onHand: 4,
        reserved: 0
      })
    })

    it('rolls back the whole change when the stock refuses: nothing is half applied', async () => {
      const { order, product } = await placed()
      await status(order.id, { status: 'CONFIRMED' })
      // Somebody wrote the reservation off by hand: shipping now finds less reserved than the order holds
      await owner.inventoryLevel.updateMany({
        where: { productId: product.id, warehouseId: ctx.warehouseA.id },
        data: { reserved: 0 }
      })

      const response = await status(order.id, { status: 'SHIPPED' })

      expect(response.status).toBe(CONFLICT)
      expect((await get(order.id)).status).toBe('CONFIRMED')
      // Nothing of the shipping was applied: no issue in the ledger, the stock as it was, no audit entry of the move
      expect((await movements(product.id)).map(row => row.type)).toEqual(['receipt', 'reserve'])
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ onHand: 10 })
      const row = await owner.order.findFirstOrThrow({ where: { id: order.id } })
      expect(row.shippedAt).toBeNull()
    })
  })

  describe('delivery', () => {
    async function file(orderId: string, extra: Record<string, unknown> = {}) {
      return owner.media.create({
        data: {
          storeId: ctx.storeA.id,
          purpose: 'order',
          orderId,
          key: `it/${randomUUID()}`,
          filename: 'proof.jpg',
          contentType: 'image/jpeg',
          fileSize: 100,
          status: 'clean',
          ...extra
        },
        select: { id: true }
      })
    }
    async function shipped() {
      const made = await placed()
      await status(made.order.id, { status: 'CONFIRMED' })
      await status(made.order.id, { status: 'SHIPPED' })
      return made.order
    }

    it('stores the proof and the moment of delivery, and refuses a moment in the future', async () => {
      const order = await shipped()
      const proof = await file(order.id)
      const future = new Date(Date.now() + 3_600_000).toISOString()

      const late = await status(order.id, { status: 'DELIVERED', deliveredAt: future })
      expect(late.status).toBe(BAD_REQUEST)

      // After the shipping the test just made, and not in the future
      const moment = new Date().toISOString()
      const response = await status(order.id, {
        status: 'DELIVERED',
        deliveredAt: moment,
        proofOfDeliveryMediaId: proof.id
      })

      expect(response.status).toBe(OK)
      const row = await owner.order.findFirstOrThrow({ where: { id: order.id } })
      expect(row.proofOfDeliveryMediaId).toBe(proof.id)
      expect(row.deliveredAt?.toISOString()).toBe(moment)
    })

    it('refuses a delivery moment before the order shipped', async () => {
      const order = await shipped()

      const response = await status(order.id, {
        status: 'DELIVERED',
        deliveredAt: '2020-01-01T00:00:00Z'
      })

      expect(response.status).toBe(BAD_REQUEST)
      expect((await get(order.id)).status).toBe('SHIPPED')
    })

    it('does not take a file of another order, of another store, of another purpose or one the scan has not cleared', async () => {
      const order = await shipped()
      const another = await placed()
      const files = [
        await file(another.order.id),
        await file(order.id, { purpose: 'message' }),
        await file(order.id, { status: 'pending' }),
        await file(order.id, { storeId: ctx.storeB.id })
      ]

      for (const proof of files) {
        const response = await status(order.id, {
          status: 'DELIVERED',
          proofOfDeliveryMediaId: proof.id
        })
        expect(response.status).toBe(NOT_FOUND)
      }
      expect((await get(order.id)).status).toBe('SHIPPED')
    })
  })

  describe('the price decisions of TDD_17 §4.13', () => {
    // A member who creates orders and approves prices but holds no override: the order he makes with a discount waits
    async function pendingOrder() {
      const clerk = await member('clerk', [
        Permissions.ORDERS_VIEW,
        Permissions.ORDERS_CREATE,
        Permissions.ORDERS_EDIT,
        Permissions.ORDERS_APPROVE_PRICE
      ])
      const product = await kit.stocked(10)
      const body = await kit.orderBody({
        items: [{ productId: product.id, quantity: 2 }],
        discountCents: 100,
        discountReason: 'promo'
      })
      const response = await clerk.agent.post(ApiRoutes.orders.create).send(body)
      const order = (response.body as CreatedBody).order
      expect(order.priceApprovalStatus).toBe(PriceApprovalStatus.PENDING)
      return { clerk, order }
    }

    it('keeps the order from being confirmed or prepared until the price is approved, and approving stores what was accepted', async () => {
      const { order } = await pendingOrder()

      const blocked = await status(order.id, { status: 'CONFIRMED' })
      expect(blocked.status).toBe(CONFLICT)
      expect(errorOf(blocked).code).toBe(ErrorCodes.ORDER_PRICE_APPROVAL_PENDING)

      const approved = await kit
        .asAdmin()
        .post(ApiRoutes.orders.priceApprovalApprove(order.id))
        .send({})

      expect(approved.status).toBe(OK)
      expect(approved.body as OrderBody).toMatchObject({
        priceApprovalStatus: PriceApprovalStatus.APPROVED,
        priceApprovedBy: ctx.adminA.id,
        priceApprovedDiscountCents: 100
      })
      expect((await status(order.id, { status: 'CONFIRMED' })).status).toBe(OK)
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_PRICE_APPROVED,
        resourceId: order.id
      })
      expect(entries).toHaveLength(1)
    })

    it('does not let anybody approve their own request, but lets them reject it', async () => {
      const { clerk, order } = await pendingOrder()

      const self = await clerk.agent.post(ApiRoutes.orders.priceApprovalApprove(order.id)).send({})
      expect(self.status).toBe(FORBIDDEN)
      expect(errorOf(self).code).toBe(ErrorCodes.ORDER_PRICE_SELF_APPROVAL)

      const withdrawn = await clerk.agent
        .post(ApiRoutes.orders.priceApprovalReject(order.id))
        .send({ reason: 'changed my mind' })
      expect(withdrawn.status).toBe(OK)
      expect((withdrawn.body as OrderBody).priceApprovalStatus).toBe(PriceApprovalStatus.REJECTED)
    })

    it('does not decide the price of an order that left the warehouse or was cancelled', async () => {
      const { order } = await pendingOrder()
      await status(order.id, { status: 'CANCELLED', cancellationReason: 'x' })

      const response = await kit
        .asAdmin()
        .post(ApiRoutes.orders.priceApprovalApprove(order.id))
        .send({})

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.ORDER_PRICE_APPROVAL_NOT_PENDING)
    })

    it('answers 409 to a decision on an order that waits for none, and needs orders:approve_price', async () => {
      const { order } = await placed()
      const reader = await member('reader', [Permissions.ORDERS_VIEW])

      const none = await kit
        .asAdmin()
        .post(ApiRoutes.orders.priceApprovalApprove(order.id))
        .send({})
      const denied = await reader.agent
        .post(ApiRoutes.orders.priceApprovalReject(order.id))
        .send({})

      expect(none.status).toBe(CONFLICT)
      expect(errorOf(none).code).toBe(ErrorCodes.ORDER_PRICE_APPROVAL_NOT_PENDING)
      expect(denied.status).toBe(FORBIDDEN)
    })

    it('keeps a rejected order blocked until the discount comes back inside the limit, which clears the request', async () => {
      const { clerk, order } = await pendingOrder()
      await kit.asAdmin().post(ApiRoutes.orders.priceApprovalReject(order.id)).send({})
      expect((await status(order.id, { status: 'CONFIRMED' })).status).toBe(CONFLICT)

      const fixed = await edit(order.id, { discountCents: 0, discountReason: null }, clerk.agent)

      expect(fixed.status).toBe(OK)
      expect(fixed.body as OrderBody).toMatchObject({
        discountCents: 0,
        priceApprovalStatus: PriceApprovalStatus.NOT_REQUIRED,
        priceApprovalRequestedBy: null
      })
      expect((await status(order.id, { status: 'CONFIRMED' })).status).toBe(OK)
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_UPDATED,
        resourceId: order.id
      })
      expect(entries[0]?.metadata).toMatchObject({ priceRequestWithdrawn: true })
    })

    it('sends an approved order back to pending when an edit raises the discount above what was approved', async () => {
      const { clerk, order } = await pendingOrder()
      await kit.asAdmin().post(ApiRoutes.orders.priceApprovalApprove(order.id)).send({})

      const lower = await edit(
        order.id,
        { discountCents: 50, discountReason: 'promo' },
        clerk.agent
      )
      expect((lower.body as OrderBody).priceApprovalStatus).toBe(PriceApprovalStatus.APPROVED)
      const same = await edit(
        order.id,
        { discountCents: 100, discountReason: 'promo' },
        clerk.agent
      )
      expect((same.body as OrderBody).priceApprovalStatus).toBe(PriceApprovalStatus.APPROVED)
      const higher = await edit(
        order.id,
        { discountCents: 150, discountReason: 'promo' },
        clerk.agent
      )

      expect(higher.status).toBe(OK)
      expect(higher.body as OrderBody).toMatchObject({
        priceApprovalStatus: PriceApprovalStatus.PENDING,
        priceApprovedBy: null,
        priceApprovedDiscountCents: null,
        priceApprovalRequestedBy: clerk.actor.id
      })
    })

    it('makes whoever moves a pending price its requester, so they cannot approve what they set', async () => {
      const { clerk, order } = await pendingOrder()
      const second = await member('second', [
        Permissions.ORDERS_VIEW,
        Permissions.ORDERS_EDIT,
        Permissions.ORDERS_APPROVE_PRICE
      ])

      const moved = await edit(
        order.id,
        { discountCents: 150, discountReason: 'promo' },
        second.agent
      )
      expect(moved.status).toBe(OK)
      expect((moved.body as OrderBody).priceApprovalRequestedBy).toBe(second.actor.id)

      const self = await second.agent.post(ApiRoutes.orders.priceApprovalApprove(order.id)).send({})
      expect(self.status).toBe(FORBIDDEN)
      expect(errorOf(self).code).toBe(ErrorCodes.ORDER_PRICE_SELF_APPROVAL)
      // The first requester may now approve what the second one set
      const other = await clerk.agent.post(ApiRoutes.orders.priceApprovalApprove(order.id)).send({})
      expect(other.status).toBe(OK)
    })

    it('does not call an edit an override when it leaves the price as it was', async () => {
      const { order } = await placed({ discountCents: 100, discountReason: 'vip' })
      await new Promise(resolve => setTimeout(resolve, 200))
      const before = await owner.auditLog.count({
        where: { action: AuditAction.ORDER_PRICE_OVERRIDDEN, resourceId: order.id }
      })

      await edit(order.id, { recipientPhones: ['71234567', '22123456'], discountReason: 'vip' })
      await edit(order.id, { shippingCents: 0, discountCents: 100, discountReason: 'vip' })
      await new Promise(resolve => setTimeout(resolve, 300))

      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.ORDER_PRICE_OVERRIDDEN, resourceId: order.id }
        })
      ).toBe(before)
    })

    it('does not put an old discount to a new test when an agent edits only the fee', async () => {
      const { order } = await placed({ discountCents: 800, discountReason: 'vip' })
      expect(order.priceApprovalStatus).toBe(PriceApprovalStatus.NOT_REQUIRED)
      const agent = await member('fee', [Permissions.ORDERS_VIEW, Permissions.ORDERS_EDIT])

      const response = await edit(order.id, { shippingCents: 300 }, agent.agent)

      expect(response.status).toBe(OK)
      expect(response.body as OrderBody).toMatchObject({
        shippingCents: 300,
        discountCents: 800,
        priceApprovalStatus: PriceApprovalStatus.NOT_REQUIRED
      })
      // The same agent raising the discount is another matter
      const raised = await edit(
        order.id,
        { discountCents: 900, discountReason: 'vip' },
        agent.agent
      )
      expect((raised.body as OrderBody).priceApprovalStatus).toBe(PriceApprovalStatus.PENDING)
    })

    it('makes the member who changes the lines of a pending order its requester, so they cannot approve their own change', async () => {
      const { order } = await pendingOrder()
      const second = await member('liner', [
        Permissions.ORDERS_VIEW,
        Permissions.ORDERS_EDIT,
        Permissions.ORDERS_APPROVE_PRICE
      ])
      const product = await kit.stocked(10)

      const moved = await edit(
        order.id,
        { items: [{ productId: product.id, quantity: 3 }] },
        second.agent
      )

      expect(moved.status).toBe(OK)
      expect((moved.body as OrderBody).priceApprovalRequestedBy).toBe(second.actor.id)
      const self = await second.agent.post(ApiRoutes.orders.priceApprovalApprove(order.id)).send({})
      expect(self.status).toBe(FORBIDDEN)
    })

    it('does not clear the reason of a discount the order keeps', async () => {
      const { order } = await placed({ discountCents: 100, discountReason: 'vip' })

      const response = await edit(order.id, { shippingCents: 5, discountReason: null })

      expect(response.status).toBe(BAD_REQUEST)
      expect(errorOf(response).code).toBe(ErrorCodes.ORDER_PRICE_REASON_REQUIRED)
      expect((await get(order.id)).discountReason).toBe('vip')
    })

    it('does not record a payment as completed while the price waits for its approval', async () => {
      const { order } = await pendingOrder()

      const response = await kit
        .asAdmin()
        .post(ApiRoutes.orders.payment(order.id))
        .send({ method: 'TRANSFER', status: 'COMPLETED' })

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.ORDER_PRICE_APPROVAL_PENDING)
    })

    it('binds an approval to its lines: shrinking the items sends it back to pending', async () => {
      const { clerk, order } = await pendingOrder()
      await kit.asAdmin().post(ApiRoutes.orders.priceApprovalApprove(order.id)).send({})
      const product = await kit.stocked(10)

      const response = await edit(
        order.id,
        {
          items: [{ productId: product.id, quantity: 1 }],
          discountCents: 100,
          discountReason: 'promo'
        },
        clerk.agent
      )

      expect(response.status).toBe(OK)
      expect(response.body as OrderBody).toMatchObject({
        priceApprovalStatus: PriceApprovalStatus.PENDING,
        priceApprovedBy: null
      })
    })

    it('blocks the preparation and the shipping of a confirmed order whose edit made its price pending', async () => {
      const { order } = await placed()
      await status(order.id, { status: 'CONFIRMED' })
      const clerk = await member('editor', [
        Permissions.ORDERS_VIEW,
        Permissions.ORDERS_EDIT,
        Permissions.ORDERS_CHANGE_STATUS
      ])

      await edit(order.id, { discountCents: 100, discountReason: 'promo' }, clerk.agent)

      const prepare = await status(order.id, { status: 'PREPARING' }, clerk.agent)
      expect(prepare.status).toBe(CONFLICT)
      expect(errorOf(prepare).code).toBe(ErrorCodes.ORDER_PRICE_APPROVAL_PENDING)
      expect((await status(order.id, { status: 'SHIPPED' }, clerk.agent)).status).toBe(CONFLICT)
    })
  })

  describe('editing by field', () => {
    it('lets each status edit the fields of OrderEditableFields and refuses the others with the list of the locked ones', async () => {
      const { order } = await placed()
      await status(order.id, { status: 'CONFIRMED' })
      await status(order.id, { status: 'PREPARING' })
      const product = await kit.stocked(5)

      const items = await edit(order.id, {
        items: [{ productId: product.id, quantity: 1 }],
        shippingCents: 100
      })
      expect(items.status).toBe(CONFLICT)
      expect(errorOf(items)).toMatchObject({
        code: ErrorCodes.ORDER_FIELD_NOT_EDITABLE,
        metadata: { fields: ['items'] }
      })
      expect((await edit(order.id, { paymentMethod: 'CASH' })).status).toBe(CONFLICT)
      expect((await edit(order.id, { shippingCents: 300 })).status).toBe(OK)
      expect((await edit(order.id, { packingNotes: 'wrap it' })).status).toBe(OK)

      await status(order.id, { status: 'SHIPPED' })
      expect((await edit(order.id, { shippingCents: 100 })).status).toBe(CONFLICT)
      expect((await edit(order.id, { trackingNumber: 'GT-123' })).status).toBe(OK)
      // The packing note ends when the order leaves the warehouse
      expect((await edit(order.id, { packingNotes: 'too late' })).status).toBe(CONFLICT)
      await status(order.id, { status: 'DELIVERED' })
      expect((await edit(order.id, { customerNotes: 'delivered' })).status).toBe(OK)
      expect((await edit(order.id, { trackingNumber: 'GT-999' })).status).toBe(CONFLICT)
    })

    it('refuses every edit of a cancelled order', async () => {
      const { order } = await placed()
      await status(order.id, { status: 'CANCELLED', cancellationReason: 'x' })

      for (const change of [
        { customerNotes: 'x' },
        { internalNotes: 'x' },
        { recipientPhones: ['71234567'] }
      ]) {
        expect((await edit(order.id, change)).status).toBe(CONFLICT)
      }
    })

    it('answers an empty edit, an unknown field and a locked field of the customer with 400s', async () => {
      const { order } = await placed()

      for (const body of [
        {},
        { status: 'CONFIRMED' },
        { totalCents: 1 },
        { storeId: ctx.storeB.id }
      ]) {
        expect((await edit(order.id, body)).status).toBe(BAD_REQUEST)
      }
    })

    it('replaces the lines: the old reservation goes back, the new one is made, and the totals follow', async () => {
      const { order, product } = await placed()
      const other = await kit.stocked(10, 0, 500)

      const response = await edit(order.id, { items: [{ productId: other.id, quantity: 3 }] })

      expect(response.status).toBe(OK)
      expect(response.body as OrderBody).toMatchObject({ subtotalCents: 1500, totalCents: 1500 })
      expect((response.body as OrderBody).items).toHaveLength(1)
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({
        onHand: 10,
        reserved: 0
      })
      expect(await kit.level(other.id, ctx.warehouseA.id)).toMatchObject({
        onHand: 10,
        reserved: 3
      })
      expect((await movements(product.id)).map(row => row.type)).toEqual([
        'receipt',
        'reserve',
        'release'
      ])
    })

    it('keeps the price a line was made at when the items are edited, unless a price is named', async () => {
      const { order, product } = await placed()
      await owner.product.update({ where: { id: product.id }, data: { priceCents: 5000 } })
      const agent = await member('keeper', [Permissions.ORDERS_VIEW, Permissions.ORDERS_EDIT])

      const kept = await edit(
        order.id,
        { items: [{ productId: product.id, quantity: 3 }] },
        agent.agent
      )

      expect(kept.status).toBe(OK)
      expect(kept.body as OrderBody).toMatchObject({ subtotalCents: 3000, totalCents: 3000 })
      expect((kept.body as OrderBody).items[0]).toMatchObject({ unitPriceCents: 1000, quantity: 3 })
    })

    it('refuses to rewrite the reason of a discount in a status that locks the discount', async () => {
      const { order } = await placed({ discountCents: 100, discountReason: 'vip' })
      await status(order.id, { status: 'CONFIRMED' })
      await status(order.id, { status: 'PREPARING' })

      const response = await edit(order.id, {
        shippingCents: 1,
        discountReason: 'friend of the owner'
      })

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response)).toMatchObject({
        code: ErrorCodes.ORDER_FIELD_NOT_EDITABLE,
        metadata: { fields: ['discount'] }
      })
      expect((await get(order.id)).discountReason).toBe('vip')
    })

    it('does not let the way an order was sold change once a payment moved', async () => {
      const { order } = await placed({ paymentMethod: 'TRANSFER' })
      expect((await edit(order.id, { paymentMethod: 'CASH' })).status).toBe(OK)
      await kit
        .asAdmin()
        .post(ApiRoutes.orders.payment(order.id))
        .send({ method: 'CASH', status: 'COMPLETED' })

      const response = await edit(order.id, { paymentMethod: 'CASH_ON_DELIVERY' })

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).metadata).toMatchObject({ fields: ['paymentMethod'] })
    })

    it('fixes the lines, the fee and the discount once the payment is completed, and opens them again after a refund', async () => {
      const { order } = await placed({ paymentMethod: 'TRANSFER' })
      await kit
        .asAdmin()
        .post(ApiRoutes.orders.payment(order.id))
        .send({ method: 'TRANSFER', status: 'COMPLETED', reference: 'TRX-1' })

      const locked = await edit(order.id, { shippingCents: 500 })
      expect(locked.status).toBe(CONFLICT)
      expect(errorOf(locked)).toMatchObject({
        code: ErrorCodes.ORDER_FIELD_NOT_EDITABLE,
        metadata: { fields: ['shipping'] }
      })
      expect((await edit(order.id, { customerNotes: 'still fine' })).status).toBe(OK)

      await kit
        .asAdmin()
        .post(ApiRoutes.orders.payment(order.id))
        .send({ method: 'TRANSFER', status: 'REFUNDED' })
      expect((await edit(order.id, { shippingCents: 500 })).status).toBe(OK)
    })

    it('keeps who set an override when someone else edits the items, and sells no more of it without the override', async () => {
      const product = await kit.stocked(50)
      const made = await kit
        .asAdmin()
        .post(ApiRoutes.orders.create)
        .send({
          ...(await kit.orderBody()),
          items: [
            { productId: product.id, quantity: 2, unitPriceCents: 100, priceReason: 'sample' }
          ]
        })
      const order = (made.body as CreatedBody).order
      const agent = await member('lines', [Permissions.ORDERS_VIEW, Permissions.ORDERS_EDIT])

      // The same quantity, the price echoed back: nothing new is named
      const same = await edit(
        order.id,
        { items: [{ productId: product.id, quantity: 2, unitPriceCents: 100 }] },
        agent.agent
      )
      expect(same.status).toBe(OK)
      const fewer = await edit(
        order.id,
        { items: [{ productId: product.id, quantity: 1 }] },
        agent.agent
      )
      expect(fewer.status).toBe(OK)
      const row = await owner.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
      expect(row).toMatchObject({ unitPriceCents: 100, priceOverriddenBy: ctx.adminA.id })

      const more = await edit(
        order.id,
        { items: [{ productId: product.id, quantity: 500 }] },
        agent.agent
      )
      expect(more.status).toBe(FORBIDDEN)
      expect(errorOf(more).code).toBe(ErrorCodes.ORDER_PRICE_OVERRIDE_FORBIDDEN)
      // Whoever holds the override may
      expect(
        (await edit(order.id, { items: [{ productId: product.id, quantity: 5 }] })).status
      ).toBe(OK)
    })

    it('reads the id of an order written in capitals on the route and in the filter', async () => {
      const { order } = await placed()

      const read = await kit.asAdmin().get(ApiRoutes.orders.byId(order.id.toUpperCase()))
      const listed = await kit
        .asAdmin()
        .get(`${ApiRoutes.orders.list}?customerId=${order.customerId.toUpperCase()}`)

      expect(read.status).toBe(OK)
      expect((listed.body as PageBody).data.map(row => row.id)).toContain(order.id)
    })

    it('reads an id written in capitals as the same id', async () => {
      const product = await kit.stocked(5)
      const customer = await kit.customer()

      const response = await kit
        .asAdmin()
        .post(ApiRoutes.orders.create)
        .send({
          customerId: customer.id.toUpperCase(),
          items: [{ productId: product.id.toUpperCase(), quantity: 1 }],
          paymentMethod: 'CASH',
          recipientPhones: ['71234567']
        })

      expect(response.status).toBe(CREATED)
      expect((response.body as CreatedBody).order.customerId).toBe(customer.id)
    })

    it('keeps the old lines and the stock when the new ones cannot be served', async () => {
      const { order, product } = await placed()
      const scarce = await kit.stocked(1)

      const response = await edit(order.id, { items: [{ productId: scarce.id, quantity: 5 }] })

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.INSUFFICIENT_INVENTORY)
      expect((await get(order.id)).items[0]?.productId).toBe(product.id)
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ reserved: 2 })
    })

    it('prices a changed fee or discount from the lines it already has, at the prices it already has', async () => {
      const { order, product } = await placed()
      await owner.product.update({ where: { id: product.id }, data: { priceCents: 5000 } })

      const response = await edit(order.id, { shippingCents: 250 })

      expect(response.status).toBe(OK)
      expect(response.body as OrderBody).toMatchObject({ subtotalCents: 2000, totalCents: 2250 })
    })

    it('answers 404 for an order of another store', async () => {
      const foreign = await owner.customer.create({ data: { storeId: ctx.storeB.id, name: 'x' } })
      const other = await owner.order.create({
        data: {
          storeId: ctx.storeB.id,
          customerId: foreign.id,
          orderNumber: `B-${randomUUID().slice(0, 6)}`,
          subtotalCents: 1,
          totalCents: 1,
          paymentMethod: 'CASH',
          createdBy: ctx.adminB.id
        }
      })

      expect((await edit(other.id, { customerNotes: 'x' })).status).toBe(NOT_FOUND)
      expect((await status(other.id, { status: 'CONFIRMED' })).status).toBe(NOT_FOUND)
      expect(
        (
          await kit
            .asAdmin()
            .post(ApiRoutes.orders.payment(other.id))
            .send({ method: 'CASH', status: 'COMPLETED' })
        ).status
      ).toBe(NOT_FOUND)
      expect(await owner.order.findFirstOrThrow({ where: { id: other.id } })).toMatchObject({
        status: 'PENDING_CONFIRMATION',
        customerNotes: null
      })
    })

    it('is refused without orders:edit', async () => {
      const { order } = await placed()
      const reader = await member('reader', [Permissions.ORDERS_VIEW])

      expect((await edit(order.id, { customerNotes: 'x' }, reader.agent)).status).toBe(FORBIDDEN)
    })
  })

  describe('the three notes of an order', () => {
    it('writes and clears each one, and audits the internal and the packing note with the text before and after', async () => {
      const { order } = await placed()

      const written = await edit(order.id, {
        customerNotes: 'door code 4411',
        internalNotes: 'called twice',
        packingNotes: 'add the gift card'
      })
      expect(written.body as OrderBody).toMatchObject({
        customerNotes: 'door code 4411',
        internalNotes: 'called twice',
        packingNotes: 'add the gift card'
      })
      const changed = await edit(order.id, {
        internalNotes: 'called three times',
        packingNotes: '   '
      })
      expect(changed.body as OrderBody).toMatchObject({
        internalNotes: 'called three times',
        packingNotes: null
      })

      const internal = await waitForAuditEntries(
        owner,
        { action: AuditAction.ORDER_INTERNAL_NOTE_CHANGED, resourceId: order.id },
        2
      )
      const packing = await waitForAuditEntries(
        owner,
        { action: AuditAction.ORDER_PACKING_NOTE_CHANGED, resourceId: order.id },
        2
      )
      expect(internal.map(entry => entry.metadata)).toEqual(
        expect.arrayContaining([
          { from: null, to: 'called twice' },
          { from: 'called twice', to: 'called three times' }
        ])
      )
      expect(packing.map(entry => entry.metadata)).toEqual(
        expect.arrayContaining([
          { from: null, to: 'add the gift card' },
          { from: 'add the gift card', to: null }
        ])
      )
    })

    it('does not audit a note that did not change', async () => {
      const { order } = await placed({ internalNotes: 'same' })

      await edit(order.id, { internalNotes: 'same', customerNotes: 'x' })
      await new Promise(resolve => setTimeout(resolve, 300))

      const entries = await owner.auditLog.findMany({
        where: { action: AuditAction.ORDER_INTERNAL_NOTE_CHANGED, resourceId: order.id }
      })
      expect(entries).toEqual([])
    })

    it('never puts a note in an event, whatever the event', async () => {
      const seen: string[] = []
      const emitter = app.get(EventEmitter2)
      const listeners = Object.values(Events).filter(name => name.startsWith('order.'))
      const handlers = listeners.map(name => {
        const handler = (payload: unknown) => {
          seen.push(JSON.stringify(payload))
        }
        emitter.on(name, handler)
        return { name, handler }
      })
      try {
        const { order } = await placed({
          customerNotes: 'SECRET-CUSTOMER',
          internalNotes: 'SECRET-INTERNAL',
          packingNotes: 'SECRET-PACKING'
        })
        await status(order.id, { status: 'CONFIRMED' })
        await edit(order.id, {
          packingNotes: 'SECRET-PACKING-2',
          internalNotes: 'SECRET-INTERNAL-2'
        })
        await new Promise(resolve => setTimeout(resolve, 300))
      } finally {
        for (const { name, handler } of handlers) emitter.off(name, handler)
      }

      expect(seen.length).toBeGreaterThan(3)
      expect(seen.join('\n')).not.toMatch(/SECRET/)
    })

    it('reads the internal notes only with orders:view: nothing of them to a member who may only edit', async () => {
      const { order } = await placed({ internalNotes: 'private', packingNotes: 'pack it' })
      const editor = await member('editor', [Permissions.ORDERS_EDIT])

      const answer = await edit(order.id, { customerNotes: 'x' }, editor.agent)

      expect(answer.status).toBe(OK)
      expect('internalNotes' in (answer.body as OrderBody)).toBe(false)
      expect('packingNotes' in (answer.body as OrderBody)).toBe(false)
      expect((await get(order.id)).internalNotes).toBe('private')
    })
  })

  describe('the warning to the warehouse when the packing note changes', () => {
    async function warehouse() {
      const mover = await member('mover', [
        Permissions.ORDERS_VIEW,
        Permissions.ORDERS_CHANGE_STATUS
      ])
      const shipper = await member('shipper', [
        Permissions.SHIPPING_MANAGE,
        Permissions.ORDERS_VIEW
      ])
      // Who may ship but not read orders gets no notice that links to an order
      const blind = await member('blind', [Permissions.SHIPPING_MANAGE])
      const reader = await member('reader', [Permissions.ORDERS_VIEW])
      return { mover, shipper, reader, blind }
    }
    // Who should be told: every member of the store holding one of the two permissions, but the one who edits
    const holdersOtherThanAdmin = async () =>
      (
        await owner.membership.findMany({
          where: {
            storeId: ctx.storeA.id,
            userId: { not: ctx.adminA.id },
            AND: [
              {
                role: {
                  permissions: {
                    some: {
                      name: { in: [Permissions.ORDERS_CHANGE_STATUS, Permissions.SHIPPING_MANAGE] }
                    }
                  }
                }
              },
              { role: { permissions: { some: { name: Permissions.ORDERS_VIEW } } } }
            ]
          },
          select: { userId: true }
        })
      ).length
    const waitForNotices = async (orderId: string, expected: number) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const rows = await owner.notification.findMany({
          where: {
            storeId: ctx.storeA.id,
            type: NotificationTypes.ORDER_PACKING_NOTE_CHANGED,
            resourceId: orderId
          }
        })
        if (rows.length >= expected) return rows
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return owner.notification.findMany({
        where: {
          storeId: ctx.storeA.id,
          type: NotificationTypes.ORDER_PACKING_NOTE_CHANGED,
          resourceId: orderId
        }
      })
    }

    it('tells the members who may prepare or ship, and not the one who changed it nor those who cannot', async () => {
      const { mover, shipper, reader, blind } = await warehouse()
      const { order } = await placed()
      await status(order.id, { status: 'CONFIRMED' })

      await edit(order.id, { packingNotes: 'swap the red one for blue' })

      // The members of earlier tests who hold one of the two permissions are told too: the store is shared
      const rows = await waitForNotices(order.id, await holdersOtherThanAdmin())
      const told = rows.map(row => row.userId)
      expect(told).toEqual(expect.arrayContaining([mover.actor.id, shipper.actor.id]))
      expect(told).not.toContain(ctx.adminA.id)
      expect(told).not.toContain(reader.actor.id)
      expect(told).not.toContain(blind.actor.id)
      const holders = await owner.membership.findMany({
        where: {
          storeId: ctx.storeA.id,
          AND: [
            {
              role: {
                permissions: {
                  some: {
                    name: { in: [Permissions.ORDERS_CHANGE_STATUS, Permissions.SHIPPING_MANAGE] }
                  }
                }
              }
            },
            { role: { permissions: { some: { name: Permissions.ORDERS_VIEW } } } }
          ]
        },
        select: { userId: true }
      })
      const allowed = new Set(holders.map(row => row.userId))
      for (const userId of told) expect(allowed.has(userId)).toBe(true)
      expect(rows[0]?.actionPath).toContain(order.id)
    })

    it('tells nobody while the order is still waiting for its confirmation, and nobody about a note that did not change', async () => {
      await warehouse()
      const { order } = await placed()

      await edit(order.id, { packingNotes: 'early note' })
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(await waitForNotices(order.id, 0)).toEqual([])

      await status(order.id, { status: 'CONFIRMED' })
      await edit(order.id, { packingNotes: 'early note' })
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(await waitForNotices(order.id, 0)).toEqual([])
    })

    it('warns about an order that is being prepared too', async () => {
      const { mover } = await warehouse()
      const { order } = await placed()
      await status(order.id, { status: 'CONFIRMED' })
      await status(order.id, { status: 'PREPARING' })

      await edit(order.id, { packingNotes: 'fragile' })

      const rows = await waitForNotices(order.id, await holdersOtherThanAdmin())
      expect(rows.map(row => row.userId)).toContain(mover.actor.id)
    })
  })

  describe('the notices of an order', () => {
    const rowsOf = (type: string, orderId: string) =>
      owner.notification.findMany({ where: { storeId: ctx.storeA.id, type, resourceId: orderId } })
    // A notice is made after the commit: wait until it shows, or for a while if none is expected
    async function noticesOf(type: string, orderId: string, expected: number) {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const rows = await rowsOf(type, orderId)
        if (rows.length >= expected && expected > 0) return rows
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return rowsOf(type, orderId)
    }
    const holders = async (permission: string, except: string) =>
      (
        await owner.membership.findMany({
          where: {
            storeId: ctx.storeA.id,
            userId: { not: except },
            AND: [
              { role: { permissions: { some: { name: permission } } } },
              { role: { permissions: { some: { name: Permissions.ORDERS_VIEW } } } }
            ]
          },
          select: { userId: true }
        })
      ).map(row => row.userId)
    // A clerk who makes orders with a discount, so that the orders wait for an approval
    const clerk = () =>
      member('clerk', [
        Permissions.ORDERS_VIEW,
        Permissions.ORDERS_CREATE,
        Permissions.ORDERS_EDIT,
        Permissions.ORDERS_CHANGE_STATUS
      ])
    async function madeBy(agent: ReturnType<typeof api>, extra: Record<string, unknown> = {}) {
      const response = await agent.post(ApiRoutes.orders.create).send(await kit.orderBody(extra))
      expect(response.status).toBe(CREATED)
      return (response.body as CreatedBody).order
    }

    it('tells who may confirm about an order that waits for it, and nobody about one made confirmed', async () => {
      const confirmer = await member('confirmer', [
        Permissions.ORDERS_VIEW,
        Permissions.ORDERS_CONFIRM
      ])
      const waiting = await madeBy(kit.asAdmin())
      const told = await noticesOf(
        NotificationTypes.ORDER_CREATED,
        waiting.id,
        (await holders(Permissions.ORDERS_CONFIRM, ctx.adminA.id)).length
      )
      expect(told.map(row => row.userId)).toContain(confirmer.actor.id)
      expect(told.map(row => row.userId).sort()).toEqual(
        (await holders(Permissions.ORDERS_CONFIRM, ctx.adminA.id)).sort()
      )

      const confirmed = await madeBy(kit.asAdmin(), { confirmOnCreate: true })
      expect(await noticesOf(NotificationTypes.ORDER_CREATED, confirmed.id, 0)).toEqual([])
    })

    it('tells the member who made the order that its status changed, unless they changed it', async () => {
      const maker = await clerk()
      const order = await madeBy(maker.agent)

      await status(order.id, { status: 'CONFIRMED' })

      const rows = await noticesOf(NotificationTypes.ORDER_STATUS_CHANGED, order.id, 1)
      expect(rows.map(row => row.userId)).toEqual([maker.actor.id])
      // Their own change tells nobody
      const own = await madeBy(kit.asAdmin())
      await status(own.id, { status: 'CONFIRMED' })
      expect(await noticesOf(NotificationTypes.ORDER_STATUS_CHANGED, own.id, 0)).toEqual([])
    })

    it('tells the approvers, but not the one who asked, when a price waits for approval', async () => {
      const approver = await member('approver', [
        Permissions.ORDERS_VIEW,
        Permissions.ORDERS_APPROVE_PRICE
      ])
      const maker = await clerk()
      const order = await madeBy(maker.agent, { discountCents: 100, discountReason: 'promo' })

      const rows = await noticesOf(
        NotificationTypes.ORDER_PRICE_APPROVAL_REQUESTED,
        order.id,
        (await holders(Permissions.ORDERS_APPROVE_PRICE, maker.actor.id)).length
      )

      expect(rows.map(row => row.userId).sort()).toEqual(
        (await holders(Permissions.ORDERS_APPROVE_PRICE, maker.actor.id)).sort()
      )
      expect(rows.map(row => row.userId)).toContain(approver.actor.id)
      expect(rows.map(row => row.userId)).not.toContain(maker.actor.id)
    })

    it('tells the approvers about an override while the store keeps the switch on, and nobody when it is off', async () => {
      const approver = await member('overrider', [
        Permissions.ORDERS_VIEW,
        Permissions.ORDERS_APPROVE_PRICE
      ])
      const on = await madeBy(kit.asAdmin(), { discountCents: 100, discountReason: 'vip' })
      const rows = await noticesOf(
        NotificationTypes.ORDER_PRICE_OVERRIDDEN,
        on.id,
        (await holders(Permissions.ORDERS_APPROVE_PRICE, ctx.adminA.id)).length
      )
      expect(rows.map(row => row.userId)).not.toContain(ctx.adminA.id)
      expect(rows.map(row => row.userId)).toContain(approver.actor.id)

      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { preferences: { orders: { notifyOnPriceOverride: false } } }
      })
      const off = await madeBy(kit.asAdmin(), { discountCents: 100, discountReason: 'vip' })
      expect(await noticesOf(NotificationTypes.ORDER_PRICE_OVERRIDDEN, off.id, 0)).toEqual([])
    })
  })

  describe('payments recorded by hand', () => {
    const pay = (orderId: string, body: Record<string, unknown>, agent = kit.asAdmin()) =>
      agent.post(ApiRoutes.orders.payment(orderId)).send(body)

    it('records a transfer with its reference, audits it, and leaves the way the order was sold as it was', async () => {
      const { order } = await placed({ paymentMethod: 'TRANSFER' })

      const response = await pay(order.id, {
        method: 'TRANSFER',
        status: 'COMPLETED',
        reference: 'TRX-90210'
      })

      expect(response.status).toBe(OK)
      expect(response.body as OrderBody).toMatchObject({
        paymentStatus: 'COMPLETED',
        paymentReference: 'TRX-90210',
        paymentMethod: 'TRANSFER'
      })
      const recorded = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_PAYMENT_RECORDED,
        resourceId: order.id
      })
      expect(recorded[0]?.metadata).toMatchObject({
        method: 'TRANSFER',
        status: 'COMPLETED',
        reference: 'TRX-90210'
      })
      const changed = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_PAYMENT_STATUS_CHANGED,
        resourceId: order.id
      })
      expect(changed[0]?.metadata).toMatchObject({ from: 'PENDING', to: 'COMPLETED' })
    })

    it('does not complete a cash-on-delivery payment before the order is delivered, even if recorded as cash', async () => {
      const { order } = await placed({ paymentMethod: 'CASH_ON_DELIVERY' })

      const early = await pay(order.id, { method: 'CASH', status: 'COMPLETED' })
      expect(early.status).toBe(CONFLICT)
      expect(errorOf(early).code).toBe(ErrorCodes.ORDER_PAYMENT_NOT_ALLOWED)

      await status(order.id, { status: 'CONFIRMED' })
      await status(order.id, { status: 'SHIPPED' })
      await status(order.id, { status: 'DELIVERED' })
      const late = await pay(order.id, { method: 'CASH', status: 'COMPLETED' })

      expect(late.status).toBe(OK)
      expect((late.body as OrderBody).paymentMethod).toBe('CASH_ON_DELIVERY')
    })

    it('refuses a payment move the table does not have, and a payment on a cancelled order unless it is a refund', async () => {
      const { order } = await placed({ paymentMethod: 'TRANSFER' })
      await pay(order.id, { method: 'TRANSFER', status: 'COMPLETED' })

      const back = await pay(order.id, { method: 'TRANSFER', status: 'PENDING' })
      expect(back.status).toBe(CONFLICT)
      expect(errorOf(back).code).toBe(ErrorCodes.ORDER_PAYMENT_INVALID_STATUS_TRANSITION)

      await status(order.id, { status: 'CANCELLED', cancellationReason: 'x' })
      expect((await pay(order.id, { method: 'TRANSFER', status: 'COMPLETED' })).status).toBe(
        CONFLICT
      )
      expect((await pay(order.id, { method: 'TRANSFER', status: 'REFUNDED' })).status).toBe(OK)
    })

    it('adds a reference to a payment that is still pending without changing its state, and keeps the earlier one when none is sent', async () => {
      const { order } = await placed({ paymentMethod: 'TRANSFER' })

      await pay(order.id, { method: 'TRANSFER', status: 'PENDING', reference: 'DEP-1' })
      const again = await pay(order.id, { method: 'TRANSFER', status: 'PENDING' })

      expect(again.body as OrderBody).toMatchObject({
        paymentStatus: 'PENDING',
        paymentReference: 'DEP-1'
      })
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.ORDER_PAYMENT_STATUS_CHANGED, resourceId: order.id }
        })
      ).toBe(0)
    })

    it('takes a receipt that belongs to the order and refuses any other file', async () => {
      const { order } = await placed({ paymentMethod: 'TRANSFER' })
      const other = await placed()
      const receipt = await owner.media.create({
        data: {
          storeId: ctx.storeA.id,
          purpose: 'order',
          orderId: order.id,
          key: `it/${randomUUID()}`,
          filename: 'receipt.pdf',
          contentType: 'application/pdf',
          fileSize: 10,
          status: 'clean'
        },
        select: { id: true }
      })
      const foreign = await owner.media.create({
        data: {
          storeId: ctx.storeA.id,
          purpose: 'order',
          orderId: other.order.id,
          key: `it/${randomUUID()}`,
          filename: 'receipt.pdf',
          contentType: 'application/pdf',
          fileSize: 10,
          status: 'clean'
        },
        select: { id: true }
      })

      expect(
        (await pay(order.id, { method: 'TRANSFER', status: 'COMPLETED', proofMediaId: foreign.id }))
          .status
      ).toBe(NOT_FOUND)
      const ok = await pay(order.id, {
        method: 'TRANSFER',
        status: 'COMPLETED',
        proofMediaId: receipt.id
      })

      expect(ok.status).toBe(OK)
      expect(await owner.order.findFirstOrThrow({ where: { id: order.id } })).toMatchObject({
        paymentProofMediaId: receipt.id
      })
    })

    it('answers 400 to a body with a field it does not know, and needs orders:edit', async () => {
      const { order } = await placed()
      const reader = await member('reader', [Permissions.ORDERS_VIEW])

      expect(
        (await pay(order.id, { method: 'CASH', status: 'COMPLETED', totalCents: 1 })).status
      ).toBe(BAD_REQUEST)
      expect(
        (await pay(order.id, { method: 'CASH', status: 'COMPLETED' }, reader.agent)).status
      ).toBe(FORBIDDEN)
    })
  })

  describe('the scheduled delivery (decision D18)', () => {
    const list = (query: string) => kit.asAdmin().get(`${ApiRoutes.orders.list}?${query}`)
    const idsOf = (response: { body: unknown }) =>
      (response.body as PageBody).data.map(row => row.id)

    async function scheduled(days: (string | null)[]) {
      const customer = await kit.customer()
      const ids: string[] = []
      for (const day of days) {
        const response = await kit
          .asAdmin()
          .post(ApiRoutes.orders.create)
          .send({
            ...(await kit.orderBody()),
            customerId: customer.id,
            scheduledDeliveryDate: day
          })
        expect(response.status).toBe(CREATED)
        ids.push((response.body as CreatedBody).order.id)
      }
      return { customer, ids }
    }

    it('stores a calendar day, lists by inclusive days, and audits a change with the old and the new day', async () => {
      const { customer, ids } = await scheduled(['2026-12-01', '2026-12-05', '2026-12-09', null])
      const mine = `customerId=${customer.id}`

      const between = await list(
        `${mine}&scheduledDeliveryFrom=2026-12-01&scheduledDeliveryTo=2026-12-05`
      )
      expect(idsOf(between).sort()).toEqual([ids[0], ids[1]].sort())
      expect(idsOf(await list(`${mine}&scheduledDeliveryFrom=2026-12-05`)).sort()).toEqual(
        [ids[1], ids[2]].sort()
      )
      expect(idsOf(await list(`${mine}&scheduledDeliveryTo=2026-12-01`))).toEqual([ids[0]])
      expect((await get(ids[0] as string)).scheduledDeliveryDate).toBe('2026-12-01')

      const moved = await edit(ids[0] as string, { scheduledDeliveryDate: '2026-12-02' })
      expect((moved.body as OrderBody).scheduledDeliveryDate).toBe('2026-12-02')
      const cleared = await edit(ids[1] as string, { scheduledDeliveryDate: null })
      expect((cleared.body as OrderBody).scheduledDeliveryDate).toBeNull()
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_SCHEDULE_CHANGED,
        resourceId: ids[0] as string
      })
      expect(entries[0]?.metadata).toEqual({ from: '2026-12-01', to: '2026-12-02' })
      expect((await edit(ids[2] as string, { scheduledDeliveryDate: '2026-02-30' })).status).toBe(
        BAD_REQUEST
      )
    })

    it('resolves today and tomorrow on the clock of the store, not of the server', async () => {
      for (const timezone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
        await owner.store.update({ where: { id: ctx.storeA.id }, data: { timezone } })
        const today = calendarDayIn(timezone, new Date())
        const tomorrow = nextCalendarDay(today)
        const { customer, ids } = await scheduled([today, tomorrow, '2031-01-01'])
        const mine = `customerId=${customer.id}`

        const onToday = idsOf(await list(`${mine}&scheduledDeliveryOn=today`))
        const onTomorrow = idsOf(await list(`${mine}&scheduledDeliveryOn=tomorrow`))

        // The store's midnight passing while the test runs (a minute of the day) moves both days: nothing is proved then
        if (calendarDayIn(timezone, new Date()) !== today) continue
        expect(onToday).toEqual([ids[0]])
        expect(onTomorrow).toEqual([ids[1]])
      }
    })

    it('sorts by the day of delivery, soonest first and the orders with no day last, across pages', async () => {
      const { customer, ids } = await scheduled([
        '2026-12-20',
        null,
        '2026-12-03',
        '2026-12-11',
        null
      ])
      const mine = `customerId=${customer.id}&sort=scheduled_delivery`

      const first = await list(`${mine}&limit=2`)
      const firstBody = first.body as PageBody
      const second = await list(`${mine}&limit=2&cursor=${firstBody.nextCursor}`)
      const secondBody = second.body as PageBody
      const third = await list(`${mine}&limit=2&cursor=${secondBody.nextCursor}`)

      expect(firstBody.data.map(row => row.id)).toEqual([ids[2], ids[3]])
      expect(secondBody.data.map(row => row.id)).toEqual([ids[0], ids[4]])
      expect(secondBody.hasMore).toBe(true)
      expect(idsOf(third)).toEqual([ids[1]])
      expect((third.body as PageBody).hasMore).toBe(false)
    })
  })

  describe('products of the catalog stay what they were when the order was made', () => {
    it('keeps the name and the price of the lines when the product changes afterwards', async () => {
      const product = await createProduct(owner, {
        storeId: ctx.storeA.id,
        priceCents: 1000,
        name: 'Mug'
      })
      await owner.product.update({ where: { id: product.id }, data: { trackInventory: false } })
      const body = await kit.orderBody({ items: [{ productId: product.id, quantity: 1 }] })
      const created = (await kit.asAdmin().post(ApiRoutes.orders.create).send(body))
        .body as CreatedBody

      await owner.product.update({
        where: { id: product.id },
        data: { priceCents: 9999, name: 'Mug v2' }
      })

      const order = await get(created.order.id)
      expect(order.items[0]).toMatchObject({ unitPriceCents: 1000, productName: 'Mug' })
      expect(order.totalCents).toBe(1000)
    })
  })
})
