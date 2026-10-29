import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { ChannelContextFactory } from '@platform/channels/connections'
import { ApiRoutes } from '@platform/core/api'
import type { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { AuthorType, MessageType } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { ReadReceipts } from '@platform/core/messaging'
import { JobNames, QueueNames, type SendOutboundReadReceiptJob } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'
import {
  ChannelCapability,
  type ChannelContext,
  type MarkReadParams,
  PluginError
} from '@platform/plugins/sdk'

import { ReadReceiptSender } from '../../apps/worker/src/outbound/read-receipt-sender.service'
import { SendAttemptFailed } from '../../apps/worker/src/outbound/send-refusal'
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

const OK = 200
const NOT_FOUND = 404
const PLAIN_TEXT_CHANNEL = 'plain_channel'

describe('Telling the channel that an agent read a conversation', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let sender: ReadReceiptSender
  let marked: MarkReadParams[] = []
  let pendingQueueing: Promise<void>[] = []
  let markAsRead: (ctx: ChannelContext, params: MarkReadParams) => Promise<void>

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const prisma = app.get(PrismaService, { strict: false })
    const registry = app.get(PluginRegistry, { strict: false })
    registry.register(
      buildChannelPlugin({
        capabilities: [ChannelCapability.TEXT, ChannelCapability.READ_RECEIPTS],
        markAsRead: (c, p) => markAsRead(c, p)
      })
    )
    registry.register(buildChannelPlugin({ id: PLAIN_TEXT_CHANNEL }))
    // The route does not wait for the queueing: the suite keeps the promise of each to wait for it
    const receipts = app.get(ReadReceipts, { strict: false })
    const queueFor = receipts.queueFor.bind(receipts)
    jest.spyOn(receipts, 'queueFor').mockImplementation((...args) => {
      const pending = queueFor(...args)
      pendingQueueing.push(pending)
      return pending
    })
    // The rows of the suite hold bytes that are no ciphertext: the context is what the plugin gets
    const cipher = { open: () => ({}) } as unknown as CredentialCipher // test double of the cipher
    sender = new ReadReceiptSender(
      prisma,
      registry,
      new ChannelContextFactory(cipher),
      await app.resolve(PinoLogger)
    )
  })
  afterEach(async () => {
    // A route does not wait for the queueing it starts: let it end before the next test begins
    await Promise.all(pendingQueueing)
  })
  afterAll(async () => {
    jest.restoreAllMocks()
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(async () => {
    marked = []
    pendingQueueing = []
    queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
    markAsRead = (_ctx, params) => {
      marked.push(params)
      return Promise.resolve()
    }
    await owner.storeSettings.deleteMany({ where: { storeId: ctx.storeA.id } })
  })

  const conversationOf = async (pluginId = TEST_CHANNEL_ID, storeId = ctx.storeA.id) => {
    const identity = await createCustomerIdentity(owner, { storeId, channelType: pluginId })
    const connection = await createChannelConnection(owner, { storeId, channelType: pluginId })
    const conversation = await createConversation(owner, {
      storeId,
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType: pluginId,
      channelConnectionId: connection.id
    })
    return { storeId, conversationId: conversation.id, connectionId: connection.id }
  }
  // Messages are written oldest first, a second apart, so that "the latest" is not a tie
  let clock = Date.now()
  const say = async (
    conversationId: string,
    over: { channelMessageId?: string | null; authorType?: AuthorType } = {}
  ) => {
    clock += 1000
    return owner.message.create({
      data: {
        storeId: ctx.storeA.id,
        conversationId,
        type: MessageType.TEXT,
        content: 'hello',
        authorType: over.authorType ?? AuthorType.CUSTOMER,
        channelMessageId:
          over.channelMessageId === undefined ? `wamid-${randomUUID()}` : over.channelMessageId,
        createdAt: new Date(clock)
      },
      select: { id: true, channelMessageId: true }
    })
  }
  const read = (conversationId: string, who = ctx.agentA) =>
    api(app, who, ctx.storeA).post(ApiRoutes.conversations.read(conversationId))
  // The job is queued after the answer: wait for the work the route started, then look at the queue
  const jobsAfterRead = async () => {
    await Promise.all(pendingQueueing)
    return queued()
  }
  const queued = (): { data: SendOutboundReadReceiptJob; opts?: { jobId?: string } }[] =>
    queueOf(app, QueueNames.OUTBOUND)
      .jobs.filter(item => item.name === JobNames.SEND_OUTBOUND_READ_RECEIPT)
      .map(item => ({ data: item.data as SendOutboundReadReceiptJob, opts: item.opts }))

  describe('the endpoint', () => {
    it('queues one job for the latest message of the customer that has an id at the channel', async () => {
      const { conversationId } = await conversationOf()
      await say(conversationId)
      const latest = await say(conversationId)
      await say(conversationId, { channelMessageId: null })
      await say(conversationId, { authorType: AuthorType.AGENT })

      const response = await read(conversationId)

      expect(response.status).toBe(OK)
      const jobs = await jobsAfterRead()
      expect(jobs).toHaveLength(1)
      expect(jobs[0]?.data).toMatchObject({
        storeId: ctx.storeA.id,
        conversationId,
        messageId: latest.id
      })
    })

    it('skips a message of the customer that was deleted and takes the one before it', async () => {
      const { conversationId } = await conversationOf()
      const kept = await say(conversationId)
      const deleted = await say(conversationId)
      await owner.message.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } })

      await read(conversationId)

      expect((await jobsAfterRead())[0]?.data).toMatchObject({ messageId: kept.id })
    })

    it('gives the job an id that is the same for the same message, so that a second read is one job', async () => {
      const { conversationId } = await conversationOf()
      await say(conversationId)

      await read(conversationId)
      await read(conversationId)

      const ids = (await jobsAfterRead()).map(item => item.opts?.jobId)
      expect(ids).toHaveLength(2)
      expect(new Set(ids).size).toBe(1)

      await say(conversationId)
      await read(conversationId)
      const after = (await jobsAfterRead()).map(item => item.opts?.jobId)
      expect(after).toHaveLength(3)
      expect(after[2]).not.toBe(after[0])
    })

    it('queues nothing when the store chose not to send read receipts', async () => {
      const { conversationId } = await conversationOf()
      await say(conversationId)
      await owner.storeSettings.create({
        data: { storeId: ctx.storeA.id, preferences: { sendReadReceipts: false } }
      })

      const response = await read(conversationId)

      expect(response.status).toBe(OK)
      expect(await jobsAfterRead()).toHaveLength(0)
    })

    it('queues one when the preferences say nothing about it, and when they do not fit', async () => {
      const { conversationId } = await conversationOf()
      await say(conversationId)
      await owner.storeSettings.create({
        data: { storeId: ctx.storeA.id, preferences: { sendReadReceipts: 'no' } }
      })

      await read(conversationId)

      expect(await jobsAfterRead()).toHaveLength(1)
    })

    it('queues nothing for a conversation with no message of the customer that has an id', async () => {
      const { conversationId } = await conversationOf()
      await say(conversationId, { channelMessageId: null })

      const response = await read(conversationId)

      expect(response.status).toBe(OK)
      expect(await jobsAfterRead()).toHaveLength(0)
    })

    it('queues nothing, and answers as for a conversation that does not exist, for another store', async () => {
      const { conversationId } = await conversationOf(TEST_CHANNEL_ID, ctx.storeB.id)

      const response = await read(conversationId)

      expect(response.status).toBe(NOT_FOUND)
      expect(await jobsAfterRead()).toHaveLength(0)
    })
  })

  describe('the worker', () => {
    const jobFor = async (
      over: { pluginId?: string; channelMessageId?: string | null } = {}
    ): Promise<SendOutboundReadReceiptJob & { externalId: string | null }> => {
      const { storeId, conversationId } = await conversationOf(over.pluginId)
      const message = await say(conversationId, {
        ...(over.channelMessageId === undefined ? {} : { channelMessageId: over.channelMessageId })
      })
      return {
        storeId,
        conversationId,
        messageId: message.id,
        externalId: message.channelMessageId
      }
    }

    it('asks the plugin to mark the message of the customer as read', async () => {
      const job = await jobFor()

      await sender.send(job, false)

      expect(marked).toEqual([
        { channelIdentity: expect.any(String) as string, externalId: job.externalId }
      ])
    })

    it('does nothing for a plugin that does not declare READ_RECEIPTS', async () => {
      const job = await jobFor({ pluginId: PLAIN_TEXT_CHANNEL })

      await sender.send(job, false)

      expect(marked).toEqual([])
    })

    it('does nothing for a connection that is disconnected', async () => {
      const job = await jobFor()
      await owner.channelConnection.updateMany({
        where: { conversations: { some: { id: job.conversationId } } },
        data: { status: 'disconnected' }
      })

      await sender.send(job, false)

      expect(marked).toEqual([])
    })

    it('does nothing for a message that is not of this conversation, or has no id at the channel', async () => {
      const other = await jobFor()
      const bare = await jobFor({ channelMessageId: null })

      await sender.send({ ...other, conversationId: randomUUID() }, false)
      await sender.send(bare, false)

      expect(marked).toEqual([])
    })

    it('does nothing for a message the customer deleted after the job was queued', async () => {
      const job = await jobFor()
      await owner.message.update({ where: { id: job.messageId }, data: { deletedAt: new Date() } })

      await sender.send(job, false)

      expect(marked).toEqual([])
    })

    it('tries again when the plugin fails in a way worth another try, and lets it go on the last attempt', async () => {
      const job = await jobFor()
      markAsRead = () => Promise.reject(new Error('socket hang up'))

      await expect(sender.send(job, false)).rejects.toBeInstanceOf(SendAttemptFailed)
      await expect(sender.send(job, true)).resolves.toBeUndefined()
    })

    it('lets go of a refusal that another try would not change', async () => {
      const job = await jobFor()
      markAsRead = () =>
        Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false }))

      await expect(sender.send(job, false)).resolves.toBeUndefined()
    })
  })
})
