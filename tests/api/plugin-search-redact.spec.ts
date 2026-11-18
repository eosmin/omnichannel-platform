import { randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, PluginApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'
import { type PluginScope, PluginScopes } from '@platform/plugins/sdk'

import {
  createConversationOf,
  createCustomer,
  createMessage,
  createOrder,
  createPluginKey,
  createProduct
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

const OK = 200
const CREATED = 201
const FORBIDDEN = 403
const NOT_FOUND = 404

interface ErrorBody {
  error: { code: string }
}
interface OrderHit {
  id: string
  orderNumber: string
  customerId?: string
  customerName?: string | null
}
interface MessageHit {
  id: string
  conversationId: string
  customerId: string
  customerName?: string | null
}
interface Hits<T> {
  hits: T[]
}

const SCOPES = {
  ordersOnly: [PluginScopes.ORDERS_READ],
  ordersWithCustomers: [PluginScopes.ORDERS_READ, PluginScopes.CUSTOMERS_READ],
  customersOnly: [PluginScopes.CUSTOMERS_READ],
  messagesOnly: [PluginScopes.CONVERSATIONS_READ, PluginScopes.MESSAGES_READ],
  messagesWithCustomers: [
    PluginScopes.CONVERSATIONS_READ,
    PluginScopes.MESSAGES_READ,
    PluginScopes.CUSTOMERS_READ
  ],
  products: [PluginScopes.PRODUCTS_READ],
  customersWrite: [PluginScopes.CUSTOMERS_READ, PluginScopes.CUSTOMERS_WRITE]
} as const

// TDD_10 §6, Step 5.6 PR E1/E2/E3a: what the search routes and the customer routes of the plugin API show of a customer. The
// identity of a customer (name, phone, id of the customer on an order) is what `customers:read` guards: a key with `orders:read`
// alone finds an order by its number and never by who it is for, and the reason of a caution flag (text the team wrote) goes to no
// plugin at all.
describe('Customer data in the search and customer routes of the plugin API', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  const keys: Record<string, { key: string; installationId: string }> = {}

  const issue = async (name: string, storeId: string, scopes: readonly PluginScope[]) => {
    keys[name] = await createPluginKey(owner, {
      storeId,
      pluginId: `${prefix}-${name}`,
      scopes
    })
  }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    await issue('ordersOnly', ctx.storeA.id, SCOPES.ordersOnly)
    await issue('ordersWithCustomers', ctx.storeA.id, SCOPES.ordersWithCustomers)
    await issue('customersOnly', ctx.storeA.id, SCOPES.customersOnly)
    await issue('messagesOnly', ctx.storeA.id, SCOPES.messagesOnly)
    await issue('messagesWithCustomers', ctx.storeA.id, SCOPES.messagesWithCustomers)
    await issue('products', ctx.storeA.id, SCOPES.products)
    await issue('customersWrite', ctx.storeA.id, SCOPES.customersWrite)
    // The same scopes, in the other store (and the other organization)
    await issue('ordersWithCustomersB', ctx.storeB.id, SCOPES.ordersWithCustomers)
    await issue('productsB', ctx.storeB.id, SCOPES.products)
    await issue('customersWriteB', ctx.storeB.id, SCOPES.customersWrite)
  })
  afterAll(async () => {
    await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: prefix } } })
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  type Method = 'get' | 'post' | 'patch'
  const call = (method: Method, path: string, name?: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    const request = supertest(server)
      [method](`${API_PREFIX}${path}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
    const key = name === undefined ? undefined : keys[name]?.key
    return key === undefined ? request : request.set('authorization', `Bearer ${key}`)
  }
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const unique = () => `plg${randomUUID().slice(0, 8)}`

  // An order of the store whose customer has a name and a phone of its own
  const orderOf = async (storeId: string, name: string, phone: string) => {
    const order = await createOrder(owner, { storeId })
    const row = await owner.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { customerId: true, orderNumber: true }
    })
    await owner.customer.update({
      where: { id: row.customerId },
      data: { name, phone, phoneNormalized: phone.replace(/\D/g, '') }
    })
    return { id: order.id, orderNumber: row.orderNumber, customerId: row.customerId }
  }

  describe('GET /plugin-api/search/orders', () => {
    it('finds an order by its number and answers no customer with orders:read alone', async () => {
      const order = await orderOf(ctx.storeA.id, `Ana ${unique()}`, '79990001')

      const response = await call('get', PluginApiRoutes.search.orders, 'ordersOnly')
        .query({ q: order.orderNumber })
        .expect(OK)

      const body = response.body as Hits<OrderHit>
      expect(body.hits.map(hit => hit.id)).toEqual([order.id])
      const text = JSON.stringify(response.body)
      expect(text).not.toContain(order.customerId)
      expect(text).not.toContain('customerId')
      expect(text).not.toContain('customerName')
    })

    it('does not search by the name of the customer without customers:read', async () => {
      const word = unique()
      const order = await orderOf(ctx.storeA.id, `Beatriz ${word}`, '79990002')

      const response = await call('get', PluginApiRoutes.search.orders, 'ordersOnly')
        .query({ q: word })
        .expect(OK)

      expect((response.body as Hits<OrderHit>).hits).toEqual([])
      expect(JSON.stringify(response.body)).not.toContain(order.customerId)
    })

    it('does not search by the phone of the customer without customers:read', async () => {
      const order = await orderOf(ctx.storeA.id, `Carla ${unique()}`, '78765432')

      const response = await call('get', PluginApiRoutes.search.orders, 'ordersOnly')
        .query({ q: '78765432' })
        .expect(OK)

      expect((response.body as Hits<OrderHit>).hits.map(hit => hit.id)).not.toContain(order.id)
    })

    describe.each(['50370001234', '+503 7000-1234', '7000', '0001234', '1234'])(
      'the phone as %s',
      q => {
        it('does not find the order with orders:read alone, and tells nothing of the customer', async () => {
          const name = `Elena ${unique()}`
          const order = await orderOf(ctx.storeA.id, name, '50370001234')

          const response = await call('get', PluginApiRoutes.search.orders, 'ordersOnly')
            .query({ q })
            .expect(OK)

          // Another order of the run may carry these digits in its number: only the order of that phone must stay out
          expect((response.body as Hits<OrderHit>).hits.map(hit => hit.id)).not.toContain(order.id)
          // The answer repeats the query, so only the hits are read for what must stay out
          const text = JSON.stringify((response.body as Hits<OrderHit>).hits)
          for (const secret of [order.customerId, name, '50370001234', 'customerName']) {
            expect(text).not.toContain(secret)
          }
        })

        // The control: the same phone finds the order for a key that may read customers, so the empty answer above is the rule and
        // not a form that matches nothing
        it('finds the order with customers:read', async () => {
          const order = await orderOf(ctx.storeA.id, `Elena ${unique()}`, '50370001234')

          const response = await call('get', PluginApiRoutes.search.orders, 'ordersWithCustomers')
            .query({ q: q.replace(/\D/g, '') })
            .expect(OK)

          expect((response.body as Hits<OrderHit>).hits.map(hit => hit.id)).toContain(order.id)
        })
      }
    )

    it('searches by the name and the phone and names the customer when the key also holds customers:read', async () => {
      const word = unique()
      const order = await orderOf(ctx.storeA.id, `Diana ${word}`, '76543210')

      const byName = await call('get', PluginApiRoutes.search.orders, 'ordersWithCustomers')
        .query({ q: word })
        .expect(OK)
      const byPhone = await call('get', PluginApiRoutes.search.orders, 'ordersWithCustomers')
        .query({ q: '76543210' })
        .expect(OK)

      for (const response of [byName, byPhone]) {
        const hit = (response.body as Hits<OrderHit>).hits.find(
          candidate => candidate.id === order.id
        )
        expect(hit?.customerId).toBe(order.customerId)
        expect(hit?.customerName).toBe(`Diana ${word}`)
      }
    })

    it('does not name a customer who was erased, even with customers:read', async () => {
      const word = unique()
      const order = await orderOf(ctx.storeA.id, `Elena ${word}`, '75432109')
      await owner.customer.update({
        where: { id: order.customerId },
        data: { erasedAt: new Date() }
      })

      const response = await call('get', PluginApiRoutes.search.orders, 'ordersWithCustomers')
        .query({ q: order.orderNumber })
        .expect(OK)

      const hit = (response.body as Hits<OrderHit>).hits.find(
        candidate => candidate.id === order.id
      )
      expect(hit?.customerName ?? null).toBeNull()
      expect(JSON.stringify(response.body)).not.toContain(word)
    })

    it('needs the orders:read scope', async () => {
      const response = await call('get', PluginApiRoutes.search.orders, 'customersOnly').query({
        q: 'T-'
      })

      expect(response.status).toBe(FORBIDDEN)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
    })

    it('answers the orders of the store of the key only, whatever the scopes', async () => {
      const word = unique()
      const mine = await orderOf(ctx.storeA.id, `Fabiola ${word}`, '74321098')
      const theirs = await orderOf(ctx.storeB.id, `Gloria ${word}`, '74321098')

      const a = await call('get', PluginApiRoutes.search.orders, 'ordersWithCustomers')
        .query({ q: word })
        .expect(OK)
      const b = await call('get', PluginApiRoutes.search.orders, 'ordersWithCustomersB')
        .query({ q: word })
        .expect(OK)

      expect((a.body as Hits<OrderHit>).hits.map(hit => hit.id)).toEqual([mine.id])
      expect((b.body as Hits<OrderHit>).hits.map(hit => hit.id)).toEqual([theirs.id])
      await call('get', PluginApiRoutes.search.orders, 'ordersWithCustomers')
        .query({ q: word, storeId: ctx.storeB.id })
        .expect(400)
    })
  })

  describe('GET /plugin-api/search/messages', () => {
    const conversationWith = async (storeId: string, name: string, text: string) => {
      const conversation = await createConversationOf(owner, { storeId })
      await owner.customer.update({ where: { id: conversation.customerId }, data: { name } })
      const message = await createMessage(owner, {
        storeId,
        conversationId: conversation.id,
        content: text
      })
      return { ...conversation, messageId: message.id }
    }

    it('finds the message and answers no name of the customer without customers:read', async () => {
      const word = unique()
      const found = await conversationWith(ctx.storeA.id, `Hilda ${unique()}`, `hola ${word}`)

      const response = await call('get', PluginApiRoutes.search.messages, 'messagesOnly')
        .query({ q: word })
        .expect(OK)

      const hit = (response.body as Hits<MessageHit>).hits.find(
        candidate => candidate.id === found.messageId
      )
      expect(hit?.conversationId).toBe(found.id)
      expect(JSON.stringify(response.body)).not.toContain('customerName')
      expect(JSON.stringify(response.body)).not.toContain('customerId')
      expect(JSON.stringify(response.body)).not.toContain(found.customerId)
      expect(JSON.stringify(response.body)).not.toContain('Hilda')
    })

    it('names the customer when the key also holds customers:read', async () => {
      const word = unique()
      const found = await conversationWith(ctx.storeA.id, `Irene ${word}`, `hola ${word}`)

      const response = await call('get', PluginApiRoutes.search.messages, 'messagesWithCustomers')
        .query({ q: word })
        .expect(OK)

      const hit = (response.body as Hits<MessageHit>).hits.find(
        candidate => candidate.id === found.messageId
      )
      expect(hit?.customerName).toBe(`Irene ${word}`)
      expect(hit?.customerId).toBe(found.customerId)
    })

    it('needs conversations:read and messages:read', async () => {
      for (const name of ['customersOnly', 'ordersOnly']) {
        const response = await call('get', PluginApiRoutes.search.messages, name).query({
          q: 'hola'
        })

        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      }
    })
  })

  describe('GET /plugin-api/search/products', () => {
    it('finds the products of the store of the key and no others', async () => {
      const word = unique()
      const mine = await createProduct(owner, { storeId: ctx.storeA.id, name: `Camisa ${word}` })
      const theirs = await createProduct(owner, { storeId: ctx.storeB.id, name: `Camisa ${word}` })

      const a = await call('get', PluginApiRoutes.search.products, 'products')
        .query({ q: word })
        .expect(OK)
      const b = await call('get', PluginApiRoutes.search.products, 'productsB')
        .query({ q: word })
        .expect(OK)

      const ids = (response: { body: unknown }) =>
        (response.body as { data: { id: string }[] }).data.map(item => item.id)
      expect(ids(a)).toEqual([mine.id])
      expect(ids(b)).toEqual([theirs.id])
    })

    it('needs the products:read scope', async () => {
      const response = await call('get', PluginApiRoutes.search.products, 'ordersOnly').query({
        q: 'camisa'
      })

      expect(response.status).toBe(FORBIDDEN)
      expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
    })

    it('has no key, no answer', async () => {
      await call('get', PluginApiRoutes.search.products).query({ q: 'camisa' }).expect(401)
    })
  })

  describe('the reason of the caution flag in the customer routes', () => {
    const REASON = 'cobro pendiente: no entregar sin pago por adelantado'
    const flagged = async (storeId: string) => {
      const customer = await createCustomer(owner, { storeId, name: `Julia ${unique()}` })
      await owner.customer.update({
        where: { id: customer.id },
        data: { isCaution: true, cautionReason: REASON }
      })
      return customer
    }

    it('shows the flag and never the reason on the detail of a customer', async () => {
      const customer = await flagged(ctx.storeA.id)

      const response = await call(
        'get',
        PluginApiRoutes.customers.byId(customer.id),
        'customersOnly'
      ).expect(OK)

      const body = response.body as { id: string; isCaution: boolean }
      expect(body.id).toBe(customer.id)
      expect(body.isCaution).toBe(true)
      expect(JSON.stringify(response.body)).not.toContain('cautionReason')
      expect(JSON.stringify(response.body)).not.toContain(REASON)
    })

    it('does not give it back when the customer is edited either', async () => {
      const customer = await flagged(ctx.storeA.id)

      const response = await call(
        'patch',
        PluginApiRoutes.customers.byId(customer.id),
        'customersWrite'
      )
        .send({ name: `Karla ${unique()}` })
        .expect(OK)

      expect((response.body as { isCaution: boolean }).isCaution).toBe(true)
      expect(JSON.stringify(response.body)).not.toContain('cautionReason')
      expect(JSON.stringify(response.body)).not.toContain(REASON)
    })

    it('answers no reason when a customer is created', async () => {
      const response = await call('post', PluginApiRoutes.customers.list, 'customersWrite')
        .send({ name: `Lucia ${unique()}` })
        .expect(CREATED)

      expect(JSON.stringify(response.body)).not.toContain('cautionReason')
    })

    it('shows the flag and no reason in the list and in the search of customers', async () => {
      const customer = await flagged(ctx.storeA.id)

      const list = await call('get', PluginApiRoutes.customers.list, 'customersOnly')
        .query({ q: customer.name })
        .expect(OK)
      const search = await call('get', PluginApiRoutes.search.customers, 'customersOnly')
        .query({ q: customer.name })
        .expect(OK)

      for (const response of [list, search]) {
        expect(JSON.stringify(response.body)).toContain(customer.id)
        expect(JSON.stringify(response.body)).not.toContain('cautionReason')
        expect(JSON.stringify(response.body)).not.toContain(REASON)
      }
    })

    it('does not show the customer of another store', async () => {
      const customer = await flagged(ctx.storeA.id)

      const response = await call(
        'get',
        PluginApiRoutes.customers.byId(customer.id),
        'customersWriteB'
      )

      expect(response.status).toBe(NOT_FOUND)
      expect(JSON.stringify(response.body)).not.toContain(REASON)
    })

    it('still holds the reason in the database for the team', async () => {
      const customer = await flagged(ctx.storeA.id)

      const row = await owner.customer.findUniqueOrThrow({
        where: { id: customer.id },
        select: { cautionReason: true }
      })

      expect(row.cautionReason).toBe(REASON)
    })
  })
})
