import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ConversationStatus,
  DeliveryStatus,
  MembershipStatus,
  MessageType,
  PluginCatalogTypes,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'
import { PlatformException } from '@platform/core/errors'
import {
  type CreateMessageBody,
  MessagesService,
  type PluginMessageOrigin,
  pluginViewerOf
} from '@platform/core/messaging'

import { createConversationOf } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const BAD_REQUEST = 400

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

// What the scopes `conversations:read` and `messages:write` stand for
const HELD = [
  Permissions.CONVERSATIONS_VIEW,
  Permissions.CONVERSATIONS_VIEW_ALL,
  Permissions.MESSAGES_SEND,
  Permissions.MESSAGES_INTERNAL_NOTE
]

// The core of the messages a plugin writes (Step 5.6, PR M1): who the message is from and whether it is quiet. The route of the
// plugin API that calls it is the next PR, so this suite calls the service the way that route will.
describe('A message written by a plugin', () => {
  const prefix = newRunPrefix()
  const pluginId = `${prefix}-bot`
  const otherPluginId = `${prefix}-other`
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let messages: MessagesService

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    messages = app.get(MessagesService, { strict: false })
    for (const id of [pluginId, otherPluginId]) {
      await owner.plugin.create({
        data: {
          id,
          name: `Plugin ${id}`,
          authorName: 'suite',
          authorEmail: 'suite@example.invalid',
          type: PluginCatalogTypes.INTEGRATION,
          organizationId: ctx.orgA.id,
          manifest: {},
          pricingModel: PluginPricingModels.FREE,
          status: PluginStatus.APPROVED
        }
      })
    }
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await app.close()
    await owner.$disconnect()
  })

  const system = (quiet = false, nickname: string | null = 'Order bot'): PluginMessageOrigin => ({
    pluginId,
    quiet,
    author: AuthorType.SYSTEM,
    nickname
  })
  const agent = (userId: string, quiet = false): PluginMessageOrigin => ({
    pluginId,
    quiet,
    author: AuthorType.AGENT,
    userId
  })
  const text = (
    conversationId: string,
    extra: Partial<CreateMessageBody> = {}
  ): CreateMessageBody =>
    ({
      type: MessageType.TEXT,
      conversationId,
      content: 'Your order is on its way',
      idempotencyKey: randomUUID(),
      ...extra
    }) as CreateMessageBody
  const note = (conversationId: string, mentions: string[] = []): CreateMessageBody => ({
    type: MessageType.INTERNAL_NOTE,
    conversationId,
    content: 'The bot saw a delay',
    idempotencyKey: randomUUID(),
    mentions
  })
  const send = (body: CreateMessageBody, origin: PluginMessageOrigin, storeId = ctx.storeA.id) =>
    messages.create(
      storeId,
      body,
      pluginViewerOf(HELD),
      undefined,
      undefined,
      undefined,
      undefined,
      origin
    )
  const row = (id: string) => owner.conversation.findUniqueOrThrow({ where: { id } })
  const mk = (extra: Partial<Parameters<typeof createConversationOf>[1]> = {}) =>
    createConversationOf(owner, { storeId: ctx.storeA.id, ...extra })

  describe('as the system', () => {
    it('is the system’s, keeps the trace of the plugin and its nickname, and is queued for the channel', async () => {
      const { id } = await mk()

      const { message, created } = await send(text(id), system())

      expect(created).toBe(true)
      expect(message).toMatchObject({
        authorType: AuthorType.SYSTEM,
        authorId: null,
        authorPluginId: pluginId,
        authorNickname: 'Order bot',
        deliveryStatus: DeliveryStatus.QUEUED
      })
      const stored = await owner.message.findUniqueOrThrow({ where: { id: message.id } })
      expect(stored).toMatchObject({ authorPluginId: pluginId, authorNickname: 'Order bot' })
    })

    it('never counts as a human answer: it sets the automated first answer and leaves firstResponseAt alone', async () => {
      const { id } = await mk()

      await send(text(id), system())
      const first = await row(id)
      await send(text(id), system())

      expect(first.firstResponseAt).toBeNull()
      expect(first.firstAutomatedResponseAt).not.toBeNull()
      expect(first.lastOutboundAt).not.toBeNull()
      expect(first.lastMessageAt).not.toBeNull()
      const second = await row(id)
      // Once: the second one does not move it
      expect(second.firstAutomatedResponseAt).toEqual(first.firstAutomatedResponseAt)
      expect(second.firstResponseAt).toBeNull()
    })

    it('does not shadow the first answer of a person that comes after it', async () => {
      const { id } = await mk()
      await send(text(id), system())

      await send(text(id), agent(ctx.agentA.id))

      const after = await row(id)
      expect(after.firstResponseAt).not.toBeNull()
      expect(after.firstAutomatedResponseAt).not.toBeNull()
    })

    it.each([ConversationStatus.RESOLVED, ConversationStatus.SNOOZED])(
      'reopens a %s conversation, like a reply of the team',
      async status => {
        const { id } = await mk({ status })

        await send(text(id), system())

        expect((await row(id)).status).toBe(ConversationStatus.OPEN)
      }
    )

    it('does not see an archived conversation: no scope grants archiving, so it is one of those a person without it does not see', async () => {
      const { id } = await mk({ status: ConversationStatus.ARCHIVED })

      await expect(send(text(id), system())).rejects.toBeInstanceOf(PlatformException)

      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })

    it('leaves a pending conversation pending: answering does not take it out of the queue', async () => {
      const { id } = await mk({ status: ConversationStatus.PENDING })

      await send(text(id), system())

      expect((await row(id)).status).toBe(ConversationStatus.PENDING)
    })

    it('does not take an unassigned conversation for anyone, whatever the store setting says', async () => {
      const { id } = await mk()

      await send(text(id), system())

      expect((await row(id)).assignedTo).toBeNull()
    })

    it('answers a retry with the same key with the message that was made, and refuses it to another plugin', async () => {
      const { id } = await mk()
      const body = text(id)

      const first = await send(body, system())
      const again = await send(body, system())

      expect(again.created).toBe(false)
      expect(again.message.id).toBe(first.message.id)
      await expect(send(body, { ...system(), pluginId: otherPluginId })).rejects.toBeInstanceOf(
        PlatformException
      )
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(1)
    })
  })

  describe('as a person of the store', () => {
    it('is theirs, counts as their answer, and keeps the trace of the plugin', async () => {
      const { id } = await mk()

      const { message } = await send(text(id), agent(ctx.agentA.id))

      expect(message).toMatchObject({
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id,
        authorPluginId: pluginId,
        authorNickname: null
      })
      const after = await row(id)
      expect(after.firstResponseAt).not.toBeNull()
      expect(after.firstAutomatedResponseAt).toBeNull()
    })

    it('is refused for a person who is a member of another store, and writes nothing', async () => {
      const { id } = await mk()

      await expect(send(text(id), agent(ctx.adminB.id))).rejects.toBeInstanceOf(PlatformException)

      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
      const after = await row(id)
      expect(after.firstResponseAt).toBeNull()
      expect(after.lastOutboundAt).toBeNull()
    })

    it('is refused for a user that does not exist', async () => {
      const { id } = await mk()

      await expect(send(text(id), agent(randomUUID()))).rejects.toBeInstanceOf(PlatformException)

      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })

    it('is refused for a member who was suspended', async () => {
      const { id } = await mk()
      await owner.membership.updateMany({
        where: { userId: ctx.agentA.id, storeId: ctx.storeA.id },
        data: { status: MembershipStatus.SUSPENDED }
      })
      try {
        await expect(send(text(id), agent(ctx.agentA.id))).rejects.toBeInstanceOf(PlatformException)
      } finally {
        await owner.membership.updateMany({
          where: { userId: ctx.agentA.id, storeId: ctx.storeA.id },
          data: { status: MembershipStatus.ACTIVE }
        })
      }

      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })

    it('is refused for a member whose role could not send it themselves', async () => {
      const { id } = await mk()

      await expect(send(text(id), agent(ctx.viewerA.id))).rejects.toBeInstanceOf(PlatformException)

      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })
  })

  describe('quiet', () => {
    // The conversation as it was: a resolved one, answered before, with every date set to a moment the message cannot be
    const SEEN = minutesAgo(90)
    const quietCase = it.each([
      ['as the system', () => system(true)],
      ['as a person', () => agent(ctx.agentA.id, true)]
    ] as const)

    quietCase('%s leaves the conversation as it was', async (_name, origin) => {
      const { id } = await mk({
        status: ConversationStatus.RESOLVED,
        lastMessageAt: SEEN,
        resolvedAt: SEEN
      })
      await owner.conversation.update({
        where: { id },
        data: { lastOutboundAt: SEEN, firstResponseAt: SEEN }
      })
      const before = await row(id)

      const { message } = await send(text(id), origin())

      // The customer gets it and the thread has it
      expect(message.deliveryStatus).toBe(DeliveryStatus.QUEUED)
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(1)
      const after = await row(id)
      expect(after.lastMessageAt).toEqual(before.lastMessageAt)
      expect(after.status).toBe(ConversationStatus.RESOLVED)
      expect(after.resolvedAt).toEqual(before.resolvedAt)
      expect(after.lastOutboundAt).toEqual(before.lastOutboundAt)
      expect(after.firstResponseAt).toEqual(before.firstResponseAt)
      expect(after.firstAutomatedResponseAt).toBeNull()
      expect(after.unreadCount).toBe(before.unreadCount)
    })

    it('does not set the first answers of a conversation nobody answered', async () => {
      const { id } = await mk()

      await send(text(id), system(true))
      await send(text(id), agent(ctx.agentA.id, true))

      const after = await row(id)
      expect(after.firstResponseAt).toBeNull()
      expect(after.firstAutomatedResponseAt).toBeNull()
      expect(after.lastOutboundAt).toBeNull()
      expect(after.lastMessageAt).toBeNull()
    })

    it('still obeys the rest: spam is not answered, even quietly', async () => {
      const { id } = await mk({ status: ConversationStatus.SPAM })

      await expect(send(text(id), system(true))).rejects.toBeInstanceOf(PlatformException)

      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })

    it('is not a thing a person of the team chooses: the route of the agents refuses the field', async () => {
      const { id } = await mk()

      const response = await api(app, ctx.agentA, ctx.storeA).post(ApiRoutes.messages.create).send({
        type: MessageType.TEXT,
        conversationId: id,
        content: 'hi',
        idempotencyKey: randomUUID(),
        quiet: true
      })

      expect(response.status).toBe(BAD_REQUEST)
      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })
  })

  describe('a note', () => {
    it('changes nothing in the conversation, as a person’s note does not', async () => {
      const { id } = await mk({
        status: ConversationStatus.RESOLVED,
        lastMessageAt: minutesAgo(60)
      })
      const before = await row(id)

      const { message } = await send(note(id), system())

      expect(message).toMatchObject({
        type: MessageType.INTERNAL_NOTE,
        authorType: AuthorType.SYSTEM,
        authorPluginId: pluginId,
        deliveryStatus: null
      })
      const after = await row(id)
      expect(after.status).toBe(ConversationStatus.RESOLVED)
      expect(after.lastMessageAt).toEqual(before.lastMessageAt)
      expect(after.firstAutomatedResponseAt).toBeNull()
      expect(after.firstResponseAt).toBeNull()
    })

    it('cannot mention anyone, as the system: a mention is from a person', async () => {
      const { id } = await mk()

      await expect(send(note(id, [ctx.agentA.id]), system())).rejects.toBeInstanceOf(
        PlatformException
      )

      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })
  })

  describe('what the plugin must be allowed', () => {
    it('cannot mention anyone either as a person: nothing in the notification would say a plugin wrote it', async () => {
      const { id } = await mk()

      await expect(send(note(id, [ctx.adminA.id]), agent(ctx.agentA.id))).rejects.toBeInstanceOf(
        PlatformException
      )

      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })

    it.each([
      [
        'a reply',
        (id: string) => text(id),
        [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_INTERNAL_NOTE]
      ],
      [
        'a note',
        (id: string) => note(id),
        [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_SEND]
      ]
    ] as const)(
      'is refused %s when the scopes do not hold its permission',
      async (_name, body, held) => {
        const { id } = await mk()

        await expect(
          messages.create(
            ctx.storeA.id,
            body(id),
            pluginViewerOf(held),
            undefined,
            undefined,
            undefined,
            undefined,
            system()
          )
        ).rejects.toBeInstanceOf(PlatformException)

        expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
      }
    )

    it('stores a nickname cleaned, whatever the caller passed', async () => {
      const { id } = await mk()

      const { message } = await send(
        text(id),
        system(false, `  Bot\u202E${'x'.repeat(200)}\u0000  `)
      )

      expect(message.authorNickname).not.toContain('\u202E')
      expect(message.authorNickname).not.toContain('\u0000')
      expect(message.authorNickname?.length).toBeLessThanOrEqual(64)
    })

    it('answers a retry of a message written as a person with it, and refuses it as another person', async () => {
      const { id } = await mk()
      const body = text(id)

      const first = await send(body, agent(ctx.agentA.id))
      const again = await send(body, agent(ctx.agentA.id))

      expect(again).toMatchObject({ created: false, message: { id: first.message.id } })
      await expect(send(body, agent(ctx.adminA.id))).rejects.toBeInstanceOf(PlatformException)
    })
  })

  describe('what a plugin does not send', () => {
    it('is no template, which is the provider’s, nor a file that its own installation did not upload', async () => {
      const { id } = await mk()

      await expect(
        send(
          {
            type: MessageType.TEMPLATE,
            conversationId: id,
            templateName: 'hello',
            language: 'en',
            variables: [],
            idempotencyKey: randomUUID()
          },
          system()
        )
      ).rejects.toBeInstanceOf(PlatformException)
      await expect(
        send(
          {
            type: MessageType.IMAGE,
            conversationId: id,
            mediaIds: [randomUUID()],
            idempotencyKey: randomUUID()
          },
          system()
        )
      ).rejects.toBeInstanceOf(PlatformException)

      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })

    it('is nothing for a conversation of another store', async () => {
      const { id } = await mk()

      await expect(send(text(id), system(), ctx.storeB.id)).rejects.toBeInstanceOf(
        PlatformException
      )

      expect(await owner.message.count({ where: { conversationId: id } })).toBe(0)
    })
  })

  describe('a message no plugin wrote', () => {
    it('has no trace of a plugin', async () => {
      const { id } = await mk()

      const response = await api(app, ctx.agentA, ctx.storeA).post(ApiRoutes.messages.create).send({
        type: MessageType.TEXT,
        conversationId: id,
        content: 'hi',
        idempotencyKey: randomUUID()
      })

      expect(response.status).toBe(201)
      expect(response.body).toMatchObject({
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id,
        authorPluginId: null,
        authorNickname: null
      })
    })
  })
})
