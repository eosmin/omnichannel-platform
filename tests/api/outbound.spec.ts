import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { PinoLogger } from 'nestjs-pino'

import { ChannelContextFactory, ChannelHealthService } from '@platform/channels/connections'
import { ApiRoutes } from '@platform/core/api'
import type { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ChannelConnectionStatus,
  PluginInstallationStatus,
  ChannelIds,
  DeliveryStatus,
  MessageType
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { ChannelConnectionResolver, OutboundQueue } from '@platform/core/messaging'
import { JobNames, QueueNames } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'
import {
  type ChannelContext,
  ChannelEventTypes,
  PluginError,
  type SendMessageParams
} from '@platform/plugins/sdk'

import { ChannelReceipts } from '../../apps/worker/src/outbound/channel-receipts.service'
import { MessageStatusWriter } from '../../apps/worker/src/outbound/message-status.writer'
import { OutboundSender } from '../../apps/worker/src/outbound/outbound-sender.service'
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

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    prisma = app.get(PrismaService, { strict: false })
    const registry = app.get(PluginRegistry, { strict: false })
    const pluginOf = (id: string): ReturnType<typeof buildChannelPlugin> =>
      buildChannelPlugin({ id, sendMessage: (c, p) => sendMessage(c, p) })
    registry.register(pluginOf(TEST_CHANNEL_ID))
    registry.register(pluginOf(ChannelIds.INSTAGRAM), { official: true })

    const logger: PinoLogger = await app.resolve(PinoLogger)
    const events = app.get(DomainEvents, { strict: false })
    writer = new MessageStatusWriter(prisma, events)
    // The rows of the suite hold bytes that are no ciphertext: the context is what the plugin gets
    const cipher = { open: () => ({}) } as unknown as CredentialCipher // test double of the cipher
    const contexts = new ChannelContextFactory(cipher)
    sender = new OutboundSender(prisma, registry, contexts, writer, logger)
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
    } = {}
  ): Promise<{ id: string; storeId: string; connectionId: string; conversationId: string }> => {
    const storeId = over.storeId ?? ctx.storeA.id
    const pluginId = over.pluginId ?? TEST_CHANNEL_ID
    const identity = await createCustomerIdentity(owner, { storeId, channelType: pluginId })
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
      channelConnectionId: connection.id
    })
    const message = await owner.message.create({
      data: {
        storeId,
        conversationId: conversation.id,
        type: over.type ?? MessageType.TEXT,
        content: over.content ?? 'hello there',
        authorType: AuthorType.AGENT,
        deliveryStatus: over.deliveryStatus ?? DeliveryStatus.QUEUED,
        ...(over.createdAt === undefined ? {} : { createdAt: over.createdAt })
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

    it('fails, and sends nothing, a reply that is not text', async () => {
      const reply = await queuedReply({ type: MessageType.IMAGE })

      await sender.send(job(reply), false)

      expect(await stored(reply.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED
      })
      expect(sent).toHaveLength(0)
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
