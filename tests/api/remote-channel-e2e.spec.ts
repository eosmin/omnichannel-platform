import { randomInt, randomUUID } from 'node:crypto'

import { getQueueToken } from '@nestjs/bullmq'
import type { INestApplication } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'
import supertest from 'supertest'

import { ChannelContextFactory, ChannelHealthService } from '@platform/channels/connections'
import { API_PREFIX, ApiRoutes, PluginApiRoutes } from '@platform/core/api'
import type { CredentialCipher } from '@platform/core/crypto'
import { JobContext, PrismaService, WorkerLists } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  DeliveryStatus,
  MessageType,
  PLUGIN_REVOKE_CONFIRMATION,
  RoutingActionTypes
} from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import {
  AwayReplyService,
  ChannelConnectionResolver,
  ConversationsService,
  CustomerIdentityService,
  type InboundEvent,
  InboundMessageService,
  MessagingWindowService,
  OutboundQueue,
  RoutingService
} from '@platform/core/messaging'
import { QueueNames } from '@platform/core/queues'
import { StorageService } from '@platform/core/storage-module'
import {
  type PluginManifest,
  PluginRegistry,
  RemoteChannelPlugin,
  type RemoteExchange,
  verifyRemoteCommand
} from '@platform/plugins/runtime'
import { ChannelEventTypes, PluginScopes } from '@platform/plugins/sdk'

import { ChannelReceipts } from '../../apps/worker/src/outbound/channel-receipts.service'
import { MessageStatusWriter } from '../../apps/worker/src/outbound/message-status.writer'
import { OutboundSender } from '../../apps/worker/src/outbound/outbound-sender.service'
import { createConversationOf, createMessage, TEST_CHANNEL_ID } from '../builders'
import {
  loopbackExchange,
  type ReferencePlugin,
  startReferencePlugin
} from '../contracts/remote-channel-reference-plugin'
import {
  DECLARED_COMMANDS_URL,
  referenceEvents,
  referenceManifest
} from '../contracts/remote-channel.contract'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue, queueOf } from '../helpers/queue'
import { onWorkerDatabase } from '../helpers/worker-db'

const OK = 200
const CREATED = 201
const ACCEPTED = 202

interface Job {
  pluginId: string
  event: Record<string, unknown> & { type: string; message?: Record<string, unknown> }
  receivedAt: string
}

// The second half of "Done when" of Step 5.6: a channel plugin of the contract suite (the reference plugin) is registered and
// installed, appears in the inbox under its own name, a message it posts reaches the inbox, the reply of an agent reaches it as a
// signed command, its status comes back, and a status event for a message of another channel is dropped. Everything between the
// plugin and the platform is real (the routes, the key, the secret, the registry, the worker services); the one thing replaced
// is the network: the adapter reaches the reference plugin over the loopback, not over public https.
describe('A remote channel plugin, from its registration to the status of a reply', () => {
  const prefix = newRunPrefix()
  const pluginId = `${prefix}-reference`
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let prisma: PrismaService
  let service: ReferencePlugin | undefined
  const reference = (): ReferencePlugin => {
    if (service === undefined) throw new Error('the reference plugin was not started')
    return service
  }
  let sender: OutboundSender
  let receipts: ChannelReceipts
  let inbound: InboundMessageService
  let key: string
  let commandSecret: string
  let storeId: string

  const account = `acct-${randomUUID().slice(0, 8)}`
  const http = () => supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const fromAddress = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`
  const asPlugin = (method: 'put' | 'post', path: string) =>
    http()
      [method](`${API_PREFIX}${path}`)
      .set('x-forwarded-for', fromAddress())
      .set('authorization', `Bearer ${key}`)
  const inboundJobs = () => queueOf(app, QueueNames.INBOUND).jobs
  const now = () => new Date().toISOString()

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp(
      [],
      onWorkerDatabase(builder =>
        builder
          .overrideProvider(getQueueToken(QueueNames.INBOUND))
          .useValue(new CapturedQueue())
          .overrideProvider(getQueueToken(QueueNames.HEAVY_PROCESSING))
          .useValue(new CapturedQueue())
      )
    )
    ctx = await seedTestContext(owner, app, prefix)
    storeId = ctx.storeA.id
    prisma = app.get(PrismaService, { strict: false })
  })
  afterAll(async () => {
    await service?.stop()
    await cleanUp(owner, prefix)
    await owner.channelConnection.deleteMany({ where: { pluginId: { startsWith: prefix } } })
    await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: prefix } } })
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await app.close()
    await owner.$disconnect()
  })

  it('is registered and installed by the owner, and the key and the secret of its commands come back once', async () => {
    const manifest: PluginManifest = referenceManifest(DECLARED_COMMANDS_URL, { id: pluginId })
    await asAdmin().post(ApiRoutes.plugins.register).send(manifest).expect(CREATED)
    const consent = (await asAdmin().get(ApiRoutes.plugins.consent(pluginId)).expect(OK)).body as {
      scopes: string[]
    }
    expect([...consent.scopes].sort()).toEqual(
      [PluginScopes.CHANNEL_CONNECTIONS, PluginScopes.CHANNEL_EVENTS].sort()
    )
    const installed = await asAdmin()
      .post(ApiRoutes.plugins.install)
      .send({ pluginId, scopes: consent.scopes })
      .expect(CREATED)
    const exchanged = await http()
      .post(`${API_PREFIX}${PluginApiRoutes.setupExchange}`)
      .set('x-forwarded-for', fromAddress())
      .send({ code: (installed.body as { setup: { code: string } }).setup.code })
      .expect(OK)
    const setup = exchanged.body as { apiKey: string; commandSecret?: string }
    expect(setup.commandSecret).toEqual(expect.any(String))
    key = setup.apiKey
    commandSecret = setup.commandSecret ?? ''

    // The service of the plugin, which holds the secret it was given, and the adapter of the registry pointed at it. The adapter is
    // the one the platform built from the manifest and reads its secret from the installation: nothing about it is made up here
    const started = await startReferencePlugin([commandSecret])
    service = started
    const adapter = app.get(PluginRegistry, { strict: false }).get(pluginId)
    expect(adapter).toBeInstanceOf(RemoteChannelPlugin)
    const toLoopback: RemoteExchange = (_url, options) => loopbackExchange(started.url, options)
    Object.assign(adapter, { exchange: toLoopback })

    // The workers of the suite, over the same registry and database
    const logger: PinoLogger = await app.resolve(PinoLogger)
    const events = app.get(DomainEvents, { strict: false })
    const conversations = app.get(ConversationsService, { strict: false })
    const connections = new ChannelConnectionResolver(prisma)
    const writer = new MessageStatusWriter(prisma, events, new JobContext(prisma))
    const cipher = { open: () => ({}) } as unknown as CredentialCipher // test double of the cipher: the plugin holds the credentials
    const contexts = new ChannelContextFactory(cipher)
    sender = new OutboundSender(
      prisma,
      app.get(PluginRegistry, { strict: false }),
      contexts,
      writer,
      conversations,
      app.get(MessagingWindowService, { strict: false }),
      events,
      app.get(StorageService, { strict: false }),
      logger,
      new JobContext(prisma)
    )
    receipts = new ChannelReceipts(
      prisma,
      connections,
      writer,
      new ChannelHealthService(
        prisma,
        contexts,
        events,
        logger,
        new JobContext(prisma),
        new WorkerLists(prisma)
      ),
      logger,
      new JobContext(prisma)
    )
    inbound = new InboundMessageService(
      prisma,
      connections,
      app.get(CustomerIdentityService, { strict: false }),
      conversations,
      app.get(RoutingService, { strict: false }),
      new AwayReplyService(
        prisma,
        conversations,
        app.get(MessagingWindowService, { strict: false }),
        events,
        app.get(OutboundQueue, { strict: false }),
        logger
      ),
      events,
      queueOf(app, QueueNames.HEAVY_PROCESSING) as never,
      logger,
      app.get(JobContext, { strict: false })
    )
  })

  it('links an account through its own key, and the inbox names the channel as the manifest does', async () => {
    await asPlugin('put', PluginApiRoutes.channel.connection(account))
      .send({ displayName: 'Reference line' })
      .expect(CREATED)

    const directory = (
      (await asAgent().get(ApiRoutes.channels.directory).expect(OK)).body as {
        data: { id: string; pluginId: string; displayName: string }[]
      }
    ).data
    const listed = directory.find(item => item.pluginId === pluginId)
    expect(listed?.displayName).toBe('Reference line')
  })

  // The routing editor offers the channels of this directory (`channelChoicesOf`), so a rule can name the plugin: the
  // api accepts the id of an installed channel plugin there, and the rule keeps it (Step 5.6 W2)
  it('lets a routing rule name the channel of the plugin', async () => {
    const created = await asAdmin()
      .post(ApiRoutes.settings.routing)
      .send({
        name: `${prefix} remote channel`,
        conditions: { channelTypes: [pluginId] },
        action: { type: RoutingActionTypes.UNASSIGNED }
      })
      .expect(CREATED)
    expect((created.body as { conditions: { channelTypes: string[] } }).conditions).toEqual({
      channelTypes: [pluginId]
    })
  })

  it('brings a message the plugin posts into the inbox, as a conversation of that channel', async () => {
    inboundJobs().length = 0
    const events = referenceEvents(account)
    const response = await asPlugin('post', PluginApiRoutes.channel.events).send({
      events: [events['received']]
    })
    expect(response.status).toBe(ACCEPTED)
    expect(response.body).toEqual({ accepted: 1 })

    // What the worker does with the job the route queued
    const [job] = inboundJobs().map(queued => queued.data as Job)
    expect(job?.pluginId).toBe(pluginId)
    const event = job?.event
    if (event?.message === undefined || job === undefined) throw new Error('no message was queued')
    await inbound.handleMessageReceived(
      pluginId,
      { ...event, message: event.message } as unknown as InboundEvent,
      new Date(job.receivedAt)
    )

    const message = await owner.message.findFirstOrThrow({
      where: {
        storeId,
        authorType: AuthorType.CUSTOMER,
        content: 'hello',
        conversation: { channelType: pluginId }
      },
      select: { conversationId: true }
    })
    const conversation = await owner.conversation.findUniqueOrThrow({
      where: { id: message.conversationId },
      select: { channelType: true, channelConnection: { select: { connectionId: true } } }
    })
    expect(conversation.channelType).toBe(pluginId)
    expect(conversation.channelConnection?.connectionId).toBe(account)
  })

  let reply: { id: string; externalId: string }

  it('sends the reply of an agent to the plugin as a signed command, and keeps the id the plugin gives back', async () => {
    const conversation = await owner.conversation.findFirstOrThrow({
      where: { storeId, channelType: pluginId },
      select: { id: true, customerIdentity: { select: { channelIdentity: true } } }
    })
    const created = await owner.message.create({
      data: {
        storeId,
        conversationId: conversation.id,
        type: MessageType.TEXT,
        content: 'we are on it',
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id,
        deliveryStatus: DeliveryStatus.QUEUED
      },
      select: { id: true }
    })

    await sender.send({ storeId, messageId: created.id }, false)

    const stored = await owner.message.findUniqueOrThrow({
      where: { id: created.id },
      select: { deliveryStatus: true, channelMessageId: true }
    })
    expect(stored.deliveryStatus).toBe(DeliveryStatus.SENT)
    expect(stored.channelMessageId).toBe('ref-1')
    expect(reference().received).toHaveLength(1)
    const [command] = reference().received
    expect(command).toMatchObject({
      command: 'message.send',
      storeId,
      connectionId: account,
      idempotencyKey: created.id,
      data: { messageId: created.id, type: 'text', content: 'we are on it' }
    })
    // Signed with the secret the exchange gave the plugin, over the bytes it was sent
    expect(
      verifyRemoteCommand(
        command?.signature ?? '',
        command?.rawBody ?? '',
        [commandSecret],
        Math.floor(Date.now() / 1000)
      )
    ).toBe(true)
    expect(reference().refused).toBe(0)
    reply = { id: created.id, externalId: stored.channelMessageId ?? '' }
  })

  it('takes the status the plugin reports for that reply, through the route and the worker', async () => {
    // The manifest declares delivery receipts, and the plugin says delivered with the id it gave
    inboundJobs().length = 0
    const delivered = {
      ...(referenceEvents(account)['delivered'] as Record<string, unknown>),
      status: { externalId: reply.externalId }
    }
    const response = await asPlugin('post', PluginApiRoutes.channel.events).send({
      events: [delivered]
    })
    expect(response.status).toBe(ACCEPTED)
    expect(response.body).toEqual({ accepted: 1 })

    const [job] = inboundJobs().map(queued => queued.data as Job)
    await receipts.handleReceipt(
      pluginId,
      job?.event as Parameters<ChannelReceipts['handleReceipt']>[1],
      false
    )

    const stored = await owner.message.findUniqueOrThrow({
      where: { id: reply.id },
      select: { deliveryStatus: true }
    })
    expect(stored.deliveryStatus).toBe(DeliveryStatus.DELIVERED)
  })

  it('drops a status event for a message of another channel: nothing is queued and the message is untouched', async () => {
    inboundJobs().length = 0
    // A reply of the same store on a connection of the test channel, which is not this plugin's
    const other = await createConversationOf(owner, { storeId, channelType: TEST_CHANNEL_ID })
    const foreign = await createMessage(owner, {
      storeId,
      conversationId: other.id,
      authorType: AuthorType.AGENT,
      authorId: ctx.agentA.id
    })
    const before = await owner.message.findUniqueOrThrow({
      where: { id: foreign.id },
      select: { deliveryStatus: true }
    })
    const failed = {
      type: ChannelEventTypes.MESSAGE_FAILED,
      connectionId: account,
      channelIdentity: 'customer-1',
      status: { externalId: 'ref-1', error: { code: 'rejected', message: 'no' } },
      messageId: foreign.id,
      timestamp: now()
    }

    const response = await asPlugin('post', PluginApiRoutes.channel.events).send({
      events: [failed]
    })

    expect(response.status).toBe(ACCEPTED)
    expect(response.body).toEqual({ accepted: 0 })
    expect(inboundJobs()).toHaveLength(0)
    const untouched = await owner.message.findUniqueOrThrow({
      where: { id: foreign.id },
      select: { deliveryStatus: true }
    })
    expect(untouched.deliveryStatus).toBe(before.deliveryStatus)
  })

  it('stops hearing from the plugin when its key is revoked', async () => {
    const installation = await owner.pluginInstallation.findFirstOrThrow({
      where: { pluginId, storeId },
      select: { id: true }
    })
    await asAdmin()
      .post(ApiRoutes.plugins.revoke(installation.id))
      .send({ confirmation: PLUGIN_REVOKE_CONFIRMATION })
      .expect(OK)

    const response = await asPlugin('post', PluginApiRoutes.channel.events).send({
      events: [referenceEvents(account)['received']]
    })
    expect(response.status).toBe(401)
  })
})
