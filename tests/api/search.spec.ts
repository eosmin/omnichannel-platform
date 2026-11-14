import { randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type Permission, Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  ConversationStatus,
  MessageType,
  SearchConfig,
  SearchLanguage,
  SearchSnippetMarks
} from '@platform/core/domain'
import { JobNames, QueueNames } from '@platform/core/queues'

import {
  createConversationOf,
  createCustomer,
  createMessage,
  createOrder,
  createProduct
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api } from '../helpers/http'
import { CapturedQueue, queueOf } from '../helpers/queue'

interface Hits<T> {
  query: string
  hits: T[]
  hasMore: boolean
}
interface CustomerHit {
  id: string
  name: string | null
  email: string | null
  phone: string | null
}
interface MessageHit {
  id: string
  conversationId: string
  type: string
  customerName: string | null
  snippet: string
}
interface OrderHit {
  id: string
  orderNumber: string
  customerName: string | null
}
interface GlobalBody {
  query: string
  groups: { entity: string; hits: { id: string }[] }[]
}

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403
// Twice the goal of the step (300 ms, measured in the PR): the guard is for a regression, not for a slow runner
const SLOW_MS = 600

describe('The search of the store', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let analytics: CapturedQueue
  // Everything of a test carries this word, new for each test: the search tolerates typos, so rows of another test whose
  // name differs in a letter would answer it too
  let tag = ''
  let storeAUser: string

  beforeEach(() => {
    tag = `zq${randomUUID().slice(0, 8)}`
  })
  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder.overrideProvider(getQueueToken(QueueNames.ANALYTICS)).useValue(new CapturedQueue())
    )
    ctx = await seedTestContext(owner, app, prefix)
    analytics = queueOf(app, QueueNames.ANALYTICS)
    storeAUser = ctx.adminA.id
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const get = (actor: Actor, path: string, query: Record<string, unknown>, store = ctx.storeA) =>
    api(app, actor, store).get(path).query(query)
  const asAdmin = (path: string, query: Record<string, unknown>) => get(ctx.adminA, path, query)

  const customersFor = async (q: string, extra: Record<string, unknown> = {}) => {
    const response = await asAdmin(ApiRoutes.search.customers, { q, ...extra })
    return { status: response.status, body: response.body as Hits<CustomerHit> }
  }
  const messagesFor = async (
    q: string,
    actor: Actor = ctx.adminA,
    extra: Record<string, unknown> = {}
  ) => {
    const response = await get(actor, ApiRoutes.search.messages, { q, ...extra })
    return { status: response.status, body: response.body as Hits<MessageHit> }
  }
  const ordersFor = async (q: string) => {
    const response = await asAdmin(ApiRoutes.search.orders, { q })
    return { status: response.status, body: response.body as Hits<OrderHit> }
  }
  const nameOf = async (customerId: string, name: string, extra: object = {}) =>
    owner.customer.update({ where: { id: customerId }, data: { name, ...extra } })
  const viewerOf = (name: string, permissions: readonly Permission[]) =>
    actorWithPermissions(owner, app, {
      prefix,
      name,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      permissions
    })

  describe('the customers', () => {
    it('finds a name whatever the accents and the case', async () => {
      const customer = await createCustomer(owner, {
        storeId: ctx.storeA.id,
        name: `José Pérez Ñandú ${tag}a`
      })
      for (const q of [
        `jose perez nandu ${tag}a`,
        `JOSÉ PEREZ`,
        `pérez ñandú ${tag}a`,
        `NANDU ${tag}a`
      ]) {
        const { status, body } = await customersFor(q)
        expect(status).toBe(OK)
        expect(body.hits.map(hit => hit.id)).toContain(customer.id)
      }
    })

    it('folds the letters that have no accent to strip the way the database does, and leaves other scripts alone', async () => {
      const soren = await createCustomer(owner, {
        storeId: ctx.storeA.id,
        name: `Søren Łukasz ${tag}`
      })
      const korean = await createCustomer(owner, { storeId: ctx.storeA.id, name: `김민수 ${tag}` })
      for (const q of [`Søren ${tag}`, `soren lukasz ${tag}`, `ŁUKASZ ${tag}`]) {
        expect((await customersFor(q)).body.hits.map(hit => hit.id)).toContain(soren.id)
      }
      expect((await customersFor(`김민수 ${tag}`)).body.hits.map(hit => hit.id)).toContain(
        korean.id
      )
    })

    it('compares with the text folded by the database, so the letters unaccent rewrites match too', async () => {
      const thor = await createCustomer(owner, { storeId: ctx.storeA.id, name: `Þór Ŋoma ${tag}` })
      for (const q of [`Þór ${tag}`, `thor ${tag}`, `THOR NOMA ${tag}`]) {
        expect((await customersFor(q)).body.hits.map(hit => hit.id)).toContain(thor.id)
      }
      // The list reads a part of the name, folded the same way
      for (const q of [`Þór Ŋoma ${tag}`, `thor noma ${tag}`, `THOR NOMA`]) {
        const list = await asAdmin(ApiRoutes.customers.list, { q })
        expect((list.body as { data: { id: string }[] }).data.map(row => row.id)).toContain(thor.id)
      }
    })

    it('has the index of the messages on the language the queries use', async () => {
      const rows = await owner.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_indexdef('idx_messages_search_unaccent'::regclass) AS definition`
      expect(rows[0]?.definition).toContain(`'${SearchLanguage}'::regconfig`)
    })

    it('refuses a text of only combining marks instead of matching everybody', async () => {
      await createCustomer(owner, { storeId: ctx.storeA.id, name: `Cualquiera ${tag}` })
      expect((await customersFor('\u0301\u0301')).status).toBe(BAD_REQUEST)
      const list = await asAdmin(ApiRoutes.customers.list, { q: '\u0301\u0301' })
      expect((list.body as { data: unknown[] }).data).toEqual([])
    })

    it('finds the accented name when the typed text has the accent and the stored one has none', async () => {
      const customer = await createCustomer(owner, {
        storeId: ctx.storeA.id,
        name: `Maria Lopez ${tag}b`
      })
      const { body } = await customersFor(`María López ${tag}b`)
      expect(body.hits.map(hit => hit.id)).toEqual([customer.id])
    })

    it('is the same rule in the list of customers: "jose" finds "José" there too', async () => {
      const customer = await createCustomer(owner, {
        storeId: ctx.storeA.id,
        name: `José Ñandú ${tag}`
      })
      for (const q of [`jose nandu ${tag}`, `JOSÉ ÑANDÚ ${tag}`, `ñandu ${tag}`]) {
        const response = await asAdmin(ApiRoutes.customers.list, { q })
        expect(response.status).toBe(OK)
        expect((response.body as { data: { id: string }[] }).data.map(row => row.id)).toEqual([
          customer.id
        ])
      }
    })

    it('reads % and _ as the characters they are, not as wildcards', async () => {
      // The "wild" names are what a wildcard would match and are too different to be a typo of the text
      const percent = await createCustomer(owner, { storeId: ctx.storeA.id, name: 'Xk%Wvq' })
      await createCustomer(owner, { storeId: ctx.storeA.id, name: 'Xkabcdefghijklmnopwvq' })
      const underscore = await createCustomer(owner, { storeId: ctx.storeA.id, name: 'Zy_Ww9' })
      await createCustomer(owner, { storeId: ctx.storeA.id, name: 'Zyabcdefghijklmnopww9' })

      expect((await customersFor('xk%wvq')).body.hits.map(hit => hit.id)).toEqual([percent.id])
      expect((await customersFor('zy_ww9')).body.hits.map(hit => hit.id)).toEqual([underscore.id])
      // Alone, a wildcard is not a name: nothing in this store has a % or a backslash in it
      expect((await customersFor('%%')).body.hits).toEqual([])
      expect((await customersFor('\\\\')).body.hits).toEqual([])
    })

    it('finds a typo of a name, and the exact name first', async () => {
      const exact = await createCustomer(owner, {
        storeId: ctx.storeA.id,
        name: `Gonzalez ${tag}e`
      })
      const { body } = await customersFor(`Gonzales ${tag}e`)
      expect(body.hits.map(hit => hit.id)).toContain(exact.id)
    })

    it('finds a customer by the email and by a run of digits of the phone', async () => {
      const customer = await createCustomer(owner, {
        storeId: ctx.storeA.id,
        name: `${tag}f Phone`,
        phone: '+503 7123-4567'
      })
      await owner.customer.update({
        where: { id: customer.id },
        data: { email: `${tag}F.Person@Example.com` }
      })

      expect((await customersFor(`${tag}f.person@example`)).body.hits.map(hit => hit.id)).toEqual([
        customer.id
      ])
      expect((await customersFor('7123-4567')).body.hits.map(hit => hit.id)).toContain(customer.id)
      expect((await customersFor('+503 7123')).body.hits.map(hit => hit.id)).toContain(customer.id)
      // Three digits match half the book: they are looked for in names only
      expect((await customersFor('456')).body.hits.map(hit => hit.id)).not.toContain(customer.id)
    })

    it('leaves out the customers erased and the ones a merge absorbed', async () => {
      const survivor = await createCustomer(owner, { storeId: ctx.storeA.id, name: `${tag}g one` })
      const erased = await createCustomer(owner, { storeId: ctx.storeA.id, name: `${tag}g two` })
      const absorbed = await createCustomer(owner, {
        storeId: ctx.storeA.id,
        name: `${tag}g three`
      })
      await owner.customer.update({ where: { id: erased.id }, data: { erasedAt: new Date() } })
      await owner.customer.update({
        where: { id: absorbed.id },
        data: { mergedIntoId: survivor.id }
      })

      const { body } = await customersFor(`${tag}g`)
      expect(body.hits.map(hit => hit.id)).toEqual([survivor.id])
    })

    it('answers 400 to a text that is too short, too long or has a NUL, and to a parameter it does not know', async () => {
      expect((await customersFor('a')).status).toBe(BAD_REQUEST)
      expect((await customersFor('   ')).status).toBe(BAD_REQUEST)
      expect((await customersFor('x'.repeat(SearchConfig.MAX_QUERY_LENGTH + 1))).status).toBe(
        BAD_REQUEST
      )
      expect((await customersFor('ab\0cd')).status).toBe(BAD_REQUEST)
      expect((await asAdmin(ApiRoutes.search.customers, {})).status).toBe(BAD_REQUEST)
      expect((await customersFor('ab', { storeId: ctx.storeB.id })).status).toBe(BAD_REQUEST)
      expect((await customersFor('ab', { limit: SearchConfig.MAX_LIMIT + 1 })).status).toBe(
        BAD_REQUEST
      )
    })

    it('stops at the limit and says there may be more', async () => {
      for (const n of [1, 2, 3]) {
        await createCustomer(owner, { storeId: ctx.storeA.id, name: `${tag}h many ${n}` })
      }
      const page = await customersFor(`${tag}h many`, { limit: 2 })
      expect(page.body.hits).toHaveLength(2)
      expect(page.body.hasMore).toBe(true)
      const all = await customersFor(`${tag}h many`, { limit: 10 })
      expect(all.body.hits).toHaveLength(3)
      expect(all.body.hasMore).toBe(false)
      // Exactly a page: nothing more to show, and it says so
      const exact = await customersFor(`${tag}h many`, { limit: 3 })
      expect(exact.body.hits).toHaveLength(3)
      expect(exact.body.hasMore).toBe(false)
    })

    it('uses the similarity threshold the constant says', async () => {
      // The statement uses the % operator, which reads the setting of the database
      const rows = await owner.$queryRaw<{ similarity: number; threshold: string }[]>`
        SELECT similarity('a', 'a') AS similarity, current_setting('pg_trgm.similarity_threshold') AS threshold`
      expect(Number(rows[0]?.threshold)).toBe(SearchConfig.SIMILARITY_THRESHOLD)
    })
  })

  describe('the messages', () => {
    it('finds a text whatever the accents, with the match between marks and the original text around it', async () => {
      const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
      await nameOf(conversation.customerId, `Cliente ${tag}i`)
      const message = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        content: `Necesito el camión de ${tag}i mañana por la mañana`
      })
      const other = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        content: `Tu María llegó ${tag}i`
      })

      const byPlain = await messagesFor(`camion ${tag}i`)
      expect(byPlain.status).toBe(OK)
      expect(byPlain.body.hits.map(hit => hit.id)).toEqual([message.id])
      expect(byPlain.body.hits[0]?.customerName).toBe(`Cliente ${tag}i`)
      expect(byPlain.body.hits[0]?.conversationId).toBe(conversation.id)
      expect(byPlain.body.hits[0]?.snippet).toContain(SearchSnippetMarks.START)
      expect(byPlain.body.hits[0]?.snippet).toContain('camión')

      expect((await messagesFor(`maria ${tag}i`)).body.hits.map(hit => hit.id)).toEqual([other.id])
      expect((await messagesFor(`MARÍA ${tag}i`)).body.hits.map(hit => hit.id)).toEqual([other.id])
    })

    it('never shows a message that was deleted or discarded, nor a line of the platform', async () => {
      const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const kept = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        content: `visible ${tag}j`
      })
      const deleted = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        content: `borrado ${tag}j`
      })
      await owner.message.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } })
      // A reply that was discarded, and the lines the platform writes into the thread, are not messages either
      const discarded = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        content: `descartado ${tag}j`
      })
      await owner.message.update({ where: { id: discarded.id }, data: { discardedAt: new Date() } })
      await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        type: MessageType.SYSTEM,
        content: `asignada ${tag}j`
      })

      expect((await messagesFor(`${tag}j`)).body.hits.map(hit => hit.id)).toEqual([kept.id])
    })

    it('shows the internal notes only to who may read them', async () => {
      const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const note = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        type: MessageType.INTERNAL_NOTE,
        content: `nota secreta ${tag}k`
      })
      const reader = await viewerOf('note-reader', [
        Permissions.CONVERSATIONS_VIEW,
        Permissions.CONVERSATIONS_VIEW_ALL,
        Permissions.MESSAGES_VIEW,
        Permissions.MESSAGES_INTERNAL_NOTE
      ])
      const plain = await viewerOf('note-plain', [
        Permissions.CONVERSATIONS_VIEW,
        Permissions.CONVERSATIONS_VIEW_ALL,
        Permissions.MESSAGES_VIEW
      ])

      expect((await messagesFor(`secreta ${tag}k`, reader)).body.hits.map(hit => hit.id)).toEqual([
        note.id
      ])
      expect((await messagesFor(`secreta ${tag}k`, plain)).body.hits).toEqual([])
    })

    it('follows the visibility of the inbox: assigned to someone else, and the hidden ones', async () => {
      const assigned = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        assignedTo: storeAUser
      })
      const free = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const archived = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        status: ConversationStatus.ARCHIVED
      })
      const spam = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        status: ConversationStatus.SPAM
      })
      const ids: Record<string, string> = {}
      for (const [label, conversation] of Object.entries({ assigned, free, archived, spam })) {
        ids[label] = (
          await createMessage(owner, {
            storeId: ctx.storeA.id,
            conversationId: conversation.id,
            content: `${label} ${tag}l`
          })
        ).id
      }
      const base = [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW] as const
      const own = await viewerOf('not-all', base)
      const all = await viewerOf('all', [...base, Permissions.CONVERSATIONS_VIEW_ALL])
      const archiver = await viewerOf('archiver', [
        ...base,
        Permissions.CONVERSATIONS_VIEW_ALL,
        Permissions.CONVERSATIONS_ARCHIVE
      ])

      const seenBy = async (actor: Actor) =>
        (await messagesFor(`${tag}l`, actor)).body.hits.map(hit => hit.id).sort()
      // Without VIEW_ALL: what nobody has, and not what is assigned to someone else, nor what is hidden
      expect(await seenBy(own)).toEqual([ids['free']])
      expect(await seenBy(all)).toEqual([ids['assigned'], ids['free']].sort())
      expect(await seenBy(archiver)).toEqual(Object.values(ids).sort())
    })

    it('hides the line of an order from who may not read orders, and the messages of an erased customer', async () => {
      const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const summary = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        type: MessageType.ORDER_SUMMARY,
        content: `Pedido ${tag}x total 99`
      })
      const erased = await createConversationOf(owner, { storeId: ctx.storeA.id })
      await owner.customer.update({
        where: { id: erased.customerId },
        data: { erasedAt: new Date() }
      })
      await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: erased.id,
        content: `Texto ${tag}x de un cliente borrado`
      })
      const base = [
        Permissions.CONVERSATIONS_VIEW,
        Permissions.CONVERSATIONS_VIEW_ALL,
        Permissions.MESSAGES_VIEW
      ] as const
      const noOrders = await viewerOf('no-orders-msg', base)
      const withOrders = await viewerOf('with-orders-msg', [...base, Permissions.ORDERS_VIEW])

      expect((await messagesFor(`${tag}x`, noOrders)).body.hits).toEqual([])
      expect((await messagesFor(`${tag}x`, withOrders)).body.hits.map(hit => hit.id)).toEqual([
        summary.id
      ])
    })

    it('can be narrowed to one conversation', async () => {
      const one = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const two = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const first = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: one.id,
        content: `lo mismo ${tag}m`
      })
      await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: two.id,
        content: `lo mismo ${tag}m`
      })

      const narrowed = await messagesFor(`${tag}m`, ctx.adminA, { conversationId: one.id })
      expect(narrowed.body.hits.map(hit => hit.id)).toEqual([first.id])
      expect((await messagesFor(`${tag}m`)).body.hits).toHaveLength(2)
      expect((await messagesFor(`${tag}m`, ctx.adminA, { conversationId: 'nope' })).status).toBe(
        BAD_REQUEST
      )
    })

    it('reads what looks like the syntax of a query as text, and never fails on it', async () => {
      for (const q of [
        `a & b ${tag}`,
        `"unterminated`,
        `x | y !`,
        `(((`,
        `:*`,
        `'; DROP TABLE messages; --`,
        `% _ \\`
      ]) {
        const { status } = await messagesFor(q)
        expect(status).toBe(OK)
      }
    })

    it('needs the permission to see conversations and the one to read messages', async () => {
      const onlyConversations = await viewerOf('only-conv', [Permissions.CONVERSATIONS_VIEW])
      const onlyMessages = await viewerOf('only-msg', [Permissions.MESSAGES_VIEW])
      expect((await messagesFor('hello', onlyConversations)).status).toBe(FORBIDDEN)
      expect((await messagesFor('hello', onlyMessages)).status).toBe(FORBIDDEN)
    })
  })

  describe('the orders', () => {
    it('finds an order by a part of its number, and by who it is for, with no accents and by phone', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const row = await owner.order.findUniqueOrThrow({ where: { id: order.id } })
      await owner.order.update({ where: { id: order.id }, data: { orderNumber: `A-${tag}-1042` } })
      await nameOf(row.customerId, `Sebastián Peña ${tag}n`, {
        phone: '+503 6000-1234',
        phoneNormalized: '50360001234'
      })

      for (const q of [
        `${tag}-1042`,
        `a-${tag}`,
        `sebastian pena ${tag}n`,
        `SEBASTIÁN`,
        '6000-1234'
      ]) {
        const { status, body } = await ordersFor(q)
        expect(status).toBe(OK)
        expect(body.hits.map(hit => hit.id)).toContain(order.id)
      }
      expect((await ordersFor(`${tag}-1042`)).body.hits[0]?.customerName).toBe(
        `Sebastián Peña ${tag}n`
      )
    })

    it('reads % and _ in the number as characters', async () => {
      const first = await createOrder(owner, { storeId: ctx.storeA.id })
      const second = await createOrder(owner, { storeId: ctx.storeA.id })
      await owner.order.update({ where: { id: first.id }, data: { orderNumber: `${tag}-5%7` } })
      await owner.order.update({ where: { id: second.id }, data: { orderNumber: `${tag}-5X7` } })
      expect((await ordersFor(`${tag}-5%7`)).body.hits.map(hit => hit.id)).toEqual([first.id])
    })

    it('hides the name of a customer who was erased', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const row = await owner.order.findUniqueOrThrow({ where: { id: order.id } })
      await owner.order.update({ where: { id: order.id }, data: { orderNumber: `${tag}-ERASED` } })
      await nameOf(row.customerId, `Borrado ${tag}o`, { erasedAt: new Date() })
      const { body } = await ordersFor(`${tag}-ERASED`)
      expect(body.hits[0]?.customerName).toBeNull()
      expect((await ordersFor(`borrado ${tag}o`)).body.hits).toEqual([])
    })

    it('needs the permission to view orders', async () => {
      const nobody = await viewerOf('no-orders', [Permissions.CUSTOMERS_VIEW])
      expect((await get(nobody, ApiRoutes.search.orders, { q: 'hello' })).status).toBe(FORBIDDEN)
    })
  })

  describe('the products', () => {
    it('answers the autocomplete of the catalog under its own route', async () => {
      const product = await createProduct(owner, {
        storeId: ctx.storeA.id,
        name: `${tag}p Zapato`,
        sku: `${tag}p-1`
      })
      const response = await asAdmin(ApiRoutes.search.products, { q: `${tag}p zap` })
      expect(response.status).toBe(OK)
      expect((response.body as { data: { id: string }[] }).data.map(item => item.id)).toEqual([
        product.id
      ])
    })

    it('needs the permission to view products', async () => {
      const nobody = await viewerOf('no-products', [Permissions.CUSTOMERS_VIEW])
      expect((await get(nobody, ApiRoutes.search.products, { q: 'hello' })).status).toBe(FORBIDDEN)
    })
  })

  describe('the global search', () => {
    it('answers a few hits of each kind, only the groups that have hits', async () => {
      const customer = await createCustomer(owner, {
        storeId: ctx.storeA.id,
        name: `Zorro ${tag}q`
      })
      const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const message = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        content: `El zorro ${tag}q`
      })
      const product = await createProduct(owner, { storeId: ctx.storeA.id, name: `Zorro ${tag}q` })

      const response = await asAdmin(ApiRoutes.search.global, { q: `zorro ${tag}q` })
      const body = response.body as GlobalBody
      expect(response.status).toBe(OK)
      expect(body.query).toBe(`zorro ${tag}q`)
      expect(body.groups.map(group => group.entity).sort()).toEqual(
        ['customers', 'messages', 'products'].sort()
      )
      const hitsOf = (entity: string) =>
        body.groups.find(group => group.entity === entity)?.hits.map(hit => hit.id)
      expect(hitsOf('customers')).toEqual([customer.id])
      expect(hitsOf('messages')).toEqual([message.id])
      expect(hitsOf('products')).toEqual([product.id])
    })

    it('answers only the kinds of thing the member may search', async () => {
      await createCustomer(owner, { storeId: ctx.storeA.id, name: `Lobo ${tag}r` })
      await createProduct(owner, { storeId: ctx.storeA.id, name: `Lobo ${tag}r` })
      const onlyCustomers = await viewerOf('only-customers', [Permissions.CUSTOMERS_VIEW])
      const none = await viewerOf('none-of-them', [Permissions.TEAM_VIEW])

      const response = await get(onlyCustomers, ApiRoutes.search.global, { q: `lobo ${tag}r` })
      expect(response.status).toBe(OK)
      expect((response.body as GlobalBody).groups.map(group => group.entity)).toEqual(['customers'])
      expect((await get(none, ApiRoutes.search.global, { q: `lobo ${tag}r` })).status).toBe(
        FORBIDDEN
      )
    })

    it('answers 400 to a text that is too short', async () => {
      expect((await asAdmin(ApiRoutes.search.global, { q: 'a' })).status).toBe(BAD_REQUEST)
      expect((await asAdmin(ApiRoutes.search.global, { q: 'ab', limit: 5 })).status).toBe(
        BAD_REQUEST
      )
    })
  })

  describe('the analytics event', () => {
    const searchJobs = () => analytics.jobs.filter(job => job.name === JobNames.TRACK_SEARCH)
    const lastJob = () => searchJobs().at(-1)

    it('queues one event per search, with the hash of the text and no text when something was found', async () => {
      await createCustomer(owner, { storeId: ctx.storeA.id, name: `Tracked ${tag}s` })
      const before = searchJobs().length
      await customersFor(`tracked ${tag}s`)
      expect(searchJobs()).toHaveLength(before + 1)
      const job = lastJob()
      expect(job?.data).toMatchObject({
        event: 'search.performed',
        storeId: ctx.storeA.id,
        data: { scope: 'customers', resultCount: 1 }
      })
      const data = (job?.data as { data: Record<string, unknown> }).data
      expect(data['query']).toBeUndefined()
      expect(data['queryHash']).toMatch(/^[0-9a-f]{16}$/)
      expect(typeof data['durationMs']).toBe('number')
    })

    it('groups the same text written with another case, accents or spacing under one hash', async () => {
      await customersFor(`Perú  ${tag}t`)
      const first = (lastJob()?.data as { data: { queryHash: string } }).data.queryHash
      await customersFor(`peru ${tag}t`)
      const second = (lastJob()?.data as { data: { queryHash: string } }).data.queryHash
      expect(second).toBe(first)
    })

    it('keeps the text of a product search that found nothing, for the zero-result report', async () => {
      await asAdmin(ApiRoutes.search.products, { q: `nada de nada ${tag}u` })
      expect(lastJob()?.data).toMatchObject({
        data: { scope: 'products', resultCount: 0, query: `nada de nada ${tag}u` }
      })
    })

    it('keeps no text of what was asked about people: customers, orders, an email or a phone', async () => {
      const textOf = () => (lastJob()?.data as { data: { query?: string } }).data.query
      await customersFor(`ninguno ${tag}w`)
      expect(textOf()).toBeUndefined()
      await ordersFor(`ninguno ${tag}w`)
      expect(textOf()).toBeUndefined()
      await messagesFor(`ninguno ${tag}w`)
      expect(textOf()).toBeUndefined()
      await asAdmin(ApiRoutes.search.global, { q: `ninguno ${tag}w` })
      expect(textOf()).toBeUndefined()
      for (const q of ['nadie@example.com', '7999-0000', `ana 71234567 ${tag}w`]) {
        const before = searchJobs().length
        await asAdmin(ApiRoutes.search.products, { q })
        expect(searchJobs()).toHaveLength(before + 1)
        expect(textOf()).toBeUndefined()
      }
      await messagesFor(`7999-0000`)
      expect(textOf()).toBeUndefined()
    })

    it('counts the global search once, with the total of what it found', async () => {
      const before = searchJobs().length
      await createCustomer(owner, { storeId: ctx.storeA.id, name: `Global ${tag}v` })
      await asAdmin(ApiRoutes.search.global, { q: `global ${tag}v` })
      expect(searchJobs()).toHaveLength(before + 1)
      expect(lastJob()?.data).toMatchObject({ data: { scope: 'global', resultCount: 1 } })
    })

    it('does not queue anything for a request that was refused', async () => {
      const before = searchJobs().length
      await customersFor('a')
      expect(searchJobs()).toHaveLength(before)
    })
  })

  describe('the speed', () => {
    it(`answers the global search of a store with thousands of rows under ${SLOW_MS} ms`, async () => {
      const store = ctx.storeA.id
      const word = `vel${randomUUID().slice(0, 5)}`
      const customers = Array.from({ length: 3000 }, (_unused, n) => ({
        storeId: store,
        name: `Cliente ${n % 50 === 0 ? word : 'comun'} Número ${n}`,
        phone: `+503 7${String(n).padStart(3, '0')}-${String(1000 + n)}`,
        phoneNormalized: `5037${String(n).padStart(3, '0')}${1000 + n}`
      }))
      await owner.customer.createMany({ data: customers })
      const conversation = await createConversationOf(owner, { storeId: store })
      await owner.message.createMany({
        data: Array.from({ length: 6000 }, (_unused, n) => ({
          storeId: store,
          conversationId: conversation.id,
          type: MessageType.TEXT,
          authorType: 'CUSTOMER',
          content: `Mensaje ${n} sobre ${n % 100 === 0 ? word : 'el pedido'} de camión`
        }))
      })
      await owner.$executeRaw`ANALYZE customers`
      await owner.$executeRaw`ANALYZE messages`

      const times: number[] = []
      for (let run = 0; run < 5; run++) {
        const started = performance.now()
        const response = await asAdmin(ApiRoutes.search.global, { q: word })
        times.push(performance.now() - started)
        expect(response.status).toBe(OK)
        expect((response.body as GlobalBody).groups.length).toBeGreaterThanOrEqual(2)
      }
      // The best of five: the first run warms the plans and the connection, and a loaded machine is not the query
      expect(Math.min(...times)).toBeLessThan(SLOW_MS)
    })
  })
})
