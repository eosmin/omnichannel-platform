import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ConversationStatus,
  DeliveryStatus,
  MessageType,
  ReactionActors
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import {
  ChannelConnectionResolver,
  ConversationsService,
  CustomerIdentityService,
  InboundMessageService,
  type InboundEvent,
  InboundOutcomes,
  InboundMessageTargets,
  MessageReactionsService,
  ReactionOutcomes,
  RoutingService
} from '@platform/core/messaging'
import { JobNames, QueueNames } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'

import {
  buildChannelPlugin,
  createConversation,
  createCustomerIdentity,
  ensurePluginInstallation,
  TEST_CHANNEL_ID
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue, queueOf } from '../helpers/queue'

const OK = 200
const NOT_FOUND = 404

interface ThreadBody {
  data: {
    id: string
    reactions: {
      emoji: string
      authorType: string
      authorId: string | null
      deliveryStatus: string
      deliveryError: string | null
    }[]
  }[]
}

describe('Echoes and reactions that a channel delivers', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let inbound: InboundMessageService
  let reactions: MessageReactionsService
  let prisma: PrismaService
  let handle = 0

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(getQueueToken(QueueNames.INBOUND))
        .useValue(new CapturedQueue())
        .overrideProvider(getQueueToken(QueueNames.HEAVY_PROCESSING))
        .useValue(new CapturedQueue())
    )
    ctx = await seedTestContext(owner, app, prefix)
    app.get(PluginRegistry, { strict: false }).register(buildChannelPlugin())
    prisma = app.get(PrismaService, { strict: false })
    const connections = new ChannelConnectionResolver(prisma)
    const events = app.get(DomainEvents, { strict: false })
    inbound = new InboundMessageService(
      prisma,
      connections,
      app.get(CustomerIdentityService, { strict: false }),
      app.get(ConversationsService, { strict: false }),
      app.get(RoutingService, { strict: false }),
      events,
      queueOf(app, QueueNames.HEAVY_PROCESSING) as never,
      await app.resolve(PinoLogger)
    )
    reactions = new MessageReactionsService(
      prisma,
      new InboundMessageTargets(prisma, connections),
      events,
      await app.resolve(PinoLogger)
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  beforeEach(() => {
    queueOf(app, QueueNames.HEAVY_PROCESSING).jobs.length = 0
  })

  const connectionOf = async (storeId: string): Promise<string> => {
    const connectionId = `${prefix}-conn-${(handle += 1)}`
    const installation = await ensurePluginInstallation(owner, {
      storeId,
      pluginId: TEST_CHANNEL_ID
    })
    await owner.channelConnection.create({
      data: {
        storeId,
        pluginId: TEST_CHANNEL_ID,
        installationId: installation.id,
        connectionId,
        displayName: 'test connection',
        status: 'active',
        credentials: Buffer.from('not a secret')
      }
    })
    return connectionId
  }
  const handleOf = (): string => `50371${String((handle += 1)).padStart(6, '0')}`
  const message = (
    connectionId: string,
    from: string,
    id: string,
    text = 'hello'
  ): InboundEvent => ({
    connectionId,
    channelIdentity: from,
    message: {
      externalId: id,
      type: MessageType.TEXT,
      content: text,
      timestamp: new Date().toISOString()
    }
  })
  const threadOf = async (storeId: string, from: string) => {
    const conversation = await owner.conversation.findFirstOrThrow({
      where: { storeId, customerIdentity: { channelIdentity: from } }
    })
    const messages = await owner.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' }
    })
    return { conversation, messages }
  }
  const echo = (connectionId: string, from: string, id: string, text = 'hello', last = true) =>
    inbound.handleMessageEcho(TEST_CHANNEL_ID, message(connectionId, from, id, text), last)

  describe('an echo', () => {
    it('is a sent message of an external author, in the thread of that customer', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(connectionId, from, 'in-1'))
      const before = await threadOf(ctx.storeA.id, from)

      const outcome = await echo(connectionId, from, 'out-1', 'from my phone')

      expect(outcome).toBe(InboundOutcomes.STORED)
      const { conversation, messages } = await threadOf(ctx.storeA.id, from)
      expect(messages).toHaveLength(2)
      expect(messages[1]).toMatchObject({
        content: 'from my phone',
        authorType: AuthorType.EXTERNAL,
        authorId: null,
        deliveryStatus: DeliveryStatus.SENT,
        channelMessageId: 'out-1',
        storeId: ctx.storeA.id
      })
      // Not unread, and the customer's wait is not answered by something the platform did not send
      expect(conversation.unreadCount).toBe(before.conversation.unreadCount)
      expect(conversation.lastInboundAt).toEqual(before.conversation.lastInboundAt)
    })

    it('does not open the messaging window of the customer', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()

      await echo(connectionId, from, 'out-2')

      const identity = await owner.customerIdentity.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, channelIdentity: from }
      })
      expect(identity.lastInboundAt).toBeNull()
    })

    it('starts a conversation, unassigned and read, when the owner writes first', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()

      const created: string[] = []
      const events = app.get(DomainEvents, { strict: false })
      const spy = jest.spyOn(events, 'publish')
      await echo(connectionId, from, 'out-3')
      for (const [, name, payload] of spy.mock.calls) {
        if (name === Events.CONVERSATION_CREATED) {
          created.push((payload as { conversationId: string }).conversationId)
        }
      }
      spy.mockRestore()

      const { conversation, messages } = await threadOf(ctx.storeA.id, from)
      expect(messages).toHaveLength(1)
      expect(conversation).toMatchObject({
        assignedTo: null,
        unreadCount: 0,
        status: ConversationStatus.OPEN
      })
      expect(created).toEqual([conversation.id])
    })

    it.each([
      [ConversationStatus.RESOLVED, ConversationStatus.OPEN],
      [ConversationStatus.SNOOZED, ConversationStatus.OPEN],
      [ConversationStatus.ARCHIVED, ConversationStatus.OPEN],
      [ConversationStatus.SPAM, ConversationStatus.SPAM]
    ])('leaves a %s conversation as %s when the owner writes', async (from, expected) => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const handle = handleOf()
      const connection = await owner.channelConnection.findFirstOrThrow({ where: { connectionId } })
      const identity = await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        channelType: TEST_CHANNEL_ID,
        handle
      })
      await createConversation(owner, {
        storeId: ctx.storeA.id,
        customerId: identity.customerId,
        customerIdentityId: identity.id,
        channelType: TEST_CHANNEL_ID,
        channelConnectionId: connection.id,
        status: from
      })

      await echo(connectionId, handle, `out-4-${from}`)

      const { conversation, messages } = await threadOf(ctx.storeA.id, handle)
      expect(conversation.status).toBe(expected)
      // The line that tells the thread it was reopened is not a message of anyone
      expect(messages.filter(item => item.authorType !== String(AuthorType.SYSTEM))).toHaveLength(1)
      expect(conversation.unreadCount).toBe(0)
    })

    it('is stored once however many times the provider delivers it', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()

      await echo(connectionId, from, 'out-5')
      const again = await echo(connectionId, from, 'out-5')

      expect(again).toBe(InboundOutcomes.DUPLICATE)
      expect((await threadOf(ctx.storeA.id, from)).messages).toHaveLength(1)
    })

    it('is not stored again when it is the message the platform sent', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(connectionId, from, 'in-6'))
      const { conversation } = await threadOf(ctx.storeA.id, from)
      await owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId: conversation.id,
          type: MessageType.TEXT,
          content: 'sent by an agent',
          authorType: AuthorType.AGENT,
          deliveryStatus: DeliveryStatus.SENT,
          channelMessageId: 'ours-6'
        }
      })

      const outcome = await echo(connectionId, from, 'ours-6', 'sent by an agent')

      expect(outcome).toBe(InboundOutcomes.DUPLICATE)
      expect((await threadOf(ctx.storeA.id, from)).messages).toHaveLength(2)
      // Its files were queued when the platform sent it, not fetched again as the owner's
      const heavy = queueOf(app, QueueNames.HEAVY_PROCESSING)
      expect(heavy.jobs.filter(job => job.name === JobNames.FETCH_INBOUND_MEDIA)).toEqual([])
    })

    it('waits for the provider id of a reply that was just queued, and stores it on the last try', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(connectionId, from, 'in-7'))
      const { conversation } = await threadOf(ctx.storeA.id, from)
      await owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId: conversation.id,
          type: MessageType.TEXT,
          content: 'queued',
          authorType: AuthorType.AGENT,
          deliveryStatus: DeliveryStatus.QUEUED
        }
      })

      await expect(echo(connectionId, from, 'maybe-ours', 'x', false)).rejects.toThrow(
        'provider id'
      )
      expect((await threadOf(ctx.storeA.id, from)).messages).toHaveLength(2)
      await echo(connectionId, from, 'maybe-ours', 'x', true)
      expect((await threadOf(ctx.storeA.id, from)).messages).toHaveLength(3)
    })

    it('sends the files of the owner to be fetched, as the media of that message', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()
      const heavy = queueOf(app, QueueNames.HEAVY_PROCESSING)
      heavy.jobs.length = 0
      const incoming = message(connectionId, from, 'out-8')
      incoming.message.type = MessageType.IMAGE
      incoming.message.media = [{ ref: 'ref-8', contentType: 'image/png', filename: null }]

      await inbound.handleMessageEcho(TEST_CHANNEL_ID, incoming, true)

      const { messages } = await threadOf(ctx.storeA.id, from)
      expect(heavy.jobs).toMatchObject([
        {
          name: JobNames.FETCH_INBOUND_MEDIA,
          data: { messageId: messages[0]?.id, mediaRef: 'ref-8' }
        }
      ])
    })

    it('does not wait for a reply queued to another customer', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const other = handleOf()
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(connectionId, other, 'in-o'))
      const { conversation } = await threadOf(ctx.storeA.id, other)
      await owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId: conversation.id,
          type: MessageType.TEXT,
          content: 'queued for someone else',
          authorType: AuthorType.AGENT,
          deliveryStatus: DeliveryStatus.QUEUED
        }
      })

      const outcome = await echo(connectionId, handleOf(), 'unrelated', 'x', false)

      expect(outcome).toBe(InboundOutcomes.STORED)
    })

    it('does not fetch the files of an echo again once they are attached', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()
      const incoming = message(connectionId, from, 'out-10')
      incoming.message.type = MessageType.IMAGE
      incoming.message.media = [{ ref: 'ref-10', contentType: 'image/png', filename: null }]
      await inbound.handleMessageEcho(TEST_CHANNEL_ID, incoming, true)
      const { messages } = await threadOf(ctx.storeA.id, from)
      await owner.media.create({
        data: {
          storeId: ctx.storeA.id,
          purpose: 'message',
          messageId: messages[0]?.id ?? '',
          key: `${prefix}-key-10`,
          filename: 'a.png',
          contentType: 'image/png',
          fileSize: 1
        }
      })
      const heavy = queueOf(app, QueueNames.HEAVY_PROCESSING)
      heavy.jobs.length = 0

      await inbound.handleMessageEcho(TEST_CHANNEL_ID, incoming, true)

      expect(heavy.jobs).toEqual([])
    })

    it('is dropped for a connection nobody has', async () => {
      const outcome = await echo('no-such-connection', handleOf(), 'out-9')

      expect(outcome).toBe(InboundOutcomes.UNKNOWN_CONNECTION)
    })
  })

  describe('a reaction', () => {
    const react = (
      connectionId: string,
      from: string,
      targetExternalId: string,
      emoji: string | null,
      by?: (typeof ReactionActors)[keyof typeof ReactionActors],
      isLastAttempt = true
    ) =>
      reactions.handleInbound(
        TEST_CHANNEL_ID,
        {
          connectionId,
          channelIdentity: from,
          reaction: { targetExternalId, emoji, ...(by === undefined ? {} : { from: by }) }
        },
        isLastAttempt
      )
    const reactionsOn = (storeId: string, externalId: string) =>
      owner.messageReaction.findMany({
        where: { storeId, message: { channelMessageId: externalId } }
      })

    it('is kept for the customer who left it, and does not count as unread', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(connectionId, from, 'r-1'))
      const before = (await threadOf(ctx.storeA.id, from)).conversation

      const outcome = await react(connectionId, from, 'r-1', '👍')

      expect(outcome).toBe(ReactionOutcomes.APPLIED)
      const identity = await owner.customerIdentity.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, channelIdentity: from }
      })
      expect(await reactionsOn(ctx.storeA.id, 'r-1')).toMatchObject([
        {
          emoji: '👍',
          authorType: AuthorType.CUSTOMER,
          customerIdentityId: identity.id,
          userId: null
        }
      ])
      const after = (await threadOf(ctx.storeA.id, from)).conversation
      expect(after.unreadCount).toBe(before.unreadCount)
      expect(after.status).toBe(before.status)
      expect(after.lastMessageAt).toEqual(before.lastMessageAt)
      expect(await owner.message.count({ where: { conversationId: after.id } })).toBe(1)
    })

    it('waits for a message that is not stored yet, and is dropped on the last attempt', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(connectionId, from, 'r-0'))

      await expect(react(connectionId, from, 'late', '👍', undefined, false)).rejects.toThrow(
        'before the message'
      )
      expect(await react(connectionId, from, 'late', '👍')).toBe(ReactionOutcomes.IGNORED)
    })

    it('does not announce a reaction that changes nothing', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(connectionId, from, 'r-00'))
      const published: unknown[] = []
      const events = app.get(DomainEvents, { strict: false })
      const spy = jest.spyOn(events, 'publish').mockImplementation((_tx, name) => {
        published.push(name)
      })
      try {
        await react(connectionId, from, 'r-00', '👍')
        await react(connectionId, from, 'r-00', '👍')
        await react(connectionId, from, 'r-00', null)
        await react(connectionId, from, 'r-00', null)
      } finally {
        spy.mockRestore()
      }
      expect(published).toEqual([Events.MESSAGE_REACTION, Events.MESSAGE_REACTION])
    })

    it('never writes a reaction on a message of another store', async () => {
      const connectionId = await connectionOf(ctx.storeB.id)
      const from = handleOf()
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(connectionId, from, 'b-msg'))
      const target = await owner.message.findFirstOrThrow({
        where: { storeId: ctx.storeB.id, channelMessageId: 'b-msg' }
      })

      await prisma.transaction(tx =>
        reactions.set(tx, ctx.storeA.id, target.id, { authorType: AuthorType.EXTERNAL }, '👍')
      )

      expect(await owner.messageReaction.count({ where: { messageId: target.id } })).toBe(0)
    })

    it('is replaced by a new emoji of the same customer, and removed by an empty one', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(connectionId, from, 'r-2'))

      await react(connectionId, from, 'r-2', '👍')
      await react(connectionId, from, 'r-2', '❤️')
      expect((await reactionsOn(ctx.storeA.id, 'r-2')).map(row => row.emoji)).toEqual(['❤️'])

      await react(connectionId, from, 'r-2', null)
      expect(await reactionsOn(ctx.storeA.id, 'r-2')).toEqual([])
      // Taking back what is not there is not an error
      expect(await react(connectionId, from, 'r-2', null)).toBe(ReactionOutcomes.APPLIED)
    })

    it('is one for the owner of the provider app, apart from the customer one', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(connectionId, from, 'r-3'))

      await react(connectionId, from, 'r-3', '👍')
      await react(connectionId, from, 'r-3', '🙏', ReactionActors.EXTERNAL)
      await react(connectionId, from, 'r-3', '🔥', ReactionActors.EXTERNAL)

      const rows = await reactionsOn(ctx.storeA.id, 'r-3')
      expect(rows.map(row => [row.authorType, row.emoji]).sort()).toEqual([
        [AuthorType.CUSTOMER, '👍'],
        [AuthorType.EXTERNAL, '🔥']
      ])
    })

    it('can be left on a message the platform or the owner sent', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()
      await echo(connectionId, from, 'r-4')

      expect(await react(connectionId, from, 'r-4', '👍')).toBe(ReactionOutcomes.APPLIED)
    })

    it('is ignored when the customer or the message is not known', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(connectionId, from, 'r-5'))
      const customers = await owner.customer.count({ where: { storeId: ctx.storeA.id } })

      expect(await react(connectionId, handleOf(), 'r-5', '👍')).toBe(ReactionOutcomes.IGNORED)
      await expect(react(connectionId, handleOf(), 'r-5', '👍', undefined, false)).rejects.toThrow(
        'before the customer'
      )
      expect(await react(connectionId, from, 'nothing-here', '👍')).toBe(ReactionOutcomes.IGNORED)
      expect(await react('no-such-connection', from, 'r-5', '👍')).toBe(ReactionOutcomes.IGNORED)

      expect(await reactionsOn(ctx.storeA.id, 'r-5')).toEqual([])
      // It never makes a customer
      expect(await owner.customer.count({ where: { storeId: ctx.storeA.id } })).toBe(customers)
    })

    it('never reaches a message of another store that has the same provider id and handle', async () => {
      const from = handleOf()
      const inA = await connectionOf(ctx.storeA.id)
      const inB = await connectionOf(ctx.storeB.id)
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(inA, from, 'same-id'))
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(inB, from, 'same-id'))

      await react(inB, from, 'same-id', '👍')

      expect(await reactionsOn(ctx.storeA.id, 'same-id')).toEqual([])
      expect(await reactionsOn(ctx.storeB.id, 'same-id')).toHaveLength(1)
    })

    it('does not cross to a message of the same handle on another connection of the store', async () => {
      const from = handleOf()
      const first = await connectionOf(ctx.storeA.id)
      const second = await connectionOf(ctx.storeA.id)
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(first, from, 'conn-id'))

      expect(await react(second, from, 'conn-id', '👍')).toBe(ReactionOutcomes.IGNORED)
    })

    it('is removed with its message and returned with it in the thread', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const from = handleOf()
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(connectionId, from, 'r-6'))
      await react(connectionId, from, 'r-6', '👍')
      await react(connectionId, from, 'r-6', '🙏', ReactionActors.EXTERNAL)
      const { conversation, messages } = await threadOf(ctx.storeA.id, from)
      const identity = await owner.customerIdentity.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, channelIdentity: from }
      })

      const response = await api(app, ctx.agentA, ctx.storeA).get(
        ApiRoutes.conversations.messages(conversation.id)
      )

      expect(response.status).toBe(OK)
      const thread = response.body as ThreadBody
      expect(thread.data.find(item => item.id === messages[0]?.id)?.reactions).toEqual([
        {
          emoji: '👍',
          authorType: AuthorType.CUSTOMER,
          authorId: identity.id,
          deliveryStatus: DeliveryStatus.SENT,
          deliveryError: null
        },
        {
          emoji: '🙏',
          authorType: AuthorType.EXTERNAL,
          authorId: null,
          deliveryStatus: DeliveryStatus.SENT,
          deliveryError: null
        }
      ])
      const other = await api(app, ctx.adminB, ctx.storeB).get(
        ApiRoutes.conversations.messages(conversation.id)
      )
      expect(other.status).toBe(NOT_FOUND)
      expect(JSON.stringify(other.body)).not.toContain('👍')
      await owner.message.delete({ where: { id: messages[0]?.id ?? '' } })
      expect(await owner.messageReaction.count({ where: { messageId: messages[0]?.id } })).toBe(0)
    })
  })
})
