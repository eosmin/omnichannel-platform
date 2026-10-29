import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ConversationStatus,
  MessageType,
  RoutingActionTypes,
  SystemMessageEvents
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import {
  ChannelConnectionResolver,
  ConversationsService,
  CustomerIdentityService,
  InboundMessageService,
  type InboundEvent,
  InboundOutcomes,
  RoutingService
} from '@platform/core/messaging'
import { type FetchInboundMediaJob, JobNames, QueueNames } from '@platform/core/queues'
import {
  inboundJobId,
  PluginRegistry,
  type ProcessChannelEventJob
} from '@platform/plugins/runtime'

import {
  buildChannelPlugin,
  createConversation,
  createCustomerIdentity,
  createRoutingRule,
  ensurePluginInstallation,
  signTestChannelBody,
  TEST_CHANNEL_ID
} from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { anonymousApi } from '../helpers/http'
import { CapturedQueue, queueOf } from '../helpers/queue'

const OK = 200
const UNAUTHORIZED = 401
const FORBIDDEN = 403
const NOT_FOUND = 404
const P99_BUDGET_MS = 300

interface ErrorBody {
  error: { code: string }
}

describe('Messages that a channel delivers', () => {
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
    )
    ctx = await seedTestContext(owner, app, prefix)
    app.get(PluginRegistry, { strict: false }).register(buildChannelPlugin())
    // What the worker builds from the same classes
    service = new InboundMessageService(
      app.get(PrismaService, { strict: false }),
      new ChannelConnectionResolver(app.get(PrismaService, { strict: false })),
      app.get(CustomerIdentityService, { strict: false }),
      app.get(ConversationsService, { strict: false }),
      app.get(RoutingService, { strict: false }),
      app.get(DomainEvents, { strict: false }),
      queueOf(app, QueueNames.HEAVY_PROCESSING) as never,
      await app.resolve(PinoLogger)
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const connectionOf = async (storeId: string, status = 'active'): Promise<string> => {
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
        status,
        credentials: Buffer.from('not a secret')
      }
    })
    return connectionId
  }
  const event = (
    connectionId: string,
    over: { from?: string; id?: string; text?: string; at?: string } = {}
  ): InboundEvent => ({
    connectionId,
    channelIdentity: over.from ?? `50370${String((handle += 1)).padStart(6, '0')}`,
    message: {
      externalId: over.id ?? `ext-${(handle += 1)}`,
      type: MessageType.TEXT,
      content: over.text ?? 'hello',
      timestamp: over.at ?? new Date().toISOString()
    }
  })
  const conversationsOf = (storeId: string) =>
    owner.conversation.findMany({ where: { storeId }, orderBy: { createdAt: 'asc' } })

  describe('the webhook', () => {
    const entries = (to: string) => ({
      entries: [{ to, from: '50322223333', id: 'w-1', text: 'hi', at: '2026-10-27T10:00:00.000Z' }]
    })
    const post = (body: unknown, signature?: string) => {
      const raw = JSON.stringify(body)
      return anonymousApi(app)
        .post(ApiRoutes.webhooks.channel(TEST_CHANNEL_ID))
        .set('content-type', 'application/json')
        .set('x-signature', signature ?? signTestChannelBody(raw))
        .send(raw)
    }
    const queued = () => queueOf(app, QueueNames.INBOUND).jobs

    it('queues each event once, under an id that a retry of the provider repeats', async () => {
      queued().length = 0

      const first = await post(entries('c-1'))
      const retry = await post(entries('c-1'))

      expect(first.status).toBe(OK)
      expect(first.body).toEqual({ received: true })
      const [job] = queued()
      const data = job?.data as ProcessChannelEventJob
      expect(job?.name).toBe(JobNames.PROCESS_CHANNEL_EVENT)
      expect(data.pluginId).toBe(TEST_CHANNEL_ID)
      expect(job?.opts?.jobId).toBe(inboundJobId(TEST_CHANNEL_ID, data.event))
      expect(queued().map(queuedJob => queuedJob.opts?.jobId)).toEqual([
        job?.opts?.jobId,
        job?.opts?.jobId
      ])
      expect(retry.status).toBe(OK)
    })

    it('refuses a body whose signature is not the plugin’s, and queues nothing', async () => {
      queued().length = 0

      const response = await post(entries('c-1'), 'not-the-signature')

      expect(response.status).toBe(UNAUTHORIZED)
      expect((response.body as ErrorBody).error.code).toBe(
        ErrorCodes.CHANNEL_WEBHOOK_SIGNATURE_INVALID
      )
      expect(queued()).toEqual([])
    })

    it('answers the same for a channel nobody registered and for one that is malformed', async () => {
      const unknown = await anonymousApi(app).post(ApiRoutes.webhooks.channel('telegram')).send({})
      const malformed = await anonymousApi(app).post(ApiRoutes.webhooks.channel('Bad Id!')).send({})

      expect(unknown.status).toBe(NOT_FOUND)
      expect(malformed.status).toBe(NOT_FOUND)
    })

    it('refuses the handshake of a channel that has none', async () => {
      const response = await anonymousApi(app).get(ApiRoutes.webhooks.channel(TEST_CHANNEL_ID))

      expect(response.status).toBe(FORBIDDEN)
    })

    it('leaves out an event that a plugin made up, such as a system line, and keeps the rest', async () => {
      const good = buildChannelPlugin()
      const forging = buildChannelPlugin({
        id: 'forging_channel',
        handleWebhook: async payload => {
          const events = await good.handleWebhook(payload)
          return [
            ...events,
            ...events.map(item => ({
              ...item,
              message: item.message && { ...item.message, type: MessageType.SYSTEM }
            }))
          ]
        }
      })
      app.get(PluginRegistry, { strict: false }).register(forging)
      queued().length = 0
      const raw = JSON.stringify(entries('c-1'))

      const response = await anonymousApi(app)
        .post(ApiRoutes.webhooks.channel('forging_channel'))
        .set('content-type', 'application/json')
        .set('x-signature', signTestChannelBody(raw))
        .send(raw)

      expect(response.status).toBe(OK)
      expect(queued()).toHaveLength(1)
    })

    it('acknowledges a body that the plugin cannot read, and queues nothing', async () => {
      app.get(PluginRegistry, { strict: false }).register(
        buildChannelPlugin({
          id: 'throwing_channel',
          handleWebhook: () => Promise.reject(new Error('cannot read this'))
        })
      )
      queued().length = 0
      const raw = JSON.stringify(entries('c-1'))

      const response = await anonymousApi(app)
        .post(ApiRoutes.webhooks.channel('throwing_channel'))
        .set('content-type', 'application/json')
        .set('x-signature', signTestChannelBody(raw))
        .send(raw)

      expect(response.status).toBe(OK)
      expect(queued()).toEqual([])
    })

    it(`answers in under ${P99_BUDGET_MS} ms at the 99th percentile while the worker does the work`, async () => {
      const times: number[] = []
      for (let i = 0; i < 40; i += 1) {
        const started = performance.now()
        await post(entries(`c-${i}`))
        times.push(performance.now() - started)
      }
      times.sort((a, b) => a - b)

      expect(times[Math.ceil(times.length * 0.99) - 1]).toBeLessThan(P99_BUDGET_MS)
    })
  })

  describe('the pipeline', () => {
    it('creates the customer, the conversation and the message in the store of the connection only', async () => {
      const connectionId = await connectionOf(ctx.storeB.id)
      const incoming = event(connectionId, { from: '50370111111', text: 'for store B' })

      const outcome = await service.handleMessageReceived(TEST_CHANNEL_ID, incoming)

      expect(outcome).toBe(InboundOutcomes.STORED)
      const b = await conversationsOf(ctx.storeB.id)
      expect(b).toHaveLength(1)
      const messages = await owner.message.findMany({ where: { conversationId: b[0]?.id } })
      expect(messages).toMatchObject([
        { storeId: ctx.storeB.id, content: 'for store B', authorType: AuthorType.CUSTOMER }
      ])
      expect(await owner.customer.count({ where: { storeId: ctx.storeB.id } })).toBe(1)
      expect(await conversationsOf(ctx.storeA.id)).toEqual([])
      expect(await owner.customerIdentity.count({ where: { storeId: ctx.storeA.id } })).toBe(0)
      expect(b[0]).toMatchObject({ unreadCount: 1 })
      const identity = await owner.customerIdentity.findFirstOrThrow({
        where: { storeId: ctx.storeB.id }
      })
      expect(identity.lastInboundAt).not.toBeNull()
    })

    it('creates nothing when the same event is delivered again', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const incoming = event(connectionId)
      await service.handleMessageReceived(TEST_CHANNEL_ID, incoming)
      const before = await owner.message.count({ where: { storeId: ctx.storeA.id } })

      const outcome = await service.handleMessageReceived(TEST_CHANNEL_ID, incoming)

      expect(outcome).toBe(InboundOutcomes.DUPLICATE)
      expect(await owner.message.count({ where: { storeId: ctx.storeA.id } })).toBe(before)
      const conversation = await owner.conversation.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, channelConnection: { connectionId } }
      })
      expect(conversation.unreadCount).toBe(1)
    })

    it('drops an event for a connection nobody has, or one that was disconnected', async () => {
      const gone = await connectionOf(ctx.storeA.id, 'disconnected')
      const before = await owner.customer.count({ where: { storeId: ctx.storeA.id } })

      const unknown = await service.handleMessageReceived(
        TEST_CHANNEL_ID,
        event('no-such-connection')
      )
      const disconnected = await service.handleMessageReceived(TEST_CHANNEL_ID, event(gone))

      expect(unknown).toBe(InboundOutcomes.UNKNOWN_CONNECTION)
      expect(disconnected).toBe(InboundOutcomes.UNKNOWN_CONNECTION)
      expect(await owner.customer.count({ where: { storeId: ctx.storeA.id } })).toBe(before)
    })

    it('does not reach the connection of another store, whatever the event says', async () => {
      const connectionOfB = await connectionOf(ctx.storeB.id)
      const storeABefore = await owner.message.count({ where: { storeId: ctx.storeA.id } })

      await service.handleMessageReceived(TEST_CHANNEL_ID, event(connectionOfB))

      expect(await owner.message.count({ where: { storeId: ctx.storeA.id } })).toBe(storeABefore)
    })

    describe('a customer who writes again', () => {
      const setup = async (status: ConversationStatus, assignedTo: string | null = null) => {
        const connectionId = await connectionOf(ctx.storeA.id)
        const from = `50370${String((handle += 1)).padStart(6, '0')}`
        const connection = await owner.channelConnection.findFirstOrThrow({
          where: { connectionId }
        })
        const identity = await createCustomerIdentity(owner, {
          storeId: ctx.storeA.id,
          channelType: TEST_CHANNEL_ID,
          handle: from
        })
        const conversation = await createConversation(owner, {
          storeId: ctx.storeA.id,
          customerId: identity.customerId,
          customerIdentityId: identity.id,
          channelType: TEST_CHANNEL_ID,
          channelConnectionId: connection.id,
          status,
          assignedTo,
          lastMessageAt: new Date()
        })
        return { connectionId, from, conversationId: conversation.id }
      }

      it.each([
        ConversationStatus.RESOLVED,
        ConversationStatus.ARCHIVED,
        ConversationStatus.SNOOZED
      ])(
        'continues the same conversation and reopens it when it was %s, the assignee keeping it',
        async status => {
          const { connectionId, from, conversationId } = await setup(status, ctx.agentA.id)

          await service.handleMessageReceived(TEST_CHANNEL_ID, event(connectionId, { from }))

          const conversation = await owner.conversation.findUniqueOrThrow({
            where: { id: conversationId }
          })
          expect(conversation).toMatchObject({
            status: ConversationStatus.OPEN,
            assignedTo: ctx.agentA.id,
            unreadCount: 1
          })
          expect(await conversationsOf(ctx.storeA.id)).toHaveLength(
            await owner.conversation.count({ where: { storeId: ctx.storeA.id } })
          )
          const lines = await owner.message.findMany({
            where: { conversationId, type: MessageType.SYSTEM }
          })
          expect(lines).toHaveLength(1)
          expect(lines[0]?.metadata).toMatchObject({
            event:
              status === ConversationStatus.SNOOZED
                ? SystemMessageEvents.WOKEN
                : SystemMessageEvents.REOPENED,
            actor: { type: 'system', id: null },
            reason: 'customer_replied'
          })
        }
      )

      it('ends the wait of a pending conversation, with no line in the thread', async () => {
        const { connectionId, from, conversationId } = await setup(ConversationStatus.PENDING)

        await service.handleMessageReceived(TEST_CHANNEL_ID, event(connectionId, { from }))

        const conversation = await owner.conversation.findUniqueOrThrow({
          where: { id: conversationId }
        })
        expect(conversation.status).toBe(ConversationStatus.OPEN)
        expect(
          await owner.message.count({ where: { conversationId, type: MessageType.SYSTEM } })
        ).toBe(0)
      })

      it('knows a message again even when a newer conversation exists', async () => {
        const { connectionId, from, conversationId } = await setup(ConversationStatus.RESOLVED)
        const first = event(connectionId, { from, id: 'again-1' })
        await service.handleMessageReceived(TEST_CHANNEL_ID, first)
        await owner.storeSettings.update({
          where: { storeId: ctx.storeA.id },
          data: { reopenWindowDays: 1 }
        })
        await owner.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: new Date(Date.now() - 3 * 86_400_000) }
        })
        await service.handleMessageReceived(TEST_CHANNEL_ID, event(connectionId, { from }))
        await owner.storeSettings.update({
          where: { storeId: ctx.storeA.id },
          data: { reopenWindowDays: null }
        })
        const countBefore = await owner.message.count({
          where: { storeId: ctx.storeA.id, conversation: { channelConnection: { connectionId } } }
        })

        const outcome = await service.handleMessageReceived(TEST_CHANNEL_ID, first)

        expect(outcome).toBe(InboundOutcomes.DUPLICATE)
        expect(
          await owner.message.count({
            where: { storeId: ctx.storeA.id, conversation: { channelConnection: { connectionId } } }
          })
        ).toBe(countBefore)
      })

      it('stores the message of a conversation marked as spam and leaves it spam', async () => {
        const { connectionId, from, conversationId } = await setup(ConversationStatus.SPAM)

        await service.handleMessageReceived(TEST_CHANNEL_ID, event(connectionId, { from }))

        const conversation = await owner.conversation.findUniqueOrThrow({
          where: { id: conversationId }
        })
        expect(conversation.status).toBe(ConversationStatus.SPAM)
        expect(await owner.message.count({ where: { conversationId } })).toBe(1)
      })

      // What the events say about who may see the conversation, as the stored row has it
      const visibilityOfEvents = async (
        name: string,
        run: () => Promise<unknown>
      ): Promise<unknown[]> => {
        const spy = jest.spyOn(app.get(DomainEvents, { strict: false }), 'publish')
        try {
          await run()
          return spy.mock.calls
            .filter(([, event]) => event === name)
            .map(([, , payload]) => (payload as { visibility: unknown }).visibility)
        } finally {
          spy.mockRestore()
        }
      }

      it('tells the assignee and the status of the row in the event of the message', async () => {
        const { connectionId, from } = await setup(ConversationStatus.RESOLVED, ctx.agentA.id)

        const seen = await visibilityOfEvents(Events.MESSAGE_RECEIVED, () =>
          service.handleMessageReceived(TEST_CHANNEL_ID, event(connectionId, { from }))
        )

        expect(seen).toEqual([{ hidden: false, assignedTo: ctx.agentA.id }])
      })

      it('tells that the conversation is hidden when it stays spam', async () => {
        const { connectionId, from } = await setup(ConversationStatus.SPAM)

        const seen = await visibilityOfEvents(Events.MESSAGE_RECEIVED, () =>
          service.handleMessageReceived(TEST_CHANNEL_ID, event(connectionId, { from }))
        )

        expect(seen).toEqual([{ hidden: true, assignedTo: null }])
      })

      it('tells that a conversation it starts is visible to who sees the unassigned ones', async () => {
        const connectionId = await connectionOf(ctx.storeA.id)
        const run = () =>
          service.handleMessageReceived(
            TEST_CHANNEL_ID,
            event(connectionId, { from: `50370${String((handle += 1)).padStart(6, '0')}` })
          )

        const seen = await visibilityOfEvents(Events.CONVERSATION_CREATED, run)

        expect(seen).toEqual([{ hidden: false, assignedTo: null }])
      })

      it('starts a new conversation only after the quiet days that the store asked for', async () => {
        const { connectionId, from, conversationId } = await setup(ConversationStatus.RESOLVED)
        await owner.storeSettings.update({
          where: { storeId: ctx.storeA.id },
          data: { reopenWindowDays: 3 }
        })
        await owner.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: new Date(Date.now() - 2 * 86_400_000) }
        })
        await service.handleMessageReceived(TEST_CHANNEL_ID, event(connectionId, { from }))
        const inside = await owner.conversation.count({
          where: { storeId: ctx.storeA.id, channelConnection: { connectionId } }
        })
        await owner.conversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: new Date(Date.now() - 4 * 86_400_000) }
        })

        await service.handleMessageReceived(TEST_CHANNEL_ID, event(connectionId, { from }))

        const after = await owner.conversation.count({
          where: { storeId: ctx.storeA.id, channelConnection: { connectionId } }
        })
        expect(inside).toBe(1)
        expect(after).toBe(2)
        await owner.storeSettings.update({
          where: { storeId: ctx.storeA.id },
          data: { reopenWindowDays: null }
        })
      })

      it('gives two events of one new handle, at the same moment, one customer and one conversation', async () => {
        const connectionId = await connectionOf(ctx.storeA.id)
        const from = '50370999999'

        await Promise.all([
          service.handleMessageReceived(TEST_CHANNEL_ID, event(connectionId, { from, id: 'p-1' })),
          service.handleMessageReceived(TEST_CHANNEL_ID, event(connectionId, { from, id: 'p-2' }))
        ])

        const conversations = await owner.conversation.findMany({
          where: { storeId: ctx.storeA.id, channelConnection: { connectionId } }
        })
        expect(conversations).toHaveLength(1)
        expect(await owner.message.count({ where: { conversationId: conversations[0]?.id } })).toBe(
          2
        )
      })
    })

    it('hands a new conversation to the person that a routing rule names', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const rule = await createRoutingRule(owner, {
        storeId: ctx.storeA.id,
        action: { type: RoutingActionTypes.ASSIGN_USER, userIds: [ctx.agentA.id] }
      })

      await service.handleMessageReceived(TEST_CHANNEL_ID, event(connectionId))

      const conversation = await owner.conversation.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, channelConnection: { connectionId } }
      })
      expect(conversation.assignedTo).toBe(ctx.agentA.id)
      await owner.routingRule.delete({ where: { id: rule.id } })
    })

    it('sends the media of a message to be fetched, once however many times it is delivered', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const heavy = queueOf(app, QueueNames.HEAVY_PROCESSING)
      heavy.jobs.length = 0
      const incoming = event(connectionId)
      incoming.message.type = MessageType.IMAGE
      incoming.message.media = [{ ref: 'media-ref', contentType: 'image/png', filename: 'a.png' }]

      await service.handleMessageReceived(TEST_CHANNEL_ID, incoming)
      await service.handleMessageReceived(TEST_CHANNEL_ID, incoming)

      const ids = new Set(heavy.jobs.map(job => job.opts?.jobId))
      expect(heavy.jobs.every(job => job.name === JobNames.FETCH_INBOUND_MEDIA)).toBe(true)
      expect(ids.size).toBe(1)
    })

    it('sends every file of an album to be fetched, as the media of one message', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const heavy = queueOf(app, QueueNames.HEAVY_PROCESSING)
      heavy.jobs.length = 0
      const incoming = event(connectionId)
      incoming.message.type = MessageType.IMAGE
      incoming.message.media = [
        { ref: 'first', contentType: 'image/png', filename: null },
        { ref: 'second', contentType: 'image/jpeg', filename: null }
      ]

      await service.handleMessageReceived(TEST_CHANNEL_ID, incoming)
      await service.handleMessageReceived(TEST_CHANNEL_ID, incoming)

      // The captured queue keeps the data as unknown; these jobs are the ones the service just added
      const fetches = heavy.jobs.map(job => job.data as FetchInboundMediaJob)
      expect(new Set(heavy.jobs.map(job => job.opts?.jobId)).size).toBe(2)
      expect(new Set(fetches.map(job => job.messageId)).size).toBe(1)
      expect(fetches.map(job => job.mediaRef).sort()).toEqual([
        'first',
        'first',
        'second',
        'second'
      ])
    })

    describe('the window of an ad', () => {
      const identityOf = (from: string) =>
        owner.customerIdentity.findFirstOrThrow({
          where: { storeId: ctx.storeA.id, channelIdentity: from }
        })
      const fromAd = (
        connectionId: string,
        from: string,
        at: string,
        sourceId = 'ad-1'
      ): InboundEvent => {
        const incoming = event(connectionId, { from, at })
        incoming.message.origin = { kind: 'ad', sourceId }
        return incoming
      }

      it('is counted from the first message of an ad, and only for an ad', async () => {
        const connectionId = await connectionOf(ctx.storeA.id)
        const from = '50370666001'
        const at = new Date(Date.now() - 60_000).toISOString()

        await service.handleMessageReceived(TEST_CHANNEL_ID, event(connectionId, { from }))
        expect((await identityOf(from)).adWindowOpenedAt).toBeNull()

        await service.handleMessageReceived(TEST_CHANNEL_ID, fromAd(connectionId, from, at))
        expect((await identityOf(from)).adWindowOpenedAt?.toISOString()).toBe(at)
      })

      it('moves for a new click on the same ad, because every referral is a click', async () => {
        const connectionId = await connectionOf(ctx.storeA.id)
        const from = '50370666003'
        const first = new Date(Date.now() - 3_600_000).toISOString()
        const again = new Date(Date.now() - 60_000).toISOString()

        await service.handleMessageReceived(TEST_CHANNEL_ID, fromAd(connectionId, from, first))
        await service.handleMessageReceived(TEST_CHANNEL_ID, fromAd(connectionId, from, again))

        expect((await identityOf(from)).adWindowOpenedAt?.toISOString()).toBe(again)
      })

      it('moves forward with a newer ad and never back with an older message', async () => {
        const connectionId = await connectionOf(ctx.storeA.id)
        const from = '50370666002'
        const newer = new Date(Date.now() - 60_000).toISOString()
        const older = new Date(Date.now() - 3_600_000).toISOString()

        await service.handleMessageReceived(TEST_CHANNEL_ID, fromAd(connectionId, from, older))
        await service.handleMessageReceived(
          TEST_CHANNEL_ID,
          fromAd(connectionId, from, newer, 'ad-2')
        )
        expect((await identityOf(from)).adWindowOpenedAt?.toISOString()).toBe(newer)

        // Another ad that arrives late, dated before the newer one
        const late = new Date(Date.now() - 7_200_000).toISOString()
        await service.handleMessageReceived(
          TEST_CHANNEL_ID,
          fromAd(connectionId, from, late, 'ad-3')
        )

        expect((await identityOf(from)).adWindowOpenedAt?.toISOString()).toBe(newer)
      })

      it('opens the window for an ad that names neither an id nor a link', async () => {
        const connectionId = await connectionOf(ctx.storeA.id)
        const from = '50370666004'
        const incoming = event(connectionId, { from })
        incoming.message.origin = { kind: 'ad', title: 'No id' }

        await service.handleMessageReceived(TEST_CHANNEL_ID, incoming)

        expect((await identityOf(from)).adWindowOpenedAt).not.toBeNull()
      })
    })

    describe('the origin of a conversation', () => {
      const withOrigin = (
        connectionId: string,
        from: string,
        sourceId: string | undefined
      ): InboundEvent => {
        const incoming = event(connectionId, { from })
        incoming.message.origin = {
          kind: 'ad',
          ...(sourceId === undefined ? {} : { sourceId }),
          title: 'Zapatos',
          media: { type: 'image', ref: 'ad-image' },
          referral: { source_id: sourceId ?? null, extra: ['kept', 1] }
        }
        return incoming
      }
      const originsOf = (from: string) =>
        owner.conversationOrigin.findMany({
          where: {
            storeId: ctx.storeA.id,
            conversation: { customerIdentity: { channelIdentity: from } }
          },
          orderBy: { createdAt: 'asc' }
        })

      it('stores the ad of a message with the message and keeps the referral as it came', async () => {
        const connectionId = await connectionOf(ctx.storeA.id)
        const from = '50370555001'
        const incoming = withOrigin(connectionId, from, 'ad-1')

        await service.handleMessageReceived(TEST_CHANNEL_ID, incoming)

        const [origin, ...rest] = await originsOf(from)
        const message = await owner.message.findFirstOrThrow({
          where: { storeId: ctx.storeA.id, channelMessageId: incoming.message.externalId }
        })
        expect(rest).toEqual([])
        expect(origin).toMatchObject({
          storeId: ctx.storeA.id,
          conversationId: message.conversationId,
          messageId: message.id,
          kind: 'ad',
          sourceId: 'ad-1',
          title: 'Zapatos',
          mediaType: 'image',
          mediaRef: 'ad-image',
          mediaUrl: null,
          referral: { source_id: 'ad-1', extra: ['kept', 1] }
        })
        // Until the origin card has an endpoint (Step 3.2), what can be proved is the write: the row is
        // in the store of the connection and the other store sees none of it
        expect(
          await owner.conversationOrigin.count({
            where: { storeId: ctx.storeB.id, conversationId: message.conversationId }
          })
        ).toBe(0)
      })

      it('keeps one entry for the same ad in a row, and one more for another ad', async () => {
        const connectionId = await connectionOf(ctx.storeA.id)
        const from = '50370555002'

        await service.handleMessageReceived(TEST_CHANNEL_ID, withOrigin(connectionId, from, 'ad-1'))
        await service.handleMessageReceived(TEST_CHANNEL_ID, withOrigin(connectionId, from, 'ad-1'))
        await service.handleMessageReceived(TEST_CHANNEL_ID, withOrigin(connectionId, from, 'ad-2'))
        await service.handleMessageReceived(TEST_CHANNEL_ID, withOrigin(connectionId, from, 'ad-1'))

        expect((await originsOf(from)).map(origin => origin.sourceId)).toEqual([
          'ad-1',
          'ad-2',
          'ad-1'
        ])
      })

      it('stores every origin that names no ad, and none for a message with no origin', async () => {
        const connectionId = await connectionOf(ctx.storeA.id)
        const from = '50370555003'

        await service.handleMessageReceived(
          TEST_CHANNEL_ID,
          withOrigin(connectionId, from, undefined)
        )
        await service.handleMessageReceived(
          TEST_CHANNEL_ID,
          withOrigin(connectionId, from, undefined)
        )
        await service.handleMessageReceived(TEST_CHANNEL_ID, event(connectionId, { from }))

        expect(await originsOf(from)).toHaveLength(2)
      })

      it('does not lose the message when a provider text carries a NUL character', async () => {
        const connectionId = await connectionOf(ctx.storeA.id)
        const from = '50370555005'
        const incoming = withOrigin(connectionId, from, 'ad-nul')
        incoming.message.origin = {
          ...incoming.message.origin,
          kind: 'ad',
          title: 'Zap\u0000atos',
          referral: { headline: 'a\u0000b' }
        }

        expect(await service.handleMessageReceived(TEST_CHANNEL_ID, incoming)).toBe(
          InboundOutcomes.STORED
        )
        expect((await originsOf(from))[0]?.title).toBe('Zapatos')
      })

      it('does not lose the message when a provider text has half of an emoji', async () => {
        const connectionId = await connectionOf(ctx.storeA.id)
        const from = '50370555007'
        const incoming = withOrigin(connectionId, from, 'ad-half')
        incoming.message.origin = {
          kind: 'ad',
          sourceId: 'ad-half',
          title: 'Zap\ud83d',
          referral: { headline: 'a\ud83d' }
        }

        expect(await service.handleMessageReceived(TEST_CHANNEL_ID, incoming)).toBe(
          InboundOutcomes.STORED
        )
        expect((await originsOf(from))[0]?.title).toBe('Zap\ufffd')
      })

      it('knows an ad by its link when one delivery has the id and another has not', async () => {
        const connectionId = await connectionOf(ctx.storeA.id)
        const from = '50370555008'
        const url = 'https://fb.me/same-ad'
        const first = event(connectionId, { from })
        first.message.origin = { kind: 'ad', sourceId: 'ad-7', sourceUrl: url }
        const second = event(connectionId, { from })
        second.message.origin = { kind: 'ad', sourceUrl: url }

        await service.handleMessageReceived(TEST_CHANNEL_ID, first)
        await service.handleMessageReceived(TEST_CHANNEL_ID, second)

        expect(await originsOf(from)).toHaveLength(1)
      })

      it('does not write the origin twice when the same message is delivered twice', async () => {
        const connectionId = await connectionOf(ctx.storeA.id)
        const from = '50370555004'
        const incoming = withOrigin(connectionId, from, 'ad-9')

        await service.handleMessageReceived(TEST_CHANNEL_ID, incoming)
        await service.handleMessageReceived(TEST_CHANNEL_ID, incoming)

        expect(await originsOf(from)).toHaveLength(1)
      })
    })

    it('never takes a message of the customer for the one of an agent', async () => {
      const connectionId = await connectionOf(ctx.storeA.id)
      const identity = await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        channelType: TEST_CHANNEL_ID,
        handle: '50370222222'
      })
      const existing = await createConversation(owner, {
        storeId: ctx.storeA.id,
        customerId: identity.customerId,
        customerIdentityId: identity.id,
        channelType: TEST_CHANNEL_ID
      })

      await service.handleMessageReceived(
        TEST_CHANNEL_ID,
        event(connectionId, { from: '50370222222' })
      )

      expect(await owner.message.count({ where: { conversationId: existing.id } })).toBe(0)
    })
  })
})
