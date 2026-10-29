import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { ChannelContextFactory } from '@platform/channels/connections'
import { ApiRoutes } from '@platform/core/api'
import type { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { AuthorType, DeliveryStatus, MessageType } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { OutboundQueue } from '@platform/core/messaging'
import { JobNames, QueueNames, type SendOutboundReactionJob } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'
import {
  ChannelCapability,
  type ChannelContext,
  PluginError,
  type SendReactionParams
} from '@platform/plugins/sdk'

import { MessageChangeStatusWriter } from '../../apps/worker/src/outbound/message-change-status.writer'
import { ReactionSender } from '../../apps/worker/src/outbound/reaction-sender.service'
import { ReactionStatusWriter } from '../../apps/worker/src/outbound/reaction-status.writer'
import { OutboundRequeueScheduler } from '../../apps/worker/src/schedulers/outbound-requeue.scheduler'
import {
  buildChannelPlugin,
  createChannelConnection,
  createConversation,
  createCustomerIdentity,
  TEST_CHANNEL_ID
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { queueOf } from '../helpers/queue'

const NO_CONTENT = 204
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const BAD_REQUEST = 400
const PLAIN_TEXT_CHANNEL = 'plain_channel'

describe('An agent reacting to a message', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let sender: ReactionSender
  let sweep: OutboundRequeueScheduler
  let sentReactions: SendReactionParams[] = []
  let sendReaction: (ctx: ChannelContext, params: SendReactionParams) => Promise<void>

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const prisma = app.get(PrismaService, { strict: false })
    const registry = app.get(PluginRegistry, { strict: false })
    registry.register(
      buildChannelPlugin({
        capabilities: [ChannelCapability.TEXT, ChannelCapability.REACTIONS],
        sendReaction: (c, p) => sendReaction(c, p)
      })
    )
    registry.register(buildChannelPlugin({ id: PLAIN_TEXT_CHANNEL }))
    const events = app.get(DomainEvents, { strict: false })
    // The rows of the suite hold bytes that are no ciphertext: the context is what the plugin gets
    const cipher = { open: () => ({}) } as unknown as CredentialCipher // test double of the cipher
    sender = new ReactionSender(
      prisma,
      registry,
      new ChannelContextFactory(cipher),
      new ReactionStatusWriter(prisma, events),
      await app.resolve(PinoLogger)
    )
    sweep = new OutboundRequeueScheduler(
      { withLock: (_name: string, _seconds: number, work: () => Promise<void>) => work() } as never, // the lock is not what is tested
      prisma,
      new OutboundQueue(queueOf(app, QueueNames.OUTBOUND) as never),
      undefined as never, // the replies are not what is tested
      new ReactionStatusWriter(prisma, events),
      new MessageChangeStatusWriter(prisma, events),
      await app.resolve(PinoLogger)
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    sentReactions = []
    queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
    sendReaction = (_ctx, params) => {
      sentReactions.push(params)
      return Promise.resolve()
    }
  })

  // A message of a customer that the channel knows by id, in a conversation of its own
  const customerMessage = async (
    over: {
      channelMessageId?: string | null
      type?: MessageType
      pluginId?: string
      storeId?: string
    } = {}
  ): Promise<{
    id: string
    storeId: string
    conversationId: string
    externalId: string | null
  }> => {
    const storeId = over.storeId ?? ctx.storeA.id
    const pluginId = over.pluginId ?? TEST_CHANNEL_ID
    const identity = await createCustomerIdentity(owner, { storeId, channelType: pluginId })
    const connection = await createChannelConnection(owner, { storeId, channelType: pluginId })
    const conversation = await createConversation(owner, {
      storeId,
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType: pluginId,
      channelConnectionId: connection.id
    })
    const externalId =
      over.channelMessageId === undefined ? `wamid-${randomUUID()}` : over.channelMessageId
    const message = await owner.message.create({
      data: {
        storeId,
        conversationId: conversation.id,
        type: over.type ?? MessageType.TEXT,
        content: 'hello',
        authorType: AuthorType.CUSTOMER,
        channelMessageId: externalId
      },
      select: { id: true }
    })
    return { id: message.id, storeId, conversationId: conversation.id, externalId }
  }
  const react = (messageId: string, emoji: string | null, who = ctx.agentA) =>
    api(app, who, ctx.storeA).put(ApiRoutes.messages.reaction(messageId)).send({ emoji })
  const stored = (messageId: string) =>
    owner.messageReaction.findFirst({
      where: { messageId, authorType: AuthorType.AGENT },
      select: { emoji: true, deliveryStatus: true, deliveryError: true, updatedAt: true }
    })
  const queuedJob = (): SendOutboundReactionJob => {
    const jobs = queueOf(app, QueueNames.OUTBOUND).jobs.filter(
      item => item.name === JobNames.SEND_OUTBOUND_REACTION
    )
    expect(jobs).toHaveLength(1)
    return jobs[0]?.data as SendOutboundReactionJob
  }

  describe('the endpoint', () => {
    it('stores the reaction as queued, queues one job and shows it in the thread', async () => {
      const message = await customerMessage()

      const response = await react(message.id, '👍')

      expect(response.status).toBe(NO_CONTENT)
      expect(await stored(message.id)).toMatchObject({
        emoji: '👍',
        deliveryStatus: DeliveryStatus.QUEUED
      })
      const job = queuedJob()
      expect(job).toMatchObject({ storeId: ctx.storeA.id, messageId: message.id })
      expect(job.userId).toBe(ctx.agentA.id)
      const thread = await api(app, ctx.agentA, ctx.storeA).get(
        ApiRoutes.conversations.messages(message.conversationId)
      )
      expect((thread.body as { data: { reactions: unknown[] }[] }).data[0]?.reactions).toEqual([
        {
          emoji: '👍',
          authorType: AuthorType.AGENT,
          authorId: ctx.agentA.id,
          deliveryStatus: DeliveryStatus.QUEUED,
          deliveryError: null
        }
      ])
    })

    it('replaces the emoji and queues a job for the new one', async () => {
      const message = await customerMessage()
      await react(message.id, '👍')
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0

      await react(message.id, '❤️')

      expect((await stored(message.id))?.emoji).toBe('❤️')
      expect(queuedJob().messageId).toBe(message.id)
    })

    it('queues nothing for the same emoji that is already waiting', async () => {
      const message = await customerMessage()
      await react(message.id, '👍')
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0

      await react(message.id, '👍')

      expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
    })

    it('queues nothing, and keeps it sent, for the same emoji that the channel took', async () => {
      const message = await customerMessage()
      await react(message.id, '👍')
      await sender.send(queuedJob(), false)
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0

      await react(message.id, '👍')

      expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
      expect((await stored(message.id))?.deliveryStatus).toBe(DeliveryStatus.SENT)
    })

    it('sends again the same emoji that the channel refused', async () => {
      const message = await customerMessage()
      await react(message.id, '👍')
      await owner.messageReaction.updateMany({
        where: { messageId: message.id },
        data: {
          deliveryStatus: DeliveryStatus.FAILED,
          deliveryError: ErrorCodes.CHANNEL_MESSAGE_FAILED
        }
      })
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0

      await react(message.id, '👍')

      expect(await stored(message.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.QUEUED,
        deliveryError: null
      })
      expect(queuedJob().messageId).toBe(message.id)
    })

    it('takes the reaction back with a null emoji, and queues the removal', async () => {
      const message = await customerMessage()
      await react(message.id, '👍')
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0

      const response = await react(message.id, null)

      expect(response.status).toBe(NO_CONTENT)
      expect(await stored(message.id)).toBeNull()
      expect(queuedJob().messageId).toBe(message.id)
    })

    it('refuses a message with no copy in the channel (a note, a reply not sent yet)', async () => {
      const noId = await customerMessage({ channelMessageId: null })

      expect((await react(noId.id, '👍')).status).toBe(CONFLICT)
      expect(await stored(noId.id)).toBeNull()
    })

    it.each([MessageType.INTERNAL_NOTE, MessageType.SYSTEM])(
      'refuses a %s, even with an id in the channel',
      async type => {
        const message = await customerMessage({ type })

        expect((await react(message.id, '👍')).status).toBe(CONFLICT)
        expect(await stored(message.id)).toBeNull()
      }
    )

    it('keeps the reactions of different people apart', async () => {
      const message = await customerMessage()
      await owner.messageReaction.create({
        data: {
          storeId: ctx.storeA.id,
          messageId: message.id,
          authorType: AuthorType.EXTERNAL,
          emoji: '🙏',
          deliveryStatus: DeliveryStatus.SENT
        }
      })
      await react(message.id, '👍')
      await react(message.id, '🔥', ctx.adminA)
      const emojisOf = async () =>
        (await owner.messageReaction.findMany({ where: { messageId: message.id } }))
          .map(row => row.emoji)
          .sort()

      expect(await emojisOf()).toEqual(['👍', '🔥', '🙏'].sort())
      await react(message.id, null)

      expect(await emojisOf()).toEqual(['🔥', '🙏'].sort())
    })

    it('queues nothing for a removal when the agent had no reaction', async () => {
      const message = await customerMessage()
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0

      expect((await react(message.id, null)).status).toBe(NO_CONTENT)

      expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
    })

    it('refuses a channel that does not take reactions', async () => {
      const message = await customerMessage({ pluginId: PLAIN_TEXT_CHANNEL })

      const response = await react(message.id, '👍')

      expect(response.status).toBe(CONFLICT)
      expect((response.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED
      )
      expect(await stored(message.id)).toBeNull()
    })

    it('needs the permission to send messages', async () => {
      const message = await customerMessage()

      const response = await react(message.id, '👍', ctx.viewerA)

      expect(response.status).toBe(FORBIDDEN)
      expect(await stored(message.id)).toBeNull()
    })

    it('answers 404 for a message that does not exist, and for one of another store', async () => {
      const elsewhere = await customerMessage({ storeId: ctx.storeB.id })

      expect((await react(randomUUID(), '👍')).status).toBe(NOT_FOUND)
      expect((await react(elsewhere.id, '👍')).status).toBe(NOT_FOUND)
      expect(await owner.messageReaction.count({ where: { messageId: elsewhere.id } })).toBe(0)
    })

    // Nothing visible, or what the database would refuse
    it.each(['', ' ', '\0', 'x'.repeat(40)])('refuses %j as an emoji', async emoji => {
      const message = await customerMessage()

      const response = await react(message.id, emoji)

      expect(response.status).toBe(BAD_REQUEST)
      expect(await stored(message.id)).toBeNull()
    })
  })

  describe('the worker', () => {
    const queue = async (emoji: string | null) => {
      const message = await customerMessage()
      await react(message.id, emoji)
      return { message, job: queuedJob() }
    }

    it('sends the reaction to the plugin and settles it as sent', async () => {
      const { message, job } = await queue('👍')

      await sender.send(job, false)

      expect(sentReactions).toEqual([
        expect.objectContaining({ targetExternalId: message.externalId, emoji: '👍' })
      ])
      expect(await stored(message.id)).toMatchObject({
        emoji: '👍',
        deliveryStatus: DeliveryStatus.SENT,
        deliveryError: null
      })
    })

    it('sends a null emoji for a reaction that was taken back', async () => {
      const message = await customerMessage()
      await react(message.id, '👍')
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
      await react(message.id, null)

      await sender.send(queuedJob(), false)

      expect(sentReactions).toEqual([expect.objectContaining({ emoji: null })])
    })

    it('settles as failed, with a code of ours, when the plugin refuses for good', async () => {
      sendReaction = () =>
        Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false }))
      const { message, job } = await queue('👍')

      await sender.send(job, false)

      expect(await stored(message.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_MESSAGE_FAILED
      })
    })

    it('tries again while the error may pass, and fails on the last attempt', async () => {
      sendReaction = () => Promise.reject(new Error('socket hang up'))
      const { message, job } = await queue('👍')

      await expect(sender.send(job, false)).rejects.toThrow('sending a reaction failed')
      expect((await stored(message.id))?.deliveryStatus).toBe(DeliveryStatus.QUEUED)
      await sender.send(job, true)

      expect((await stored(message.id))?.deliveryStatus).toBe(DeliveryStatus.FAILED)
    })

    it('leaves alone a job of an emoji that was replaced since', async () => {
      const message = await customerMessage()
      await react(message.id, '👍')
      const first = queuedJob()
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
      await react(message.id, '🔥')
      const second = queuedJob()

      await sender.send(first, false)
      expect(sentReactions).toHaveLength(0)
      await sender.send(second, false)

      expect(sentReactions).toEqual([expect.objectContaining({ emoji: '🔥' })])
    })

    it('leaves alone a removal job when the agent reacted again since', async () => {
      const message = await customerMessage()
      await react(message.id, '👍')
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
      await react(message.id, null)
      const removal = queuedJob()
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
      await react(message.id, '🔥')

      await sender.send(removal, false)

      expect(sentReactions).toHaveLength(0)
      expect((await stored(message.id))?.deliveryStatus).toBe(DeliveryStatus.QUEUED)
    })

    it('ends a removal that the channel refused, which only the log can tell', async () => {
      const message = await customerMessage()
      await react(message.id, '👍')
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
      await react(message.id, null)
      sendReaction = () =>
        Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false }))

      await expect(sender.send(queuedJob(), false)).resolves.toBeUndefined()

      expect(await stored(message.id)).toBeNull()
    })

    it('does not send a reaction that was settled already', async () => {
      const { job } = await queue('👍')
      await sender.send(job, false)
      sentReactions = []

      await sender.send(job, false)

      expect(sentReactions).toHaveLength(0)
    })

    it('settles as failed when the connection is gone', async () => {
      const { message, job } = await queue('👍')
      await owner.channelConnection.updateMany({
        where: { conversations: { some: { id: message.conversationId } } },
        data: { status: 'disconnected' }
      })

      await sender.send(job, false)

      expect(sentReactions).toHaveLength(0)
      expect(await stored(message.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_NOT_CONNECTED
      })
    })
  })

  describe('the sweep', () => {
    // The sweep looks at every store: what earlier tests left aged and queued would be swept here
    beforeEach(async () => {
      await owner.messageReaction.deleteMany({ where: { storeId: ctx.storeA.id } })
    })
    const MINUTE_MS = 60_000
    const TWO_HOURS_MS = 120 * MINUTE_MS
    const ageReaction = (messageId: string, ms: number) =>
      owner.messageReaction.updateMany({
        where: { messageId, authorType: AuthorType.AGENT },
        data: { updatedAt: new Date(Date.now() - ms) }
      })

    it('queues again a reaction that stayed queued, with the version it had', async () => {
      const message = await customerMessage()
      await react(message.id, '👍')
      await ageReaction(message.id, 5 * MINUTE_MS)
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0

      await sweep.requeueStaleReactions()

      const job = queuedJob()
      const row = await stored(message.id)
      expect(job).toMatchObject({ messageId: message.id, userId: ctx.agentA.id })
      expect(job.version).toBe(row?.updatedAt.getTime())
      await sender.send(job, false)
      expect(sentReactions).toEqual([expect.objectContaining({ emoji: '👍' })])
    })

    it('leaves alone a recent reaction and one that was settled', async () => {
      const recent = await customerMessage()
      await react(recent.id, '👍')
      const settled = await customerMessage()
      await react(settled.id, '🔥')
      await owner.messageReaction.updateMany({
        where: { messageId: settled.id },
        data: {
          deliveryStatus: DeliveryStatus.SENT,
          updatedAt: new Date(Date.now() - TWO_HOURS_MS)
        }
      })
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0

      await sweep.requeueStaleReactions()

      const queued = queueOf(app, QueueNames.OUTBOUND).jobs.map(
        item => (item.data as SendOutboundReactionJob).messageId
      )
      expect(queued).not.toContain(recent.id)
      expect(queued).not.toContain(settled.id)
    })

    it('marks as failed, and tells the team, a reaction that waited for hours', async () => {
      const message = await customerMessage()
      await react(message.id, '👍')
      await ageReaction(message.id, TWO_HOURS_MS)
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0

      const result = await sweep.requeueStaleReactions()

      expect(result.gaveUp).toBeGreaterThanOrEqual(1)
      expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
      expect(await stored(message.id)).toMatchObject({
        deliveryStatus: DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_MESSAGE_FAILED
      })
    })

    it('goes on with the next reaction when one cannot be queued', async () => {
      const first = await customerMessage()
      await react(first.id, '👍')
      await ageReaction(first.id, 10 * MINUTE_MS)
      const next = await customerMessage()
      await react(next.id, '🔥')
      await ageReaction(next.id, 5 * MINUTE_MS)
      const queue = queueOf(app, QueueNames.OUTBOUND)
      queue.jobs.length = 0
      const add = jest.spyOn(queue, 'add')
      add.mockRejectedValueOnce(new Error('redis is down'))

      await sweep.requeueStaleReactions()
      add.mockRestore()

      const queued = queue.jobs.map(item => (item.data as SendOutboundReactionJob).messageId)
      expect(queued).toContain(next.id)
      expect(queued).not.toContain(first.id)
    })

    it('sweeps the reactions even when the sweep of the replies fails', async () => {
      const message = await customerMessage()
      await react(message.id, '👍')
      await ageReaction(message.id, 5 * MINUTE_MS)
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
      const replies = jest.spyOn(sweep, 'requeueStale').mockRejectedValue(new Error('db down'))

      await sweep.run()
      replies.mockRestore()

      const queued = queueOf(app, QueueNames.OUTBOUND).jobs.map(
        item => (item.data as SendOutboundReactionJob).messageId
      )
      expect(queued).toContain(message.id)
    })
  })
})
