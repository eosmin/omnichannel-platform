import { randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import supertest from 'supertest'

import { API_PREFIX, PluginApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AttentionReasons,
  ChannelIds,
  ConversationStatus,
  PaginationLimits
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { PluginScopes } from '@platform/plugins/sdk'

import {
  createChannelConnection,
  createConversationOf,
  createCustomerIdentity,
  createPluginKey
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

const OK = HttpStatusCodes.OK
const CREATED = HttpStatusCodes.CREATED
const NOT_FOUND = HttpStatusCodes.NOT_FOUND
const FORBIDDEN = HttpStatusCodes.FORBIDDEN

interface CustomerBody {
  id: string
  name?: string | null
  displayIdentity?: string
  username?: string | null
  avatarUrl?: string | null
  isCaution?: boolean
}
interface ConversationBody {
  id: string
  assignedTo?: string | null
  attention?: { reason: string; note?: string | null } | null
  customer: CustomerBody
}

const READING = [PluginScopes.CONVERSATIONS_READ, PluginScopes.CONVERSATIONS_WRITE]

// What a conversation says of its customer through the plugin API (PR plugin-conversations-identity, owner's decision of 2026-11-17): the
// name, the handle of the channel (a phone number on a phone channel), the username, the photo and the caution flag are the identity of the
// customer, and the note an agent wrote on the mark of the conversation is text about them. A key sees them only with `customers:read` too;
// without it the customer is its id, a pseudonym. The load of each member of the team is not the customer's and no scope of a plugin opens
// it, so it never leaves. The tenancy and the scopes of the routes themselves are the cases of `plugin-conversations.spec.ts`.
describe('The identity of the customer in the conversations of the plugin API', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let withCustomers: { key: string; installationId: string }
  let withoutCustomers: { key: string; installationId: string }
  let otherStore: { key: string; installationId: string }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    withCustomers = await createPluginKey(owner, {
      storeId: ctx.storeA.id,
      pluginId: `${prefix}-with`,
      scopes: [...READING, PluginScopes.CUSTOMERS_READ]
    })
    withoutCustomers = await createPluginKey(owner, {
      storeId: ctx.storeA.id,
      pluginId: `${prefix}-without`,
      scopes: READING
    })
    otherStore = await createPluginKey(owner, {
      storeId: ctx.storeB.id,
      pluginId: `${prefix}-other`,
      scopes: READING
    })
  })
  afterAll(async () => {
    await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: prefix } } })
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  type Method = 'get' | 'post' | 'patch'
  const call = (method: Method, path: string, key: string) => {
    const server = app.getHttpServer() as Parameters<typeof supertest>[0]
    return supertest(server)
      [method](`${API_PREFIX}${path}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
      .set('authorization', `Bearer ${key}`)
  }

  // A conversation whose customer is known by name, handle, username and photo, is flagged, has a mark with a note and is assigned
  interface Known {
    id: string
    customerId: string
    secrets: {
      name: string
      handle: string
      username: string
      avatar: string
      note: string
      reason: string
    }
  }
  async function known(): Promise<Known> {
    // Each case has its own, because a handle is unique in its store
    const tag = randomUUID().slice(0, 8)
    const secrets = {
      name: `Marta ${tag}`,
      handle: `ig-${tag}`,
      username: `marta_${tag}`,
      avatar: `https://cdn.example.com/${tag}.jpg`,
      note: `Call her mother at 555-${randomInt(1000, 9999)} ${tag}`,
      reason: `Refund for Marta ${tag}, approved by phone`
    }
    const made = await createConversationOf(owner, {
      storeId: ctx.storeA.id,
      assignedTo: ctx.agentA.id
    })
    await owner.customer.update({
      where: { id: made.customerId },
      data: { name: secrets.name, isCaution: true }
    })
    await owner.customerIdentity.update({
      where: { id: made.customerIdentityId },
      data: {
        channelIdentity: secrets.handle,
        username: secrets.username,
        avatarUrl: secrets.avatar
      }
    })
    await owner.conversation.update({
      where: { id: made.id },
      data: {
        attentionReason: AttentionReasons.SNOOZE_WOKE,
        attentionAt: new Date(),
        attentionNote: secrets.note,
        resolutionReason: secrets.reason,
        // A customer who has written, which marking it unread needs
        lastInboundAt: new Date()
      }
    })
    return { id: made.id, customerId: made.customerId, secrets }
  }

  // Nothing of the customer but the id, anywhere in what the key was told
  const expectPseudonym = (body: unknown, made: Known): void => {
    const item = body as ConversationBody
    expect(item.customer).toEqual({ id: made.customerId })
    expect(item.attention?.note).toBeUndefined()
    expect(item).not.toHaveProperty('resolutionReason', made.secrets.reason)
    // The reading, the unreading, the status and the snooze take the mark away, so for them the absence of the note proves little: the
    // list, the detail and the assignment (which leaves the mark where it was) are the cases that prove it
    const text = JSON.stringify(body)
    for (const secret of Object.values(made.secrets)) expect(text).not.toContain(secret)
  }
  const expectIdentity = (body: unknown, made: Known): void => {
    const item = body as ConversationBody
    expect(item.customer).toMatchObject({
      id: made.customerId,
      name: made.secrets.name,
      // What the inbox writes for the customer: the name when there is one, the handle when there is not
      displayIdentity: made.secrets.name,
      username: made.secrets.username,
      avatarUrl: made.secrets.avatar,
      isCaution: true
    })
    expect(item.attention?.note).toBe(made.secrets.note)
  }

  describe('a key that holds conversations:read and not customers:read', () => {
    it('lists the conversations with the id of the customer and nothing else of them', async () => {
      const made = await known()

      const response = await call('get', PluginApiRoutes.conversations.list, withoutCustomers.key)
        .query({ limit: PaginationLimits.MAX })
        .expect(OK)

      const item = (response.body as { data: ConversationBody[] }).data.find(
        row => row.id === made.id
      )
      expectPseudonym(item, made)
    })

    it('reads one conversation with the id of the customer and nothing else of them', async () => {
      const made = await known()

      const response = await call(
        'get',
        PluginApiRoutes.conversations.byId(made.id),
        withoutCustomers.key
      ).expect(OK)

      expectPseudonym(response.body, made)
    })

    it.each([
      [
        'resolves it',
        'patch',
        (id: string) => PluginApiRoutes.conversations.status(id),
        { status: ConversationStatus.RESOLVED }
      ],
      [
        'snoozes it',
        'post',
        (id: string) => PluginApiRoutes.conversations.snooze(id),
        { until: new Date(Date.now() + 3_600_000).toISOString() }
      ],
      [
        'assigns it',
        'patch',
        (id: string) => PluginApiRoutes.conversations.assign(id),
        { userId: null }
      ],
      ['marks it read', 'post', (id: string) => PluginApiRoutes.conversations.read(id), undefined],
      [
        'marks it unread',
        'post',
        (id: string) => PluginApiRoutes.conversations.unread(id),
        undefined
      ]
    ] as const)(
      'answers the conversation it changes without the identity of the customer, when it %s',
      async (_label, method, path, body) => {
        const made = await known()

        const request = call(method, path(made.id), withoutCustomers.key)
        const response = await (body === undefined ? request : request.send(body)).expect(OK)

        expectPseudonym(response.body, made)
        // Assigning leaves the mark where it was, so for this route the absence of the note is a fact and not an emptied mark
        if (_label === 'assigns it') {
          expect((response.body as ConversationBody).attention?.reason).toBe(
            AttentionReasons.SNOOZE_WOKE
          )
        }
      }
    )

    it('starts a conversation and is told the id of the customer and nothing else of them', async () => {
      const identity = await createCustomerIdentity(owner, { storeId: ctx.storeA.id })
      const name = `Marta ${randomUUID().slice(0, 8)}`
      const handle = `ig-${randomUUID().slice(0, 8)}`
      const username = `marta_${randomUUID().slice(0, 8)}`
      await owner.customer.update({ where: { id: identity.customerId }, data: { name } })
      await owner.customerIdentity.update({
        where: { id: identity.id },
        data: { channelIdentity: handle, username }
      })
      const connection = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelIds.INSTAGRAM
      })

      const response = await call('post', PluginApiRoutes.conversations.list, withoutCustomers.key)
        .send({ customerIdentityId: identity.id, channelConnectionId: connection.id })
        .expect(CREATED)

      const text = JSON.stringify(response.body)
      for (const secret of [name, handle, username]) expect(text).not.toContain(secret)
      expect((response.body as { conversation: ConversationBody }).conversation.customer).toEqual({
        id: identity.customerId
      })
    })

    it('still sees who the conversation is assigned to, which an assignment needs', async () => {
      const made = await known()

      const response = await call(
        'get',
        PluginApiRoutes.conversations.byId(made.id),
        withoutCustomers.key
      ).expect(OK)

      expect((response.body as ConversationBody).assignedTo).toBe(ctx.agentA.id)
    })
  })

  describe('a key that holds both scopes', () => {
    it('sees the customer and the note, on the list, on one conversation and after a change', async () => {
      const made = await known()

      const list = await call('get', PluginApiRoutes.conversations.list, withCustomers.key)
        .query({ limit: PaginationLimits.MAX })
        .expect(OK)
      const one = await call(
        'get',
        PluginApiRoutes.conversations.byId(made.id),
        withCustomers.key
      ).expect(OK)
      // Reading a conversation takes its mark away, so the change that is answered here is the assignment
      const changed = await call(
        'patch',
        PluginApiRoutes.conversations.assign(made.id),
        withCustomers.key
      )
        .send({ userId: ctx.agentA.id })
        .expect(OK)

      expectIdentity(
        (list.body as { data: ConversationBody[] }).data.find(row => row.id === made.id),
        made
      )
      expectIdentity(one.body, made)
      expectIdentity(changed.body, made)
    })
  })

  describe('the routes that name a customer', () => {
    it('keeps the conversations of a customer closed to a key that does not hold customers:read', async () => {
      const made = await known()

      await call(
        'get',
        PluginApiRoutes.customers.conversations(made.customerId),
        withoutCustomers.key
      ).expect(FORBIDDEN)
    })
  })

  describe('the numbers beside the filters', () => {
    it.each([
      ['without customers:read', () => withoutCustomers.key],
      ['with customers:read', () => withCustomers.key]
    ])('never carry the load of each member of the team, %s', async (_label, key) => {
      await known()

      const response = await call('get', PluginApiRoutes.conversations.list, key())
        .query({ countsOnly: 'true' })
        .expect(OK)

      const counts = response.body as Record<string, unknown>
      expect(typeof counts['all']).toBe('number')
      expect(typeof counts['unassigned']).toBe('number')
      expect(typeof counts['byStatus']).toBe('object')
      expect(typeof counts['byChannel']).toBe('object')
      expect(counts).not.toHaveProperty('byAgent')
      expect(counts).not.toHaveProperty('activeByAgent')
      expect(JSON.stringify(counts)).not.toContain(ctx.agentA.id)
    })
  })

  describe('the tenancy', () => {
    it('does not hand a conversation of another store to a key, whatever the scopes', async () => {
      const made = await known()

      await call('get', PluginApiRoutes.conversations.byId(made.id), otherStore.key).expect(
        NOT_FOUND
      )
    })
  })
})
