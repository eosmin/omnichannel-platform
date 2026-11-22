import { randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, ApiRoutes, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  BulkActions,
  ChannelConnectionStatus,
  ChannelIds,
  ConversationStatus,
  PLUGIN_ACTOR_PREFIX,
  SystemMessageEvents
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { PluginScopes } from '@platform/plugins/sdk'

import {
  createChannelConnection,
  createConversationOf,
  createCustomer,
  createCustomerIdentity,
  createMessage,
  createPluginKey,
  createTag
} from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

// The channel the builders use for a handle and an account when none is named
const CHANNEL = ChannelIds.INSTAGRAM
const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface DetailBody {
  id: string
  status: string
  assignedTo?: string | null
  unreadCount: number
}
interface PageBody {
  data: { id: string }[]
}

const ALL = [
  PluginScopes.CONVERSATIONS_READ,
  PluginScopes.CONVERSATIONS_WRITE,
  PluginScopes.MESSAGES_READ,
  PluginScopes.CUSTOMERS_READ,
  PluginScopes.CHANNELS_READ
]

// TDD_10 §6, Step 5.6 PR E1: the conversations, the search and the channel directory under the key of a plugin, over the same
// services as the inbox. What matters most is the tenancy (the key names the store, whatever the call says) and the scopes.
describe('Conversations, search and channels through the plugin API', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let keyA: { key: string; installationId: string }
  let keyB: { key: string; installationId: string }
  let readOnly: { key: string; installationId: string }

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
    // Another plugin, in store A, that was granted the reading only
    readOnly = await createPluginKey(owner, {
      storeId: ctx.storeA.id,
      pluginId: `${prefix}-read`,
      scopes: [PluginScopes.CONVERSATIONS_READ]
    })
  })
  afterAll(async () => {
    // The plugins belong to the organization, which cannot go while they exist
    await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: prefix } } })
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  type Method = 'get' | 'post' | 'patch' | 'delete'
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
  const mkA = (extra: Partial<Parameters<typeof createConversationOf>[1]> = {}) =>
    createConversationOf(owner, { storeId: ctx.storeA.id, ...extra })
  const row = (id: string) => owner.conversation.findUniqueOrThrow({ where: { id } })

  describe('the tenancy', () => {
    it('lists the conversations of the store of the key and never those of another store', async () => {
      const mine = await mkA()
      const theirs = await createConversationOf(owner, { storeId: ctx.storeB.id })

      const a = await asA('get', PluginApiRoutes.conversations.list).expect(OK)
      const b = await asB('get', PluginApiRoutes.conversations.list).expect(OK)

      const idsA = (a.body as PageBody).data.map(item => item.id)
      const idsB = (b.body as PageBody).data.map(item => item.id)
      expect(idsA).toContain(mine.id)
      expect(idsA).not.toContain(theirs.id)
      expect(idsB).toContain(theirs.id)
      expect(idsB).not.toContain(mine.id)
    })

    it('ignores the store a call names in the x-store-id header', async () => {
      const mine = await mkA()
      const theirs = await createConversationOf(owner, { storeId: ctx.storeB.id })

      const listed = await asA('get', PluginApiRoutes.conversations.list)
        .set('x-store-id', ctx.storeB.id)
        .expect(OK)
      const read = await asA('get', PluginApiRoutes.conversations.byId(theirs.id)).set(
        'x-store-id',
        ctx.storeB.id
      )

      const ids = (listed.body as PageBody).data.map(item => item.id)
      expect(ids).toContain(mine.id)
      expect(ids).not.toContain(theirs.id)
      expect(read.status).toBe(NOT_FOUND)
    })

    it.each([
      ['reads one', 'get', (id: string) => PluginApiRoutes.conversations.byId(id), undefined],
      [
        'reads its origins',
        'get',
        (id: string) => PluginApiRoutes.conversations.origins(id),
        undefined
      ],
      [
        'reads its messaging window',
        'get',
        (id: string) => PluginApiRoutes.conversations.messagingWindow(id),
        undefined
      ],
      [
        'changes its status',
        'patch',
        (id: string) => PluginApiRoutes.conversations.status(id),
        { status: ConversationStatus.PENDING }
      ],
      [
        'assigns it',
        'patch',
        (id: string) => PluginApiRoutes.conversations.assign(id),
        { userId: null }
      ],
      [
        'snoozes it',
        'post',
        (id: string) => PluginApiRoutes.conversations.snooze(id),
        { until: new Date(Date.now() + 3_600_000).toISOString() }
      ],
      ['marks it read', 'post', (id: string) => PluginApiRoutes.conversations.read(id), undefined],
      [
        'marks it unread',
        'post',
        (id: string) => PluginApiRoutes.conversations.unread(id),
        undefined
      ]
    ] as const)(
      'is a 404 for a conversation of another store when it %s',
      async (_name, method, path, body) => {
        const theirs = await createConversationOf(owner, { storeId: ctx.storeB.id })
        const before = await row(theirs.id)

        const response = await asA(method, path(theirs.id)).send(body)

        expect(response.status).toBe(NOT_FOUND)
        expect(await row(theirs.id)).toEqual(before)
      }
    )

    it('does not tag a conversation of another store, nor with a tag of another store', async () => {
      const mine = await mkA()
      const theirs = await createConversationOf(owner, { storeId: ctx.storeB.id })
      const tagB = await createTag(owner, { storeId: ctx.storeB.id })
      const tagA = await createTag(owner, { storeId: ctx.storeA.id })

      const onTheirs = await asA('post', PluginApiRoutes.conversations.tags(theirs.id)).send({
        tagId: tagA.id
      })
      const withTheirs = await asA('post', PluginApiRoutes.conversations.tags(mine.id)).send({
        tagId: tagB.id
      })

      expect(onTheirs.status).toBe(NOT_FOUND)
      expect(withTheirs.status).toBe(NOT_FOUND)
      expect(await owner.conversation.count({ where: { id: mine.id, tags: { some: {} } } })).toBe(0)
    })

    it('does not reach another store through a bulk action', async () => {
      const mine = await mkA()
      const theirs = await createConversationOf(owner, { storeId: ctx.storeB.id })

      const response = await asA('post', PluginApiRoutes.conversations.bulk)
        .send({
          action: BulkActions.SET_STATUS,
          conversationIds: [mine.id, theirs.id],
          params: { status: ConversationStatus.PENDING }
        })
        .expect(OK)

      const body = response.body as { succeeded: string[]; failed: { id: string; code: string }[] }
      expect(body.succeeded).toEqual([mine.id])
      expect(body.failed).toEqual([{ id: theirs.id, code: ErrorCodes.RESOURCE_NOT_FOUND }])
      expect((await row(theirs.id)).status).toBe(ConversationStatus.OPEN)
    })

    it('searches and lists the directory of its own store only', async () => {
      const unique = `plg${randomUUID().slice(0, 8)}`
      await createCustomer(owner, { storeId: ctx.storeA.id, name: `${unique} Alfa` })
      await createCustomer(owner, { storeId: ctx.storeB.id, name: `${unique} Beta` })

      const a = await asA('get', PluginApiRoutes.search.customers).query({ q: unique }).expect(OK)
      const b = await asB('get', PluginApiRoutes.search.customers).query({ q: unique }).expect(OK)

      const names = (response: { body: unknown }) =>
        (response.body as { hits: { name: string }[] }).hits.map(hit => hit.name)
      expect(names(a)).toEqual([`${unique} Alfa`])
      expect(names(b)).toEqual([`${unique} Beta`])
      await asA('get', PluginApiRoutes.search.customers)
        .query({ q: unique, storeId: ctx.storeB.id })
        .expect(BAD_REQUEST)
    })

    it('shows the directory of the channel accounts of its store only', async () => {
      const mine = await row((await mkA()).id)
      const theirs = await row((await createConversationOf(owner, { storeId: ctx.storeB.id })).id)

      const a = await asA('get', PluginApiRoutes.channels.directory).expect(OK)

      const ids = (a.body as { data: { id: string }[] }).data.map(entry => entry.id)
      expect(ids).toContain(mine.channelConnectionId)
      expect(ids).not.toContain(theirs.channelConnectionId)
    })
  })

  describe('the scopes', () => {
    it('reads with conversations:read and writes nothing', async () => {
      const mine = await mkA()

      const read = await call('get', PluginApiRoutes.conversations.byId(mine.id), readOnly.key)
      const write = await call(
        'patch',
        PluginApiRoutes.conversations.status(mine.id),
        readOnly.key
      ).send({
        status: ConversationStatus.PENDING
      })

      expect(read.status).toBe(OK)
      expect(write.status).toBe(FORBIDDEN)
      expect(codeOf(write.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      expect((await row(mine.id)).status).toBe(ConversationStatus.OPEN)
    })

    it('needs messages:read for the origins and the search of messages, customers:read for customers', async () => {
      const mine = await mkA()

      const origins = await call(
        'get',
        PluginApiRoutes.conversations.origins(mine.id),
        readOnly.key
      )
      const messages = await call('get', PluginApiRoutes.search.messages, readOnly.key).query({
        q: 'hello'
      })
      const customers = await call('get', PluginApiRoutes.search.customers, readOnly.key).query({
        q: 'hello'
      })
      const directory = await call('get', PluginApiRoutes.channels.directory, readOnly.key)

      for (const response of [origins, messages, customers, directory]) {
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
      }
    })

    it('reaches the templates of an account of its own store with channels:read, and not those of another store', async () => {
      const mine = await row((await mkA()).id)
      const theirs = await row((await createConversationOf(owner, { storeId: ctx.storeB.id })).id)
      const path = PluginApiRoutes.channels.templates(mine.channelType)

      const own = await asA('get', path).query({ connectionId: mine.channelConnectionId })
      const other = await asA('get', path).query({ connectionId: theirs.channelConnectionId })
      const without = await call('get', path, readOnly.key).query({
        connectionId: mine.channelConnectionId
      })

      // The channel of the builders has no templates: the service answers that, which is as far as the scope lets the call go
      expect(own.status).toBe(CONFLICT)
      expect(other.status).toBe(NOT_FOUND)
      expect(without.status).toBe(FORBIDDEN)
      expect(codeOf(without.body)).toBe(ErrorCodes.PLUGIN_SCOPE_DENIED)
    })

    it('does not show what messages:read guards on a route that names conversations:read only', async () => {
      const mine = await mkA()
      const word = `plgpreview${randomUUID().slice(0, 8)}`
      await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: mine.id,
        content: word
      })
      await owner.conversation.update({
        where: { id: mine.id },
        data: { lastMessageAt: new Date() }
      })
      const both = await createPluginKey(owner, {
        storeId: ctx.storeA.id,
        pluginId: `${prefix}-both`,
        scopes: [PluginScopes.CONVERSATIONS_READ, PluginScopes.MESSAGES_READ]
      })

      const listed = await call('get', PluginApiRoutes.conversations.list, both.key).expect(OK)

      expect(JSON.stringify(listed.body)).toContain(mine.id)
      expect(JSON.stringify(listed.body)).not.toContain(word)
    })

    it('starts nothing without conversations:write', async () => {
      const identity = await createCustomerIdentity(owner, { storeId: ctx.storeA.id })
      const connection = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: CHANNEL
      })

      const response = await call('post', PluginApiRoutes.conversations.list, readOnly.key).send({
        customerIdentityId: identity.id,
        channelConnectionId: connection.id
      })

      expect(response.status).toBe(FORBIDDEN)
      expect(await owner.conversation.count({ where: { customerIdentityId: identity.id } })).toBe(0)
    })

    it('refuses a call with no key, a key of a person and an unknown key', async () => {
      await call('get', PluginApiRoutes.conversations.list).expect(401)
      await call('get', PluginApiRoutes.conversations.list, ctx.adminA.token).expect(401)
      await call('get', PluginApiRoutes.conversations.list, 'plg_live_nothing').expect(401)
    })

    it('does not see what a person without the archive permission does not see', async () => {
      const spam = await mkA({ status: ConversationStatus.SPAM })
      const archived = await mkA({ status: ConversationStatus.ARCHIVED })

      const listed = await asA('get', PluginApiRoutes.conversations.list).expect(OK)

      const ids = (listed.body as PageBody).data.map(item => item.id)
      expect(ids).not.toContain(spam.id)
      expect(ids).not.toContain(archived.id)
      await asA('get', PluginApiRoutes.conversations.byId(spam.id)).expect(NOT_FOUND)
    })
  })

  describe('what a plugin changes', () => {
    it('sees a conversation that is assigned to a person, as a person who sees all does', async () => {
      const mine = await mkA({ assignedTo: ctx.agentA.id })

      const response = await asA('get', PluginApiRoutes.conversations.byId(mine.id)).expect(OK)

      expect((response.body as DetailBody).assignedTo).toBe(ctx.agentA.id)
    })

    it('resolves a conversation, and the audit log says that a plugin did it', async () => {
      const mine = await mkA()

      const response = await asA('patch', PluginApiRoutes.conversations.status(mine.id))
        .send({ status: ConversationStatus.RESOLVED })
        .expect(OK)

      expect((response.body as DetailBody).status).toBe(ConversationStatus.RESOLVED)
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.CONVERSATION_RESOLVED,
        resourceId: mine.id
      })
      expect(entry?.userId).toBeNull()
      expect(entry?.metadata).toMatchObject({ pluginInstallationId: keyA.installationId })
    })

    it('leaves a thread that people can still read after it resolves, assigns and snoozes', async () => {
      const mine = await mkA()
      await asA('patch', PluginApiRoutes.conversations.assign(mine.id))
        .send({ userId: ctx.agentA.id })
        .expect(OK)
      await asA('patch', PluginApiRoutes.conversations.status(mine.id))
        .send({ status: ConversationStatus.RESOLVED })
        .expect(OK)

      const thread = await api(app, ctx.adminA, ctx.storeA).get(
        ApiRoutes.conversations.messages(mine.id)
      )

      expect(thread.status).toBe(OK)
      const lines = (
        thread.body as { data: { system: { event: string; actor: { type: string } } | null }[] }
      ).data
        .map(item => item.system)
        .filter(line => line !== null)
      expect(lines.map(line => line.event)).toEqual(
        expect.arrayContaining([SystemMessageEvents.ASSIGNED, SystemMessageEvents.RESOLVED])
      )
      expect(lines.every(line => line.actor.type === 'system')).toBe(true)
      expect(JSON.stringify(thread.body)).not.toContain(PLUGIN_ACTOR_PREFIX)
    })

    it('does not send the closing snippet: that reply is written as a person', async () => {
      const mine = await mkA()

      const response = await asA('patch', PluginApiRoutes.conversations.status(mine.id)).send({
        status: ConversationStatus.RESOLVED,
        closingSnippetId: randomUUID()
      })

      expect(response.status).toBe(BAD_REQUEST)
      expect((await row(mine.id)).status).toBe(ConversationStatus.OPEN)
    })

    it('assigns to a person of the store and back to nobody, and not to a person of another store', async () => {
      const mine = await mkA()

      const assigned = await asA('patch', PluginApiRoutes.conversations.assign(mine.id))
        .send({ userId: ctx.agentA.id })
        .expect(OK)
      const refused = await asA('patch', PluginApiRoutes.conversations.assign(mine.id)).send({
        userId: ctx.adminB.id
      })
      // What the refused call wrote: nothing, the person assigned before is still there
      expect((await row(mine.id)).assignedTo).toBe(ctx.agentA.id)
      const cleared = await asA('patch', PluginApiRoutes.conversations.assign(mine.id))
        .send({ userId: null })
        .expect(OK)

      expect((assigned.body as DetailBody).assignedTo).toBe(ctx.agentA.id)
      expect(refused.status).toBe(NOT_FOUND)
      expect((cleared.body as DetailBody).assignedTo).toBeNull()
      expect((await row(mine.id)).assignedTo).toBeNull()
    })

    it('reads a conversation as `plugin:<installation>`, never as a person', async () => {
      const mine = await mkA({ unreadCount: 3 })

      const response = await asA('post', PluginApiRoutes.conversations.read(mine.id)).expect(OK)

      expect((response.body as DetailBody).unreadCount).toBe(0)
      expect((await row(mine.id)).lastReadBy).toBe(`${PLUGIN_ACTOR_PREFIX}${keyA.installationId}`)
    })

    it('tags and untags a conversation', async () => {
      const mine = await mkA()
      const tag = await createTag(owner, { storeId: ctx.storeA.id })

      const attached = await asA('post', PluginApiRoutes.conversations.tags(mine.id))
        .send({ tagId: tag.id })
        .expect(OK)
      await asA('delete', PluginApiRoutes.conversations.tagById(mine.id, tag.id)).expect(NO_CONTENT)

      expect((attached.body as { id: string }[]).map(item => item.id)).toEqual([tag.id])
      expect(await owner.conversation.count({ where: { id: mine.id, tags: { some: {} } } })).toBe(0)
    })

    it('snoozes a conversation', async () => {
      const mine = await mkA()

      const response = await asA('post', PluginApiRoutes.conversations.snooze(mine.id))
        .send({ until: new Date(Date.now() + 3_600_000).toISOString() })
        .expect(OK)

      expect((response.body as DetailBody).status).toBe(ConversationStatus.SNOOZED)
    })

    it('acts on many, but never "assign to me" and never a file', async () => {
      const one = await mkA()
      const two = await mkA()

      const done = await asA('post', PluginApiRoutes.conversations.bulk)
        .send({
          action: BulkActions.SET_STATUS,
          conversationIds: [one.id, two.id],
          params: { status: ConversationStatus.RESOLVED }
        })
        .expect(OK)
      const toMe = await asA('post', PluginApiRoutes.conversations.bulk).send({
        action: BulkActions.ASSIGN_TO_ME,
        conversationIds: [one.id]
      })
      const file = await asA('post', PluginApiRoutes.conversations.bulk).send({
        action: BulkActions.EXPORT_CSV,
        conversationIds: [one.id]
      })

      expect((done.body as { succeeded: string[] }).succeeded).toHaveLength(2)
      expect(toMe.status).toBe(BAD_REQUEST)
      expect(file.status).toBe(BAD_REQUEST)
      expect((await row(one.id)).assignedTo).toBeNull()
      const entries = await waitForAuditEntries(
        owner,
        { action: AuditAction.BULK_ACTION_EXECUTED, storeId: ctx.storeA.id },
        2
      )
      // This call resolved two conversations: the earlier bulk test of the suite set another status
      const entry = entries.find(
        item =>
          (item.metadata as { params?: { status?: string } } | null)?.params?.status ===
          ConversationStatus.RESOLVED
      )
      expect(entry?.userId).toBeNull()
      expect(entry?.metadata).toMatchObject({ pluginInstallationId: keyA.installationId })
    })

    it('finds a message by its words, in its own store', async () => {
      const mine = await mkA()
      const word = `plgmsg${randomUUID().slice(0, 8)}`
      await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: mine.id,
        content: `${word} please`
      })

      const found = await asA('get', PluginApiRoutes.search.messages).query({ q: word }).expect(OK)
      const other = await asB('get', PluginApiRoutes.search.messages).query({ q: word }).expect(OK)

      expect((found.body as { hits: unknown[] }).hits).toHaveLength(1)
      expect((other.body as { hits: unknown[] }).hits).toHaveLength(0)
    })
  })

  describe('starting a conversation', () => {
    const open = async (storeId: string) => {
      const identity = await createCustomerIdentity(owner, { storeId })
      const connection = await createChannelConnection(owner, {
        storeId,
        channelType: CHANNEL
      })
      return { identity, connection }
    }

    it('makes one for a handle that has none, and gives the same back the second time', async () => {
      const { identity, connection } = await open(ctx.storeA.id)
      const body = { customerIdentityId: identity.id, channelConnectionId: connection.id }

      const first = await asA('post', PluginApiRoutes.conversations.list).send(body).expect(CREATED)
      const second = await asA('post', PluginApiRoutes.conversations.list).send(body).expect(OK)

      const made = first.body as { created: boolean; conversation: DetailBody }
      const again = second.body as { created: boolean; conversation: DetailBody }
      expect(made.created).toBe(true)
      expect(again.created).toBe(false)
      expect(again.conversation.id).toBe(made.conversation.id)
      expect(await owner.conversation.count({ where: { customerIdentityId: identity.id } })).toBe(1)
      const stored = await row(made.conversation.id)
      expect(stored).toMatchObject({
        storeId: ctx.storeA.id,
        customerId: identity.customerId,
        channelConnectionId: connection.id,
        assignedTo: null,
        status: ConversationStatus.OPEN
      })
      expect(await owner.message.count({ where: { conversationId: stored.id } })).toBe(0)
    })

    it('does not use the identity or the account of another store', async () => {
      const mineOpen = await open(ctx.storeA.id)
      const theirs = await open(ctx.storeB.id)

      const identityOfB = await asA('post', PluginApiRoutes.conversations.list).send({
        customerIdentityId: theirs.identity.id,
        channelConnectionId: mineOpen.connection.id
      })
      const connectionOfB = await asA('post', PluginApiRoutes.conversations.list).send({
        customerIdentityId: mineOpen.identity.id,
        channelConnectionId: theirs.connection.id
      })

      expect(identityOfB.status).toBe(NOT_FOUND)
      expect(connectionOfB.status).toBe(NOT_FOUND)
      expect(
        await owner.conversation.count({
          where: { customerIdentityId: { in: [theirs.identity.id, mineOpen.identity.id] } }
        })
      ).toBe(0)
    })

    it('does not open a thread for a customer who was erased', async () => {
      const { identity, connection } = await open(ctx.storeA.id)
      await owner.customer.update({
        where: { id: identity.customerId },
        data: { erasedAt: new Date() }
      })

      const response = await asA('post', PluginApiRoutes.conversations.list).send({
        customerIdentityId: identity.id,
        channelConnectionId: connection.id
      })

      expect(response.status).toBe(CONFLICT)
      expect(await owner.conversation.count({ where: { customerIdentityId: identity.id } })).toBe(0)
    })

    it('does not open a thread on an account that is disconnected', async () => {
      const { identity, connection } = await open(ctx.storeA.id)
      await owner.channelConnection.update({
        where: { id: connection.id },
        data: { status: ChannelConnectionStatus.DISCONNECTED }
      })

      const response = await asA('post', PluginApiRoutes.conversations.list).send({
        customerIdentityId: identity.id,
        channelConnectionId: connection.id
      })

      expect(response.status).toBe(NOT_FOUND)
    })

    it('refuses an identity and an account of different channels', async () => {
      const identity = await createCustomerIdentity(owner, { storeId: ctx.storeA.id })
      const other = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: `${CHANNEL}-other`
      })

      const response = await asA('post', PluginApiRoutes.conversations.list).send({
        customerIdentityId: identity.id,
        channelConnectionId: other.id
      })

      expect(response.status).toBe(CONFLICT)
    })

    it('takes nothing but the two ids', async () => {
      const { identity, connection } = await open(ctx.storeA.id)

      const response = await asA('post', PluginApiRoutes.conversations.list).send({
        customerIdentityId: identity.id,
        channelConnectionId: connection.id,
        storeId: ctx.storeB.id
      })

      expect(response.status).toBe(BAD_REQUEST)
    })
  })

  it('keeps the routes of the inbox closed to a key', async () => {
    const mine = await mkA()

    // The human route is not the plugin route: a key is not a session
    await call('get', `${ApiRoutes.conversations.byId(mine.id)}`, keyA.key).expect(401)
  })
})
