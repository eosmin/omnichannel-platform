import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { OrderStatus, PaymentMethod } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { createCustomer } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api } from '../helpers/http'

interface OrderRow {
  id: string
  orderNumber: string
  status: string
  totalCents: number
  itemCount: number
  [key: string]: unknown
}
interface OrdersPage {
  data: OrderRow[]
  nextCursor: string | null
  hasMore: boolean
  figures: {
    orders: number
    totalSpentCents: number
    averageOrderCents: number | null
    firstOrderAt: string | null
    lastOrderAt: string | null
  } | null
}
interface TimelinePage {
  data: { type: string; id: string; orderNumber?: string; totalCents?: number }[]
  nextCursor: string | null
  hasMore: boolean
}
interface ErrorBody {
  error: { code: string }
}

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404

describe('The orders of a customer', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let customersOnly: Actor

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    customersOnly = await actorWithPermissions(owner, app, {
      prefix,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      name: 'customersOnlyA',
      permissions: [Permissions.CUSTOMERS_VIEW]
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  let sequence = 0
  async function makeOrder(
    customerId: string,
    status: OrderStatus,
    totalCents: number,
    createdAt: Date,
    storeId: string = ctx.storeA.id
  ) {
    sequence += 1
    return owner.order.create({
      data: {
        storeId,
        customerId,
        orderNumber: `${prefix}-${sequence}`,
        status,
        subtotalCents: totalCents,
        totalCents,
        paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
        createdBy: ctx.adminA.id,
        createdAt,
        internalNotes: 'owes us a favour',
        packingNotes: 'wrap twice',
        customerNotes: 'ring the bell',
        recipientPhones: ['71234567'],
        shippingAddress: { line1: 'Calle secreta 9' },
        items: {
          create: {
            productId: (
              await owner.product.create({
                data: { storeId, name: `${prefix}-p${sequence}`, priceCents: totalCents },
                select: { id: true }
              })
            ).id,
            productName: 'P',
            quantity: 2,
            unitPriceCents: Math.floor(totalCents / 2)
          }
        }
      }
    })
  }
  const day = (n: number) => new Date(Date.UTC(2026, 0, n, 12))

  describe('GET /customers/:id/orders', () => {
    it('lists them newest first with the figures over the orders the store took on', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await makeOrder(customer.id, OrderStatus.CONFIRMED, 1000, day(1))
      await makeOrder(customer.id, OrderStatus.DELIVERED, 2500, day(3))
      await makeOrder(customer.id, OrderStatus.CANCELLED, 9000, day(4))
      await makeOrder(customer.id, OrderStatus.PENDING_CONFIRMATION, 7000, day(5))

      const response = await asAdmin().get(ApiRoutes.customers.orders(customer.id))

      expect(response.status).toBe(OK)
      const page = response.body as OrdersPage
      expect(page.data.map(order => order.status)).toEqual([
        OrderStatus.PENDING_CONFIRMATION,
        OrderStatus.CANCELLED,
        OrderStatus.DELIVERED,
        OrderStatus.CONFIRMED
      ])
      expect(page.data.every(order => order.itemCount === 1)).toBe(true)
      // 1000 + 2500 over two orders; the pending and the cancelled one are not counted
      expect(page.figures).toEqual({
        orders: 2,
        totalSpentCents: 3500,
        averageOrderCents: 1750,
        firstOrderAt: day(1).toISOString(),
        lastOrderAt: day(3).toISOString()
      })
      expect(page.hasMore).toBe(false)
    })

    it('never carries the notes, the address or the phones of the order', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await makeOrder(customer.id, OrderStatus.CONFIRMED, 1000, day(1))

      const response = await asAdmin().get(ApiRoutes.customers.orders(customer.id))

      const text = JSON.stringify(response.body)
      for (const secret of [
        'owes us a favour',
        'wrap twice',
        'ring the bell',
        'secreta',
        '71234567'
      ]) {
        expect(text).not.toContain(secret)
      }
    })

    it('pages with an opaque cursor and gives the figures of the whole history on the first page only', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      for (const n of [1, 2, 3])
        await makeOrder(customer.id, OrderStatus.CONFIRMED, 100 * n, day(n))

      const first = (
        await asAdmin().get(ApiRoutes.customers.orders(customer.id)).query({ limit: 2 })
      ).body as OrdersPage
      const second = (
        await asAdmin()
          .get(ApiRoutes.customers.orders(customer.id))
          .query({ limit: 2, cursor: first.nextCursor })
      ).body as OrdersPage

      expect(first.data).toHaveLength(2)
      expect(first.hasMore).toBe(true)
      expect(second.data).toHaveLength(1)
      expect(second.hasMore).toBe(false)
      expect(second.nextCursor).toBeNull()
      expect(new Set([...first.data, ...second.data].map(order => order.id)).size).toBe(3)
      expect(first.figures).toMatchObject({ orders: 3, totalSpentCents: 600 })
      expect(second.figures).toBeNull()
    })

    it('does not skip or repeat orders made at the same instant when a page ends between them', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      const moment = day(10)
      for (let i = 0; i < 3; i += 1)
        await makeOrder(customer.id, OrderStatus.CONFIRMED, 100, moment)

      const seen: string[] = []
      let cursor: string | null = null
      for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
        const query: Record<string, string | number> = { limit: 1 }
        if (cursor !== null) query['cursor'] = cursor
        const page = (await asAdmin().get(ApiRoutes.customers.orders(customer.id)).query(query))
          .body as OrdersPage
        seen.push(...page.data.map(order => order.id))
        cursor = page.nextCursor
        if (cursor === null) break
      }

      expect(seen).toHaveLength(3)
      expect(new Set(seen).size).toBe(3)
    })

    it('filters by status, and refuses a status or a cursor it does not know', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await makeOrder(customer.id, OrderStatus.CONFIRMED, 100, day(1))
      await makeOrder(customer.id, OrderStatus.CANCELLED, 200, day(2))

      const cancelled = (
        await asAdmin()
          .get(ApiRoutes.customers.orders(customer.id))
          .query({ status: OrderStatus.CANCELLED })
      ).body as OrdersPage

      expect(cancelled.data.map(order => order.status)).toEqual([OrderStatus.CANCELLED])
      // The figures are over the whole history, not over the filter
      expect(cancelled.figures).toMatchObject({ orders: 1, totalSpentCents: 100 })
      for (const query of [
        { status: 'LOST' },
        { cursor: 'nope' },
        { limit: 0 },
        { storeId: 'x' }
      ]) {
        const refused = await asAdmin().get(ApiRoutes.customers.orders(customer.id)).query(query)
        expect(refused.status).toBe(BAD_REQUEST)
      }
    })

    it('answers zeros and no average for a customer with no order', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })

      const response = await asAdmin().get(ApiRoutes.customers.orders(customer.id))

      expect((response.body as OrdersPage).data).toEqual([])
      expect((response.body as OrdersPage).figures).toEqual({
        orders: 0,
        totalSpentCents: 0,
        averageOrderCents: null,
        firstOrderAt: null,
        lastOrderAt: null
      })
    })

    it('answers 404 for a customer of another store, one that does not exist and one that was absorbed', async () => {
      const foreign = await createCustomer(owner, { storeId: ctx.storeB.id })
      const survivor = await createCustomer(owner, { storeId: ctx.storeA.id })
      const absorbed = await createCustomer(owner, { storeId: ctx.storeA.id })
      await owner.customer.update({
        where: { id: absorbed.id },
        data: { mergedIntoId: survivor.id }
      })

      for (const id of [foreign.id, randomUUID(), absorbed.id]) {
        const response = await asAdmin().get(ApiRoutes.customers.orders(id))
        expect(response.status).toBe(NOT_FOUND)
        expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
      }
    })

    it('needs the permission to view orders besides the one to view customers', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await makeOrder(customer.id, OrderStatus.CONFIRMED, 100, day(1))

      const response = await api(app, customersOnly, ctx.storeA).get(
        ApiRoutes.customers.orders(customer.id)
      )

      expect(response.status).toBe(FORBIDDEN)
      expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.PERMISSION_DENIED)
    })
  })

  describe('the orders in GET /customers/:id/timeline', () => {
    it('come in the timeline with their number and total, and filter by type', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      const older = await makeOrder(customer.id, OrderStatus.CONFIRMED, 1000, day(1))
      const newer = await makeOrder(customer.id, OrderStatus.CANCELLED, 2000, day(2))
      await owner.customerNote.create({
        data: { customerId: customer.id, authorId: ctx.adminA.id, content: 'a note' }
      })

      const all = (await asAdmin().get(ApiRoutes.customers.timeline(customer.id)))
        .body as TimelinePage
      const onlyOrders = (
        await asAdmin().get(ApiRoutes.customers.timeline(customer.id)).query({ type: 'order' })
      ).body as TimelinePage

      const orderIds = all.data.filter(entry => entry.type === 'order').map(entry => entry.id)
      expect(orderIds).toEqual([newer.id, older.id])
      expect(all.data.some(entry => entry.type === 'note')).toBe(true)
      expect(onlyOrders.data.map(entry => entry.id)).toEqual([newer.id, older.id])
      expect(onlyOrders.data[0]).toMatchObject({ orderNumber: newer.orderNumber, totalCents: 2000 })
      expect(JSON.stringify(all)).not.toContain('owes us a favour')
      expect(JSON.stringify(all)).not.toContain('wrap twice')
    })

    it('are left out for a member who may not view orders, and the rest still comes', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      await makeOrder(customer.id, OrderStatus.CONFIRMED, 1000, day(1))
      await owner.customerNote.create({
        data: { customerId: customer.id, authorId: ctx.adminA.id, content: 'a note' }
      })

      const response = await api(app, customersOnly, ctx.storeA).get(
        ApiRoutes.customers.timeline(customer.id)
      )

      expect(response.status).toBe(OK)
      const types = (response.body as TimelinePage).data.map(entry => entry.type)
      expect(types).toEqual(['note'])
    })
  })
})
