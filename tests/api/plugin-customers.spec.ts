import { randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import { PLUGIN_ACTOR_PREFIX } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { PluginScopes } from '@platform/plugins/sdk'

import {
  createConversationOf,
  createCustomer,
  createCustomerIdentity,
  createOrder,
  createPluginKey,
  createTag
} from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const FORBIDDEN = 403
const NOT_FOUND = 404

interface ErrorBody {
  error: { code: string }
}
interface CustomerBody {
  id: string
  name: string | null
}
interface PageBody {
  data: { id: string }[]
}
interface TimelineBody {
  data: { type: string }[]
}

const ALL = [
  PluginScopes.CUSTOMERS_READ,
  PluginScopes.CUSTOMERS_WRITE,
  PluginScopes.CUSTOMERS_DELETE,
  PluginScopes.CUSTOMERS_FLAG_CAUTION,
  PluginScopes.ORDERS_READ,
  PluginScopes.CONVERSATIONS_READ
]

// TDD_10 §6, Step 5.6 PR E2: the customers of the store under the key of a plugin, over the same services as the profile. What
// matters most is the tenancy (the key names the store, whatever the call says), the scopes of each route, and that what a person
// does with a person's id (notes, merge) is not reachable.
describe('Customers through the plugin API', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let keyA: { key: string; installationId: string }
  let keyB: { key: string; installationId: string }
  let readOnly: { key: string; installationId: string }
  let writeOnly: { key: string; installationId: string }
  let readWrite: { key: string; installationId: string }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    keyA = await createPluginKey(owner, {
      storeId: ctx.storeA.id,
      pluginId: `${prefix}-all`,
      scopes: ALL
    })
    keyB = await createPluginKey(owner, {
      storeId: ctx.storeB.id,
      pluginId: `${prefix}-all`,
      scopes: ALL
    })
    readOnly = await createPluginKey(owner, {
      storeId: ctx.storeA.id,
      pluginId: `${prefix}-read`,
      scopes: [PluginScopes.CUSTOMERS_READ]
    })
    writeOnly = await createPluginKey(owner, {
      storeId: ctx.storeA.id,
      pluginId: `${prefix}-write`,
      scopes: [PluginScopes.CUSTOMERS_WRITE]
    })
    // Reads and writes a profile, and holds neither the delete nor the caution scope
    readWrite = await createPluginKey(owner, {
      storeId: ctx.storeA.id,
      pluginId: `${prefix}-rw`,
      scopes: [PluginScopes.CUSTOMERS_READ, PluginScopes.CUSTOMERS_WRITE]
    })
  })
  afterAll(async () => {
    await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: prefix } } })
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  type Method = 'get' | 'post' | 'patch' | 'put' | 'delete'
  const call = (method: Method, path: string, key?: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    const request = supertest(server)
      [method](`${API_PREFIX}${path}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
    return key === undefined ? request : request.set('authorization', `Bearer ${key}`)
  }
  const asA = (method: Method, path: string) => call(method, path, keyA.key)
  const asB = (method: Method, path: string) => call(method, path, keyB.key)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const mkA = (name?: string) =>
    createCustomer(owner, { storeId: ctx.storeA.id, ...(name === undefined ? {} : { name }) })
  const tagCount = async (id: string) =>
    (
      await owner.customer.findUniqueOrThrow({
        where: { id },
        select: { _count: { select: { tags: true } } }
      })
    )._count.tags
  const row = (id: string) => owner.customer.findUniqueOrThrow({ where: { id } })

  describe('the tenancy', () => {
    it('lists the customers of the store of the key and never those of another store', async () => {
      const mine = await mkA()
      const theirs = await createCustomer(owner, { storeId: ctx.storeB.id })

      const a = await asA('get', PluginApiRoutes.customers.list).expect(OK)
      const b = await asB('get', PluginApiRoutes.customers.list).expect(OK)

      const idsA = (a.body as PageBody).data.map(item => item.id)
      const idsB = (b.body as PageBody).data.map(item => item.id)
      expect(idsA).toContain(mine.id)
      expect(idsA).not.toContain(theirs.id)
      expect(idsB).toContain(theirs.id)
      expect(idsB).not.toContain(mine.id)
    })

    it('ignores the store a call names in the x-store-id header', async () => {
      const theirs = await createCustomer(owner, { storeId: ctx.storeB.id })

      const read = await asA('get', PluginApiRoutes.customers.byId(theirs.id)).set(
        'x-store-id',
        ctx.storeB.id
      )

      expect(read.status).toBe(NOT_FOUND)
    })

    it('creates a customer in the store of the key, whatever the call says', async () => {
      const created = await asA('post', PluginApiRoutes.customers.list)
        .set('x-store-id', ctx.storeB.id)
        .send({ name: `${prefix}-made` })
        .expect(CREATED)

      expect((await row((created.body as CustomerBody).id)).storeId).toBe(ctx.storeA.id)
    })

    it.each([
      ['reads one', 'get', (id: string) => PluginApiRoutes.customers.byId(id), undefined],
      [
        'changes one',
        'patch',
        (id: string) => PluginApiRoutes.customers.byId(id),
        { name: 'hacked' }
      ],
      ['deletes one', 'delete', (id: string) => PluginApiRoutes.customers.byId(id), undefined],
      [
        'flags one',
        'put',
        (id: string) => PluginApiRoutes.customers.caution(id),
        { reason: 'hacked' }
      ],
      [
        'clears the flag of one',
        'delete',
        (id: string) => PluginApiRoutes.customers.caution(id),
        undefined
      ],
      [
        'links a handle to one',
        'post',
        (id: string) => PluginApiRoutes.customers.identities(id),
        { channelType: 'instagram', channelIdentity: 'someone' }
      ],
      [
        'reads its timeline',
        'get',
        (id: string) => PluginApiRoutes.customers.timeline(id),
        undefined
      ],
      ['reads its orders', 'get', (id: string) => PluginApiRoutes.customers.orders(id), undefined],
      [
        'reads its conversations',
        'get',
        (id: string) => PluginApiRoutes.customers.conversations(id),
        undefined
      ],
      ['reads its notes', 'get', (id: string) => PluginApiRoutes.customers.notes(id), undefined],
      [
        'adds an address to one',
        'post',
        (id: string) => PluginApiRoutes.customers.addresses(id),
        { line1: 'x', city: 'y', country: 'SV' }
      ]
    ] as const)(
      'is a 404 for a customer of another store when it %s',
      async (_name, method, path, body) => {
        const theirs = await createCustomer(owner, { storeId: ctx.storeB.id, name: 'untouched' })

        const response = await (body === undefined
          ? asA(method, path(theirs.id))
          : asA(method, path(theirs.id)).send(body))

        expect(response.status).toBe(NOT_FOUND)
        const after = await row(theirs.id)
        expect(after.name).toBe('untouched')
        expect(after.isCaution).toBe(false)
        expect(await owner.customerIdentity.count({ where: { customerId: theirs.id } })).toBe(0)
        expect(await owner.address.count({ where: { customerId: theirs.id } })).toBe(0)
      }
    )

    it('is a 404 to attach a tag of another store, or to a customer of another store', async () => {
      const mine = await mkA()
      const theirs = await createCustomer(owner, { storeId: ctx.storeB.id })
      const tagB = await createTag(owner, { storeId: ctx.storeB.id })
      const tagA = await createTag(owner, { storeId: ctx.storeA.id })

      const foreignTag = await asA('post', PluginApiRoutes.customers.tags(mine.id)).send({
        tagId: tagB.id
      })
      const foreignCustomer = await asA('post', PluginApiRoutes.customers.tags(theirs.id)).send({
        tagId: tagA.id
      })

      expect(foreignTag.status).toBe(NOT_FOUND)
      expect(foreignCustomer.status).toBe(NOT_FOUND)
      expect(await tagCount(mine.id)).toBe(0)
      expect(await tagCount(theirs.id)).toBe(0)
    })

    it('is a 404 to remove an identity, an address or a tag that belongs to a customer of another store', async () => {
      const theirs = await createCustomer(owner, { storeId: ctx.storeB.id })
      const identity = await createCustomerIdentity(owner, {
        storeId: ctx.storeB.id,
        customerId: theirs.id
      })
      const mine = await mkA()

      // Through its own customer, and through another one of the key's store
      const own = await asA(
        'delete',
        PluginApiRoutes.customers.identityById(theirs.id, identity.id)
      )
      const crossed = await asA(
        'delete',
        PluginApiRoutes.customers.identityById(mine.id, identity.id)
      )

      expect(own.status).toBe(NOT_FOUND)
      expect(crossed.status).toBe(NOT_FOUND)
      expect(await owner.customerIdentity.count({ where: { id: identity.id } })).toBe(1)
    })
  })

  describe('the scopes', () => {
    it('lets a key that only reads, read, and not change or create anything', async () => {
      const mine = await mkA('before')

      const read = await call('get', PluginApiRoutes.customers.byId(mine.id), readOnly.key)
      const create = await call('post', PluginApiRoutes.customers.list, readOnly.key).send({
        name: 'nope'
      })
      const change = await call(
        'patch',
        PluginApiRoutes.customers.byId(mine.id),
        readOnly.key
      ).send({ name: 'after' })

      expect(read.status).toBe(OK)
      for (const response of [create, change]) {
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      }
      expect((await row(mine.id)).name).toBe('before')
    })

    it('does not let a key that only writes read the customer it answers with', async () => {
      const mine = await mkA()

      const read = await call('get', PluginApiRoutes.customers.byId(mine.id), writeOnly.key)
      const change = await call(
        'patch',
        PluginApiRoutes.customers.byId(mine.id),
        writeOnly.key
      ).send({ name: 'after' })

      expect(read.status).toBe(FORBIDDEN)
      expect(change.status).toBe(FORBIDDEN)
      expect(codeOf(change.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
    })

    it('keeps the delete and the caution behind scopes of their own that customers:write does not grant', async () => {
      const mine = await mkA()

      const remove = await call('delete', PluginApiRoutes.customers.byId(mine.id), readWrite.key)
      const flag = await call(
        'put',
        PluginApiRoutes.customers.caution(mine.id),
        readWrite.key
      ).send({ reason: 'x' })
      const clear = await call('delete', PluginApiRoutes.customers.caution(mine.id), readWrite.key)

      for (const response of [remove, flag, clear]) {
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      }
      const after = await row(mine.id)
      expect(after.isCaution).toBe(false)
    })

    it('needs orders:read for the orders and conversations:read for the conversations of a customer', async () => {
      const mine = await mkA()

      const orders = await call('get', PluginApiRoutes.customers.orders(mine.id), readOnly.key)
      const conversations = await call(
        'get',
        PluginApiRoutes.customers.conversations(mine.id),
        readOnly.key
      )

      for (const response of [orders, conversations]) {
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      }
    })

    it('has no route that writes a note, merges, undoes a merge or previews one', async () => {
      const mine = await mkA()
      const other = await mkA()
      const notes = `${PluginApiRoutes.customers.byId(mine.id)}/notes`
      const merge = `${PluginApiRoutes.customers.byId(mine.id)}/merge`
      const unmerge = `${PluginApiRoutes.customers.byId(mine.id)}/unmerge`
      const preview = `${PluginApiRoutes.customers.byId(mine.id)}/merge-preview`

      const responses = [
        await asA('post', notes).send({ content: 'hello' }),
        await asA('delete', `${notes}/${randomUUID()}`),
        await asA('post', merge).send({ absorbedId: other.id }),
        await asA('post', unmerge).send({ mergeId: randomUUID() }),
        await asA('get', preview).query({ absorbedId: other.id })
      ]

      for (const response of responses) expect(response.status).toBe(NOT_FOUND)
      expect(await owner.customerNote.count({ where: { customerId: mine.id } })).toBe(0)
      expect((await row(other.id)).mergedIntoId).toBeNull()
    })

    it('rejects a call with no key', async () => {
      const mine = await mkA()

      const response = await call('get', PluginApiRoutes.customers.byId(mine.id))

      expect(response.status).toBe(401)
    })
  })

  describe('the profile', () => {
    it('creates, reads and changes a customer', async () => {
      const created = await asA('post', PluginApiRoutes.customers.list)
        .send({ name: `${prefix}-ana`, email: `ana-${randomUUID().slice(0, 6)}@example.invalid` })
        .expect(CREATED)
      const id = (created.body as CustomerBody).id

      const changed = await asA('patch', PluginApiRoutes.customers.byId(id))
        .send({ name: `${prefix}-ana-2` })
        .expect(OK)
      const read = await asA('get', PluginApiRoutes.customers.byId(id)).expect(OK)

      expect((changed.body as CustomerBody).name).toBe(`${prefix}-ana-2`)
      expect((read.body as CustomerBody).name).toBe(`${prefix}-ana-2`)
    })

    it('links and unlinks a handle, answering 200 for one the customer already has', async () => {
      const mine = await mkA()
      const handle = `ig-${randomUUID().slice(0, 10)}`
      const body = { channelType: 'instagram', channelIdentity: handle }

      const first = await asA('post', PluginApiRoutes.customers.identities(mine.id)).send(body)
      const again = await asA('post', PluginApiRoutes.customers.identities(mine.id)).send(body)
      const identityId = (first.body as { id: string }).id
      const removed = await asA(
        'delete',
        PluginApiRoutes.customers.identityById(mine.id, identityId)
      )

      expect(first.status).toBe(CREATED)
      expect(again.status).toBe(OK)
      expect(removed.status).toBe(NO_CONTENT)
      expect(await owner.customerIdentity.count({ where: { customerId: mine.id } })).toBe(0)
    })

    it('adds, changes and removes an address, and tags and untags a customer', async () => {
      const mine = await mkA()
      const tag = await createTag(owner, { storeId: ctx.storeA.id })

      const address = await asA('post', PluginApiRoutes.customers.addresses(mine.id))
        .send({ line1: 'Calle 1', city: 'San Salvador', country: 'sv' })
        .expect(CREATED)
      const addressId = (address.body as { id: string }).id
      await asA('patch', PluginApiRoutes.customers.addressById(mine.id, addressId))
        .send({ city: 'Santa Ana' })
        .expect(OK)
      await asA('delete', PluginApiRoutes.customers.addressById(mine.id, addressId)).expect(
        NO_CONTENT
      )
      await asA('post', PluginApiRoutes.customers.tags(mine.id)).send({ tagId: tag.id }).expect(OK)
      expect(await tagCount(mine.id)).toBe(1)
      await asA('delete', PluginApiRoutes.customers.tagById(mine.id, tag.id)).expect(NO_CONTENT)

      expect(await owner.address.count({ where: { customerId: mine.id } })).toBe(0)
      expect(await tagCount(mine.id)).toBe(0)
    })

    it('reads the notes a person wrote', async () => {
      const mine = await mkA()
      await owner.customerNote.create({
        data: { customerId: mine.id, authorId: ctx.agentA.id, content: 'called back' }
      })

      const notes = await asA('get', PluginApiRoutes.customers.notes(mine.id)).expect(OK)

      expect((notes.body as { content: string }[]).map(note => note.content)).toEqual([
        'called back'
      ])
    })

    it('lists the orders and the conversations of a customer, and only its own', async () => {
      const order = await createOrder(owner, { storeId: ctx.storeA.id })
      const customerId = (
        await owner.order.findUniqueOrThrow({
          where: {
            id: (await owner.orderItem.findUniqueOrThrow({ where: { id: order.itemId } })).orderId
          },
          select: { customerId: true }
        })
      ).customerId
      const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const other = await mkA()

      const orders = await asA('get', PluginApiRoutes.customers.orders(customerId)).expect(OK)
      const none = await asA('get', PluginApiRoutes.customers.orders(other.id)).expect(OK)
      const ofConversation = await asA(
        'get',
        PluginApiRoutes.customers.conversations(
          (await owner.conversation.findUniqueOrThrow({ where: { id: conversation.id } }))
            .customerId
        )
      ).expect(OK)

      expect((orders.body as PageBody).data).toHaveLength(1)
      expect((none.body as PageBody).data).toHaveLength(0)
      expect((ofConversation.body as PageBody).data.map(item => item.id)).toEqual([conversation.id])
    })

    it('shows the conversations and orders in the timeline only to a key that holds their scopes', async () => {
      const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const customerId = (
        await owner.conversation.findUniqueOrThrow({ where: { id: conversation.id } })
      ).customerId

      const full = await asA('get', PluginApiRoutes.customers.timeline(customerId)).expect(OK)
      const reading = await call(
        'get',
        PluginApiRoutes.customers.timeline(customerId),
        readOnly.key
      ).expect(OK)

      // `customers:read` stands for CUSTOMERS_VIEW alone: the same page of a person without CONVERSATIONS_VIEW
      expect((reading.body as TimelineBody).data.map(entry => entry.type)).not.toContain(
        'conversation'
      )
      expect((full.body as TimelineBody).data.length).toBeGreaterThanOrEqual(
        (reading.body as TimelineBody).data.length
      )
    })
  })

  describe('the caution flag and the delete', () => {
    it('flags and clears a customer, keeping the plugin as the setter and as the system in the audit log', async () => {
      const mine = await mkA()

      const flagged = await asA('put', PluginApiRoutes.customers.caution(mine.id))
        .send({ reason: 'chargeback' })
        .expect(OK)

      expect(flagged.body).toEqual({ isCaution: true, cautionReason: 'chargeback' })
      expect((await row(mine.id)).cautionSetBy).toBe(`${PLUGIN_ACTOR_PREFIX}${keyA.installationId}`)
      const [set] = await waitForAuditEntries(owner, {
        action: AuditAction.CUSTOMER_CAUTION_SET,
        resourceId: mine.id
      })
      expect(set?.userId).toBeNull()
      expect(set?.metadata).toMatchObject({ pluginInstallationId: keyA.installationId })
      // The reason is free text about a person: it is in the row and in no audit entry
      expect(JSON.stringify(set?.metadata)).not.toContain('chargeback')

      const cleared = await asA('delete', PluginApiRoutes.customers.caution(mine.id)).expect(OK)

      expect(cleared.body).toEqual({ isCaution: false, cautionReason: null })
      const after = await row(mine.id)
      expect(after.isCaution).toBe(false)
      expect(after.cautionSetBy).toBeNull()
      const [clear] = await waitForAuditEntries(owner, {
        action: AuditAction.CUSTOMER_CAUTION_CLEARED,
        resourceId: mine.id
      })
      expect(clear?.userId).toBeNull()
      expect(clear?.metadata).toMatchObject({ pluginInstallationId: keyA.installationId })
    })

    it('deletes a customer with no history, as the system in the audit log, and refuses one with a conversation', async () => {
      const free = await mkA()
      const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id })
      const busy = (await owner.conversation.findUniqueOrThrow({ where: { id: conversation.id } }))
        .customerId

      await asA('delete', PluginApiRoutes.customers.byId(free.id)).expect(NO_CONTENT)
      const refused = await asA('delete', PluginApiRoutes.customers.byId(busy))

      expect(await owner.customer.count({ where: { id: free.id } })).toBe(0)
      expect(refused.status).toBe(409)
      expect(await owner.customer.count({ where: { id: busy } })).toBe(1)
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.CUSTOMER_DELETED,
        resourceId: free.id
      })
      expect(entry?.userId).toBeNull()
      expect(entry?.metadata).toMatchObject({ pluginInstallationId: keyA.installationId })
    })
  })
})
