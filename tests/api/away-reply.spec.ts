import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { AuthorType, ConversationStatus, DeliveryStatus, MessageType } from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import {
  AWAY_REPLY_METADATA,
  AwayReplyService,
  ChannelConnectionResolver,
  ConversationsService,
  CustomerIdentityService,
  InboundMessageService,
  type InboundEvent,
  MessagingWindowService,
  OutboundQueue,
  RoutingService
} from '@platform/core/messaging'
import { JobNames, QueueNames } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'

import {
  buildChannelPlugin,
  createConversation,
  createCustomerIdentity,
  createSnippet,
  ensurePluginInstallation,
  TEST_CHANNEL_ID
} from '../builders'
import { BUSINESS_HOURS_TIMEZONE } from '../builders/store-settings'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { CapturedQueue, queueOf } from '../helpers/queue'

// El Salvador is UTC-6 all year. The store opens Monday to Friday, 09:00 to 18:00.
const WEEK = {
  mon: [{ from: '09:00', to: '18:00' }],
  tue: [{ from: '09:00', to: '18:00' }],
  wed: [{ from: '09:00', to: '18:00' }],
  thu: [{ from: '09:00', to: '18:00' }],
  fri: [{ from: '09:00', to: '18:00' }],
  sat: [],
  sun: []
}
const SATURDAY_NOON = new Date('2026-10-24T18:00:00.000Z')
const SATURDAY_AFTERNOON = new Date('2026-10-24T21:00:00.000Z')
const MONDAY_BEFORE_OPENING = new Date('2026-10-26T14:00:00.000Z') // 08:00
const TUESDAY_BEFORE_OPENING = new Date('2026-10-27T14:00:00.000Z') // 08:00
const WEDNESDAY_NOON = new Date('2026-10-28T18:00:00.000Z')
const AWAY_TEXT = 'We are closed now. We will answer when we open.'

describe('The reply of a store that is closed', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let service: InboundMessageService
  let handle = 0

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], builder =>
      builder
        .overrideProvider(getQueueToken(QueueNames.INBOUND))
        .useValue(new CapturedQueue())
        .overrideProvider(getQueueToken(QueueNames.HEAVY_PROCESSING))
        .useValue(new CapturedQueue())
        .overrideProvider(getQueueToken(QueueNames.OUTBOUND))
        .useValue(new CapturedQueue())
    )
    ctx = await seedTestContext(owner, app, prefix)
    app.get(PluginRegistry, { strict: false }).register(buildChannelPlugin())
    const prisma = app.get(PrismaService, { strict: false })
    const events = app.get(DomainEvents, { strict: false })
    const conversations = app.get(ConversationsService, { strict: false })
    service = new InboundMessageService(
      prisma,
      new ChannelConnectionResolver(prisma),
      app.get(CustomerIdentityService, { strict: false }),
      conversations,
      app.get(RoutingService, { strict: false }),
      new AwayReplyService(
        prisma,
        conversations,
        app.get(MessagingWindowService, { strict: false }),
        events,
        app.get(OutboundQueue, { strict: false }),
        await app.resolve(PinoLogger)
      ),
      events,
      queueOf(app, QueueNames.HEAVY_PROCESSING) as never,
      await app.resolve(PinoLogger)
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const storeId = () => ctx.storeB.id
  const outbound = () => queueOf(app, QueueNames.OUTBOUND).jobs
  let snippetId: string

  beforeEach(async () => {
    outbound().length = 0
    const snippet = await createSnippet(owner, { storeId: storeId() })
    await owner.snippet.update({ where: { id: snippet.id }, data: { content: AWAY_TEXT } })
    snippetId = snippet.id
    await owner.businessHours.upsert({
      where: { storeId: storeId() },
      create: {
        storeId: storeId(),
        timezone: BUSINESS_HOURS_TIMEZONE,
        schedule: WEEK,
        awayMessageSnippetId: snippetId
      },
      update: {
        timezone: BUSINESS_HOURS_TIMEZONE,
        schedule: WEEK,
        awayMessageSnippetId: snippetId
      }
    })
  })
  afterEach(async () => {
    await owner.businessHours.deleteMany({ where: { storeId: storeId() } })
    await owner.message.deleteMany({ where: { storeId: storeId() } })
    await owner.conversation.deleteMany({ where: { storeId: storeId() } })
  })

  const connectionOf = async (): Promise<string> => {
    const connectionId = `${prefix}-away-${(handle += 1)}`
    const installation = await ensurePluginInstallation(owner, {
      storeId: storeId(),
      pluginId: TEST_CHANNEL_ID
    })
    await owner.channelConnection.create({
      data: {
        storeId: storeId(),
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
  const writes = (
    connectionId: string,
    from: string,
    at: Date,
    clock: Date = at
  ): Promise<unknown> => {
    const incoming: InboundEvent = {
      connectionId,
      channelIdentity: from,
      message: {
        externalId: `ext-${(handle += 1)}`,
        type: MessageType.TEXT,
        content: 'hello?',
        timestamp: at.toISOString()
      }
    }
    // The messaging window reads the clock: only the date is moved, to the moment of the message
    jest.useFakeTimers({
      now: clock,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout'
      ]
    })
    return service
      .handleMessageReceived(TEST_CHANNEL_ID, incoming, at)
      .finally(() => jest.useRealTimers())
  }
  const handleOf = () => `50371${String((handle += 1)).padStart(6, '0')}`
  const awayRepliesOf = (conversationId?: string) =>
    owner.message.findMany({
      where: {
        storeId: storeId(),
        ...(conversationId === undefined ? {} : { conversationId }),
        authorType: AuthorType.SYSTEM
      },
      orderBy: { createdAt: 'asc' }
    })
  const conversationOf = (connectionId: string) =>
    owner.conversation.findFirstOrThrow({
      where: { storeId: storeId(), channelConnection: { connectionId } }
    })

  it('answers a customer who writes while it is closed, with the saved reply, once', async () => {
    const connectionId = await connectionOf()
    const from = handleOf()

    await writes(connectionId, from, SATURDAY_NOON)
    await writes(connectionId, from, SATURDAY_AFTERNOON)

    const conversation = await conversationOf(connectionId)
    const replies = await awayRepliesOf(conversation.id)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatchObject({
      type: MessageType.TEXT,
      content: AWAY_TEXT,
      authorId: null,
      deliveryStatus: DeliveryStatus.QUEUED,
      metadata: AWAY_REPLY_METADATA
    })
    expect(outbound()).toHaveLength(1)
    expect(outbound()[0]).toMatchObject({
      name: JobNames.SEND_OUTBOUND_MESSAGE,
      data: { storeId: storeId(), messageId: replies[0]?.id }
    })
  })

  it('is not an answer of the team: the first response, the last outbound date and the status stay', async () => {
    const connectionId = await connectionOf()

    await writes(connectionId, handleOf(), SATURDAY_NOON)

    const conversation = await conversationOf(connectionId)
    expect(conversation.firstResponseAt).toBeNull()
    expect(conversation.lastOutboundAt).toBeNull()
    expect(conversation.status).toBe(ConversationStatus.OPEN)
    expect(conversation.unreadCount).toBe(1)
  })

  it('says nothing while the store is open', async () => {
    const connectionId = await connectionOf()

    await writes(connectionId, handleOf(), WEDNESDAY_NOON)

    expect(await awayRepliesOf()).toEqual([])
    expect(outbound()).toEqual([])
  })

  it('says nothing to a message that arrives late, once the store is open again', async () => {
    const connectionId = await connectionOf()

    // Written on Saturday, delivered by a retry on Wednesday at noon
    await writes(connectionId, handleOf(), SATURDAY_NOON, WEDNESDAY_NOON)

    expect(await awayRepliesOf()).toEqual([])
    expect(outbound()).toEqual([])
  })

  it('says nothing when the hours name a time zone that cannot be read, and stores the message', async () => {
    const connectionId = await connectionOf()
    await owner.businessHours.update({
      where: { storeId: storeId() },
      data: { timezone: 'Not/AZone' }
    })

    await writes(connectionId, handleOf(), SATURDAY_NOON)

    const conversation = await conversationOf(connectionId)
    expect(await owner.message.count({ where: { conversationId: conversation.id } })).toBe(1)
    expect(await awayRepliesOf()).toEqual([])
  })

  it('says nothing when the store has no hours, or no reply chosen', async () => {
    const connectionId = await connectionOf()
    await owner.businessHours.update({
      where: { storeId: storeId() },
      data: { awayMessageSnippetId: null }
    })
    await writes(connectionId, handleOf(), SATURDAY_NOON)
    await owner.businessHours.delete({ where: { storeId: storeId() } })
    await writes(connectionId, handleOf(), SATURDAY_NOON)

    expect(await awayRepliesOf()).toEqual([])
    expect(outbound()).toEqual([])
  })

  it('answers again in the next closed stretch, not in the same one', async () => {
    const connectionId = await connectionOf()
    const from = handleOf()
    await writes(connectionId, from, SATURDAY_NOON)
    // The reply is as old as the message that set it off, as it is outside this test
    await owner.message.updateMany({
      where: { storeId: storeId(), authorType: AuthorType.SYSTEM },
      data: { createdAt: SATURDAY_NOON }
    })

    await writes(connectionId, from, MONDAY_BEFORE_OPENING)
    expect(await awayRepliesOf()).toHaveLength(1)

    await writes(connectionId, from, WEDNESDAY_NOON)
    await writes(connectionId, from, TUESDAY_BEFORE_OPENING)
    // Tuesday 08:00 comes after Monday and Tuesday were open: a new stretch
    expect(await awayRepliesOf()).toHaveLength(2)
  })

  it('does not answer a conversation that the team or the owner already answered in the stretch', async () => {
    const connectionId = await connectionOf()
    const from = handleOf()
    await writes(connectionId, from, SATURDAY_NOON)
    const conversation = await conversationOf(connectionId)
    await owner.message.deleteMany({
      where: { conversationId: conversation.id, authorType: AuthorType.SYSTEM }
    })
    await owner.message.create({
      data: {
        storeId: storeId(),
        conversationId: conversation.id,
        type: MessageType.TEXT,
        content: 'I am here',
        authorType: AuthorType.EXTERNAL,
        createdAt: SATURDAY_NOON
      }
    })
    outbound().length = 0

    await writes(connectionId, from, SATURDAY_AFTERNOON)

    expect(await awayRepliesOf(conversation.id)).toEqual([])
    expect(outbound()).toEqual([])
  })

  it('answers a conversation whose only reply of the team was thrown away: it never reached the customer', async () => {
    const connectionId = await connectionOf()
    const from = handleOf()
    await writes(connectionId, from, SATURDAY_NOON)
    const conversation = await conversationOf(connectionId)
    await owner.message.deleteMany({
      where: { conversationId: conversation.id, authorType: AuthorType.SYSTEM }
    })
    await owner.message.create({
      data: {
        storeId: storeId(),
        conversationId: conversation.id,
        type: MessageType.TEXT,
        content: 'a reply that never went',
        authorType: AuthorType.AGENT,
        createdAt: SATURDAY_NOON,
        discardedAt: SATURDAY_NOON,
        deletedAt: SATURDAY_NOON
      }
    })
    outbound().length = 0

    await writes(connectionId, from, SATURDAY_AFTERNOON)

    expect(await awayRepliesOf(conversation.id)).toHaveLength(1)
  })

  it('does not answer a conversation that is spam', async () => {
    const connectionId = await connectionOf()
    const from = handleOf()
    const connection = await owner.channelConnection.findFirstOrThrow({ where: { connectionId } })
    const identity = await createCustomerIdentity(owner, {
      storeId: storeId(),
      channelType: TEST_CHANNEL_ID,
      handle: from
    })
    const spam = await createConversation(owner, {
      storeId: storeId(),
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType: TEST_CHANNEL_ID,
      channelConnectionId: connection.id,
      status: ConversationStatus.SPAM,
      lastMessageAt: SATURDAY_NOON
    })

    await writes(connectionId, from, SATURDAY_AFTERNOON)

    expect((await owner.conversation.findUniqueOrThrow({ where: { id: spam.id } })).status).toBe(
      ConversationStatus.SPAM
    )
    expect(await awayRepliesOf()).toEqual([])
    expect(outbound()).toEqual([])
  })

  it('does not fail the message that set it off when the reply cannot be stored', async () => {
    const connectionId = await connectionOf()
    // A reply that points at a saved reply that is gone: the pointer has no foreign key
    await owner.businessHours.update({
      where: { storeId: storeId() },
      data: { awayMessageSnippetId: '00000000-0000-4000-8000-000000000000' }
    })

    await writes(connectionId, handleOf(), SATURDAY_NOON)

    const conversation = await conversationOf(connectionId)
    expect(await owner.message.count({ where: { conversationId: conversation.id } })).toBe(1)
    expect(await awayRepliesOf()).toEqual([])
  })
})
