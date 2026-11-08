import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { MessageType } from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import {
  AwayReplyService,
  ChannelConnectionResolver,
  ConversationsService,
  CustomerIdentityService,
  InboundMessageService,
  type InboundEvent,
  InboundMessageTargets,
  ReactionOutcomes,
  MessageReactionsService,
  MessagingWindowService,
  OutboundQueue,
  RoutingService
} from '@platform/core/messaging'
import { QueueNames } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'

import { buildChannelPlugin, ensurePluginInstallation, TEST_CHANNEL_ID } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { CapturedQueue, queueOf } from '../helpers/queue'

describe('Several pictures that a customer sends in a row', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let inbound: InboundMessageService
  let reactions: MessageReactionsService
  let prisma: PrismaService
  let handle = 0

  const warn = jest.fn<void, [Record<string, unknown>, string]>()
  const info = jest.fn<void, [Record<string, unknown>, string]>()
  let logger: PinoLogger

  beforeAll(async () => {
    logger = {
      setContext: jest.fn(),
      warn,
      info,
      debug: jest.fn(),
      error: jest.fn()
    } as unknown as PinoLogger
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
    prisma = app.get(PrismaService, { strict: false })
    const connections = new ChannelConnectionResolver(prisma)
    const events = app.get(DomainEvents, { strict: false })
    inbound = new InboundMessageService(
      prisma,
      connections,
      app.get(CustomerIdentityService, { strict: false }),
      app.get(ConversationsService, { strict: false }),
      app.get(RoutingService, { strict: false }),
      new AwayReplyService(
        prisma,
        app.get(ConversationsService, { strict: false }),
        app.get(MessagingWindowService, { strict: false }),
        events,
        app.get(OutboundQueue, { strict: false }),
        logger
      ),
      events,
      queueOf(app, QueueNames.HEAVY_PROCESSING) as never,
      logger
    )
    reactions = new MessageReactionsService(
      prisma,
      new InboundMessageTargets(prisma, connections),
      events,
      logger
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  beforeEach(() => {
    warn.mockClear()
    info.mockClear()
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

  const picture = (
    connectionId: string,
    from: string,
    id: string,
    files = 1,
    replyTo?: string
  ): InboundEvent => ({
    connectionId,
    channelIdentity: from,
    message: {
      externalId: id,
      type: MessageType.IMAGE,
      content: null,
      timestamp: new Date().toISOString(),
      ...(replyTo === undefined ? {} : { replyToExternalId: replyTo }),
      media: Array.from({ length: files }, (_, n) => ({
        ref: `https://scontent.cdninstagram.com/v/${id}-${n}.jpg`,
        contentType: 'application/octet-stream',
        filename: null
      }))
    }
  })
  // The shape a log line of the last call carried
  const targetOf = (log: typeof warn): Record<string, unknown> | undefined =>
    (log.mock.calls.at(-1)?.[0] as { target?: Record<string, unknown> } | undefined)?.target
  const quoting = (
    connectionId: string,
    from: string,
    id: string,
    target: string
  ): InboundEvent => {
    const base = message(connectionId, from, id, 'about that one')
    return { ...base, message: { ...base.message, replyToExternalId: target } }
  }
  const react = (connectionId: string, from: string, target: string, emoji: string | null) =>
    reactions.handleInbound(
      TEST_CHANNEL_ID,
      { connectionId, channelIdentity: from, reaction: { targetExternalId: target, emoji } },
      true
    )

  it('keeps the reaction to each picture sent as a message of its own (WhatsApp)', async () => {
    const connectionId = await connectionOf(ctx.storeA.id)
    const from = handleOf()
    for (const id of ['p1', 'p2', 'p3']) {
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, picture(connectionId, from, id))
    }
    await react(connectionId, from, 'p2', '👍')
    await react(connectionId, from, 'p3', '❤️')
    const { messages } = await threadOf(ctx.storeA.id, from)
    expect(messages.map(m => m.channelMessageId).sort()).toEqual(['p1', 'p2', 'p3'])
    const rows = await owner.messageReaction.findMany({
      where: { storeId: ctx.storeA.id, message: { channelMessageId: { in: ['p1', 'p2', 'p3'] } } },
      include: { message: { select: { channelMessageId: true } } }
    })
    expect(rows.map(r => `${r.message.channelMessageId}:${r.emoji}`).sort()).toEqual([
      'p2:👍',
      'p3:❤️'
    ])
  })

  it('links the quote of the second and third picture', async () => {
    const connectionId = await connectionOf(ctx.storeA.id)
    const from = handleOf()
    for (const id of ['q1', 'q2', 'q3']) {
      await inbound.handleMessageReceived(TEST_CHANNEL_ID, picture(connectionId, from, id))
    }
    await inbound.handleMessageReceived(TEST_CHANNEL_ID, quoting(connectionId, from, 'q4', 'q3'))
    const { messages } = await threadOf(ctx.storeA.id, from)
    const third = messages.find(m => m.channelMessageId === 'q3')
    expect(messages.find(m => m.channelMessageId === 'q4')?.replyToMessageId).toBe(third?.id)
  })

  it('keeps the reaction to a message with three pictures, by its one id (Messenger, Instagram)', async () => {
    const connectionId = await connectionOf(ctx.storeA.id)
    const from = handleOf()
    await inbound.handleMessageReceived(TEST_CHANNEL_ID, picture(connectionId, from, 'album', 3))
    await react(connectionId, from, 'album', '👍')
    const rows = await owner.messageReaction.findMany({
      where: { storeId: ctx.storeA.id, message: { channelMessageId: 'album' } }
    })
    expect(rows).toHaveLength(1)
  })

  it('says it, with the channel only, when a quote points at a message that is not here', async () => {
    const connectionId = await connectionOf(ctx.storeA.id)
    const from = handleOf()
    await inbound.handleMessageReceived(TEST_CHANNEL_ID, quoting(connectionId, from, 'z1', 'gone'))
    // The shape of the id, not the id
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]?.[1]).toBe('an inbound message quotes a message that is not here')
    // The quoting message is stored by now, so it is the one recent message
    expect(targetOf(info)).toMatchObject({ length: 4, prefix: 'gon', recentCustomerMessages: 1 })
    expect(JSON.stringify(info.mock.calls)).not.toContain('"gone"')
    const { messages } = await threadOf(ctx.storeA.id, from)
    expect(messages[0]?.replyToMessageId).toBeNull()
  })

  it('says it too for the message of the owner that comes back as an echo, with the shape only', async () => {
    const connectionId = await connectionOf(ctx.storeA.id)
    const from = handleOf()
    await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(connectionId, from, 'e0'))
    info.mockClear()

    await inbound.handleMessageEcho(
      TEST_CHANNEL_ID,
      quoting(connectionId, from, 'e1', 'gone-too'),
      false
    )

    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0]?.[1]).toBe('an inbound message quotes a message that is not here')
    expect(targetOf(info)).toMatchObject({ length: 8, prefix: 'gon' })
    expect(JSON.stringify(info.mock.calls)).not.toContain('gone-too')
  })

  it('does not say it when the quote is found', async () => {
    const connectionId = await connectionOf(ctx.storeA.id)
    const from = handleOf()
    await inbound.handleMessageReceived(TEST_CHANNEL_ID, picture(connectionId, from, 'y1'))
    await inbound.handleMessageReceived(TEST_CHANNEL_ID, quoting(connectionId, from, 'y2', 'y1'))
    expect(info).not.toHaveBeenCalled()
  })

  it('ignores, and says it, a reaction to a message that is not here', async () => {
    const connectionId = await connectionOf(ctx.storeA.id)
    const from = handleOf()
    await inbound.handleMessageReceived(TEST_CHANNEL_ID, picture(connectionId, from, 'x1'))
    await expect(react(connectionId, from, 'gone', '👍')).resolves.toBe(ReactionOutcomes.IGNORED)
    // x1 is a picture of the thread, so a target that starts like it is counted; the id itself never leaves
    expect(warn).toHaveBeenCalledWith(
      {
        pluginId: TEST_CHANNEL_ID,
        target: {
          length: 4,
          prefix: 'gon',
          sameShortPrefix: 0,
          sameLongPrefix: 0,
          recentCustomerMessages: 1
        }
      },
      'reaction not applied: no message, customer or connection to attach it to'
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain('"gone"')
  })

  it('counts the prefix `m_` literally: the underscore is no wildcard', async () => {
    const connectionId = await connectionOf(ctx.storeA.id)
    const from = handleOf()
    await inbound.handleMessageReceived(
      TEST_CHANNEL_ID,
      picture(connectionId, from, 'mXabcdefghij')
    )
    await inbound.handleMessageReceived(
      TEST_CHANNEL_ID,
      picture(connectionId, from, 'm_abcdefghij')
    )
    await react(connectionId, from, 'm_zzzzzzzzzz', '👍')
    expect(targetOf(warn)).toMatchObject({ prefix: 'm_z', sameShortPrefix: 0, sameLongPrefix: 0 })
    // `m_a` is on one stored id only, not on `mX…`
    warn.mockClear()
    await react(connectionId, from, 'm_abcdefghXX', '👍')
    expect(targetOf(warn)).toMatchObject({ sameShortPrefix: 1, sameLongPrefix: 1 })
  })
})
