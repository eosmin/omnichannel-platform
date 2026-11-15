import { randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, PluginApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  OrderGuideFilters,
  OrderMessageKind,
  OrderMessageRoutes,
  OrderMessageTriggers
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Locales } from '@platform/core/i18n'
import { PluginScopes } from '@platform/plugins/sdk'

import { createOrder, createOrderMessageTemplate, createPluginKey } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

const OK = 200
const UNAUTHORIZED = 401
const FORBIDDEN = 403
const NOT_FOUND = 404
const BAD_REQUEST = 400

interface ErrorBody {
  error: { code: string }
}
interface PageBody {
  data: { id: string }[]
}
interface DetailBody {
  id: string
  totalCents: number
  internalNotes?: unknown
  packingNotes?: unknown
  items: { unitPriceCents: number }[]
}
interface HistoryBody {
  data: { id: string; route: string }[]
}

const EXPECTED_PREFERENCE_KEYS = [
  'assignOnReply',
  'orders',
  'remittances',
  'returns',
  'sendReadReceipts'
]

const READER = [
  PluginScopes.ORDERS_READ,
  PluginScopes.ORDER_MESSAGES_READ,
  PluginScopes.SETTINGS_READ
]

// TDD_10 §6, Step 5.6 PR E3a: the orders, their message history, the order templates and the store preferences, read under the
// key of a plugin over the same services as the screens. What matters is the tenancy (the key names the store), the scopes (each
// route its own), what a plugin must never read (the internal notes) and that the writes are not there.
describe('Orders, order messages and settings through the plugin API (read)', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let keyA: { key: string; installationId: string }
  let keyB: { key: string; installationId: string }
  let ordersOnly: { key: string; installationId: string }
  let settingsOnly: { key: string; installationId: string }
  let messagesOnly: { key: string; installationId: string }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    keyA = await createPluginKey(owner, {
      storeId: ctx.storeA.id,
      pluginId: `${prefix}-all`,
      scopes: READER
    })
    keyB = await createPluginKey(owner, {
      storeId: ctx.storeB.id,
      pluginId: `${prefix}-all`,
      scopes: READER
    })
    ordersOnly = await createPluginKey(owner, {
      storeId: ctx.storeA.id,
      pluginId: `${prefix}-orders`,
      scopes: [PluginScopes.ORDERS_READ]
    })
    messagesOnly = await createPluginKey(owner, {
      storeId: ctx.storeA.id,
      pluginId: `${prefix}-messages`,
      scopes: [PluginScopes.ORDER_MESSAGES_READ]
    })
    settingsOnly = await createPluginKey(owner, {
      storeId: ctx.storeA.id,
      pluginId: `${prefix}-settings`,
      scopes: [PluginScopes.SETTINGS_READ]
    })
  })
  afterAll(async () => {
    await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: prefix } } })
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const get = (path: string, key?: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    const request = supertest(server)
      .get(`${API_PREFIX}${path}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
    return key === undefined ? request : request.set('authorization', `Bearer ${key}`)
  }
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, key: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    return supertest(server)
      [method](`${API_PREFIX}${path}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
      .set('authorization', `Bearer ${key}`)
      .send({})
  }
  const asA = (path: string) => get(path, keyA.key)
  const asB = (path: string) => get(path, keyB.key)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code

  describe('the tenancy', () => {
    it('lists the orders of the store of the key and never those of another store', async () => {
      const mine = await createOrder(owner, { storeId: ctx.storeA.id })
      const theirs = await createOrder(owner, { storeId: ctx.storeB.id })

      const a = await asA(PluginApiRoutes.orders.list).expect(OK)
      const b = await asB(PluginApiRoutes.orders.list).expect(OK)

      const idsA = (a.body as PageBody).data.map(item => item.id)
      const idsB = (b.body as PageBody).data.map(item => item.id)
      expect(idsA).toContain(mine.id)
      expect(idsA).not.toContain(theirs.id)
      expect(idsB).toContain(theirs.id)
      expect(idsB).not.toContain(mine.id)
    })

    it('ignores the store a call names in the x-store-id header', async () => {
      const mine = await createOrder(owner, { storeId: ctx.storeA.id })
      const theirs = await createOrder(owner, { storeId: ctx.storeB.id })

      const response = await asA(PluginApiRoutes.orders.list)
        .set('x-store-id', ctx.storeB.id)
        .expect(OK)

      const ids = (response.body as PageBody).data.map(item => item.id)
      expect(ids).toContain(mine.id)
      expect(ids).not.toContain(theirs.id)
    })

    it('does not find an order of another store by id, nor its message history', async () => {
      const theirs = await createOrder(owner, { storeId: ctx.storeB.id })

      const detail = await asA(PluginApiRoutes.orders.byId(theirs.id)).expect(NOT_FOUND)
      const history = await asA(PluginApiRoutes.orders.messages(theirs.id)).expect(NOT_FOUND)

      expect(codeOf(detail.body)).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
      expect(codeOf(history.body)).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
      await asB(PluginApiRoutes.orders.byId(theirs.id)).expect(OK)
    })

    it('reads the templates of its own store only', async () => {
      const mine = await createOrderMessageTemplate(owner, {
        storeId: ctx.storeA.id,
        kind: OrderMessageKind.ORDER_SHIPPED,
        locale: Locales.ES,
        body: `Hola ${prefix}-a`
      })
      await createOrderMessageTemplate(owner, {
        storeId: ctx.storeB.id,
        kind: OrderMessageKind.ORDER_SHIPPED,
        locale: Locales.ES,
        body: `Hola ${prefix}-b`
      })

      const list = await asA(PluginApiRoutes.orderTemplates.list).expect(OK)
      const one = await asA(
        PluginApiRoutes.orderTemplates.byKindAndLocale(mine.kind, mine.locale)
      ).expect(OK)

      const texts = JSON.stringify(list.body)
      expect(texts).toContain(`${prefix}-a`)
      expect(texts).not.toContain(`${prefix}-b`)
      expect((one.body as { body: string }).body).toBe(`Hola ${prefix}-a`)
    })
  })

  describe('what a plugin reads of an order', () => {
    it('answers the detail without the internal and the packing notes', async () => {
      const order = await createOrder(owner, {
        storeId: ctx.storeA.id,
        customerNotes: 'leave it at the door',
        internalNotes: 'customer is a difficult one',
        packingNotes: 'fragile, double box'
      })

      const response = await asA(PluginApiRoutes.orders.byId(order.id)).expect(OK)

      const body = response.body as DetailBody
      expect(body.id).toBe(order.id)
      expect(body).not.toHaveProperty('internalNotes')
      expect(body).not.toHaveProperty('packingNotes')
      expect(JSON.stringify(response.body)).not.toContain('difficult')
      expect(JSON.stringify(response.body)).not.toContain('leave it at the door')
      expect(JSON.stringify(response.body)).not.toContain('double box')
    })

    it('answers money in whole cents and no cost of the product', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })

      const response = await asA(PluginApiRoutes.orders.byId(order.id)).expect(OK)

      const body = response.body as DetailBody
      expect(body.totalCents).toBe(1999)
      expect(body.items[0]?.unitPriceCents).toBe(1999)
      expect(JSON.stringify(response.body).toLowerCase()).not.toMatch(/cost/)
    })

    it('answers none of the customer, the address, the payment proof, the guide or the people of the team', async () => {
      const order = await createOrder(owner, {
        storeId: ctx.storeA.id,
        shippingAddress: { line1: 'Calle Secreta 123' },
        recipientPhones: ['79998888']
      })
      const customer = await owner.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { customerId: true, createdBy: true, customer: { select: { name: true } } }
      })

      const detail = await asA(PluginApiRoutes.orders.byId(order.id)).expect(OK)
      const list = await asA(PluginApiRoutes.orders.list).expect(OK)

      const text = JSON.stringify([detail.body, list.body])
      for (const secret of [
        'Calle Secreta',
        '79998888',
        customer.customerId,
        customer.createdBy,
        order.productId,
        customer.customer.name ?? randomUUID()
      ]) {
        expect(text).not.toContain(secret)
      }
      for (const field of ['customer', 'shippingAddress', 'carrierConnectionId', 'createdBy']) {
        expect(text).not.toContain(`"${field}"`)
      }
    })

    it('takes no text search and no customer, guide or carrier filter: they reach the customer or the shipping data', async () => {
      for (const query of [
        { q: 'ana' },
        { customerId: randomUUID() },
        { guide: OrderGuideFilters.WITH },
        { priceApprovalStatus: 'pending' },
        { carrierConnectionId: randomUUID() }
      ]) {
        const response = await asA(PluginApiRoutes.orders.list).query(query)
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('answers the history of the messages without naming the member who pressed send', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const member = await owner.membership.findFirstOrThrow({
        where: { storeId: ctx.storeA.id },
        select: { userId: true }
      })
      await owner.orderMessageDispatch.create({
        data: {
          storeId: ctx.storeA.id,
          orderId: order.id,
          kind: OrderMessageKind.ORDER_SHIPPED,
          trigger: OrderMessageTriggers.MANUAL,
          route: OrderMessageRoutes.EMAIL,
          idempotencyKey: randomUUID(),
          requestedBy: member.userId
        }
      })

      const response = await asA(PluginApiRoutes.orders.messages(order.id)).expect(OK)

      const body = response.body as HistoryBody
      expect(body.data).toHaveLength(1)
      expect(body.data[0]?.route).toBe(OrderMessageRoutes.EMAIL)
      expect(body.data[0]).not.toHaveProperty('requestedBy')
      expect(JSON.stringify(response.body)).not.toContain(member.userId)
    })
  })

  describe('the store settings', () => {
    it('reads the preferences and the return rules of the store of the key', async () => {
      const preferences = await asA(PluginApiRoutes.settings.preferences).expect(OK)
      const returns = await asA(PluginApiRoutes.settings.returns).expect(OK)

      expect(typeof preferences.body).toBe('object')
      expect(typeof returns.body).toBe('object')
      // The view is an allowlist (the unit spec lists its inner keys): what a plugin reads is what somebody chose
      expect(Object.keys(preferences.body as object).sort()).toEqual(EXPECTED_PREFERENCE_KEYS)
      expect(JSON.stringify(preferences.body)).not.toContain('discountLimitPercent')
    })
  })

  describe('the scopes', () => {
    it('refuses a call with no key', async () => {
      await get(PluginApiRoutes.orders.list).expect(UNAUTHORIZED)
    })

    it('refuses each route to a key that does not hold its scope', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const denied = [
        // orders:read alone does not read the history, the templates or the settings
        get(PluginApiRoutes.orders.messages(order.id), ordersOnly.key),
        get(PluginApiRoutes.orderTemplates.list, ordersOnly.key),
        get(
          PluginApiRoutes.orderTemplates.byKindAndLocale(
            OrderMessageKind.ORDER_SHIPPED,
            Locales.ES
          ),
          ordersOnly.key
        ),
        get(PluginApiRoutes.settings.preferences, ordersOnly.key),
        get(PluginApiRoutes.settings.returns, ordersOnly.key),
        // the history is about an order: order-messages:read alone does not read it
        get(PluginApiRoutes.orders.messages(order.id), messagesOnly.key),
        // settings:read alone does not read orders
        get(PluginApiRoutes.orders.list, settingsOnly.key),
        get(PluginApiRoutes.orders.byId(order.id), settingsOnly.key)
      ]

      for (const request of denied) {
        const response = await request
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      }
    })

    it('does not expose a write of an order: it stores the person who did it, and a plugin is none', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const writes = [
        send('post', PluginApiRoutes.orders.list, keyA.key),
        send('patch', PluginApiRoutes.orders.byId(order.id), keyA.key),
        send('post', `${PluginApiRoutes.orders.byId(order.id)}/cancel`, keyA.key),
        send('post', `${PluginApiRoutes.orders.byId(order.id)}/confirm`, keyA.key),
        send('post', `${PluginApiRoutes.orders.byId(order.id)}/status`, keyA.key),
        send('post', `${PluginApiRoutes.orders.byId(order.id)}/payment`, keyA.key),
        send('post', PluginApiRoutes.orders.messages(order.id), keyA.key),
        send('put', PluginApiRoutes.settings.preferences, keyA.key),
        send(
          'put',
          PluginApiRoutes.orderTemplates.byKindAndLocale(
            OrderMessageKind.ORDER_SHIPPED,
            Locales.ES
          ),
          keyA.key
        )
      ]

      for (const request of writes) {
        expect((await request).status).toBe(NOT_FOUND)
      }
      const after = await owner.order.findUniqueOrThrow({ where: { id: order.id } })
      expect(after.status).toBe('PENDING_CONFIRMATION')
    })
  })
})
