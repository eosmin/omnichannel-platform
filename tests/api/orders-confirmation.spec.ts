import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  OrderCopyWarnings,
  OrderLimits,
  type OrderCopyDraft,
  PriceApprovalStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { createCustomer } from '../builders'
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

interface BulkBody {
  succeeded: string[]
  failed: { id: string; code: string }[]
}

// The confirmation of an order (Step 4.9 PR B, TDD_17 §4.3): "mark as confirmed" over a selection, and the draft of a copy.
// The single confirmation, confirming at creation and the refusal of a guide for an unconfirmed order are covered by
// orders-lifecycle.spec.ts, orders.spec.ts and shipments.spec.ts.
describe('The confirmation of orders', () => {
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
  afterEach(async () => {
    await kit.resetSettings()
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
    return api(app, actor, ctx.storeA)
  }
  async function placed(extra: Record<string, unknown> = {}, quantity = 2) {
    const product = await kit.stocked(10)
    const body = await kit.orderBody({ items: [{ productId: product.id, quantity }], ...extra })
    const response = await kit.asAdmin().post(ApiRoutes.orders.create).send(body)
    expect(response.status).toBe(CREATED)
    return { order: (response.body as CreatedBody).order, product, body }
  }
  const confirmBulk = (body: Record<string, unknown>, agent = kit.asAdmin()) =>
    agent.post(ApiRoutes.orders.confirmBulk).send(body)
  const copyOf = (orderId: string, agent = kit.asAdmin()) =>
    agent.get(ApiRoutes.orders.copy(orderId))
  const rowOf = (orderId: string) => owner.order.findFirstOrThrow({ where: { id: orderId } })

  describe('"mark as confirmed" over a selection', () => {
    it('confirms each order of its own and says why the others were not, without stopping at the first', async () => {
      const pending = (await placed()).order
      const already = (await placed()).order
      await kit.asAdmin().post(ApiRoutes.orders.confirm(already.id)).send({ via: 'call' })
      const cancelled = (await placed()).order
      await kit
        .asAdmin()
        .post(ApiRoutes.orders.cancel(cancelled.id))
        .send({ cancellationReason: 'changed mind' })
      const waiting = (await placed()).order
      await owner.order.update({
        where: { id: waiting.id },
        data: { priceApprovalStatus: PriceApprovalStatus.PENDING }
      })
      const missing = randomUUID()

      const response = await confirmBulk({
        ids: [already.id, pending.id, cancelled.id, waiting.id, missing],
        via: 'in_person'
      })

      expect(response.status).toBe(OK)
      expect(response.body as BulkBody).toEqual({
        succeeded: [pending.id],
        failed: [
          { id: already.id, code: ErrorCodes.ORDER_ALREADY_CONFIRMED },
          { id: cancelled.id, code: ErrorCodes.ORDER_INVALID_STATUS_TRANSITION },
          { id: waiting.id, code: ErrorCodes.ORDER_PRICE_APPROVAL_PENDING },
          { id: missing, code: ErrorCodes.RESOURCE_NOT_FOUND }
        ]
      })
      expect(await rowOf(pending.id)).toMatchObject({
        status: 'CONFIRMED',
        confirmedBy: ctx.adminA.id,
        confirmedVia: 'in_person'
      })
      expect((await rowOf(already.id)).confirmedVia).toBe('call')
      expect((await rowOf(cancelled.id)).status).toBe('CANCELLED')
      expect((await rowOf(waiting.id)).status).toBe('PENDING_CONFIRMATION')
      // The one that changed has its own audit entry, like a single confirmation
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_CONFIRMED,
        resourceId: pending.id
      })
      expect(entries[0]?.metadata).toMatchObject({ via: 'in_person' })
    })

    it('needs the permission to confirm and changes nothing without it', async () => {
      const { order } = await placed()
      const mover = await member('mover', [
        Permissions.ORDERS_VIEW,
        Permissions.ORDERS_CHANGE_STATUS
      ])

      const response = await confirmBulk({ ids: [order.id], via: 'call' }, mover)

      expect(response.status).toBe(FORBIDDEN)
      expect((await rowOf(order.id)).status).toBe('PENDING_CONFIRMATION')
    })

    it('refuses a selection that is empty, too long, repeated or confirmed by a way that is not one', async () => {
      const { order } = await placed()
      const tooMany = Array.from({ length: OrderLimits.BULK_CONFIRM_MAX + 1 }, () => randomUUID())

      const bodies = [
        { ids: [], via: 'call' },
        { ids: tooMany, via: 'call' },
        { ids: [order.id, order.id], via: 'call' },
        { ids: [order.id], via: 'at_creation' },
        { ids: [order.id] },
        { ids: ['not-an-id'], via: 'call' },
        { ids: [order.id], via: 'call', storeId: ctx.storeB.id }
      ]
      for (const body of bodies) {
        expect((await confirmBulk(body)).status).toBe(BAD_REQUEST)
      }
      expect((await rowOf(order.id)).status).toBe('PENDING_CONFIRMATION')
    })
  })

  describe('the copy of an order', () => {
    it('is a draft that the create route takes as it is: current prices, the old order as its source, pending confirmation', async () => {
      const { order, product } = await placed({ customerNotes: 'ring twice', shippingCents: 350 })
      // The catalog moved since: the draft carries no price, the new order is made at today's
      await owner.product.update({ where: { id: product.id }, data: { priceCents: 1500 } })

      const response = await copyOf(order.id)

      expect(response.status).toBe(OK)
      const { draft, lines, warnings } = response.body as OrderCopyDraft
      expect(draft).toMatchObject({
        customerId: order.customerId,
        items: [{ productId: product.id, quantity: 2 }],
        shippingCents: 350,
        customerNotes: 'ring twice',
        copiedFromOrderId: order.id
      })
      expect(JSON.stringify(draft)).not.toMatch(
        /unitPriceCents|discountCents|scheduledDeliveryDate/
      )
      expect(lines[0]).toMatchObject({ unitPriceCents: 1500, previousUnitPriceCents: 1000 })
      expect(warnings.map(warning => warning.code)).toEqual([OrderCopyWarnings.PRICE_CHANGED])
      // It wrote nothing
      expect(await owner.order.count({ where: { customerId: order.customerId } })).toBe(1)

      const made = await kit.asAdmin().post(ApiRoutes.orders.create).send(draft)

      expect(made.status).toBe(CREATED)
      const copy = (made.body as CreatedBody).order
      expect(copy.status).toBe('PENDING_CONFIRMATION')
      expect(copy.items[0]?.unitPriceCents).toBe(1500)
      expect(copy.id).not.toBe(order.id)
      expect((await rowOf(copy.id)).copiedFromOrderId).toBe(order.id)
      const read = (await kit.asAdmin().get(ApiRoutes.orders.byId(copy.id))).body as OrderBody
      expect(read.copiedFromOrderId).toBe(order.id)
    })

    it('copies an order in any status, a cancelled one included', async () => {
      const { order } = await placed()
      await kit
        .asAdmin()
        .post(ApiRoutes.orders.cancel(order.id))
        .send({ cancellationReason: 'changed mind' })

      expect((await copyOf(order.id)).status).toBe(OK)
    })

    it('warns about a product that is switched off and keeps the line, and the create refuses it if it is still off', async () => {
      const { order, product } = await placed()
      await owner.product.update({ where: { id: product.id }, data: { active: false } })

      const { draft, lines, warnings } = (await copyOf(order.id)).body as OrderCopyDraft

      expect(warnings).toEqual([
        {
          code: OrderCopyWarnings.PRODUCT_INACTIVE,
          itemIndex: 0,
          productId: product.id,
          variantId: null
        }
      ])
      expect(draft.items).toHaveLength(1)
      expect(lines[0]?.unitPriceCents).toBeNull()
      const made = await kit.asAdmin().post(ApiRoutes.orders.create).send(draft)
      expect(made.status).toBe(CONFLICT)
    })

    it('warns about a product that has no stock left for the quantity', async () => {
      const product = await kit.stocked(2)
      const body = await kit.orderBody({ items: [{ productId: product.id, quantity: 2 }] })
      const first = await kit.asAdmin().post(ApiRoutes.orders.create).send(body)
      expect(first.status).toBe(CREATED)

      const { warnings } = (await copyOf((first.body as CreatedBody).order.id))
        .body as OrderCopyDraft

      expect(warnings.map(warning => warning.code)).toEqual([OrderCopyWarnings.OUT_OF_STOCK])
    })

    it('goes to the customer that survived a merge, and refuses one that was erased', async () => {
      const { order } = await placed()
      const survivor = await createCustomer(owner, { storeId: ctx.storeA.id })
      await owner.customer.update({
        where: { id: order.customerId },
        data: { mergedIntoId: survivor.id }
      })

      const merged = await copyOf(order.id)

      expect(merged.status).toBe(OK)
      expect((merged.body as OrderCopyDraft).draft.customerId).toBe(survivor.id)

      await owner.customer.update({ where: { id: survivor.id }, data: { erasedAt: new Date() } })
      const erased = await copyOf(order.id)
      expect(erased.status).toBe(CONFLICT)
    })

    it('needs to read orders and to create them, and an order that does not exist is not found', async () => {
      const { order } = await placed()
      const reader = await member('reader', [Permissions.ORDERS_VIEW])
      const creator = await member('creator', [Permissions.ORDERS_CREATE])

      expect((await copyOf(order.id, reader)).status).toBe(FORBIDDEN)
      expect((await copyOf(order.id, creator)).status).toBe(FORBIDDEN)
      expect((await copyOf(randomUUID())).status).toBe(NOT_FOUND)
      expect((await copyOf('not-an-id')).status).toBe(BAD_REQUEST)
    })

    it('is a source that only who may read orders can name: a creator without it learns nothing about the order', async () => {
      const { order } = await placed()
      const creator = await member('creator', [Permissions.ORDERS_CREATE])
      const body = await kit.orderBody({ copiedFromOrderId: order.id })
      const missing = await kit.orderBody({ copiedFromOrderId: randomUUID() })

      const real = await creator.post(ApiRoutes.orders.create).send(body)
      const none = await creator.post(ApiRoutes.orders.create).send(missing)

      // The same answer for an order that exists and for one that does not, and nothing was made
      expect([real.status, none.status]).toEqual([FORBIDDEN, FORBIDDEN])
      expect(errorOf(real)).toEqual(errorOf(none))
      expect(errorOf(real).code).toBe(ErrorCodes.PERMISSION_DENIED)
      expect(await owner.order.count({ where: { customerId: body.customerId } })).toBe(0)
    })

    it('is a source that must exist when the new order names it', async () => {
      const body = await kit.orderBody({ copiedFromOrderId: randomUUID() })

      const response = await kit.asAdmin().post(ApiRoutes.orders.create).send(body)

      expect(response.status).toBe(NOT_FOUND)
      expect(errorOf(response).code).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
    })
  })
})
