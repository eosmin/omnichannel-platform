import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { AuthorType, DeliveryStatus, MessageType, ReactionActors } from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import {
  AwayReplyService,
  ChannelConnectionResolver,
  ConversationsService,
  CustomerIdentityService,
  InboundMessageService,
  type InboundEvent,
  InboundMessageChangesService,
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
import { api } from '../helpers/http'
import { TEST_IDENTITY_KINDS } from '../helpers/identity-kinds'
import { CapturedQueue, queueOf } from '../helpers/queue'

describe('A reaction or a quote that points at a message the platform sent', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let inbound: InboundMessageService
  let reactions: MessageReactionsService
  let changes: InboundMessageChangesService
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
    const targets = new InboundMessageTargets(prisma, connections, TEST_IDENTITY_KINDS)
    reactions = new MessageReactionsService(prisma, targets, events, logger)
    changes = new InboundMessageChangesService(prisma, targets, events)
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

  // An agent's message as the worker leaves it: the id of the message is the first file's, the other files
  // of an album carry their own on their row, and Instagram or Messenger keep the id of the caption apart.
  const sentByAgent = async (
    storeId: string,
    from: string,
    ids: { message: string | null; files?: string[]; caption?: string }
  ) => {
    const conversation = await owner.conversation.findFirstOrThrow({
      where: { storeId, customerIdentity: { channelIdentity: from } }
    })
    const created = await owner.message.create({
      data: {
        storeId,
        conversationId: conversation.id,
        type: ids.files === undefined ? MessageType.TEXT : MessageType.IMAGE,
        content: 'from the team',
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id,
        deliveryStatus: DeliveryStatus.SENT,
        channelMessageId: ids.message,
        captionChannelMessageId: ids.caption ?? null
      }
    })
    for (const [position, id] of (ids.files ?? []).entries()) {
      await owner.media.create({
        data: {
          storeId,
          purpose: 'message',
          messageId: created.id,
          key: `${prefix}-key-${created.id}-${position}`,
          filename: `f${position}.jpg`,
          contentType: 'image/jpeg',
          fileSize: 10,
          position,
          deliveryStatus: DeliveryStatus.SENT,
          channelMessageId: id
        }
      })
    }
    return created
  }
  const reactionOf = (messageId: string) => owner.messageReaction.findMany({ where: { messageId } })

  const seeded = async () => {
    const connectionId = await connectionOf(ctx.storeA.id)
    const from = handleOf()
    await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(connectionId, from, 'c1'))
    return { connectionId, from }
  }

  it('applies the reaction to a text the agent sent', async () => {
    const { connectionId, from } = await seeded()
    const sent = await sentByAgent(ctx.storeA.id, from, { message: 'out-text' })
    await expect(react(connectionId, from, 'out-text', '👍')).resolves.toBe(
      ReactionOutcomes.APPLIED
    )
    expect(await reactionOf(sent.id)).toHaveLength(1)
  })

  it.each(['out-f1', 'out-f2', 'out-f3'])(
    'applies the reaction to file %s of an album the agent sent, on the message',
    async fileId => {
      const { connectionId, from } = await seeded()
      const sent = await sentByAgent(ctx.storeA.id, from, {
        message: 'out-f1',
        files: ['out-f1', 'out-f2', 'out-f3']
      })
      await expect(react(connectionId, from, fileId, '❤️')).resolves.toBe(ReactionOutcomes.APPLIED)
      expect(await reactionOf(sent.id)).toHaveLength(1)
    }
  )

  it('applies the reaction to the caption that went as a message of its own', async () => {
    const { connectionId, from } = await seeded()
    const sent = await sentByAgent(ctx.storeA.id, from, {
      message: 'out-file',
      files: ['out-file'],
      caption: 'out-caption'
    })
    await expect(react(connectionId, from, 'out-caption', '👍')).resolves.toBe(
      ReactionOutcomes.APPLIED
    )
    expect(await reactionOf(sent.id)).toHaveLength(1)
  })

  it('puts the reaction of the customer under the file it names, one for each file', async () => {
    const { connectionId, from } = await seeded()
    const sent = await sentByAgent(ctx.storeA.id, from, {
      message: 'pf-1',
      files: ['pf-1', 'pf-2', 'pf-3']
    })
    const files = await owner.media.findMany({
      where: { messageId: sent.id },
      select: { id: true, channelMessageId: true }
    })
    const idOf = (providerId: string) => files.find(f => f.channelMessageId === providerId)?.id
    // The first file IS the message at the provider (one id): its reaction is the message's
    await react(connectionId, from, 'pf-1', '👍')
    await react(connectionId, from, 'pf-2', '❤️')
    await react(connectionId, from, 'pf-3', '🔥')
    // The same file again replaces its own emoji and leaves the others
    await react(connectionId, from, 'pf-2', '🙏')

    const rows = await reactionOf(sent.id)
    expect(rows.map(r => `${r.mediaId}:${r.emoji}`).sort()).toEqual(
      [`null:👍`, `${idOf('pf-2')}:🙏`, `${idOf('pf-3')}:🔥`].sort()
    )
    // Taking one back leaves the others
    await react(connectionId, from, 'pf-3', null)
    await react(connectionId, from, 'pf-1', null)
    expect((await reactionOf(sent.id)).map(r => r.mediaId)).toEqual([idOf('pf-2')])
  })

  it('keeps the reaction on the message when the files of the album share one id', async () => {
    const { connectionId, from } = await seeded()
    const sent = await sentByAgent(ctx.storeA.id, from, {
      message: 'shared-1',
      files: ['shared-1', 'shared-1', 'shared-1']
    })
    await react(connectionId, from, 'shared-1', '👍')
    await react(connectionId, from, 'shared-1', '❤️')

    expect((await reactionOf(sent.id)).map(r => [r.mediaId, r.emoji])).toEqual([[null, '❤️']])
  })

  it('takes back the reaction under a file even when a later file now shares its id', async () => {
    const { connectionId, from } = await seeded()
    const sent = await sentByAgent(ctx.storeA.id, from, {
      message: 'rm-1',
      files: ['rm-1', 'rm-2', 'rm-3']
    })
    await react(connectionId, from, 'rm-2', '👍')
    await react(connectionId, from, 'rm-1', '❤️')
    expect((await reactionOf(sent.id)).map(r => r.emoji).sort()).toEqual(['❤️', '👍'])
    // The third file now carries the id of the second: the provider can no longer tell them apart
    await owner.media.updateMany({
      where: { messageId: sent.id, channelMessageId: 'rm-3' },
      data: { channelMessageId: 'rm-2' }
    })

    await react(connectionId, from, 'rm-2', null)

    // The reaction under the second file goes, and the one of the message stays
    expect((await reactionOf(sent.id)).map(r => [r.mediaId, r.emoji])).toEqual([[null, '❤️']])
  })

  it('allows one reaction for each person and target, in the database itself', async () => {
    const { connectionId, from } = await seeded()
    const sent = await sentByAgent(ctx.storeA.id, from, {
      message: 'ix-1',
      files: ['ix-1', 'ix-2']
    })
    const second = await owner.media.findFirstOrThrow({
      where: { messageId: sent.id, channelMessageId: 'ix-2' }
    })
    const identity = await owner.customerIdentity.findFirstOrThrow({
      where: { storeId: ctx.storeA.id, channelIdentity: from }
    })
    const row = (mediaId: string | null) =>
      owner.messageReaction.create({
        data: {
          storeId: ctx.storeA.id,
          messageId: sent.id,
          authorType: AuthorType.CUSTOMER,
          customerIdentityId: identity.id,
          emoji: '👍',
          mediaId
        }
      })
    await row(null)
    await row(second.id)
    // A second one for the same target is refused, whether the target is the message (a NULL) or a file
    await expect(row(null)).rejects.toThrow()
    await expect(row(second.id)).rejects.toThrow()
    expect(await reactionOf(sent.id)).toHaveLength(2)
    expect(connectionId).toBeTruthy()
  })

  it('keeps a reaction to the only file of a message, or to its caption, on the message', async () => {
    const { connectionId, from } = await seeded()
    const single = await sentByAgent(ctx.storeA.id, from, {
      message: 'one-f1',
      files: ['one-f1'],
      caption: 'one-cap'
    })
    await react(connectionId, from, 'one-f1', '👍')
    expect((await reactionOf(single.id)).map(r => r.mediaId)).toEqual([null])
    await react(connectionId, from, 'one-cap', '❤️')
    // The caption is the message's: it replaces the emoji of the message, it is no file of its own
    expect((await reactionOf(single.id)).map(r => [r.mediaId, r.emoji])).toEqual([[null, '❤️']])
  })

  it('links the quote of a customer to a file of an album the agent sent', async () => {
    const { connectionId, from } = await seeded()
    const sent = await sentByAgent(ctx.storeA.id, from, {
      message: 'q-f1',
      files: ['q-f1', 'q-f2']
    })
    await inbound.handleMessageReceived(TEST_CHANNEL_ID, quoting(connectionId, from, 'c2', 'q-f2'))
    const { messages } = await threadOf(ctx.storeA.id, from)
    expect(messages.find(m => m.channelMessageId === 'c2')?.replyToMessageId).toBe(sent.id)
    expect(info).not.toHaveBeenCalled()
  })

  it('does not find a file of another connection of the same store, nor of another store', async () => {
    const { connectionId, from } = await seeded()
    const otherConnection = await connectionOf(ctx.storeA.id)
    const otherFrom = handleOf()
    await inbound.handleMessageReceived(TEST_CHANNEL_ID, message(otherConnection, otherFrom, 'd1'))
    const foreign = await sentByAgent(ctx.storeA.id, otherFrom, {
      message: 'x-f1',
      files: ['x-f1', 'x-f2']
    })
    await expect(react(connectionId, from, 'x-f2', '👍')).resolves.toBe(ReactionOutcomes.IGNORED)
    expect(await reactionOf(foreign.id)).toHaveLength(0)

    const connectionB = await connectionOf(ctx.storeB.id)
    await expect(react(connectionB, otherFrom, 'x-f2', '👍')).resolves.toBe(
      ReactionOutcomes.IGNORED
    )
  })

  it('links the quote of a customer to the caption that went as a message of its own', async () => {
    const { connectionId, from } = await seeded()
    const sent = await sentByAgent(ctx.storeA.id, from, {
      message: 'qc-file',
      files: ['qc-file'],
      caption: 'qc-caption'
    })
    await inbound.handleMessageReceived(
      TEST_CHANNEL_ID,
      quoting(connectionId, from, 'c3', 'qc-caption')
    )
    const { messages } = await threadOf(ctx.storeA.id, from)
    expect(messages.find(m => m.channelMessageId === 'c3')?.replyToMessageId).toBe(sent.id)
  })

  it('does not match a file row that belongs to another store, whatever its id', async () => {
    const { connectionId, from } = await seeded()
    const sent = await sentByAgent(ctx.storeA.id, from, { message: 'own-1' })
    await owner.media.create({
      data: {
        storeId: ctx.storeB.id,
        purpose: 'message',
        messageId: sent.id,
        key: `${prefix}-key-foreign-${sent.id}`,
        filename: 'f.jpg',
        contentType: 'image/jpeg',
        fileSize: 10,
        channelMessageId: 'foreign-file'
      }
    })
    await expect(react(connectionId, from, 'foreign-file', '👍')).resolves.toBe(
      ReactionOutcomes.IGNORED
    )
    expect(await reactionOf(sent.id)).toHaveLength(0)
  })

  it('leaves an album whole when the provider deletes ONE of its files', async () => {
    const { connectionId, from } = await seeded()
    const sent = await sentByAgent(ctx.storeA.id, from, {
      message: 'del-f1',
      files: ['del-f1', 'del-f2']
    })
    await changes.handleDeleted(
      TEST_CHANNEL_ID,
      {
        connectionId,
        channelIdentity: from,
        deletion: { targetExternalId: 'del-f2', from: ReactionActors.EXTERNAL }
      },
      true
    )
    const after = await owner.message.findUniqueOrThrow({
      where: { id: sent.id },
      select: { deletedAt: true }
    })
    expect(after.deletedAt).toBeNull()
  })

  it('says, for an id that matches nothing, how many ids of the files share its prefix, never the id', async () => {
    const { connectionId, from } = await seeded()
    await sentByAgent(ctx.storeA.id, from, {
      message: 'wamid.AAAAAAAAAA1',
      files: ['wamid.AAAAAAAAAA1', 'wamid.AAAAAAAAAA2']
    })
    await expect(react(connectionId, from, 'wamid.AAAAAAAAAA3', '👍')).resolves.toBe(
      ReactionOutcomes.IGNORED
    )
    expect((warn.mock.calls.at(-1)?.[0] as { target?: unknown }).target).toMatchObject({
      prefix: 'wam',
      sameShortPrefix: 1,
      sameLongPrefix: 1
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain('AAAAAAAAAA3')
  })

  describe('what the thread says of the files of an album', () => {
    type ThreadItem = {
      id: string
      media: { id: string; targetable: boolean }[]
      reactions: { fileId: string | null; mediaId: string | null }[]
      replyTo: { file: { mediaId: string; position: number } | null } | null
      replyToMediaId: string | null
    }
    const threadItems = async (from: string): Promise<ThreadItem[]> => {
      const conversation = await owner.conversation.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, customerIdentity: { channelIdentity: from } }
      })
      const response = await api(app, ctx.agentA, ctx.storeA).get(
        ApiRoutes.conversations.messages(conversation.id)
      )
      return (response.body as { data: ThreadItem[] }).data
    }

    it('says each file of a message with one message at the provider for each is targetable, and puts the reaction of the first under it', async () => {
      const { connectionId, from } = await seeded()
      const sent = await sentByAgent(ctx.storeA.id, from, {
        message: 'v-1',
        files: ['v-1', 'v-2', 'v-3']
      })
      await react(connectionId, from, 'v-1', '👍')
      await react(connectionId, from, 'v-3', '🔥')

      const item = (await threadItems(from)).find(entry => entry.id === sent.id)
      expect(item?.media.map(file => file.targetable)).toEqual([true, true, true])
      const ids = item?.media.map(file => file.id) ?? []
      expect(item?.reactions.map(r => r.fileId).sort()).toEqual([ids[0], ids[2]].sort())
      expect(JSON.stringify(item)).not.toContain('v-1')
    })

    it("says no file is targetable when the files share one id, and the reaction is the message's", async () => {
      const { connectionId, from } = await seeded()
      const sent = await sentByAgent(ctx.storeA.id, from, {
        message: 'n-1',
        files: ['n-1', 'n-1', 'n-1']
      })
      await react(connectionId, from, 'n-1', '👍')

      const item = (await threadItems(from)).find(entry => entry.id === sent.id)
      expect(item?.media.map(file => file.targetable)).toEqual([false, false, false])
      expect(item?.reactions.map(r => r.fileId)).toEqual([null])
    })

    it('says nothing is targetable, and breaks nothing, while the files have no id yet', async () => {
      const { from } = await seeded()
      const sent = await sentByAgent(ctx.storeA.id, from, { message: null, files: [] })
      for (const position of [0, 1]) {
        await owner.media.create({
          data: {
            storeId: ctx.storeA.id,
            purpose: 'message',
            messageId: sent.id,
            key: `${prefix}-key-queued-${sent.id}-${position}`,
            filename: 'q.jpg',
            contentType: 'image/jpeg',
            fileSize: 10,
            position
          }
        })
      }

      const item = (await threadItems(from)).find(entry => entry.id === sent.id)
      expect(item?.media.map(file => file.targetable)).toEqual([false, false])
    })

    it('keeps the file a customer quoted, also the first one, and the message when the files share an id', async () => {
      const { connectionId, from } = await seeded()
      const sent = await sentByAgent(ctx.storeA.id, from, {
        message: 'qf-1',
        files: ['qf-1', 'qf-2', 'qf-3']
      })
      const native = await sentByAgent(ctx.storeA.id, from, {
        message: 'qn-1',
        files: ['qn-1', 'qn-1']
      })
      for (const [id, target] of [
        ['q1', 'qf-1'],
        ['q2', 'qf-3'],
        ['q3', 'qn-1']
      ] as const) {
        await inbound.handleMessageReceived(
          TEST_CHANNEL_ID,
          quoting(connectionId, from, id, target)
        )
      }

      const items = await threadItems(from)
      const quoteOf = async (providerId: string) =>
        await owner.message.findFirstOrThrow({
          where: { channelMessageId: providerId, storeId: ctx.storeA.id }
        })
      const files = await owner.media.findMany({
        where: { messageId: sent.id },
        orderBy: { position: 'asc' }
      })
      expect((await quoteOf('q1')).replyToMediaId).toBe(files[0]?.id)
      expect((await quoteOf('q2')).replyToMediaId).toBe(files[2]?.id)
      expect((await quoteOf('q3')).replyToMediaId).toBeNull()
      expect((await quoteOf('q3')).replyToMessageId).toBe(native.id)
      // The thread places the quoted file where it is in the album
      const q2 = items.find(entry => entry.replyToMediaId === files[2]?.id)
      expect(q2?.replyTo?.file).toEqual({ mediaId: files[2]?.id, position: 2 })
    })
  })
})
