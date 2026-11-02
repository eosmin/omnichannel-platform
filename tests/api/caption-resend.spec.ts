import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { ChannelContextFactory } from '@platform/channels/connections'
import { ApiRoutes } from '@platform/core/api'
import type { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  CaptionState,
  ConversationStatus,
  DeliveryStatus,
  MessageType
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { OutboundQueue } from '@platform/core/messaging'
import { JobNames, QueueNames, type SendOutboundCaptionJob } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'
import {
  type ChannelContext,
  PluginError,
  type SendMessageParams,
  type ChannelMessageResult
} from '@platform/plugins/sdk'

import { MessageChangeSender } from '../../apps/worker/src/outbound/message-change-sender.service'
import { MessageChangeStatusWriter } from '../../apps/worker/src/outbound/message-change-status.writer'
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

const OK = 200
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const DAY_MS = 86_400_000

const codeOf = (body: unknown): string => (body as { error: { code: string } }).error.code

describe('Sending only the text under a file again', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let sender: MessageChangeSender
  let sweep: OutboundRequeueScheduler
  let sent: SendMessageParams[] = []
  let sendMessage: (ctx: ChannelContext, params: SendMessageParams) => Promise<ChannelMessageResult>

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const prisma = app.get(PrismaService, { strict: false })
    const registry = app.get(PluginRegistry, { strict: false })
    registry.register(buildChannelPlugin({ sendMessage: (c, p) => sendMessage(c, p) }))
    const events = app.get(DomainEvents, { strict: false })
    const cipher = { open: () => ({}) } as unknown as CredentialCipher // test double of the cipher
    const status = new MessageChangeStatusWriter(prisma, events)
    sender = new MessageChangeSender(
      prisma,
      registry,
      new ChannelContextFactory(cipher),
      status,
      await app.resolve(PinoLogger)
    )
    sweep = new OutboundRequeueScheduler(
      { withLock: (_name: string, _seconds: number, work: () => Promise<void>) => work() } as never, // the lock is not what is tested
      prisma,
      new OutboundQueue(queueOf(app, QueueNames.OUTBOUND) as never),
      undefined as never, // the replies are not what is tested
      new ReactionStatusWriter(prisma, events),
      status,
      await app.resolve(PinoLogger)
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    sent = []
    queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
    sendMessage = (_ctx, params) => {
      sent.push(params)
      return Promise.resolve({
        externalId: `caption-${params.idempotencyKey}`,
        status: DeliveryStatus.SENT,
        sentAt: new Date().toISOString()
      })
    }
  })

  const conversationOn = async (
    over: { storeId?: string; windowOpen?: boolean; status?: ConversationStatus } = {}
  ): Promise<string> => {
    const storeId = over.storeId ?? ctx.storeA.id
    const identity = await createCustomerIdentity(owner, {
      storeId,
      channelType: TEST_CHANNEL_ID,
      lastInboundAt: new Date(Date.now() - (over.windowOpen === false ? 3 * DAY_MS : 0))
    })
    const connection = await createChannelConnection(owner, {
      storeId,
      channelType: TEST_CHANNEL_ID
    })
    const conversation = await createConversation(owner, {
      storeId,
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType: TEST_CHANNEL_ID,
      channelConnectionId: connection.id,
      ...(over.status === undefined ? {} : { status: over.status })
    })
    return conversation.id
  }
  // A file the channel took, with the text under it in the state given
  const fileWithCaption = async (
    captionState: string | null,
    over: { conversationId?: string; storeId?: string; deletedAt?: Date } = {}
  ): Promise<string> => {
    const created = await owner.message.create({
      data: {
        storeId: over.storeId ?? ctx.storeA.id,
        conversationId: over.conversationId ?? (await conversationOn()),
        type: MessageType.IMAGE,
        content: 'the text under the file',
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id,
        deliveryStatus: DeliveryStatus.SENT,
        channelMessageId: `file-${randomUUID()}`,
        captionState,
        ...(over.deletedAt === undefined ? {} : { deletedAt: over.deletedAt })
      },
      select: { id: true }
    })
    return created.id
  }
  const row = (id: string) =>
    owner.message.findUniqueOrThrow({
      where: { id },
      select: {
        captionState: true,
        captionChannelMessageId: true,
        changeRequestedAt: true,
        version: true,
        content: true,
        deliveryStatus: true
      }
    })
  const resend = (id: string, who = ctx.agentA) =>
    api(app, who, ctx.storeA).post(ApiRoutes.messages.resendCaption(id))
  const queuedJob = (): SendOutboundCaptionJob => {
    const jobs = queueOf(app, QueueNames.OUTBOUND).jobs.filter(
      item => item.name === JobNames.SEND_OUTBOUND_CAPTION
    )
    expect(jobs).toHaveLength(1)
    return jobs[0]?.data as SendOutboundCaptionJob
  }

  describe('the request', () => {
    it.each([CaptionState.FAILED, CaptionState.UNCONFIRMED])(
      'queues the text of a caption that is %s, and not the file',
      async state => {
        const id = await fileWithCaption(state)

        const response = await resend(id)

        expect(response.status).toBe(OK)
        expect(response.body).toMatchObject({ id, captionState: CaptionState.QUEUED })
        const stored = await row(id)
        expect(stored).toMatchObject({
          captionState: CaptionState.QUEUED,
          deliveryStatus: DeliveryStatus.SENT,
          version: 2
        })
        expect(stored.changeRequestedAt).not.toBeNull()
        expect(queuedJob()).toMatchObject({ storeId: ctx.storeA.id, messageId: id, version: 2 })
      }
    )

    it.each([null, CaptionState.SENT, CaptionState.QUEUED])(
      'is refused when the caption is %j',
      async state => {
        const id = await fileWithCaption(state)

        const response = await resend(id)

        expect(response.status).toBe(CONFLICT)
        expect((await row(id)).captionState).toBe(state)
        expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
      }
    )

    it('is refused for a message that was deleted', async () => {
      const id = await fileWithCaption(CaptionState.FAILED, { deletedAt: new Date() })

      const response = await resend(id)

      expect(response.status).toBe(CONFLICT)
      expect((await row(id)).captionState).toBe(CaptionState.FAILED)
    })

    it('is refused while an edit or a deletion of the message is on its way', async () => {
      const id = await fileWithCaption(CaptionState.FAILED)
      await owner.message.update({
        where: { id },
        data: { deleteStatus: DeliveryStatus.QUEUED, changeRequestedAt: new Date() }
      })

      const response = await resend(id)

      expect(response.status).toBe(CONFLICT)
      expect((await row(id)).captionState).toBe(CaptionState.FAILED)
    })

    it('needs the window open, as a text does', async () => {
      const conversationId = await conversationOn({ windowOpen: false })
      const id = await fileWithCaption(CaptionState.FAILED, { conversationId })

      const response = await resend(id)

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.CHANNEL_WINDOW_EXPIRED)
      expect((await row(id)).captionState).toBe(CaptionState.FAILED)
    })

    it('is not sent to a spam conversation', async () => {
      const conversationId = await conversationOn({ status: ConversationStatus.SPAM })
      const id = await fileWithCaption(CaptionState.FAILED, { conversationId })

      const response = await resend(id, ctx.adminA)

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.CONVERSATION_INVALID_STATUS_TRANSITION)
    })

    it('is refused to who may not send, and changes nothing', async () => {
      const id = await fileWithCaption(CaptionState.FAILED)

      const response = await resend(id, ctx.viewerA)

      expect(response.status).toBe(FORBIDDEN)
      expect((await row(id)).captionState).toBe(CaptionState.FAILED)
      expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
    })

    it('does not reach a message of another store', async () => {
      const id = await fileWithCaption(CaptionState.FAILED, {
        storeId: ctx.storeB.id,
        conversationId: await conversationOn({ storeId: ctx.storeB.id })
      })

      const response = await resend(id)

      expect(response.status).toBe(NOT_FOUND)
      expect((await row(id)).captionState).toBe(CaptionState.FAILED)
    })

    it('is refused when the file itself failed: that one is sent again whole', async () => {
      const id = await fileWithCaption(CaptionState.FAILED)
      await owner.message.update({ where: { id }, data: { deliveryStatus: DeliveryStatus.FAILED } })

      const response = await resend(id)

      expect(response.status).toBe(CONFLICT)
      expect((await row(id)).captionState).toBe(CaptionState.FAILED)
    })

    it('makes the message impossible to delete until the text is settled', async () => {
      const id = await fileWithCaption(CaptionState.FAILED)
      await resend(id)

      const response = await api(app, ctx.agentA, ctx.storeA).delete(ApiRoutes.messages.byId(id))

      expect(response.status).toBe(CONFLICT)
      expect((await row(id)).captionState).toBe(CaptionState.QUEUED)
    })
  })

  describe('the worker', () => {
    const queued = async (): Promise<{ id: string; job: SendOutboundCaptionJob }> => {
      const id = await fileWithCaption(CaptionState.FAILED)
      await resend(id)
      return { id, job: queuedJob() }
    }

    it('sends the text alone, and settles it as sent with the id of that text', async () => {
      const { id, job } = await queued()

      await sender.sendCaption(job, false)

      expect(sent).toEqual([
        expect.objectContaining({
          content: 'the text under the file',
          idempotencyKey: `caption-${id}-2`
        })
      ])
      expect(await row(id)).toMatchObject({
        captionState: CaptionState.SENT,
        captionChannelMessageId: `caption-caption-${id}-2`,
        changeRequestedAt: null
      })
    })

    it('settles a refusal as failed and keeps no id', async () => {
      const { id, job } = await queued()
      sendMessage = () =>
        Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false }))

      await sender.sendCaption(job, false)

      expect(await row(id)).toMatchObject({
        captionState: CaptionState.FAILED,
        captionChannelMessageId: null,
        changeRequestedAt: null
      })
    })

    it.each([
      [
        'a plugin that does not know the outcome',
        () =>
          new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
            retryable: true,
            outcomeUnknown: true
          })
      ],
      ['a network error or a timeout', () => new Error('socket hang up')]
    ])('settles %s as unconfirmed, and never repeats the call', async (_name, failure) => {
      const { id, job } = await queued()
      sendMessage = () => Promise.reject(failure())

      await sender.sendCaption(job, false)

      expect((await row(id)).captionState).toBe(CaptionState.UNCONFIRMED)
    })

    it('settles an answer it cannot read as unconfirmed', async () => {
      const { id, job } = await queued()
      sendMessage = () => Promise.resolve({} as ChannelMessageResult)

      await sender.sendCaption(job, false)

      expect((await row(id)).captionState).toBe(CaptionState.UNCONFIRMED)
    })

    it('tries a throttled refusal again, and gives it up as failed on the last attempt', async () => {
      const { id, job } = await queued()
      sendMessage = () =>
        Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: true }))

      await expect(sender.sendCaption(job, false)).rejects.toThrow()
      expect((await row(id)).captionState).toBe(CaptionState.QUEUED)

      await sender.sendCaption(job, true)
      expect((await row(id)).captionState).toBe(CaptionState.FAILED)
    })

    it('does nothing for a text that is not waiting, so a late job sends nothing', async () => {
      const id = await fileWithCaption(CaptionState.SENT)

      await sender.sendCaption({ storeId: ctx.storeA.id, messageId: id, version: 2 }, true)

      expect(sent).toHaveLength(0)
      expect((await row(id)).captionState).toBe(CaptionState.SENT)
    })

    it('does not touch a message of another store', async () => {
      const { id } = await queued()

      await sender.sendCaption({ storeId: ctx.storeB.id, messageId: id, version: 2 }, true)

      expect(sent).toHaveLength(0)
      expect((await row(id)).captionState).toBe(CaptionState.QUEUED)
    })

    it('ends the request without a call when the message was deleted since', async () => {
      const { id, job } = await queued()
      await owner.message.update({ where: { id }, data: { deletedAt: new Date() } })

      await sender.sendCaption(job, true)

      expect(sent).toHaveLength(0)
      expect((await row(id)).captionState).toBe(CaptionState.FAILED)
    })

    it('sends nothing for a job of an earlier request', async () => {
      const { id, job } = await queued()

      await sender.sendCaption({ ...job, version: job.version - 1 }, true)

      expect(sent).toHaveLength(0)
      expect((await row(id)).captionState).toBe(CaptionState.QUEUED)
    })
  })

  describe('a request that stayed queued', () => {
    it('is never sent again by the sweep: after two minutes it shows as unconfirmed', async () => {
      const waiting = await fileWithCaption(CaptionState.FAILED)
      const fresh = await fileWithCaption(CaptionState.FAILED)
      await resend(waiting)
      await resend(fresh)
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
      await owner.message.update({
        where: { id: waiting },
        data: { changeRequestedAt: new Date(Date.now() - 5 * 60_000) }
      })

      const done = await sweep.requeueStaleChanges()

      expect(done).toEqual({ requeued: 0, gaveUp: 1 })
      expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
      expect(await row(waiting)).toMatchObject({
        captionState: CaptionState.UNCONFIRMED,
        changeRequestedAt: null
      })
      expect((await row(fresh)).captionState).toBe(CaptionState.QUEUED)
    })
  })
})
