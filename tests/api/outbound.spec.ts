import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { PinoLogger } from 'nestjs-pino'

import { ChannelContextFactory, ChannelHealthService } from '@platform/channels/connections'
import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ChannelConnectionStatus,
  ConversationStatus,
  PluginInstallationStatus,
  ChannelIds,
  DeliveryStatus,
  MessageType
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import {
  ChannelConnectionResolver,
  CLOSING_MESSAGE_METADATA,
  ConversationsService,
  MessagesService,
  MessagingWindowService,
  OutboundQueue,
  viewerOf
} from '@platform/core/messaging'
import { JobNames, QueueNames } from '@platform/core/queues'
import { StorageService } from '@platform/core/storage-module'
import { PluginRegistry } from '@platform/plugins/runtime'
import {
  ChannelCapability,
  type ChannelContext,
  ChannelEventTypes,
  PluginError,
  type SendMediaParams,
  type SendMessageParams,
  type SendTemplateParams
} from '@platform/plugins/sdk'

import { channelFileLimits } from '../../apps/api/src/modules/messages/channel-file-limits'
import { ChannelReceipts } from '../../apps/worker/src/outbound/channel-receipts.service'
import { MessageChangeStatusWriter } from '../../apps/worker/src/outbound/message-change-status.writer'
import { MessageStatusWriter } from '../../apps/worker/src/outbound/message-status.writer'
import { OutboundSender } from '../../apps/worker/src/outbound/outbound-sender.service'
import { ReactionStatusWriter } from '../../apps/worker/src/outbound/reaction-status.writer'
import { OutboundRequeueScheduler } from '../../apps/worker/src/schedulers/outbound-requeue.scheduler'
import {
  buildChannelPlugin,
  createChannelConnection,
  createConversation,
  createConversationOf,
  createCustomerIdentity,
  TEST_CHANNEL_ID
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

const CREATED = 201
const OK = 200
const INSTAGRAM_LIMIT = 1000
const TEMPLATE_CHANNEL_ID = 'template_channel'
const MEDIA_CHANNEL_ID = 'media_channel'
// Takes up to three small pngs in one message, when sending several is on
const MULTI_MEDIA_CHANNEL_ID = 'multi_media_channel'
const CONFLICT = 409
const BAD_REQUEST = 400
const NOT_FOUND = 404
const THREE_MINUTES_MS = 180_000
const TWO_HOURS_MS = 7_200_000
const SIX_MINUTES_MS = 360_000

describe('Replies on their way to a channel', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let prisma: PrismaService
  let sender: OutboundSender
  let writer: MessageStatusWriter
  let receipts: ChannelReceipts
  let sweep: OutboundRequeueScheduler
  let outboundQueue: OutboundQueue
  let sent: SendMessageParams[] = []
  let sentTemplates: SendTemplateParams[] = []
  let sentMedia: SendMediaParams[] = []
  let mediaResult: { metadata?: Record<string, unknown> } = {}
  // Makes the send of some files fail: given the params, an error to throw or null to accept
  let mediaFailure: (params: SendMediaParams) => Error | null = () => null
  // Runs inside the send of a file, before the provider's answer: where a receipt can overtake the worker
  let duringMediaSend: (params: SendMediaParams) => Promise<void> = () => Promise.resolve()
  let heard: { event: string; payload: Record<string, unknown> }[] = []
  let sendMessage: (ctx: ChannelContext, params: SendMessageParams) => ReturnType<ChannelSend>
  let externalCount = 0

  type ChannelSend = ReturnType<typeof buildChannelPlugin>['sendMessage']

  const accept: typeof sendMessage = (_ctx, params) => {
    sent.push(params)
    return Promise.resolve({
      externalId: `ext-${(externalCount += 1)}`,
      status: DeliveryStatus.SENT,
      sentAt: new Date().toISOString()
    })
  }

  const sendMediaOf = async (_ctx: ChannelContext, params: SendMediaParams) => {
    sentMedia.push(params)
    await duringMediaSend(params)
    const failure = mediaFailure(params)
    if (failure !== null) throw failure
    return {
      externalId: `media-${params.idempotencyKey}`,
      status: DeliveryStatus.SENT,
      sentAt: new Date().toISOString(),
      ...mediaResult
    }
  }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    prisma = app.get(PrismaService, { strict: false })
    const registry = app.get(PluginRegistry, { strict: false })
    const pluginOf = (id: string): ReturnType<typeof buildChannelPlugin> =>
      buildChannelPlugin({ id, sendMessage: (c, p) => sendMessage(c, p) })
    registry.register(pluginOf(TEST_CHANNEL_ID))
    registry.register(
      buildChannelPlugin({
        id: TEMPLATE_CHANNEL_ID,
        capabilities: [ChannelCapability.TEXT, ChannelCapability.TEMPLATES],
        sendTemplate: (_ctx, params) => {
          sentTemplates.push(params)
          return Promise.resolve({
            externalId: `tpl-${params.idempotencyKey}`,
            status: DeliveryStatus.SENT,
            sentAt: new Date().toISOString()
          })
        },
        listTemplates: () => Promise.resolve([])
      })
    )
    registry.register(
      buildChannelPlugin({
        id: MEDIA_CHANNEL_ID,
        capabilities: [
          ChannelCapability.TEXT,
          ChannelCapability.IMAGE,
          ChannelCapability.DOCUMENT,
          ChannelCapability.MESSAGING_WINDOW
        ],
        sendMedia: sendMediaOf
      })
    )
    registry.register(
      buildChannelPlugin({
        id: MULTI_MEDIA_CHANNEL_ID,
        capabilities: [
          ChannelCapability.TEXT,
          ChannelCapability.IMAGE,
          ChannelCapability.MESSAGING_WINDOW
        ],
        media: {
          maxFilesPerMessage: 3,
          kinds: { image: { types: ['image/png'], maxBytes: 100 } }
        },
        sendMedia: sendMediaOf
      })
    )
    // Instagram is an official plugin of the app now: its send is the only thing the suite replaces
    jest
      .spyOn(registry.get(ChannelIds.INSTAGRAM), 'sendMessage')
      .mockImplementation((c, p) => sendMessage(c, p))

    const logger: PinoLogger = await app.resolve(PinoLogger)
    const events = app.get(DomainEvents, { strict: false })
    writer = new MessageStatusWriter(prisma, events)
    // The rows of the suite hold bytes that are no ciphertext: the context is what the plugin gets
    const cipher = { open: () => ({}) } as unknown as CredentialCipher // test double of the cipher
    const contexts = new ChannelContextFactory(cipher)
    sender = new OutboundSender(
      prisma,
      registry,
      contexts,
      writer,
      new ConversationsService(prisma, events),
      app.get(MessagingWindowService, { strict: false }),
      events,
      app.get(StorageService, { strict: false }),
      logger
    )
    receipts = new ChannelReceipts(
      prisma,
      new ChannelConnectionResolver(prisma),
      writer,
      new ChannelHealthService(prisma, contexts, events, logger),
      logger
    )
    outboundQueue = new OutboundQueue(queueOf(app, QueueNames.OUTBOUND) as never)
    sweep = new OutboundRequeueScheduler(
      undefined as never, // the lock is not what is tested
      prisma,
      outboundQueue,
      writer,
      new ReactionStatusWriter(prisma, events),
      new MessageChangeStatusWriter(prisma, events),
      logger
    )
    app.get(EventEmitter2).onAny((event, payload) => {
      heard.push({ event: String(event), payload: payload as Record<string, unknown> })
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    sent = []
    sentTemplates = []
    sentMedia = []
    mediaResult = {}
    mediaFailure = () => null
    duringMediaSend = () => Promise.resolve()
    heard = []
    sendMessage = accept
  })

  // A reply waiting in a conversation of its own, over a connection of the given plugin
  const queuedReply = async (
    over: {
      storeId?: string
      pluginId?: string
      status?: string
      content?: string
      type?: MessageType
      deliveryStatus?: DeliveryStatus
      createdAt?: Date
      resentAt?: Date
      metadata?: { template: { name: string; language?: string; variables?: string[] } }
      // The closing message of a resolution, in a conversation in this state
      closing?: {
        conversationStatus: ConversationStatus
        resolvedAt: Date | null
        // The last message of the customer, which the messaging window counts from
        lastInboundAt?: Date
      }
    } = {}
  ): Promise<{ id: string; storeId: string; connectionId: string; conversationId: string }> => {
    const storeId = over.storeId ?? ctx.storeA.id
    const pluginId = over.pluginId ?? TEST_CHANNEL_ID
    const identity = await createCustomerIdentity(owner, {
      storeId,
      channelType: pluginId,
      ...(over.closing?.lastInboundAt === undefined
        ? {}
        : { lastInboundAt: over.closing.lastInboundAt })
    })
    const connection = await createChannelConnection(owner, { storeId, channelType: pluginId })
    if (over.status !== undefined) {
      await owner.channelConnection.update({
        where: { id: connection.id },
        data: { status: over.status }
      })
    }
    const conversation = await createConversation(owner, {
      storeId,
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType: pluginId,
      channelConnectionId: connection.id,
      ...(over.closing === undefined
        ? {}
        : { status: over.closing.conversationStatus, resolvedAt: over.closing.resolvedAt })
    })
    const message = await owner.message.create({
      data: {
        storeId,
        conversationId: conversation.id,
        type: over.type ?? MessageType.TEXT,
        content: over.content ?? 'hello there',
        authorType: AuthorType.AGENT,
        deliveryStatus: over.deliveryStatus ?? DeliveryStatus.QUEUED,
        ...(over.createdAt === undefined ? {} : { createdAt: over.createdAt }),
        ...(over.resentAt === undefined ? {} : { resentAt: over.resentAt }),
        ...(over.metadata === undefined ? {} : { metadata: over.metadata }),
        ...(over.closing === undefined ? {} : { metadata: CLOSING_MESSAGE_METADATA })
      },
      select: { id: true }
    })
    const row = await owner.channelConnection.findUniqueOrThrow({
      where: { id: connection.id },
      select: { connectionId: true }
    })
    return {
      id: message.id,
      storeId,
      connectionId: row.connectionId,
      conversationId: conversation.id
    }
  }
  const stored = (id: string) =>
    owner.message.findUniqueOrThrow({
      where: { id },
      select: { deliveryStatus: true, deliveryError: true, channelMessageId: true }
    })
  const job = (reply: { id: string; storeId: string }) => ({
    storeId: reply.storeId,
    messageId: reply.id
  })
  const eventsOf = (name: string) => heard.filter(item => item.event === name)

  describe('the closing message of a resolution', () => {
    const resolvedBefore = (createdAt: Date) => ({
      conversationStatus: ConversationStatus.RESOLVED,
      resolvedAt: new Date(createdAt.getTime() - 1_000)
    })

    it('is sent while the conversation is still resolved by the same resolution, and counts as the answer', async () => {
      const createdAt = new Date()
      const reply = await queuedReply({ createdAt, closing: resolvedBefore(createdAt) })

      await sender.send(job(reply), false)

      expect(sent).toHaveLength(1)
      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
      const conversation = await owner.conversation.findUniqueOrThrow({
        where: { id: reply.conversationId },
        select: { status: true, firstResponseAt: true }
      })
      expect(conversation.status).toBe(ConversationStatus.RESOLVED)
      expect(conversation.firstResponseAt).toEqual(createdAt)
    })

    // The Undo and the send are two transactions at once: the Undo holds the row of the conversation,
    // reopened, and has not committed when the worker starts to look at it. A reply sent to a customer
    // cannot be taken back, so the worker must wait for that row and read the conversation again.
    it('is not sent when an Undo that reopens the conversation commits after the worker began', async () => {
      const createdAt = new Date()
      const reply = await queuedReply({ createdAt, closing: resolvedBefore(createdAt) })
      let release = (): void => undefined
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      let locked = (): void => undefined
      const undoHoldsTheRow = new Promise<void>(resolve => {
        locked = resolve
      })
      const undo = prisma.transaction(async tx => {
        await app
          .get(ConversationsService, { strict: false })
          .applyStatus(tx, reply.storeId, reply.conversationId, ConversationStatus.OPEN, {
            actor: 'system'
          })
        locked()
        await held
      })
      await undoHoldsTheRow

      const sending = sender.send(job(reply), false)
      let settled = false
      void sending.then(
        () => (settled = true),
        () => (settled = true)
      )
      // The worker has had time to read the conversation and, with no lock, to go on to the provider
      await new Promise(resolve => setTimeout(resolve, 500))
      // It waits for the row the Undo holds: it did not go on, and it did not finish
      expect(settled).toBe(false)
      expect(sent).toHaveLength(0)
      release()
      await undo
      await Promise.race([
        sending,
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('the send did not finish: a lock was not released')),
            5_000
          )
        )
      ])

      expect(sent).toHaveLength(0)
      expect(await owner.message.count({ where: { id: reply.id } })).toBe(0)
    })

    // By design: past the point of no return (the 10 s of the Undo and the 2 s of grace are over) the
    // reply is on its way to the customer, and the lock is not held while the provider is asked
    it('is not taken back by an Undo that comes while the provider is being asked', async () => {
      const createdAt = new Date()
      const reply = await queuedReply({ createdAt, closing: resolvedBefore(createdAt) })
      sendMessage = async (channelContext, params) => {
        await app
          .get(ConversationsService, { strict: false })
          .updateStatus(reply.storeId, reply.conversationId, ConversationStatus.OPEN, {
            actor: 'system'
          })
        return accept(channelContext, params)
      }

      await sender.send(job(reply), false)

      expect(sent).toHaveLength(1)
      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
    })

    it('is not judged again, nor deleted, when a retry follows an attempt that may have reached the provider', async () => {
      const createdAt = new Date()
      // The first attempt marked it as one that may have gone; then the customer wrote back, which
      // reopened the conversation
      const reply = await queuedReply({
        createdAt,
        closing: { conversationStatus: ConversationStatus.OPEN, resolvedAt: null }
      })
      await owner.message.update({ where: { id: reply.id }, data: { failureDefinitive: false } })

      await sender.send(job(reply), false)

      expect(await owner.message.count({ where: { id: reply.id } })).toBe(1)
      expect(sent).toHaveLength(1)
    })

    it('does nothing for a closing message that is no longer queued', async () => {
      const createdAt = new Date()
      const reply = await queuedReply({
        createdAt,
        deliveryStatus: DeliveryStatus.SENT,
        closing: resolvedBefore(createdAt)
      })

      await sender.send(job(reply), false)

      expect(sent).toHaveLength(0)
      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
    })

    it('is deleted, never sent and never counted, when the Undo reopened the conversation', async () => {
      const createdAt = new Date()
      const reply = await queuedReply({
        createdAt,
        closing: { conversationStatus: ConversationStatus.OPEN, resolvedAt: null }
      })

      await sender.send(job(reply), false)

      expect(sent).toHaveLength(0)
      expect(await owner.message.count({ where: { id: reply.id } })).toBe(0)
      expect(eventsOf(Events.MESSAGE_DELETED)).toHaveLength(1)
      const conversation = await owner.conversation.findUniqueOrThrow({
        where: { id: reply.conversationId },
        select: { firstResponseAt: true }
      })
      expect(conversation.firstResponseAt).toBeNull()
    })

    it('is deleted when the messaging window closed during the wait', async () => {
      const createdAt = new Date()
      const reply = await queuedReply({
        pluginId: ChannelIds.INSTAGRAM,
        createdAt,
        closing: {
          ...resolvedBefore(createdAt),
          lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000)
        }
      })

      await sender.send(job(reply), false)

      expect(sent).toHaveLength(0)
      expect(await owner.message.count({ where: { id: reply.id } })).toBe(0)
    })

    it('is deleted when the conversation was resolved again since: that resolution has its own message', async () => {
      const createdAt = new Date(Date.now() - 20_000)
      const reply = await queuedReply({
        createdAt,
        closing: {
          conversationStatus: ConversationStatus.RESOLVED,
          resolvedAt: new Date(createdAt.getTime() + 15_000)
        }
      })

      await sender.send(job(reply), false)

      expect(sent).toHaveLength(0)
      expect(await owner.message.count({ where: { id: reply.id } })).toBe(0)
    })
  })

  describe('the processor', () => {
    it('sends a queued reply through its plugin and writes sent, with the message id as the key', async () => {
      const reply = await queuedReply()

      await sender.send(job(reply), false)

      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ content: 'hello there', idempotencyKey: reply.id })
      expect(await stored(reply.id)).toEqual({
        deliveryStatus: DeliveryStatus.SENT,
        deliveryError: null,
        channelMessageId: 'ext-' + externalCount
      })
      expect(eventsOf(Events.MESSAGE_SENT)).toHaveLength(1)
    })

    it('does nothing for a message that is no longer queued, so a second job sends nothing', async () => {
      const reply = await queuedReply({ deliveryStatus: DeliveryStatus.SENT })

      await sender.send(job(reply), false)

      expect(sent).toHaveLength(0)
      expect(heard).toHaveLength(0)
    })

    it('does not find a message through the store of another', async () => {
      const reply = await queuedReply()

      await sender.send({ storeId: ctx.storeB.id, messageId: reply.id }, false)

      expect(sent).toHaveLength(0)
      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.QUEUED)
    })

    it('tries again after a network error, and fails the message on the last attempt', async () => {
      const reply = await queuedReply()
      sendMessage = () => Promise.reject(new Error('socket hang up'))

      await expect(sender.send(job(reply), false)).rejects.toThrow(
        `sending a reply failed: ${ErrorCodes.CHANNEL_MESSAGE_FAILED}`
      )
      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.QUEUED)

      await sender.send(job(reply), true)
      expect(await stored(reply.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_MESSAGE_FAILED
      })
      expect(eventsOf(Events.MESSAGE_FAILED).map(item => item.payload.errorCode)).toEqual([
        ErrorCodes.CHANNEL_MESSAGE_FAILED
      ])
    })

    it('fails at once, without a retry, what the plugin refuses without saying it can be retried', async () => {
      const reply = await queuedReply()
      sendMessage = () => Promise.reject(new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID))

      await sender.send(job(reply), false)

      expect(await stored(reply.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_CREDENTIALS_INVALID
      })
    })

    it('lets the retryable flag of the plugin win: retried when true, never when false', async () => {
      const retried = await queuedReply()
      sendMessage = () =>
        Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true }))
      await expect(sender.send(job(retried), false)).rejects.toThrow('sending a reply failed')
      expect((await stored(retried.id)).deliveryStatus).toBe(DeliveryStatus.QUEUED)

      const final = await queuedReply()
      sendMessage = () =>
        Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false }))
      await sender.send(job(final), false)
      expect((await stored(final.id)).deliveryStatus).toBe(DeliveryStatus.FAILED)
    })

    describe('whether a failure is definitive (the reply can be thrown away only when it is)', () => {
      const definitive = async (id: string) =>
        (await owner.message.findUniqueOrThrow({ where: { id } })).failureDefinitive

      it('is definitive when the provider refuses it in so many words', async () => {
        const refused = await queuedReply()
        sendMessage = () =>
          Promise.reject(new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { refused: true }))
        await sender.send(job(refused), false)
        const local = await queuedReply()
        sendMessage = () =>
          Promise.reject(new PluginError(ErrorCodes.CHANNEL_FILE_TOO_LARGE, { retryable: false }))
        await sender.send(job(local), false)
        const throttled = await queuedReply()
        sendMessage = () =>
          Promise.reject(
            new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true, refused: true })
          )
        await expect(sender.send(job(throttled), false)).rejects.toThrow()
        await sender.send(job(throttled), true)

        expect(await definitive(refused.id)).toBe(true)
        // A check of the plugin itself, made before anything was sent
        expect(await definitive(local.id)).toBe(true)
        // A refusal that was retried to the end is still a refusal: the provider never took it
        expect(await definitive(throttled.id)).toBe(true)
      })

      it('is not definitive when a plugin fails without saying that the provider refused: the default is the doubt', async () => {
        const silent = await queuedReply()
        sendMessage = () =>
          Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false }))
        await sender.send(job(silent), false)
        const credentials = await queuedReply()
        sendMessage = () => Promise.reject(new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID))
        await sender.send(job(credentials), false)
        // A plugin cannot both say that the provider refused and that the outcome is unknown
        const both = await queuedReply()
        sendMessage = () =>
          Promise.reject(
            new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
              retryable: false,
              refused: true,
              outcomeUnknown: true
            })
          )
        await sender.send(job(both), false)

        expect(await definitive(silent.id)).toBe(false)
        expect(await definitive(credentials.id)).toBe(false)
        expect(await definitive(both.id)).toBe(false)
      })

      it('is not definitive when the outcome is unknown: a timeout, a network error, or a plugin that says so', async () => {
        const network = await queuedReply()
        sendMessage = () => Promise.reject(new Error('socket hang up'))
        await expect(sender.send(job(network), false)).rejects.toThrow()
        await sender.send(job(network), true)
        const unknown = await queuedReply()
        sendMessage = () =>
          Promise.reject(
            new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
              retryable: false,
              outcomeUnknown: true
            })
          )
        await sender.send(job(unknown), false)

        expect(await definitive(network.id)).toBe(false)
        expect(await definitive(unknown.id)).toBe(false)
      })

      it('is not definitive when an earlier attempt may have gone, whatever the last one says', async () => {
        const reply = await queuedReply()
        sendMessage = () => Promise.reject(new Error('socket hang up'))
        await expect(sender.send(job(reply), false)).rejects.toThrow()
        sendMessage = () =>
          Promise.reject(new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { refused: true }))

        await sender.send(job(reply), true)

        expect(await stored(reply.id)).toMatchObject({
          deliveryStatus: DeliveryStatus.FAILED,
          deliveryError: ErrorCodes.CHANNEL_CREDENTIALS_INVALID
        })
        expect(await definitive(reply.id)).toBe(false)
      })

      it('is not definitive when the answer of the plugin makes no sense: the provider may have taken it', async () => {
        const reply = await queuedReply()
        sendMessage = () => Promise.resolve({} as never)

        await sender.send(job(reply), false)

        expect(await stored(reply.id)).toMatchObject({ deliveryStatus: DeliveryStatus.FAILED })
        expect(await definitive(reply.id)).toBe(false)
      })

      it('is definitive when nothing was sent: a connection that is down, a reply too long', async () => {
        const down = await queuedReply({ status: ChannelConnectionStatus.DISCONNECTED })
        await sender.send(job(down), false)

        expect(await stored(down.id)).toMatchObject({
          deliveryError: ErrorCodes.CHANNEL_NOT_CONNECTED
        })
        expect(await definitive(down.id)).toBe(true)
        expect(sent).toHaveLength(0)
      })

      it('is marked as one that may have gone BEFORE the provider is asked, and unmarked once it went', async () => {
        const reply = await queuedReply()
        let duringTheCall: boolean | null | undefined
        sendMessage = async (...args) => {
          duringTheCall = (await owner.message.findUniqueOrThrow({ where: { id: reply.id } }))
            .failureDefinitive
          return accept(...args)
        }

        await sender.send(job(reply), false)

        expect(duringTheCall).toBe(false)
        expect(await definitive(reply.id)).toBeNull()
      })

      it('is not definitive after an attempt that died mid-send: the mark it left is still there', async () => {
        const reply = await queuedReply()
        // What a worker that crashed (or a job that stalled) after the provider was asked leaves behind
        await owner.message.update({ where: { id: reply.id }, data: { failureDefinitive: false } })
        sendMessage = () =>
          Promise.reject(new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { refused: true }))

        await sender.send(job(reply), false)

        expect(await stored(reply.id)).toMatchObject({ deliveryStatus: DeliveryStatus.FAILED })
        expect(await definitive(reply.id)).toBe(false)
      })

      it('is not definitive for a check that fails before sending, when an earlier send may have gone', async () => {
        const reply = await queuedReply({ status: ChannelConnectionStatus.DISCONNECTED })
        await owner.message.update({ where: { id: reply.id }, data: { failureDefinitive: false } })

        await sender.send(job(reply), false)

        expect(await stored(reply.id)).toMatchObject({
          deliveryError: ErrorCodes.CHANNEL_NOT_CONNECTED
        })
        expect(await definitive(reply.id)).toBe(false)
      })

      it('takes the mark off after a clean refusal that is retried, so the next one can be definitive', async () => {
        const reply = await queuedReply()
        sendMessage = () =>
          Promise.reject(
            new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true, refused: true })
          )
        await expect(sender.send(job(reply), false)).rejects.toThrow()

        expect(await definitive(reply.id)).toBeNull()
      })

      it('is not kept once the reply is sent, and a reply that went has none', async () => {
        const reply = await queuedReply()
        sendMessage = () => Promise.reject(new Error('socket hang up'))
        await expect(sender.send(job(reply), false)).rejects.toThrow()
        sendMessage = accept

        await sender.send(job(reply), true)

        expect(await stored(reply.id)).toMatchObject({ deliveryStatus: DeliveryStatus.SENT })
        expect(await definitive(reply.id)).toBeNull()
      })

      it('is not definitive for a failure that a receipt of the provider reports', async () => {
        const reply = await queuedReply()
        sendMessage = accept
        await sender.send(job(reply), false)
        const row = await owner.message.findUniqueOrThrow({ where: { id: reply.id } })

        await writer.apply({
          storeId: ctx.storeA.id,
          messageId: reply.id,
          to: DeliveryStatus.FAILED,
          errorCode: ErrorCodes.CHANNEL_MESSAGE_FAILED
        })

        expect(row.channelMessageId).not.toBeNull()
        expect(await stored(reply.id)).toMatchObject({ deliveryStatus: DeliveryStatus.FAILED })
        expect(await definitive(reply.id)).toBe(false)
      })
    })

    it('keeps what the provider said out of the row, the event and the logs', async () => {
      const reply = await queuedReply()
      sendMessage = () => Promise.reject(new Error('401 token=EAAB-secret-token'))

      await sender.send(job(reply), true)

      const row = JSON.stringify(await stored(reply.id)) + JSON.stringify(heard)
      expect(row).not.toContain('EAAB-secret-token')
    })

    it('fails a reply that is too long for its channel, and never calls the plugin', async () => {
      const reply = await queuedReply({
        pluginId: ChannelIds.INSTAGRAM,
        content: 'x'.repeat(INSTAGRAM_LIMIT + 1)
      })
      const fits = await queuedReply({
        pluginId: ChannelIds.INSTAGRAM,
        content: 'x'.repeat(INSTAGRAM_LIMIT)
      })

      await sender.send(job(reply), false)
      await sender.send(job(fits), false)

      expect(await stored(reply.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_MESSAGE_FAILED
      })
      expect((await stored(fits.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
      expect(sent).toHaveLength(1)
    })

    it('counts characters of text and not bytes: emoji do not eat the limit', async () => {
      const reply = await queuedReply({
        pluginId: ChannelIds.INSTAGRAM,
        content: '😀'.repeat(INSTAGRAM_LIMIT)
      })

      await sender.send(job(reply), false)

      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
    })

    it('fails with CHANNEL_NOT_CONNECTED when the connection is disconnected or its plugin is gone', async () => {
      const disconnected = await queuedReply({ status: ChannelConnectionStatus.DISCONNECTED })
      const unknown = await queuedReply({ pluginId: 'not_registered' })

      await sender.send(job(disconnected), false)
      await sender.send(job(unknown), true)

      for (const reply of [disconnected, unknown]) {
        expect(await stored(reply.id)).toMatchObject({
          deliveryStatus: DeliveryStatus.FAILED,
          deliveryError: ErrorCodes.CHANNEL_NOT_CONNECTED
        })
      }
      expect(sent).toHaveLength(0)
    })

    it('sends nothing through a connection whose installation was revoked', async () => {
      const reply = await queuedReply()
      await owner.pluginInstallation.updateMany({
        where: { storeId: reply.storeId, pluginId: TEST_CHANNEL_ID },
        data: { status: PluginInstallationStatus.REVOKED, revokedAt: new Date() }
      })

      try {
        await sender.send(job(reply), false)

        expect(await stored(reply.id)).toMatchObject({
          deliveryStatus: DeliveryStatus.FAILED,
          deliveryError: ErrorCodes.CHANNEL_NOT_CONNECTED
        })
        expect(sent).toHaveLength(0)
      } finally {
        await owner.pluginInstallation.updateMany({
          where: { storeId: reply.storeId, pluginId: TEST_CHANNEL_ID },
          data: { status: PluginInstallationStatus.ACTIVE, revokedAt: null }
        })
      }
    })

    it('tries again when the plugin is not registered yet, and fails only on the last attempt', async () => {
      const reply = await queuedReply({ pluginId: 'not_registered' })

      await expect(sender.send(job(reply), false)).rejects.toThrow('not registered')
      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.QUEUED)

      await sender.send(job(reply), true)
      expect((await stored(reply.id)).deliveryError).toBe(ErrorCodes.CHANNEL_NOT_CONNECTED)
    })

    it('fails a reply whose connection or message holds a value the worker does not know, instead of leaving it queued', async () => {
      const reply = await queuedReply()
      await owner.channelConnection.updateMany({
        where: { connectionId: reply.connectionId },
        data: { status: 'from-a-newer-version' }
      })

      await sender.send(job(reply), false)

      expect(await stored(reply.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_MESSAGE_FAILED
      })
    })

    it('rethrows for the retry an error that carries nothing the provider said', async () => {
      const reply = await queuedReply()
      sendMessage = () => Promise.reject(new Error('401 Bearer EAAB-secret-token'))

      const error = (await sender
        .send(job(reply), false)
        .catch((caught: unknown) => caught)) as Error

      expect(error).toBeInstanceOf(Error)
      expect(`${error.name} ${error.message} ${error.stack ?? ''}`).not.toContain('EAAB-secret')
    })

    it('does not send again when the write after the provider took the message fails once', async () => {
      const reply = await queuedReply()
      jest.spyOn(writer, 'apply').mockRejectedValueOnce(new Error('connection reset'))

      await sender.send(job(reply), false)

      expect(sent).toHaveLength(1)
      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
    })

    it('marks the reply sent without the id when the id is taken between the check and the write', async () => {
      const reply = await queuedReply()
      const taken = Object.assign(new Error('unique constraint'), { code: 'P2002' })
      jest.spyOn(writer, 'apply').mockRejectedValueOnce(taken)

      await sender.send(job(reply), false)

      expect(sent).toHaveLength(1)
      expect(await stored(reply.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.SENT,
        channelMessageId: null
      })
    })

    it('does not store a provider id that another conversation of the connection already holds', async () => {
      const first = await queuedReply()
      const connection = await owner.message.findUniqueOrThrow({
        where: { id: first.id },
        select: { conversation: { select: { channelConnectionId: true } } }
      })
      const identity = await createCustomerIdentity(owner, {
        storeId: first.storeId,
        channelType: TEST_CHANNEL_ID
      })
      const other = await createConversation(owner, {
        storeId: first.storeId,
        customerId: identity.customerId,
        customerIdentityId: identity.id,
        channelType: TEST_CHANNEL_ID,
        channelConnectionId: connection.conversation.channelConnectionId
      })
      const second = await owner.message.create({
        data: {
          storeId: first.storeId,
          conversationId: other.id,
          type: MessageType.TEXT,
          content: 'elsewhere',
          authorType: AuthorType.AGENT,
          deliveryStatus: DeliveryStatus.QUEUED
        },
        select: { id: true }
      })
      sendMessage = (_ctx, params) => {
        sent.push(params)
        return Promise.resolve({
          externalId: 'shared-id',
          status: DeliveryStatus.SENT,
          sentAt: new Date().toISOString()
        })
      }

      await sender.send(job(first), false)
      await sender.send({ storeId: first.storeId, messageId: second.id }, false)

      // A receipt looks messages up by connection: an id that two of them held could not be told apart
      expect((await stored(first.id)).channelMessageId).toBe('shared-id')
      expect((await stored(second.id)).channelMessageId).toBeNull()
    })

    it('still sends over a connection in error: a health blip does not fail the replies', async () => {
      const reply = await queuedReply({ status: ChannelConnectionStatus.ERROR })

      await sender.send(job(reply), false)

      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
    })

    it('fails, and sends nothing, a reply of a kind the platform does not send', async () => {
      const reply = await queuedReply({ type: MessageType.LOCATION })

      await sender.send(job(reply), false)

      expect(await stored(reply.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED
      })
      expect(sent).toHaveLength(0)
    })

    it('keys a reply sent again apart from its first attempt, for a provider that dedupes on the key', async () => {
      const resentAt = new Date(Date.now() - 60_000)
      const reply = await queuedReply({ resentAt })

      await sender.send(job(reply), false)

      expect(sent[0]?.idempotencyKey).toBe(`${reply.id}-${resentAt.getTime()}`)
    })

    it('sends a template by name, language and variables, not by its text', async () => {
      const reply = await queuedReply({
        pluginId: TEMPLATE_CHANNEL_ID,
        type: MessageType.TEMPLATE,
        content: 'Hello Ana, your order 42 is ready',
        metadata: { template: { name: 'order_ready', language: 'es', variables: ['Ana', '42'] } }
      })

      await sender.send(job(reply), false)

      expect(sent).toHaveLength(0)
      expect(sentTemplates).toEqual([
        {
          channelIdentity: expect.any(String) as string,
          templateName: 'order_ready',
          language: 'es',
          variables: ['Ana', '42'],
          idempotencyKey: reply.id
        }
      ])
      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
    })

    it('fails a template whose stored data is not a template, without calling the plugin', async () => {
      const reply = await queuedReply({
        pluginId: TEMPLATE_CHANNEL_ID,
        type: MessageType.TEMPLATE,
        metadata: { template: { name: '' } }
      })

      await sender.send(job(reply), false)

      expect(await stored(reply.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_MESSAGE_FAILED
      })
      expect(sentTemplates).toHaveLength(0)
    })

    it('fails a template for a plugin that cannot send one', async () => {
      const reply = await queuedReply({
        type: MessageType.TEMPLATE,
        metadata: { template: { name: 'order_ready', language: 'es', variables: [] } }
      })

      await sender.send(job(reply), false)

      expect(await stored(reply.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED
      })
    })

    it('fails, and does not send twice, when the plugin answers nonsense', async () => {
      const reply = await queuedReply()
      sendMessage = () => Promise.resolve({ externalId: '', status: 'queued' } as never) // what a bad plugin answers

      await sender.send(job(reply), false)

      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.FAILED)
    })

    it('hands the plugin the external id of the message that is replied to', async () => {
      const target = await queuedReply({ deliveryStatus: DeliveryStatus.SENT })
      await owner.message.update({
        where: { id: target.id },
        data: { channelMessageId: 'ext-target' }
      })
      const reply = await queuedReply()
      await owner.message.update({
        where: { id: reply.id },
        data: { replyToMessageId: target.id }
      })

      await sender.send(job(reply), false)

      expect(sent[0]?.replyToExternalId).toBe('ext-target')
    })

    it('marks a reply sent without the provider id when the plugin repeats an id of the conversation', async () => {
      const first = await queuedReply()
      const second = await owner.message.create({
        data: {
          storeId: first.storeId,
          conversationId: first.conversationId,
          type: MessageType.TEXT,
          content: 'again',
          authorType: AuthorType.AGENT,
          deliveryStatus: DeliveryStatus.QUEUED
        },
        select: { id: true }
      })
      sendMessage = (_ctx, params) => {
        sent.push(params)
        return Promise.resolve({
          externalId: 'same-id',
          status: DeliveryStatus.SENT,
          sentAt: new Date().toISOString()
        })
      }

      await sender.send(job(first), false)
      await sender.send({ storeId: first.storeId, messageId: second.id }, false)

      expect((await stored(first.id)).channelMessageId).toBe('same-id')
      expect(await stored(second.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.SENT,
        channelMessageId: null
      })
    })
  })

  describe('a media message', () => {
    // A file of the message, written the way the confirmation leaves it
    const fileOf = async (
      storeId: string,
      over: {
        messageId?: string
        status?: string
        contentType?: string
        uploadedBy?: string
        fileSize?: number
        position?: number
      } = {}
    ) => {
      const id = randomUUID()
      return owner.media.create({
        data: {
          id,
          storeId,
          purpose: 'message',
          key: `stores/${storeId}/messages/${id}/photo.png`,
          filename: 'photo.png',
          contentType: over.contentType ?? 'image/png',
          fileSize: over.fileSize ?? 10,
          status: over.status ?? 'clean',
          ...(over.position === undefined
            ? {}
            : { position: over.position, deliveryStatus: 'queued' }),
          ...(over.messageId === undefined ? {} : { messageId: over.messageId }),
          ...(over.uploadedBy === undefined ? {} : { uploadedBy: over.uploadedBy })
        },
        select: { id: true }
      })
    }

    it('sends the file by a signed link with its text as the caption, in one message', async () => {
      const reply = await queuedReply({
        pluginId: MEDIA_CHANNEL_ID,
        type: MessageType.IMAGE,
        content: 'look at this'
      })
      await fileOf(reply.storeId, { messageId: reply.id })

      await sender.send(job(reply), false)

      expect(sentMedia).toHaveLength(1)
      expect(sentMedia[0]).toMatchObject({
        contentType: 'image/png',
        filename: 'photo.png',
        caption: 'look at this',
        idempotencyKey: reply.id
      })
      // The core signs no link for a plugin: the bytes come through `openFile`
      expect(sentMedia[0]).not.toHaveProperty('mediaUrl')
      expect(typeof sentMedia[0]?.openFile).toBe('function')
      expect(sent).toHaveLength(0)
      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
    })

    it('lets the plugin read the stored bytes of the clean file, at the size that was recorded', async () => {
      const reply = await queuedReply({ pluginId: MEDIA_CHANNEL_ID, type: MessageType.IMAGE })
      const media = await fileOf(reply.storeId, { messageId: reply.id })
      const { key } = await owner.media.findUniqueOrThrow({
        where: { id: media.id },
        select: { key: true }
      })
      const storage = app.get(StorageService, { strict: false })
      await storage.put(key, Buffer.from('0123456789'), 'image/png')

      try {
        await sender.send(job(reply), false)

        expect(sentMedia[0]?.fileSize).toBe(10)
        const chunks: Buffer[] = []
        for await (const chunk of (await sentMedia[0]?.openFile()) ?? []) {
          chunks.push(Buffer.from(chunk as Uint8Array))
        }
        expect(Buffer.concat(chunks).toString()).toBe('0123456789')
      } finally {
        await storage.delete(key)
      }
    })

    it('does not give the bytes of a file that stopped being clean after the send was picked up', async () => {
      const reply = await queuedReply({ pluginId: MEDIA_CHANNEL_ID, type: MessageType.IMAGE })
      const media = await fileOf(reply.storeId, { messageId: reply.id })
      await sender.send(job(reply), false)
      await owner.media.update({ where: { id: media.id }, data: { status: 'infected' } })

      await expect(sentMedia[0]?.openFile()).rejects.toMatchObject({ retryable: false })
    })

    it('fails the read, and sends nothing else, when the object is gone from the bucket', async () => {
      const reply = await queuedReply({ pluginId: MEDIA_CHANNEL_ID, type: MessageType.IMAGE })
      await fileOf(reply.storeId, { messageId: reply.id })

      await sender.send(job(reply), false)

      await expect(sentMedia[0]?.openFile()).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_MESSAGE_FAILED,
        retryable: false
      })
    })

    it('sends a file with no text under it, and no caption at all', async () => {
      const reply = await queuedReply({
        pluginId: MEDIA_CHANNEL_ID,
        type: MessageType.IMAGE,
        content: ''
      })
      await owner.message.update({ where: { id: reply.id }, data: { content: null } })
      await fileOf(reply.storeId, { messageId: reply.id })

      await sender.send(job(reply), false)

      expect(sentMedia).toHaveLength(1)
      expect(sentMedia[0]).not.toHaveProperty('caption')
    })

    it('keeps the id of the second message that carried the caption', async () => {
      const reply = await queuedReply({ pluginId: MEDIA_CHANNEL_ID, type: MessageType.IMAGE })
      await fileOf(reply.storeId, { messageId: reply.id })
      mediaResult = { metadata: { captionExternalId: 'cap-1', ignored: 'x' } }

      await sender.send(job(reply), false)

      const row = await owner.message.findUniqueOrThrow({
        where: { id: reply.id },
        select: { metadata: true, captionChannelMessageId: true, captionState: true }
      })
      expect(row.captionChannelMessageId).toBe('cap-1')
      expect(row.captionState).toBe('sent')
      // The column is the only place of the id, and what else the plugin said is dropped
      expect(row.metadata).toBeNull()
    })

    it.each(['failed', 'unconfirmed'])(
      'marks a reply whose file went and whose caption is %s',
      async state => {
        const reply = await queuedReply({ pluginId: MEDIA_CHANNEL_ID, type: MessageType.IMAGE })
        await fileOf(reply.storeId, { messageId: reply.id })
        mediaResult = { metadata: { captionState: state } }

        await sender.send(job(reply), false)

        const row = await owner.message.findUniqueOrThrow({
          where: { id: reply.id },
          select: {
            metadata: true,
            captionState: true,
            deliveryStatus: true,
            channelMessageId: true
          }
        })
        expect(row.deliveryStatus).toBe(DeliveryStatus.SENT)
        expect(row.channelMessageId).not.toBeNull()
        expect(row.captionState).toBe(state)
        expect(row.metadata).toBeNull()
      }
    )

    it('keeps the metadata the message already has when the caption id is written', async () => {
      const reply = await queuedReply({ pluginId: MEDIA_CHANNEL_ID, type: MessageType.IMAGE })
      await fileOf(reply.storeId, { messageId: reply.id })
      await owner.message.update({ where: { id: reply.id }, data: { metadata: { other: 1 } } })
      mediaResult = { metadata: { captionExternalId: 'cap-2' } }

      await sender.send(job(reply), false)

      const row = await owner.message.findUniqueOrThrow({
        where: { id: reply.id },
        select: { metadata: true, captionChannelMessageId: true }
      })
      expect(row.metadata).toEqual({ other: 1 })
      expect(row.captionChannelMessageId).toBe('cap-2')
    })

    it.each(['infected', 'pending'])('fails the message when its file is %s', async status => {
      const reply = await queuedReply({ pluginId: MEDIA_CHANNEL_ID, type: MessageType.IMAGE })
      await fileOf(reply.storeId, { messageId: reply.id, status })

      await sender.send(job(reply), false)

      expect(sentMedia).toHaveLength(0)
      expect(await stored(reply.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.FILE_UNAVAILABLE
      })
    })

    it('fails a message that lost its file', async () => {
      const reply = await queuedReply({ pluginId: MEDIA_CHANNEL_ID, type: MessageType.DOCUMENT })

      await sender.send(job(reply), false)

      expect(sentMedia).toHaveLength(0)
      expect(await stored(reply.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.FILE_UNAVAILABLE
      })
    })

    describe('POST /messages with mediaIds', () => {
      const conversationOnMediaChannel = async () => {
        const conversation = await createConversationOf(owner, {
          storeId: ctx.storeA.id,
          channelType: MEDIA_CHANNEL_ID
        })
        await owner.customerIdentity.update({
          where: { id: conversation.customerIdentityId },
          data: { lastInboundAt: new Date() }
        })
        return conversation
      }
      const post = (body: Record<string, unknown>) =>
        api(app, ctx.agentA, ctx.storeA).post(ApiRoutes.messages.create).send(body)

      it('stores one message with the file linked to it and the customer, and queues it', async () => {
        const conversation = await conversationOnMediaChannel()
        const file = await fileOf(ctx.storeA.id, { uploadedBy: ctx.agentA.id })
        const queue = queueOf(app, QueueNames.OUTBOUND)
        queue.jobs.length = 0

        const response = await post({
          type: MessageType.IMAGE,
          conversationId: conversation.id,
          mediaIds: [file.id],
          content: 'caption',
          idempotencyKey: randomUUID()
        }).expect(CREATED)

        const created = response.body as {
          id: string
          type: string
          content: string
          media: { id: string; status: string }[]
        }
        expect(created).toMatchObject({ type: MessageType.IMAGE, content: 'caption' })
        // The answer already carries the file it was sent with
        expect(created.media.map(item => item.id)).toEqual([file.id])
        const linked = await owner.media.findUniqueOrThrow({
          where: { id: file.id },
          select: { messageId: true, customerId: true }
        })
        expect(linked).toEqual({ messageId: created.id, customerId: conversation.customerId })
        expect(queue.jobs).toHaveLength(1)
      })

      it('answers a repeated key with the same message, and refuses it with other files', async () => {
        const conversation = await conversationOnMediaChannel()
        const file = await fileOf(ctx.storeA.id, { uploadedBy: ctx.agentA.id })
        const other = await fileOf(ctx.storeA.id, { uploadedBy: ctx.agentA.id })
        const body = {
          type: MessageType.IMAGE,
          conversationId: conversation.id,
          mediaIds: [file.id],
          idempotencyKey: randomUUID()
        }
        const first = await post(body).expect(CREATED)

        const again = await post(body).expect(OK)
        await post({ ...body, mediaIds: [other.id] }).expect(CONFLICT)

        expect((again.body as { id: string }).id).toBe((first.body as { id: string }).id)
      })

      it('refuses the file of another store, of another member and one that does not exist', async () => {
        const conversation = await conversationOnMediaChannel()
        const foreign = await fileOf(ctx.storeB.id, { uploadedBy: ctx.agentA.id })
        const notMine = await fileOf(ctx.storeA.id, { uploadedBy: ctx.adminA.id })
        for (const id of [foreign.id, notMine.id, randomUUID()]) {
          await post({
            type: MessageType.IMAGE,
            conversationId: conversation.id,
            mediaIds: [id],
            idempotencyKey: randomUUID()
          }).expect(NOT_FOUND)
        }
      })

      it('refuses a file that is not clean yet, an infected one and one already sent', async () => {
        const conversation = await conversationOnMediaChannel()
        const pending = await fileOf(ctx.storeA.id, {
          uploadedBy: ctx.agentA.id,
          status: 'pending'
        })
        const infected = await fileOf(ctx.storeA.id, {
          uploadedBy: ctx.agentA.id,
          status: 'infected'
        })
        const used = await fileOf(ctx.storeA.id, { uploadedBy: ctx.agentA.id })
        await post({
          type: MessageType.IMAGE,
          conversationId: conversation.id,
          mediaIds: [used.id],
          idempotencyKey: randomUUID()
        }).expect(CREATED)

        const attempt = (id: string) =>
          post({
            type: MessageType.IMAGE,
            conversationId: conversation.id,
            mediaIds: [id],
            idempotencyKey: randomUUID()
          })
        expect((await attempt(pending.id).expect(CONFLICT)).body).toMatchObject({
          error: { code: ErrorCodes.FILE_NOT_READY }
        })
        await attempt(infected.id).expect(403)
        await attempt(used.id).expect(CONFLICT)
      })

      it('refuses a file that is not of the type of the message', async () => {
        const conversation = await conversationOnMediaChannel()
        const pdf = await fileOf(ctx.storeA.id, {
          uploadedBy: ctx.agentA.id,
          contentType: 'application/pdf'
        })

        await post({
          type: MessageType.IMAGE,
          conversationId: conversation.id,
          mediaIds: [pdf.id],
          idempotencyKey: randomUUID()
        }).expect(BAD_REQUEST)
      })

      it('refuses a kind of file the channel does not declare', async () => {
        const conversation = await conversationOnMediaChannel()
        const audio = await fileOf(ctx.storeA.id, {
          uploadedBy: ctx.agentA.id,
          contentType: 'audio/ogg'
        })

        const response = await post({
          type: MessageType.AUDIO,
          conversationId: conversation.id,
          mediaIds: [audio.id],
          idempotencyKey: randomUUID()
        }).expect(CONFLICT)

        expect(response.body).toMatchObject({
          error: { code: ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED }
        })
      })

      it('needs the files and the key', async () => {
        const conversation = await conversationOnMediaChannel()
        const base = { type: MessageType.IMAGE, conversationId: conversation.id }
        await post({ ...base, idempotencyKey: randomUUID() }).expect(BAD_REQUEST)
        await post({ ...base, mediaIds: [], idempotencyKey: randomUUID() }).expect(BAD_REQUEST)
        await post({ ...base, mediaIds: [randomUUID()] }).expect(BAD_REQUEST)
      })

      it('takes one file while several are off, whatever the channel declares, and says how many', async () => {
        const conversation = await createConversationOf(owner, {
          storeId: ctx.storeA.id,
          channelType: MULTI_MEDIA_CHANNEL_ID
        })
        await owner.customerIdentity.update({
          where: { id: conversation.customerIdentityId },
          data: { lastInboundAt: new Date() }
        })
        const files = [
          await fileOf(ctx.storeA.id, { uploadedBy: ctx.agentA.id }),
          await fileOf(ctx.storeA.id, { uploadedBy: ctx.agentA.id })
        ]

        const response = await post({
          type: MessageType.IMAGE,
          conversationId: conversation.id,
          mediaIds: files.map(file => file.id),
          idempotencyKey: randomUUID()
        }).expect(CONFLICT)

        expect(response.body).toMatchObject({
          error: { code: ErrorCodes.CHANNEL_TOO_MANY_FILES }
        })
        // Nothing was linked: the files can still be attached
        expect(
          await owner.media.count({ where: { id: { in: files.map(f => f.id) }, messageId: null } })
        ).toBe(2)
      })
    })
  })

  describe('several files in one message', () => {
    const fileOf = (
      storeId: string,
      over: {
        messageId?: string
        status?: string
        contentType?: string
        uploadedBy?: string
        fileSize?: number
        position?: number
      } = {}
    ) => {
      const id = randomUUID()
      return owner.media.create({
        data: {
          id,
          storeId,
          purpose: 'message',
          key: `stores/${storeId}/messages/${id}/photo.png`,
          filename: 'photo.png',
          contentType: over.contentType ?? 'image/png',
          fileSize: over.fileSize ?? 10,
          status: over.status ?? 'clean',
          createdAt: new Date(Date.now() + (over.position ?? 0)),
          ...(over.position === undefined
            ? {}
            : { position: over.position, deliveryStatus: DeliveryStatus.QUEUED }),
          ...(over.messageId === undefined ? {} : { messageId: over.messageId }),
          ...(over.uploadedBy === undefined ? {} : { uploadedBy: over.uploadedBy })
        },
        select: { id: true }
      })
    }
    const rowsOf = (messageId: string) =>
      owner.media.findMany({
        where: { messageId },
        orderBy: { position: 'asc' },
        select: {
          position: true,
          deliveryStatus: true,
          channelMessageId: true,
          sendErrorCode: true,
          sentAt: true
        }
      })

    describe('creating the message, with sending several switched on', () => {
      const create = async (
        mediaIds: string[],
        over: { conversationId?: string; viewer?: string } = {}
      ) => {
        const registry = app.get(PluginRegistry, { strict: false })
        const conversation =
          over.conversationId === undefined
            ? await createConversationOf(owner, {
                storeId: ctx.storeA.id,
                channelType: MULTI_MEDIA_CHANNEL_ID
              })
            : { id: over.conversationId }
        await owner.conversation.update({
          where: { id: conversation.id },
          data: { customerIdentity: { update: { lastInboundAt: new Date() } } }
        })
        return app.get(MessagesService, { strict: false }).create(
          ctx.storeA.id,
          {
            type: MessageType.IMAGE,
            conversationId: conversation.id,
            mediaIds,
            idempotencyKey: randomUUID()
          },
          viewerOf(ctx.agentA.id, Object.values(Permissions)),
          undefined,
          (channel, capability) => registry.hasCapability(channel, capability),
          channelFileLimits(registry, true)
        )
      }
      const mine = (over: Parameters<typeof fileOf>[1] = {}) =>
        fileOf(ctx.storeA.id, { uploadedBy: ctx.agentA.id, ...over })

      it('links the files in the order the agent gave, each queued, and lists them in that order', async () => {
        const [a, b, c] = [await mine(), await mine(), await mine()]

        const { message } = await create([c.id, a.id, b.id])

        expect(message.media.map(file => [file.id, file.position, file.delivery])).toEqual([
          [c.id, 0, 'queued'],
          [a.id, 1, 'queued'],
          [b.id, 2, 'queued']
        ])
        expect((await rowsOf(message.id)).map(row => row.position)).toEqual([0, 1, 2])
      })

      it('refuses more files than the channel takes, a type it does not take and a file that is too big', async () => {
        const files = [await mine(), await mine(), await mine(), await mine()]
        await expect(create(files.map(file => file.id))).rejects.toMatchObject({
          code: ErrorCodes.CHANNEL_TOO_MANY_FILES
        })
        const gif = await mine({ contentType: 'image/gif' })
        await expect(create([gif.id])).rejects.toMatchObject({
          code: ErrorCodes.CHANNEL_FILE_TYPE_UNSUPPORTED
        })
        const big = await mine({ fileSize: 101 })
        await expect(create([big.id])).rejects.toMatchObject({
          code: ErrorCodes.CHANNEL_FILE_TOO_LARGE
        })
        // Nothing was linked by any of them
        expect(
          await owner.media.count({
            where: { id: { in: [...files, gif, big].map(file => file.id) }, messageId: null }
          })
        ).toBe(6)
      })

      it("refuses the whole message, linking none, when one of the files is another store's or not clean", async () => {
        const ok = await mine()
        const foreign = await fileOf(ctx.storeB.id, { uploadedBy: ctx.agentA.id })
        await expect(create([ok.id, foreign.id])).rejects.toThrow('media not found')
        const pending = await mine({ status: 'pending' })
        await expect(create([ok.id, pending.id])).rejects.toMatchObject({
          code: ErrorCodes.FILE_NOT_READY
        })
        expect(await owner.media.count({ where: { id: ok.id, messageId: null } })).toBe(1)
      })
    })

    describe('sending them', () => {
      const replyWithFiles = async (count: number, content = 'look') => {
        const reply = await queuedReply({
          pluginId: MULTI_MEDIA_CHANNEL_ID,
          type: MessageType.IMAGE,
          content
        })
        const files = []
        for (let position = 0; position < count; position += 1) {
          files.push(await fileOf(reply.storeId, { messageId: reply.id, position }))
        }
        return { reply, files }
      }

      it('sends them one after the other, the text under the first, and marks each', async () => {
        const { reply } = await replyWithFiles(3)

        await sender.send(job(reply), false)

        expect(sentMedia.map(params => params.idempotencyKey)).toEqual([
          `${reply.id}-0`,
          `${reply.id}-1`,
          `${reply.id}-2`
        ])
        expect(sentMedia.map(params => params.caption)).toEqual(['look', undefined, undefined])
        const rows = await rowsOf(reply.id)
        expect(rows.map(row => row.deliveryStatus)).toEqual(['sent', 'sent', 'sent'])
        expect(rows.map(row => row.channelMessageId)).toEqual([
          `media-${reply.id}-0`,
          `media-${reply.id}-1`,
          `media-${reply.id}-2`
        ])
        const message = await stored(reply.id)
        expect(message.deliveryStatus).toBe(DeliveryStatus.SENT)
        // The id of the message is the first file's
        expect(message.channelMessageId).toBe(`media-${reply.id}-0`)
      })

      it('waits for the answer of a file before the next one goes', async () => {
        const { reply } = await replyWithFiles(2)
        const order: string[] = []
        mediaFailure = params => {
          order.push(`start-${params.idempotencyKey}`)
          return null
        }
        await sender.send(job(reply), false)
        // Each started once, in order: the second never started before the first had been answered
        expect(order).toEqual([`start-${reply.id}-0`, `start-${reply.id}-1`])
      })

      it('marks the file that failed, sends the others, fails the message, and sends again only that file', async () => {
        const { reply } = await replyWithFiles(3)
        mediaFailure = params =>
          params.idempotencyKey === `${reply.id}-1`
            ? new PluginError(ErrorCodes.CHANNEL_FILE_TOO_LARGE, { retryable: false })
            : null

        await sender.send(job(reply), false)

        expect(sentMedia).toHaveLength(3)
        expect(
          (await rowsOf(reply.id)).map(row => [row.deliveryStatus, row.sendErrorCode])
        ).toEqual([
          ['sent', null],
          ['failed', ErrorCodes.CHANNEL_FILE_TOO_LARGE],
          ['sent', null]
        ])
        const failed = await stored(reply.id)
        expect(failed.deliveryStatus).toBe(DeliveryStatus.FAILED)
        expect(failed.deliveryError).toBe(ErrorCodes.CHANNEL_FILE_TOO_LARGE)
        // The first file's id is kept even though the message failed: its receipts and echo find it
        expect(failed.channelMessageId).toBe(`media-${reply.id}-0`)

        mediaFailure = () => null
        sentMedia = []
        // The agent sends it again, through the service: only the file that failed goes back to queued
        const conversation = await owner.conversation.findUniqueOrThrow({
          where: { id: reply.conversationId },
          select: { customerIdentityId: true }
        })
        await owner.customerIdentity.update({
          where: { id: conversation.customerIdentityId },
          data: { lastInboundAt: new Date() }
        })
        await app
          .get(MessagesService, { strict: false })
          .resend(reply.storeId, reply.id, viewerOf(ctx.agentA.id, Object.values(Permissions)))
        expect((await rowsOf(reply.id)).map(row => row.deliveryStatus)).toEqual([
          'sent',
          'queued',
          'sent'
        ])
        const { resentAt } = await owner.message.findUniqueOrThrow({
          where: { id: reply.id },
          select: { resentAt: true }
        })
        if (resentAt === null) throw new Error('the message was not marked as sent again')
        await sender.send(job(reply), false)

        expect(sentMedia.map(params => params.idempotencyKey)).toEqual([
          `${reply.id}-1-${resentAt.getTime()}`
        ])
        // The text went with the first file, which is not sent again
        expect(sentMedia[0]).not.toHaveProperty('caption')
        expect((await rowsOf(reply.id)).map(row => row.deliveryStatus)).toEqual([
          'sent',
          'sent',
          'sent'
        ])
        expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
      })

      it('stops at a failure that may be repeated while there are attempts, and the next attempt skips what went', async () => {
        const { reply } = await replyWithFiles(3)
        mediaFailure = params =>
          params.idempotencyKey === `${reply.id}-1`
            ? new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true })
            : null

        await expect(sender.send(job(reply), false)).rejects.toThrow()

        expect(sentMedia).toHaveLength(2)
        expect((await rowsOf(reply.id)).map(row => row.deliveryStatus)).toEqual([
          'sent',
          'queued',
          'queued'
        ])
        expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.QUEUED)

        mediaFailure = () => null
        sentMedia = []
        await sender.send(job(reply), true)

        // The first is not sent twice; the other two go, in order
        expect(sentMedia.map(params => params.idempotencyKey)).toEqual([
          `${reply.id}-1`,
          `${reply.id}-2`
        ])
        expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
      })

      it('after an ambiguous failure of file k, with the files before it sent, keeps the doubt and sends again only the failed file', async () => {
        const { reply } = await replyWithFiles(3)
        // The second file times out: the provider may or may not have it
        mediaFailure = params =>
          params.idempotencyKey === `${reply.id}-1`
            ? new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
                retryable: false,
                outcomeUnknown: true
              })
            : null
        await sender.send(job(reply), false)

        const failed = await owner.message.findUniqueOrThrow({ where: { id: reply.id } })
        expect(failed.deliveryStatus).toBe(DeliveryStatus.FAILED)
        // Amber, no "throw away": part of it went and one file's outcome is unknown
        expect(failed.failureDefinitive).toBe(false)

        const conversation = await owner.conversation.findUniqueOrThrow({
          where: { id: reply.conversationId },
          select: { customerIdentityId: true }
        })
        await owner.customerIdentity.update({
          where: { id: conversation.customerIdentityId },
          data: { lastInboundAt: new Date() }
        })
        await app
          .get(MessagesService, { strict: false })
          .resend(reply.storeId, reply.id, viewerOf(ctx.agentA.id, Object.values(Permissions)))
        mediaFailure = () => null
        sentMedia = []
        await sender.send(job(reply), false)

        // Only the failed file goes again (the third had gone in the first run)
        expect(sentMedia).toHaveLength(1)
        expect(sentMedia[0]?.idempotencyKey).toMatch(new RegExp(`^${reply.id}-1-\\d+$`))
      })

      it('is a definitive failure only when no file went and every one was refused in so many words', async () => {
        const none = await replyWithFiles(2)
        mediaFailure = () =>
          new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { refused: true })
        await sender.send(job(none.reply), false)
        expect(
          (await owner.message.findUniqueOrThrow({ where: { id: none.reply.id } }))
            .failureDefinitive
        ).toBe(true)

        // The first went and the second was refused: the message has gone in part, so it can be sent again
        // but never thrown away as one that did not go
        const partly = await replyWithFiles(2)
        mediaFailure = params =>
          params.idempotencyKey === `${partly.reply.id}-1`
            ? new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { refused: true })
            : null
        await sender.send(job(partly.reply), false)
        expect(
          (await owner.message.findUniqueOrThrow({ where: { id: partly.reply.id } }))
            .failureDefinitive
        ).toBe(false)

        // Refused, but one of the files gave an answer that says nothing about whether it went
        const unsure = await replyWithFiles(2)
        mediaFailure = params =>
          params.idempotencyKey === `${unsure.reply.id}-1`
            ? new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false })
            : new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { refused: true })
        await sender.send(job(unsure.reply), false)
        expect(
          (await owner.message.findUniqueOrThrow({ where: { id: unsure.reply.id } }))
            .failureDefinitive
        ).toBe(false)
      })

      it('does not send again a file that a receipt already moved to delivered or read', async () => {
        const { reply, files } = await replyWithFiles(3)
        mediaFailure = params =>
          params.idempotencyKey === `${reply.id}-2`
            ? new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true })
            : null
        await expect(sender.send(job(reply), false)).rejects.toThrow()
        await owner.media.update({
          where: { id: files[0]?.id ?? '' },
          data: { deliveryStatus: 'read' }
        })
        await owner.media.update({
          where: { id: files[1]?.id ?? '' },
          data: { deliveryStatus: 'delivered' }
        })
        mediaFailure = () => null
        sentMedia = []

        await sender.send(job(reply), true)

        expect(sentMedia.map(params => params.idempotencyKey)).toEqual([`${reply.id}-2`])
        expect((await rowsOf(reply.id)).map(row => row.deliveryStatus)).toEqual([
          'read',
          'delivered',
          'sent'
        ])
      })

      it("never takes a file back from read when the receipt beats the worker's write", async () => {
        const { reply, files } = await replyWithFiles(1)
        duringMediaSend = async () => {
          await owner.media.update({
            where: { id: files[0]?.id ?? '' },
            data: { deliveryStatus: 'read' }
          })
        }

        await sender.send(job(reply), false)

        expect((await rowsOf(reply.id)).map(row => row.deliveryStatus)).toEqual(['read'])
      })

      it("does not send again, behind the agent's back, a file that failed on an earlier attempt", async () => {
        const { reply } = await replyWithFiles(3)
        mediaFailure = params =>
          params.idempotencyKey === `${reply.id}-0`
            ? new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false })
            : params.idempotencyKey === `${reply.id}-1`
              ? new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true })
              : null
        await expect(sender.send(job(reply), false)).rejects.toThrow()
        mediaFailure = () => null
        sentMedia = []

        await sender.send(job(reply), true)

        // The first one is not sent again; the second and the third go
        expect(sentMedia.map(params => params.idempotencyKey)).toEqual([
          `${reply.id}-1`,
          `${reply.id}-2`
        ])
        const message = await stored(reply.id)
        expect(message.deliveryStatus).toBe(DeliveryStatus.FAILED)
        expect(
          (await owner.message.findUniqueOrThrow({ where: { id: reply.id } })).failureDefinitive
        ).toBe(false)
      })

      it('keeps the id of the caption of the first file when a later file makes the job try again', async () => {
        const { reply } = await replyWithFiles(2)
        mediaResult = { metadata: { captionExternalId: 'cap-multi' } }
        mediaFailure = params =>
          params.idempotencyKey === `${reply.id}-1`
            ? new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true })
            : null
        await expect(sender.send(job(reply), false)).rejects.toThrow()
        mediaFailure = () => null

        await sender.send(job(reply), true)

        const row = await owner.message.findUniqueOrThrow({
          where: { id: reply.id },
          select: { captionChannelMessageId: true, captionState: true, deliveryStatus: true }
        })
        expect(row).toMatchObject({
          captionChannelMessageId: 'cap-multi',
          captionState: 'sent',
          deliveryStatus: 'sent'
        })
      })

      it('keeps a clean-refusal mark when an earlier file of the same attempt left the outcome unknown', async () => {
        const { reply } = await replyWithFiles(2)
        mediaFailure = params =>
          params.idempotencyKey === `${reply.id}-0`
            ? new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false })
            : new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
                refused: true,
                retryable: true
              })

        await expect(sender.send(job(reply), false)).rejects.toThrow()

        expect(
          (await owner.message.findUniqueOrThrow({ where: { id: reply.id } })).failureDefinitive
        ).toBe(false)
      })

      it('fails the file that is not clean and sends the rest', async () => {
        const { reply, files } = await replyWithFiles(3)
        await owner.media.update({
          where: { id: files[2]?.id ?? '' },
          data: { status: 'infected' }
        })

        await sender.send(job(reply), false)

        expect(sentMedia).toHaveLength(2)
        expect(
          (await rowsOf(reply.id)).map(row => [row.deliveryStatus, row.sendErrorCode])
        ).toEqual([
          ['sent', null],
          ['sent', null],
          ['failed', ErrorCodes.FILE_UNAVAILABLE]
        ])
        expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.FAILED)
      })

      it('fails the message when its first file failed and none went, with no id to keep', async () => {
        const { reply } = await replyWithFiles(2)
        mediaFailure = () =>
          new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false })

        await sender.send(job(reply), false)

        const message = await stored(reply.id)
        expect(message.deliveryStatus).toBe(DeliveryStatus.FAILED)
        expect(message.channelMessageId).toBeNull()
        expect((await rowsOf(reply.id)).map(row => row.deliveryStatus)).toEqual([
          'failed',
          'failed'
        ])
      })

      it('sends a message of files written before each had a state as it always did', async () => {
        const reply = await queuedReply({ pluginId: MEDIA_CHANNEL_ID, type: MessageType.IMAGE })
        await fileOf(reply.storeId, { messageId: reply.id })

        await sender.send(job(reply), false)

        expect(sentMedia.map(params => params.idempotencyKey)).toEqual([reply.id])
        expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
        expect((await rowsOf(reply.id)).map(row => row.deliveryStatus)).toEqual(['sent'])
      })
    })
  })

  describe('the receipts of the provider', () => {
    const receipt = (
      reply: { connectionId: string },
      type: 'message_delivered' | 'message_read' | 'message_failed',
      externalId: string,
      isLastAttempt = false
    ) =>
      receipts.handleReceipt(
        TEST_CHANNEL_ID,
        {
          type,
          connectionId: reply.connectionId,
          channelIdentity: '50370000000',
          status: { externalId },
          timestamp: new Date().toISOString()
        },
        isLastAttempt
      )

    const sentReply = async () => {
      const reply = await queuedReply()
      await sender.send(job(reply), false)
      const { channelMessageId } = await stored(reply.id)
      heard = []
      return { ...reply, externalId: channelMessageId ?? '' }
    }

    it('moves a file by its own receipt, and the message only once every file has reached that state', async () => {
      const reply = await queuedReply({ pluginId: MULTI_MEDIA_CHANNEL_ID, type: MessageType.IMAGE })
      for (let position = 0; position < 3; position += 1) {
        const id = randomUUID()
        await owner.media.create({
          data: {
            id,
            storeId: reply.storeId,
            purpose: 'message',
            messageId: reply.id,
            key: `stores/${reply.storeId}/messages/${id}/p.png`,
            filename: 'p.png',
            contentType: 'image/png',
            fileSize: 10,
            status: 'clean',
            position,
            deliveryStatus: 'queued',
            createdAt: new Date(Date.now() + position)
          }
        })
      }
      await sender.send(job(reply), false)

      const aboutFile = (position: number, type: 'message_delivered' | 'message_read') =>
        receipts.handleReceipt(
          MULTI_MEDIA_CHANNEL_ID,
          {
            type,
            connectionId: reply.connectionId,
            channelIdentity: '50370000000',
            status: { externalId: `media-${reply.id}-${position}` },
            timestamp: new Date().toISOString()
          },
          false
        )
      const states = async () =>
        (
          await owner.media.findMany({
            where: { messageId: reply.id },
            orderBy: { position: 'asc' },
            select: { deliveryStatus: true }
          })
        ).map(file => file.deliveryStatus)
      await aboutFile(2, 'message_read')

      // One file read is one file read: the message is not read while the others are not
      expect(await states()).toEqual(['sent', 'sent', 'read'])
      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
      // A receipt that arrives late for an earlier state never takes a file back
      await aboutFile(2, 'message_delivered')
      expect(await states()).toEqual(['sent', 'sent', 'read'])
      await aboutFile(0, 'message_read')
      await aboutFile(1, 'message_read')

      expect(await states()).toEqual(['read', 'read', 'read'])
      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.READ)
    })

    it('fails the message when a later file fails by receipt, and only that file', async () => {
      const reply = await queuedReply({ pluginId: MULTI_MEDIA_CHANNEL_ID, type: MessageType.IMAGE })
      for (let position = 0; position < 2; position += 1) {
        const id = randomUUID()
        await owner.media.create({
          data: {
            id,
            storeId: reply.storeId,
            purpose: 'message',
            messageId: reply.id,
            key: `stores/${reply.storeId}/messages/${id}/p.png`,
            filename: 'p.png',
            contentType: 'image/png',
            fileSize: 10,
            status: 'clean',
            position,
            deliveryStatus: 'queued',
            createdAt: new Date(Date.now() + position)
          }
        })
      }
      await sender.send(job(reply), false)

      await receipts.handleReceipt(
        MULTI_MEDIA_CHANNEL_ID,
        {
          type: 'message_failed',
          connectionId: reply.connectionId,
          channelIdentity: '50370000000',
          status: { externalId: `media-${reply.id}-1` },
          timestamp: new Date().toISOString()
        },
        false
      )

      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.FAILED)
      const files = await owner.media.findMany({
        where: { messageId: reply.id },
        orderBy: { position: 'asc' },
        select: { deliveryStatus: true }
      })
      expect(files.map(file => file.deliveryStatus)).toEqual(['sent', 'failed'])
    })

    it('moves a sent reply to delivered and then read, and says each once', async () => {
      const reply = await sentReply()

      await receipt(reply, ChannelEventTypes.MESSAGE_DELIVERED, reply.externalId)
      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.DELIVERED)
      await receipt(reply, ChannelEventTypes.MESSAGE_READ, reply.externalId)
      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.READ)

      await receipt(reply, ChannelEventTypes.MESSAGE_READ, reply.externalId)
      expect(eventsOf(Events.MESSAGE_DELIVERED)).toHaveLength(1)
      expect(eventsOf(Events.MESSAGE_READ)).toHaveLength(1)
    })

    it('never takes a message back: a late delivered or a failure after read changes nothing', async () => {
      const reply = await sentReply()
      await receipt(reply, ChannelEventTypes.MESSAGE_READ, reply.externalId)
      heard = []

      await receipt(reply, ChannelEventTypes.MESSAGE_DELIVERED, reply.externalId)
      await receipt(reply, ChannelEventTypes.MESSAGE_FAILED, reply.externalId)

      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.READ)
      expect(heard).toHaveLength(0)
    })

    it('fails a sent reply that the provider could not deliver, with a code of ours', async () => {
      const reply = await sentReply()

      await receipts.handleReceipt(
        TEST_CHANNEL_ID,
        {
          type: ChannelEventTypes.MESSAGE_FAILED,
          connectionId: reply.connectionId,
          channelIdentity: '50370000000',
          status: {
            externalId: reply.externalId,
            error: { code: 'x', message: 'token EAAB-secret leaked here' }
          },
          timestamp: new Date().toISOString()
        },
        false
      )

      expect(await stored(reply.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_MESSAGE_FAILED
      })
      expect(JSON.stringify(heard)).not.toContain('EAAB-secret')
    })

    it('ignores a receipt that names a message of another connection, even with the right id', async () => {
      const reply = await sentReply()
      const other = await queuedReply({ storeId: ctx.storeB.id })

      await receipt(other, ChannelEventTypes.MESSAGE_READ, reply.externalId, true)

      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
    })

    it('tries again a receipt that came before its message was written, and gives up on the last attempt', async () => {
      const waiting = await queuedReply()

      await expect(
        receipt(waiting, ChannelEventTypes.MESSAGE_DELIVERED, 'not-written-yet')
      ).rejects.toThrow('before the provider id')
      await expect(
        receipt(waiting, ChannelEventTypes.MESSAGE_DELIVERED, 'not-written-yet', true)
      ).resolves.toBeUndefined()
    })

    it('still waits for a reply that is in its retries: the wait is as long as the retries', async () => {
      const retrying = await queuedReply({ createdAt: new Date(Date.now() - THREE_MINUTES_MS) })

      await expect(
        receipt(retrying, ChannelEventTypes.MESSAGE_DELIVERED, 'unknown')
      ).rejects.toThrow('before the provider id')
    })

    it('applies a receipt to no message when two of the connection have that provider id', async () => {
      const reply = await sentReply()
      const first = await owner.message.findUniqueOrThrow({
        where: { id: reply.id },
        select: { conversation: { select: { channelConnectionId: true } } }
      })
      const identity = await createCustomerIdentity(owner, {
        storeId: reply.storeId,
        channelType: TEST_CHANNEL_ID
      })
      const other = await createConversation(owner, {
        storeId: reply.storeId,
        customerId: identity.customerId,
        customerIdentityId: identity.id,
        channelType: TEST_CHANNEL_ID,
        channelConnectionId: first.conversation.channelConnectionId
      })
      const twin = await owner.message.create({
        data: {
          storeId: reply.storeId,
          conversationId: other.id,
          type: MessageType.TEXT,
          content: 'twin',
          authorType: AuthorType.AGENT,
          deliveryStatus: DeliveryStatus.SENT,
          channelMessageId: reply.externalId
        },
        select: { id: true }
      })

      await receipt(reply, ChannelEventTypes.MESSAGE_READ, reply.externalId, true)

      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
      expect((await stored(twin.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
    })

    it('drops at once a receipt for an unknown message when nothing is waiting in that connection', async () => {
      const settled = await queuedReply({ deliveryStatus: DeliveryStatus.SENT })

      await expect(
        receipt(settled, ChannelEventTypes.MESSAGE_DELIVERED, 'sent-from-the-phone')
      ).resolves.toBeUndefined()
    })

    it('does not wait for a reply that has been queued for long: it is the sweep that handles it', async () => {
      const old = await queuedReply({ createdAt: new Date(Date.now() - SIX_MINUTES_MS) })

      await expect(
        receipt(old, ChannelEventTypes.MESSAGE_DELIVERED, 'unknown')
      ).resolves.toBeUndefined()
    })

    it('ignores a receipt for a message the platform did not send', async () => {
      const reply = await sentReply()
      await owner.message.update({
        where: { id: reply.id },
        data: { authorType: AuthorType.CUSTOMER }
      })

      await receipt(reply, ChannelEventTypes.MESSAGE_READ, reply.externalId)

      expect((await stored(reply.id)).deliveryStatus).toBe(DeliveryStatus.SENT)
    })
  })

  describe('a connection error of the provider', () => {
    it('puts the connection in error with the reason cleaned, and says it', async () => {
      const reply = await queuedReply()

      await receipts.handleConnectionError(TEST_CHANNEL_ID, {
        type: ChannelEventTypes.CONNECTION_ERROR,
        connectionId: reply.connectionId,
        channelIdentity: reply.connectionId,
        status: { externalId: 'x', error: { code: 'revoked', message: 'token‮ revoked' } },
        timestamp: new Date().toISOString()
      })

      const row = await owner.channelConnection.findFirstOrThrow({
        where: { connectionId: reply.connectionId },
        select: { status: true, lastError: true }
      })
      expect(row).toEqual({ status: ChannelConnectionStatus.ERROR, lastError: 'token revoked' })
      expect(eventsOf(Events.CHANNEL_DISCONNECTED)).toHaveLength(1)
    })

    it('leaves a disconnected connection as it is', async () => {
      const reply = await queuedReply({ status: ChannelConnectionStatus.DISCONNECTED })

      await receipts.handleConnectionError(TEST_CHANNEL_ID, {
        type: ChannelEventTypes.CONNECTION_ERROR,
        connectionId: reply.connectionId,
        channelIdentity: reply.connectionId,
        timestamp: new Date().toISOString()
      })

      const row = await owner.channelConnection.findFirstOrThrow({
        where: { connectionId: reply.connectionId },
        select: { status: true }
      })
      expect(row.status).toBe(ChannelConnectionStatus.DISCONNECTED)
    })
  })

  describe('the way in: POST /messages', () => {
    it('queues the reply after it is stored, once, with the message as the job id; a note is not queued', async () => {
      const conversation = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelIds.INSTAGRAM
      })
      // The channel has a messaging window: the customer wrote a moment ago
      await owner.customerIdentity.update({
        where: { id: conversation.customerIdentityId },
        data: { lastInboundAt: new Date() }
      })
      const queue = queueOf(app, QueueNames.OUTBOUND)
      queue.jobs.length = 0

      const reply = await api(app, ctx.agentA, ctx.storeA)
        .post(ApiRoutes.messages.create)
        .send({
          conversationId: conversation.id,
          type: MessageType.TEXT,
          content: 'hi',
          idempotencyKey: randomUUID()
        })
        .expect(CREATED)
      await api(app, ctx.agentA, ctx.storeA)
        .post(ApiRoutes.messages.create)
        .send({
          conversationId: conversation.id,
          type: MessageType.INTERNAL_NOTE,
          content: 'team only',
          mentions: []
        })
        .expect(CREATED)

      const created = reply.body as { id: string }
      expect(queue.jobs).toEqual([
        {
          name: JobNames.SEND_OUTBOUND_MESSAGE,
          data: { storeId: ctx.storeA.id, messageId: created.id },
          opts: { jobId: `send-${created.id}` }
        }
      ])
    })
  })

  describe('a retry of the same request', () => {
    it('queues the reply again, with the same job id, so that a failed first enqueue is not left to the sweep', async () => {
      const conversation = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelIds.INSTAGRAM
      })
      await owner.customerIdentity.update({
        where: { id: conversation.customerIdentityId },
        data: { lastInboundAt: new Date() }
      })
      const queue = queueOf(app, QueueNames.OUTBOUND)
      queue.jobs.length = 0
      const body = {
        conversationId: conversation.id,
        type: MessageType.TEXT,
        content: 'hi again',
        idempotencyKey: randomUUID()
      }

      await api(app, ctx.agentA, ctx.storeA)
        .post(ApiRoutes.messages.create)
        .send(body)
        .expect(CREATED)
      await api(app, ctx.agentA, ctx.storeA).post(ApiRoutes.messages.create).send(body).expect(OK)

      expect(queue.jobs.map(item => item.opts?.jobId)).toHaveLength(2)
      expect(new Set(queue.jobs.map(item => item.opts?.jobId)).size).toBe(1)
    })

    it('does not queue a reply that has already left the queue', async () => {
      const conversation = await createConversationOf(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelIds.INSTAGRAM
      })
      await owner.customerIdentity.update({
        where: { id: conversation.customerIdentityId },
        data: { lastInboundAt: new Date() }
      })
      const body = {
        conversationId: conversation.id,
        type: MessageType.TEXT,
        content: 'already out',
        idempotencyKey: randomUUID()
      }
      const first = await api(app, ctx.agentA, ctx.storeA)
        .post(ApiRoutes.messages.create)
        .send(body)
        .expect(CREATED)
      await owner.message.update({
        where: { id: (first.body as { id: string }).id },
        data: { deliveryStatus: DeliveryStatus.SENT }
      })
      const queue = queueOf(app, QueueNames.OUTBOUND)
      queue.jobs.length = 0

      await api(app, ctx.agentA, ctx.storeA).post(ApiRoutes.messages.create).send(body).expect(OK)

      expect(queue.jobs).toHaveLength(0)
    })
  })

  describe('the sweep', () => {
    it('goes on with the next reply when one cannot be queued, and counts what it did', async () => {
      const oldest = await queuedReply({ createdAt: new Date(Date.now() - 20 * 60_000) })
      const next = await queuedReply({ createdAt: new Date(Date.now() - 10 * 60_000) })
      const forgotten = await queuedReply({ createdAt: new Date(Date.now() - TWO_HOURS_MS) })
      const queue = queueOf(app, QueueNames.OUTBOUND)
      queue.jobs.length = 0
      const requeue = jest.spyOn(outboundQueue, 'requeue')
      requeue.mockImplementation(async (item: { messageId: string }) => {
        if (item.messageId === oldest.id) throw new Error('redis is down')
        await outboundQueue.enqueue(item as never)
      })

      const result = await sweep.requeueStale()
      requeue.mockRestore()

      const queued = queue.jobs.map(item => (item.data as { messageId: string }).messageId)
      expect(queued).toContain(next.id)
      expect(queued).not.toContain(oldest.id)
      expect((await stored(forgotten.id)).deliveryStatus).toBe(DeliveryStatus.FAILED)
      expect(result.requeued).toBeGreaterThanOrEqual(1)
      expect(result.gaveUp).toBeGreaterThanOrEqual(1)
    })

    it('counts the age of a reply sent again from the moment it was asked for again', async () => {
      const longAgo = new Date(Date.now() - TWO_HOURS_MS)
      const justResent = await queuedReply({ createdAt: longAgo, resentAt: new Date() })
      const resentAWhileAgo = await queuedReply({
        createdAt: longAgo,
        resentAt: new Date(Date.now() - THREE_MINUTES_MS)
      })
      const queue = queueOf(app, QueueNames.OUTBOUND)
      queue.jobs.length = 0

      await sweep.requeueStale()

      const queued = queue.jobs.map(item => (item.data as { messageId: string }).messageId)
      // Neither is given up for the age of its first attempt, and only the one that waited is queued
      expect(queued).toContain(resentAWhileAgo.id)
      expect(queued).not.toContain(justResent.id)
      expect((await stored(justResent.id)).deliveryStatus).toBe(DeliveryStatus.QUEUED)
      expect((await stored(resentAWhileAgo.id)).deliveryStatus).toBe(DeliveryStatus.QUEUED)
    })

    it('queues again a reply that stayed queued, and leaves a recent one and a settled one alone', async () => {
      const old = new Date(Date.now() - THREE_MINUTES_MS)
      const stale = await queuedReply({ createdAt: old })
      const recent = await queuedReply()
      const settled = await queuedReply({ createdAt: old, deliveryStatus: DeliveryStatus.SENT })
      const forgotten = await queuedReply({ createdAt: new Date(Date.now() - TWO_HOURS_MS) })
      const queue = queueOf(app, QueueNames.OUTBOUND)
      queue.jobs.length = 0
      heard = []

      await sweep.requeueStale()

      const queued = queue.jobs.map(item => (item.data as { messageId: string }).messageId)
      expect(queued).toContain(stale.id)
      expect(queued).not.toContain(recent.id)
      expect(queued).not.toContain(settled.id)
      // One that waited for hours is not sent late: it fails, and the agent is told
      expect(queued).not.toContain(forgotten.id)
      expect(await stored(forgotten.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_MESSAGE_FAILED
      })
      expect(eventsOf(Events.MESSAGE_FAILED)).toHaveLength(1)
    })
  })
})
