import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { CarrierConnectionStatus, PriceApprovalStatus } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { createCarrierConnection } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
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
const NOT_FOUND = 404
const CONFLICT = 409

// The planned carrier of an order and the range its fee is judged against (TDD_17 §4.13)
describe('The planned carrier of an order', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let kit: OrdersKit
  let agent: ReturnType<typeof api>
  let rangedId = ''
  let otherRangeId = ''

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    kit = ordersKit(owner, app, ctx)
    // Without the right to override prices: the range is what limits this member
    const member = await actorWithPermissions(owner, app, {
      prefix,
      name: `agent${randomUUID().slice(0, 6)}`,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions: [Permissions.ORDERS_VIEW, Permissions.ORDERS_CREATE, Permissions.ORDERS_EDIT]
    })
    agent = api(app, member, ctx.storeA)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const create = async (extra: Record<string, unknown>, who = agent) => {
    const body = await kit.orderBody(extra)
    return who.post(ApiRoutes.orders.create).send(body)
  }
  const approvalOf = (response: { body: unknown }) =>
    (response.body as CreatedBody).order.priceApprovalStatus
  const carrierOf = async (response: { body: unknown }) =>
    (
      await owner.order.findUniqueOrThrow({
        where: { id: (response.body as CreatedBody).order.id },
        select: { carrierConnectionId: true }
      })
    ).carrierConnectionId

  it('limits the fee only by the free-shipping rule while the store has no carrier at all', async () => {
    const response = await create({ shippingCents: 300 })
    expect(response.status).toBe(CREATED)
    expect(approvalOf(response)).toBe(PriceApprovalStatus.NOT_REQUIRED)
    expect(await carrierOf(response)).toBeNull()
  })

  describe('once the store has a carrier', () => {
    beforeAll(async () => {
      rangedId = (await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'OA' })).id
      await owner.carrierConnection.update({
        where: { id: rangedId },
        data: { minShippingFeeCents: 200, maxShippingFeeCents: 500 }
      })
      otherRangeId = (
        await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'OB' })
      ).id
      await owner.carrierConnection.update({
        where: { id: otherRangeId },
        data: { minShippingFeeCents: 1000, maxShippingFeeCents: 2000 }
      })
    })
    afterAll(() =>
      owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { defaultCarrierConnectionId: null }
      })
    )

    it('asks for an approval when a fee is charged and no carrier is planned', async () => {
      const charged = await create({ shippingCents: 300, discountReason: 'out of the range' })
      expect(charged.status).toBe(CREATED)
      expect(approvalOf(charged)).toBe(PriceApprovalStatus.PENDING)
      const free = await create({ shippingCents: 0 })
      expect(approvalOf(free)).toBe(PriceApprovalStatus.NOT_REQUIRED)
    })

    it('accepts a fee inside the range of the planned carrier, and keeps the carrier on the order', async () => {
      const response = await create({ shippingCents: 300, carrierConnectionId: rangedId })
      expect(response.status).toBe(CREATED)
      expect(approvalOf(response)).toBe(PriceApprovalStatus.NOT_REQUIRED)
      expect(await carrierOf(response)).toBe(rangedId)
    })

    it('asks for an approval for a fee outside the range, above and below', async () => {
      for (const shippingCents of [900, 100]) {
        const response = await create({
          shippingCents,
          carrierConnectionId: rangedId,
          discountReason: 'out of the range'
        })
        expect(approvalOf(response)).toBe(PriceApprovalStatus.PENDING)
      }
    })

    it('lets a member who may override prices set any fee without an approval', async () => {
      const response = await create(
        { shippingCents: 900, carrierConnectionId: rangedId, discountReason: 'the customer asked' },
        kit.asAdmin()
      )
      expect(response.status).toBe(CREATED)
      expect(approvalOf(response)).toBe(PriceApprovalStatus.NOT_REQUIRED)
    })

    it('plans with the default carrier of the store when the request names none', async () => {
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { defaultCarrierConnectionId: rangedId }
      })
      const response = await create({ shippingCents: 300 })
      expect(approvalOf(response)).toBe(PriceApprovalStatus.NOT_REQUIRED)
      expect(await carrierOf(response)).toBe(rangedId)
      // An explicit null is no carrier
      const none = await create({
        shippingCents: 300,
        carrierConnectionId: null,
        discountReason: 'out of the range'
      })
      expect(approvalOf(none)).toBe(PriceApprovalStatus.PENDING)
      expect(await carrierOf(none)).toBeNull()
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { defaultCarrierConnectionId: null }
      })
    })

    it('does not plan a carrier of another store, one that was disconnected, nor one that does not exist', async () => {
      const foreign = await createCarrierConnection(owner, { storeId: ctx.storeB.id, prefix: 'OF' })
      expect((await create({ carrierConnectionId: foreign.id })).status).toBe(NOT_FOUND)
      expect((await create({ carrierConnectionId: randomUUID() })).status).toBe(NOT_FOUND)
      const gone = await createCarrierConnection(owner, {
        storeId: ctx.storeA.id,
        prefix: 'OG',
        status: CarrierConnectionStatus.DISABLED
      })
      const refused = await create({ carrierConnectionId: gone.id })
      expect(refused.status).toBe(CONFLICT)
      expect((refused.body as ErrorBody).error.code).toBe(ErrorCodes.SHIPPING_CARRIER_NOT_ACTIVE)
    })

    it('judges the fee again against the new range when the carrier is changed', async () => {
      const made = await create({ shippingCents: 300, carrierConnectionId: rangedId })
      const orderId = (made.body as CreatedBody).order.id
      const moved = await agent
        .patch(ApiRoutes.orders.byId(orderId))
        .send({ carrierConnectionId: otherRangeId, discountReason: 'new carrier, same fee' })
      expect(moved.status).toBe(OK)
      const order = moved.body as OrderBody
      expect(order.priceApprovalStatus).toBe(PriceApprovalStatus.PENDING)
      const row = await owner.order.findUniqueOrThrow({ where: { id: orderId } })
      expect(row.carrierConnectionId).toBe(otherRangeId)
      // And back: the fee fits again and the request is withdrawn
      const back = await agent
        .patch(ApiRoutes.orders.byId(orderId))
        .send({ carrierConnectionId: rangedId })
      expect((back.body as OrderBody).priceApprovalStatus).toBe(PriceApprovalStatus.NOT_REQUIRED)
    })

    it('clears the carrier with null, and refuses a carrier of another store on an edit', async () => {
      const made = await create({ shippingCents: 300, carrierConnectionId: rangedId })
      const orderId = (made.body as CreatedBody).order.id
      const foreign = await createCarrierConnection(owner, { storeId: ctx.storeB.id, prefix: 'OH' })
      const refused = await agent
        .patch(ApiRoutes.orders.byId(orderId))
        .send({ carrierConnectionId: foreign.id })
      expect(refused.status).toBe(NOT_FOUND)
      const cleared = await agent
        .patch(ApiRoutes.orders.byId(orderId))
        .send({ carrierConnectionId: null, discountReason: 'no carrier, same fee' })
      expect((cleared.body as OrderBody).priceApprovalStatus).toBe(PriceApprovalStatus.PENDING)
      expect(
        (await owner.order.findUniqueOrThrow({ where: { id: orderId } })).carrierConnectionId
      ).toBeNull()
    })

    it('does not change the carrier of an order that was paid: its fee is fixed with its total', async () => {
      const made = await create({ shippingCents: 300, carrierConnectionId: rangedId })
      const orderId = (made.body as CreatedBody).order.id
      await owner.order.update({ where: { id: orderId }, data: { paymentStatus: 'COMPLETED' } })
      const refused = await agent
        .patch(ApiRoutes.orders.byId(orderId))
        .send({ carrierConnectionId: otherRangeId, discountReason: 'new carrier' })
      expect(refused.status).toBe(CONFLICT)
      expect((refused.body as ErrorBody).error.code).toBe(ErrorCodes.ORDER_FIELD_NOT_EDITABLE)
    })

    it('leaves a disconnected carrier out of the judgement of an order that had it', async () => {
      const made = await create({ shippingCents: 300, carrierConnectionId: rangedId })
      const orderId = (made.body as CreatedBody).order.id
      const temp = await createCarrierConnection(owner, { storeId: ctx.storeA.id, prefix: 'OT' })
      await owner.order.update({ where: { id: orderId }, data: { carrierConnectionId: temp.id } })
      await owner.carrierConnection.update({
        where: { id: temp.id },
        data: { status: CarrierConnectionStatus.DISABLED }
      })
      // An edit of something else is not blocked by the carrier that was let go
      const edit = await agent
        .patch(ApiRoutes.orders.byId(orderId))
        .send({ customerNotes: 'ring twice' })
      expect(edit.status).toBe(OK)
    })
  })
})
