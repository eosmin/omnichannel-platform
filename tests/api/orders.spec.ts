import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  OrderConflicts,
  OrderNotices,
  PaymentMethod,
  PriceApprovalStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { createConversationOf, createProduct, createProductVariant } from '../builders'
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

// Creating an order (Step 4.3 PR B): the server prices it from the catalog, allocates and reserves the stock, and
// controls every price change. The life of the order is in orders-lifecycle.spec.ts.
describe('Creating an order', () => {
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
  afterEach(() => kit.resetSettings())

  const errorOf = (response: { body: unknown }) => (response.body as ErrorBody).error
  const post = (body: unknown, agent = kit.asAdmin()) =>
    agent.post(ApiRoutes.orders.create).send(body as object)
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
  // Members that can make and read orders but hold no override or approval
  const agentOf = (extra: Parameters<typeof actorWithPermissions>[2]['permissions'] = []) =>
    member('agent', [
      Permissions.ORDERS_VIEW,
      Permissions.ORDERS_CREATE,
      Permissions.ORDERS_EDIT,
      ...extra
    ])
  const setDiscountLimit = (percent: number) =>
    owner.storeSettings.update({
      where: { storeId: ctx.storeA.id },
      data: { preferences: { orders: { discountLimitPercent: percent } } }
    })

  describe('the order itself', () => {
    it('is created pending, priced from the catalog, with the totals computed by the server', async () => {
      const body = await kit.orderBody({ shippingCents: 300 })

      const response = await post(body)

      expect(response.status).toBe(CREATED)
      const { order, notices } = response.body as CreatedBody
      expect(notices).toEqual([])
      expect(order).toMatchObject({
        status: 'PENDING_CONFIRMATION',
        subtotalCents: 2000,
        shippingCents: 300,
        discountCents: 0,
        totalCents: 2300,
        paymentStatus: 'PENDING',
        priceApprovalStatus: PriceApprovalStatus.NOT_REQUIRED,
        recipientPhones: ['71234567'],
        priceModified: false
      })
      expect(order.orderNumber).toMatch(/^\d{5,}$/)
      expect(order.customer.nationalPhone).toBe('71234567')
      expect(order.items[0]).toMatchObject({ quantity: 2, unitPriceCents: 1000 })
      const row = await owner.order.findFirstOrThrow({ where: { id: order.id } })
      expect(row).toMatchObject({ storeId: ctx.storeA.id, createdBy: ctx.adminA.id })
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_CREATED,
        resourceId: order.id
      })
      expect(entries[0]).toMatchObject({ storeId: ctx.storeA.id, userId: ctx.adminA.id })
    })

    it('numbers the orders of a store one after the other, and each store has its own count', async () => {
      const first = (await post(await kit.orderBody())).body as CreatedBody
      const second = (await post(await kit.orderBody())).body as CreatedBody

      expect(Number(second.order.orderNumber)).toBe(Number(first.order.orderNumber) + 1)
      expect(second.order.orderNumber).toHaveLength(first.order.orderNumber.length)
    })

    it('refuses what the client must not send: a total, a status, a store, an unknown field', async () => {
      const body = await kit.orderBody()
      for (const forged of [
        { totalCents: 1 },
        { subtotalCents: 1 },
        { status: 'CONFIRMED' },
        { storeId: ctx.storeB.id },
        { freeShipping: true },
        { priceApprovalStatus: 'approved' }
      ]) {
        const response = await post({ ...body, ...forged })
        expect(response.status).toBe(BAD_REQUEST)
      }
      expect(
        await owner.order.count({ where: { storeId: ctx.storeA.id, customerId: body.customerId } })
      ).toBe(0)
    })

    it('reads the price of a variant, or of its product when the variant has none', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id, priceCents: 1000 })
      const priced = await createProductVariant(owner, {
        productId: product.id,
        name: 'XL',
        priceCents: 1500
      })
      const inherits = await createProductVariant(owner, {
        productId: product.id,
        name: 'M',
        priceCents: null
      })
      await owner.product.update({ where: { id: product.id }, data: { trackInventory: false } })
      const customer = await kit.customer()

      const response = await post({
        customerId: customer.id,
        items: [
          { productId: product.id, variantId: priced.id, quantity: 1 },
          { productId: product.id, variantId: inherits.id, quantity: 2 }
        ],
        paymentMethod: PaymentMethod.CASH,
        recipientPhones: ['71234567']
      })

      expect(response.status).toBe(CREATED)
      expect((response.body as CreatedBody).order.subtotalCents).toBe(1500 + 2 * 1000)
    })

    it('refuses a product that has variants without the one that is sold, a switched-off product and a foreign variant', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      const variant = await createProductVariant(owner, { productId: product.id, name: 'XL' })
      const other = await createProduct(owner, { storeId: ctx.storeA.id })
      const otherVariant = await createProductVariant(owner, { productId: other.id, name: 'S' })
      const off = await createProduct(owner, { storeId: ctx.storeA.id, active: false })
      const customer = await kit.customer()
      const base = {
        customerId: customer.id,
        paymentMethod: PaymentMethod.CASH,
        recipientPhones: ['71234567']
      }

      const noVariant = await post({ ...base, items: [{ productId: product.id, quantity: 1 }] })
      expect(noVariant.status).toBe(CONFLICT)
      expect(errorOf(noVariant).metadata).toMatchObject({
        conflict: OrderConflicts.VARIANT_REQUIRED
      })
      const inactive = await post({ ...base, items: [{ productId: off.id, quantity: 1 }] })
      expect(inactive.status).toBe(CONFLICT)
      expect(errorOf(inactive).metadata).toMatchObject({
        conflict: OrderConflicts.PRODUCT_INACTIVE
      })
      const foreign = await post({
        ...base,
        items: [{ productId: product.id, variantId: otherVariant.id, quantity: 1 }]
      })
      expect(foreign.status).toBe(NOT_FOUND)
      expect(variant.id).toBeDefined()
    })

    it('answers 404 for a customer, a product or a conversation of another store, and writes nothing', async () => {
      const body = await kit.orderBody()
      const foreignCustomer = await owner.customer.create({
        data: { storeId: ctx.storeB.id, name: 'x' }
      })
      const foreignProduct = await createProduct(owner, { storeId: ctx.storeB.id })

      for (const change of [
        { customerId: foreignCustomer.id },
        { items: [{ productId: foreignProduct.id, quantity: 1 }] },
        { conversationId: randomUUID() }
      ]) {
        const response = await post({ ...body, ...change })
        expect(response.status).toBe(NOT_FOUND)
      }
      expect(
        await owner.order.count({ where: { storeId: ctx.storeA.id, customerId: body.customerId } })
      ).toBe(0)
    })

    it('goes to the customer a merge left, and refuses a customer that was erased', async () => {
      const survivor = await kit.customer()
      const absorbed = await kit.customer()
      await owner.customer.update({
        where: { id: absorbed.id },
        data: { mergedIntoId: survivor.id }
      })
      const erased = await kit.customer()
      await owner.customer.update({ where: { id: erased.id }, data: { erasedAt: new Date() } })
      const body = await kit.orderBody()

      const merged = await post({ ...body, customerId: absorbed.id })
      const refused = await post({ ...body, customerId: erased.id })

      expect(merged.status).toBe(CREATED)
      expect((merged.body as CreatedBody).order.customerId).toBe(survivor.id)
      expect(refused.status).toBe(CONFLICT)
      expect(errorOf(refused).metadata).toMatchObject({ conflict: OrderConflicts.CUSTOMER_ERASED })
    })

    it('is refused without orders:create, and an agent who can only read cannot create', async () => {
      const reader = await member('reader', [Permissions.ORDERS_VIEW])
      const none = await member('none', [Permissions.CUSTOMERS_VIEW])
      const body = await kit.orderBody()

      expect((await post(body, reader)).status).toBe(FORBIDDEN)
      expect((await post(body, none)).status).toBe(FORBIDDEN)
    })

    it('does not tell the contact data, the address or the notes back to a member who may create but not read orders', async () => {
      const creator = await member('creator', [Permissions.ORDERS_CREATE])
      const body = await kit.orderBody({
        customerNotes: 'leave it at the door',
        internalNotes: 'for customer care',
        packingNotes: 'wrap it twice',
        shippingAddress: { line1: '1 Main St', city: 'San Salvador' }
      })

      const response = await post(body, creator)

      expect(response.status).toBe(CREATED)
      const { order } = response.body as CreatedBody
      expect(order).toMatchObject({
        customerNotes: null,
        shippingAddress: null,
        recipientPhones: [],
        customer: { id: body.customerId, name: null, email: null, phone: null, nationalPhone: null }
      })
      expect('internalNotes' in order).toBe(false)
      expect('packingNotes' in order).toBe(false)
      const row = await owner.order.findFirstOrThrow({ where: { id: order.id } })
      expect(row).toMatchObject({
        customerNotes: 'leave it at the door',
        internalNotes: 'for customer care',
        packingNotes: 'wrap it twice'
      })
      // The member who may read orders reads it all
      const read = await kit.asAdmin().get(ApiRoutes.orders.byId(order.id))
      expect((read.body as OrderBody).customerNotes).toBe('leave it at the door')
    })

    it('links an order only to a conversation of its own customer', async () => {
      const body = await kit.orderBody()
      const foreignThread = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const ownThread = await createConversationOf(owner, { storeId: ctx.storeA.id })

      const wrong = await post({
        ...body,
        customerId: ownThread.customerId,
        conversationId: foreignThread.id
      })
      const right = await post({
        ...body,
        customerId: ownThread.customerId,
        conversationId: ownThread.id
      })

      expect(wrong.status).toBe(NOT_FOUND)
      expect(right.status).toBe(CREATED)
    })
  })

  describe('the stock', () => {
    it('reserves each allocation through the engine and records it, in the first warehouse that covers the line', async () => {
      const product = await kit.stocked(5, 20)
      const body = await kit.orderBody({ items: [{ productId: product.id, quantity: 4 }] })

      const response = await post(body)

      expect(response.status).toBe(CREATED)
      const item = (response.body as CreatedBody).order.items[0]
      expect(item?.allocations).toEqual([{ warehouseId: ctx.warehouseA.id, quantity: 4 }])
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({
        onHand: 5,
        reserved: 4
      })
      expect(await kit.level(product.id, ctx.warehouseASecond.id)).toMatchObject({
        onHand: 20,
        reserved: 0
      })
      const reserve = await owner.inventoryMovement.findMany({
        where: { productId: product.id, type: 'reserve' }
      })
      expect(reserve).toHaveLength(1)
      expect(reserve[0]).toMatchObject({
        referenceType: 'order',
        quantity: 4,
        createdBy: ctx.adminA.id
      })
      expect(reserve[0]?.idempotencyKey).toMatch(/^order:/)
    })

    it('is refused with INSUFFICIENT_INVENTORY when no warehouse covers the line and split is off, and nothing is written', async () => {
      const product = await kit.stocked(6, 8)
      const body = await kit.orderBody({ items: [{ productId: product.id, quantity: 10 }] })

      const response = await post(body)

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response)).toMatchObject({
        code: ErrorCodes.INSUFFICIENT_INVENTORY,
        metadata: {
          productId: product.id,
          requested: 10,
          availableByWarehouse: [
            { warehouseId: ctx.warehouseA.id, available: 6 },
            { warehouseId: ctx.warehouseASecond.id, available: 8 }
          ]
        }
      })
      expect(
        await owner.order.count({ where: { storeId: ctx.storeA.id, customerId: body.customerId } })
      ).toBe(0)
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ reserved: 0 })
    })

    it('splits the line across the warehouses by priority when the store allows it (the example of TDD_16 §4.1)', async () => {
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { allowSplitFulfillment: true }
      })
      const product = await kit.stocked(6, 8)
      const body = await kit.orderBody({ items: [{ productId: product.id, quantity: 10 }] })

      const response = await post(body)

      expect(response.status).toBe(CREATED)
      const item = (response.body as CreatedBody).order.items[0]
      expect(item?.allocations).toEqual([
        { warehouseId: ctx.warehouseA.id, quantity: 6 },
        { warehouseId: ctx.warehouseASecond.id, quantity: 4 }
      ])
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({ reserved: 6 })
      expect(await kit.level(product.id, ctx.warehouseASecond.id)).toMatchObject({ reserved: 4 })
    })

    it('still refuses when all the warehouses together are short, split on', async () => {
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { allowSplitFulfillment: true }
      })
      const product = await kit.stocked(6, 8)

      const response = await post(
        await kit.orderBody({ items: [{ productId: product.id, quantity: 15 }] })
      )

      expect(response.status).toBe(CONFLICT)
      expect(errorOf(response).code).toBe(ErrorCodes.INSUFFICIENT_INVENTORY)
    })

    it('sells what is missing from the first warehouse when the store allows negative stock', async () => {
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { allowNegativeStock: true }
      })
      const product = await kit.stocked(3)

      const response = await post(
        await kit.orderBody({ items: [{ productId: product.id, quantity: 10 }] })
      )

      expect(response.status).toBe(CREATED)
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({
        onHand: 3,
        reserved: 10
      })
    })

    it('does not touch the stock of a product that does not track it', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id })
      await owner.product.update({ where: { id: product.id }, data: { trackInventory: false } })

      const response = await post(
        await kit.orderBody({ items: [{ productId: product.id, quantity: 3 }] })
      )

      expect(response.status).toBe(CREATED)
      expect((response.body as CreatedBody).order.items[0]?.allocations).toEqual([])
      expect(await owner.inventoryLevel.count({ where: { productId: product.id } })).toBe(0)
    })

    it('gives the last unit to exactly one of two orders made at the same time', async () => {
      const product = await kit.stocked(1)
      const bodyOf = async () => kit.orderBody({ items: [{ productId: product.id, quantity: 1 }] })
      const [first, second] = await Promise.all([bodyOf(), bodyOf()])

      const answers = await Promise.all([post(first), post(second)])

      expect(answers.map(answer => answer.status).sort()).toEqual([CREATED, CONFLICT])
      expect(await kit.level(product.id, ctx.warehouseA.id)).toMatchObject({
        onHand: 1,
        reserved: 1
      })
    })
  })

  describe('the price control of TDD_17 §4.13', () => {
    it('refuses a price on a line from a member without orders:override_price', async () => {
      const agent = await agentOf()
      const body = await kit.orderBody()
      const [line] = body.items as { productId: string; quantity: number }[]

      const response = await post(
        { ...body, items: [{ ...line, unitPriceCents: 1, priceReason: 'a friend' }] },
        agent
      )

      expect(response.status).toBe(FORBIDDEN)
      expect(errorOf(response).code).toBe(ErrorCodes.ORDER_PRICE_OVERRIDE_FORBIDDEN)
    })

    it('takes a price from a member who holds the override, with its reason, and records the original', async () => {
      const body = await kit.orderBody()
      const [line] = body.items as { productId: string; quantity: number }[]

      const missingReason = await post({ ...body, items: [{ ...line, unitPriceCents: 700 }] })
      expect(missingReason.status).toBe(BAD_REQUEST)
      expect(errorOf(missingReason).code).toBe(ErrorCodes.ORDER_PRICE_REASON_REQUIRED)

      const response = await post({
        ...body,
        items: [{ ...line, unitPriceCents: 700, priceReason: 'damaged box' }]
      })

      expect(response.status).toBe(CREATED)
      const { order } = response.body as CreatedBody
      expect(order).toMatchObject({
        subtotalCents: 1400,
        totalCents: 1400,
        priceModified: true,
        priceApprovalStatus: PriceApprovalStatus.NOT_REQUIRED
      })
      expect(order.items[0]).toMatchObject({
        unitPriceCents: 700,
        originalUnitPriceCents: 1000,
        priceOverrideReason: 'damaged box'
      })
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_PRICE_OVERRIDDEN,
        resourceId: order.id
      })
      expect(entries[0]?.metadata).toMatchObject({
        lines: [{ fromCents: 1000, toCents: 700, reason: 'damaged box' }]
      })
    })

    it('takes a price equal to the catalog as no override at all', async () => {
      const agent = await agentOf()
      const body = await kit.orderBody()
      const [line] = body.items as { productId: string; quantity: number }[]

      const response = await post({ ...body, items: [{ ...line, unitPriceCents: 1000 }] }, agent)

      expect(response.status).toBe(CREATED)
      expect((response.body as CreatedBody).order.priceModified).toBe(false)
    })

    it('allows no discount while the store limit is 0: the order waits for an approval, and the reason is required', async () => {
      const agent = await agentOf()
      const body = await kit.orderBody()

      const noReason = await post({ ...body, discountCents: 100 }, agent)
      expect(noReason.status).toBe(BAD_REQUEST)
      expect(errorOf(noReason).code).toBe(ErrorCodes.ORDER_PRICE_REASON_REQUIRED)

      const response = await post(
        { ...body, discountCents: 100, discountReason: 'loyal customer' },
        agent
      )

      expect(response.status).toBe(CREATED)
      const { order } = response.body as CreatedBody
      expect(order).toMatchObject({
        discountCents: 100,
        totalCents: 1900,
        priceApprovalStatus: PriceApprovalStatus.PENDING,
        discountReason: 'loyal customer'
      })
      const row = await owner.order.findFirstOrThrow({ where: { id: order.id } })
      expect(row.priceApprovalRequestedBy).not.toBeNull()
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_PRICE_APPROVAL_REQUESTED,
        resourceId: order.id
      })
      expect(entries).toHaveLength(1)
    })

    it('passes a discount inside the limit of the store without approval, and audits it', async () => {
      await setDiscountLimit(10)
      const agent = await agentOf()
      const body = await kit.orderBody()

      const within = await post({ ...body, discountCents: 200, discountReason: 'promo' }, agent)
      const above = await post(
        { ...(await kit.orderBody()), discountCents: 201, discountReason: 'promo' },
        agent
      )

      expect((within.body as CreatedBody).order.priceApprovalStatus).toBe(
        PriceApprovalStatus.NOT_REQUIRED
      )
      expect((above.body as CreatedBody).order.priceApprovalStatus).toBe(
        PriceApprovalStatus.PENDING
      )
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.ORDER_DISCOUNT_APPLIED,
        resourceId: (within.body as CreatedBody).order.id
      })
      expect(entries[0]?.metadata).toMatchObject({ discountCents: 200, reason: 'promo' })
    })

    it('lets a member with the override give any discount, with a reason, and never asks for approval', async () => {
      const response = await post({
        ...(await kit.orderBody()),
        discountCents: 1500,
        discountReason: 'vip'
      })

      expect(response.status).toBe(CREATED)
      expect((response.body as CreatedBody).order).toMatchObject({
        discountCents: 1500,
        priceApprovalStatus: PriceApprovalStatus.NOT_REQUIRED
      })
    })

    it('refuses a discount above the subtotal', async () => {
      const response = await post({
        ...(await kit.orderBody()),
        discountCents: 2001,
        discountReason: 'x'
      })

      expect(response.status).toBe(BAD_REQUEST)
      expect(errorOf(response).code).toBe(ErrorCodes.ORDER_DISCOUNT_EXCEEDS_SUBTOTAL)
    })

    it('accepts a fee of 0 on a free-shipping order and asks for approval for any other', async () => {
      const agent = await agentOf()
      const free = await kit.stocked(10)
      await owner.product.update({ where: { id: free.id }, data: { freeShipping: true } })
      const body = await kit.orderBody({ items: [{ productId: free.id, quantity: 1 }] })

      const zero = await post(body, agent)
      const fee = await post(
        {
          ...(await kit.orderBody({ items: [{ productId: free.id, quantity: 1 }] })),
          shippingCents: 500,
          discountReason: 'courier'
        },
        agent
      )

      expect((zero.body as CreatedBody).order).toMatchObject({
        freeShipping: true,
        priceApprovalStatus: PriceApprovalStatus.NOT_REQUIRED
      })
      expect((fee.body as CreatedBody).order.priceApprovalStatus).toBe(PriceApprovalStatus.PENDING)
    })

    it('follows the rule of the store for a mixed cart: all items by default, any item when set', async () => {
      const flagged = await kit.stocked(10)
      await owner.product.update({ where: { id: flagged.id }, data: { freeShipping: true } })
      const plain = await kit.stocked(10)
      const mixed = () =>
        kit.orderBody({
          items: [
            { productId: flagged.id, quantity: 1 },
            { productId: plain.id, quantity: 1 }
          ]
        })

      const byDefault = await post(await mixed())
      await owner.storeSettings.update({
        where: { storeId: ctx.storeA.id },
        data: { preferences: { orders: { freeShippingRule: 'any_item' } } }
      })
      const anyItem = await post(await mixed())

      expect((byDefault.body as CreatedBody).order.freeShipping).toBe(false)
      expect((anyItem.body as CreatedBody).order.freeShipping).toBe(true)
    })

    it('never confirms at creation an order that waits for an approval, and says so', async () => {
      const response = await post(
        {
          ...(await kit.orderBody()),
          discountCents: 100,
          discountReason: 'x',
          confirmOnCreate: true
        },
        await agentOf([Permissions.ORDERS_CONFIRM])
      )

      expect(response.status).toBe(CREATED)
      const { order, notices } = response.body as CreatedBody
      expect(order.status).toBe('PENDING_CONFIRMATION')
      expect(notices).toEqual([OrderNotices.CONFIRMATION_SKIPPED_PRICE_APPROVAL])
    })
  })

  describe('confirming at creation', () => {
    it('creates the order confirmed, with how and by whom, for a member with orders:confirm', async () => {
      const response = await post({ ...(await kit.orderBody()), confirmOnCreate: true })

      expect(response.status).toBe(CREATED)
      expect((response.body as CreatedBody).order).toMatchObject({
        status: 'CONFIRMED',
        confirmedVia: 'at_creation'
      })
      const row = await owner.order.findFirstOrThrow({
        where: { id: (response.body as CreatedBody).order.id }
      })
      expect(row).toMatchObject({ confirmedBy: ctx.adminA.id })
      expect(row.confirmedAt).not.toBeNull()
    })

    it('refuses the flag from a member without orders:confirm instead of ignoring it', async () => {
      const response = await post(
        { ...(await kit.orderBody()), confirmOnCreate: true },
        await agentOf()
      )

      expect(response.status).toBe(FORBIDDEN)
      expect(errorOf(response).code).toBe(ErrorCodes.PERMISSION_DENIED)
    })
  })

  describe('reading', () => {
    it('reads one order with its lines and allocations, and 404s an order of another store', async () => {
      const created = (await post(await kit.orderBody())).body as CreatedBody
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

      const mine = await kit.asAdmin().get(ApiRoutes.orders.byId(created.order.id))
      const theirs = await kit.asAdmin().get(ApiRoutes.orders.byId(other.id))

      expect(mine.status).toBe(OK)
      expect((mine.body as OrderBody).items).toHaveLength(1)
      expect(theirs.status).toBe(NOT_FOUND)
    })

    it('lists the orders newest first in pages, filtered by status and customer', async () => {
      const customer = await kit.customer()
      const made: string[] = []
      for (let count = 0; count < 3; count += 1) {
        const response = await post({ ...(await kit.orderBody()), customerId: customer.id })
        made.push((response.body as CreatedBody).order.id)
      }

      const first = await kit
        .asAdmin()
        .get(`${ApiRoutes.orders.list}?customerId=${customer.id}&limit=2`)
      const body = first.body as { data: { id: string }[]; nextCursor: string; hasMore: boolean }
      const second = await kit
        .asAdmin()
        .get(`${ApiRoutes.orders.list}?customerId=${customer.id}&limit=2&cursor=${body.nextCursor}`)

      expect(body.data.map(row => row.id)).toEqual([made[2], made[1]])
      expect(body.hasMore).toBe(true)
      expect((second.body as { data: { id: string }[] }).data.map(row => row.id)).toEqual([made[0]])
      const none = await kit
        .asAdmin()
        .get(`${ApiRoutes.orders.list}?customerId=${customer.id}&status=CANCELLED`)
      expect((none.body as { data: unknown[] }).data).toEqual([])
    })

    it('refuses a bad cursor and a bad filter with a 400', async () => {
      for (const query of [
        'cursor=nope',
        'status=LOST',
        'limit=0',
        'scheduledDeliveryOn=today&scheduledDeliveryFrom=2026-01-01'
      ]) {
        const response = await kit.asAdmin().get(`${ApiRoutes.orders.list}?${query}`)
        expect(response.status).toBe(BAD_REQUEST)
      }
    })
  })
})
