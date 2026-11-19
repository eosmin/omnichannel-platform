import { createHash, randomInt, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'
import supertest from 'supertest'

import { ChannelContextFactory } from '@platform/channels/connections'
import { API_PREFIX, ApiRoutes, PluginApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { CredentialCipher } from '@platform/core/crypto'
import { JobContext, PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ConversationStatus,
  DeliveryStatus,
  MessageType,
  OutboundLimits,
  PLUGIN_ACTOR_PREFIX,
  PLUGIN_API_KEY_TOKEN_PREFIX,
  PluginCatalogTypes,
  PluginPricingModels,
  PluginStatus
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { OutboundQueue } from '@platform/core/messaging'
import {
  JobNames,
  QueueNames,
  type SendOutboundDeleteJob,
  type SendOutboundEditJob,
  type SendOutboundReactionJob
} from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'
import {
  ChannelCapability,
  type ChannelContext,
  type DeleteMessageParams,
  type EditMessageParams,
  PluginError,
  PluginScopes,
  type SendReactionParams
} from '@platform/plugins/sdk'

import { MessageChangeSender } from '../../apps/worker/src/outbound/message-change-sender.service'
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
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { queueOf } from '../helpers/queue'
import { onWorkerDatabase, createGuardedWorkerPrisma } from '../helpers/worker-db'

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const FORBIDDEN = 403
const CONFLICT = 409

const FULL_SCOPES = [
  PluginScopes.CONVERSATIONS_READ,
  PluginScopes.MESSAGES_READ,
  PluginScopes.MESSAGES_WRITE,
  PluginScopes.MESSAGES_WRITE_AS_AGENT,
  PluginScopes.MESSAGES_DELETE
]

// TDD_10 §6.4, Step 5.6 PR M1c: a plugin is the actor of an edit, a deletion, a resend, a discard and a reaction. What this suite
// pins: the plugin is what the row says (never a person, never an empty id, never `plugin:<id>`), a plugin touches only what it wrote
// (it may react to any message), the worker records the plugin that asked, and a plugin that sends again moves nothing.
describe('A plugin as the actor of a change of a message', () => {
  const prefix = newRunPrefix()
  const pluginA = `${prefix}-a`
  const pluginB = `${prefix}-b`
  const pluginC = `${prefix}-c`
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let sender: MessageChangeSender
  let reactionSender: ReactionSender
  let sweep: OutboundRequeueScheduler
  let edited: EditMessageParams[] = []
  let deleteMessage: (ctx: ChannelContext, params: DeleteMessageParams) => Promise<void>
  let sentReactions: SendReactionParams[] = []
  const keys = { a: '', b: '', noDelete: '' }

  const installPlugin = async (id: string, scopes: string[]): Promise<string> => {
    await owner.plugin.create({
      data: {
        id,
        name: `Plugin ${id}`,
        authorName: 'suite',
        authorEmail: 'suite@example.invalid',
        type: PluginCatalogTypes.INTEGRATION,
        organizationId: ctx.orgA.id,
        manifest: {},
        pricingModel: PluginPricingModels.FREE,
        status: PluginStatus.APPROVED
      }
    })
    const key = `${PLUGIN_API_KEY_TOKEN_PREFIX}${prefix}${id.slice(-1)}${'x'.repeat(40)}`
    await owner.pluginInstallation.create({
      data: {
        storeId: ctx.storeA.id,
        pluginId: id,
        scopes,
        status: 'active',
        apiKeyPrefix: key.slice(0, 12),
        apiKeyHash: createHash('sha256').update(key).digest('hex'),
        installedBy: 'suite'
      }
    })
    return key
  }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([], onWorkerDatabase())
    ctx = await seedTestContext(owner, app, prefix)
    const prisma = app.get(PrismaService, { strict: false })
    const registry = app.get(PluginRegistry, { strict: false })
    registry.register(
      buildChannelPlugin({
        capabilities: [
          ChannelCapability.TEXT,
          ChannelCapability.EDIT_MESSAGE,
          ChannelCapability.DELETE_MESSAGE,
          ChannelCapability.REACTIONS
        ],
        editMessage: (_c, params) => {
          edited.push(params)
          return Promise.resolve()
        },
        deleteMessage: (c, p) => deleteMessage(c, p),
        sendReaction: (_c, params) => {
          sentReactions.push(params)
          return Promise.resolve()
        }
      })
    )
    const events = app.get(DomainEvents, { strict: false })
    // The rows of the suite hold bytes that are no ciphertext: the context is what the plugin gets
    const cipher = { open: () => ({}) } as unknown as CredentialCipher // test double of the cipher
    const status = new MessageChangeStatusWriter(prisma, events, new JobContext(prisma))
    sender = new MessageChangeSender(
      prisma,
      registry,
      new ChannelContextFactory(cipher),
      status,
      await app.resolve(PinoLogger),
      new JobContext(prisma)
    )
    reactionSender = new ReactionSender(
      prisma,
      registry,
      new ChannelContextFactory(cipher),
      new ReactionStatusWriter(prisma, events, new JobContext(prisma)),
      await app.resolve(PinoLogger),
      new JobContext(prisma)
    )
    sweep = new OutboundRequeueScheduler(
      { withLock: (_name: string, _seconds: number, work: () => Promise<void>) => work() } as never, // the lock is not what is tested
      createGuardedWorkerPrisma(),
      new OutboundQueue(queueOf(app, QueueNames.OUTBOUND) as never),
      undefined as never, // the replies are not what is tested
      new ReactionStatusWriter(prisma, events, new JobContext(prisma)),
      status,
      await app.resolve(PinoLogger),
      new JobContext(createGuardedWorkerPrisma())
    )
    keys.a = await installPlugin(pluginA, FULL_SCOPES)
    keys.b = await installPlugin(pluginB, FULL_SCOPES)
    keys.noDelete = await installPlugin(pluginC, [
      PluginScopes.CONVERSATIONS_READ,
      PluginScopes.MESSAGES_WRITE
    ])
  })
  afterAll(async () => {
    await owner.pluginInstallation.deleteMany({ where: { pluginId: { startsWith: prefix } } })
    await cleanUp(owner, prefix)
    await owner.plugin.deleteMany({ where: { id: { startsWith: prefix } } })
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    edited = []
    sentReactions = []
    queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
    deleteMessage = () => Promise.resolve()
  })

  const call = (
    method: 'post' | 'patch' | 'delete' | 'put',
    path: string,
    key: string,
    body?: Record<string, unknown>
  ) => {
    const request = supertest(app.getHttpServer() as Parameters<typeof supertest>[0])
      [method](`${API_PREFIX}${path}`)
      .set('x-forwarded-for', `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`)
      .set('authorization', `Bearer ${key}`)
    return body === undefined ? request : request.send(body)
  }
  const jobs = <T>(name: string): T[] =>
    queueOf(app, QueueNames.OUTBOUND)
      .jobs.filter(item => item.name === name)
      .map(item => item.data as T)

  const firstJob = <T>(name: string): T => {
    const [first] = jobs<T>(name)
    if (first === undefined) throw new Error(`no job ${name} was queued`)
    return first
  }

  // A conversation on the channel of the suite, the customer wrote a moment ago (the window is open)
  const conversationOn = async (
    over: { status?: ConversationStatus; resolvedAt?: Date } = {}
  ): Promise<string> => {
    const storeId = ctx.storeA.id
    const identity = await createCustomerIdentity(owner, {
      storeId,
      channelType: TEST_CHANNEL_ID,
      lastInboundAt: new Date()
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
      ...over
    })
    return conversation.id
  }
  // A message as a plugin or a person wrote it
  const messageIn = async (
    conversationId: string,
    over: {
      type?: MessageType
      authorType?: AuthorType
      authorId?: string | null
      authorPluginId?: string | null
      channelMessageId?: string | null
      deliveryStatus?: DeliveryStatus
      failureDefinitive?: boolean
    }
  ): Promise<string> => {
    const row = await owner.message.create({
      data: {
        storeId: ctx.storeA.id,
        conversationId,
        type: over.type ?? MessageType.TEXT,
        content: 'first text',
        authorType: over.authorType ?? AuthorType.SYSTEM,
        authorId: over.authorId ?? null,
        authorPluginId: over.authorPluginId ?? null,
        channelMessageId: over.channelMessageId ?? null,
        ...(over.deliveryStatus === undefined
          ? {}
          : {
              deliveryStatus: over.deliveryStatus,
              deliveryError: ErrorCodes.CHANNEL_MESSAGE_FAILED,
              failureDefinitive: over.failureDefinitive ?? true
            }),
        createdAt: new Date(Date.now() - 2 * 3_600_000)
      },
      select: { id: true }
    })
    return row.id
  }
  const noteOf = async (authorPluginId: string | null, authorId: string | null = null) =>
    messageIn(await conversationOn(), {
      type: MessageType.INTERNAL_NOTE,
      authorType: authorPluginId === null ? AuthorType.AGENT : AuthorType.SYSTEM,
      authorId,
      authorPluginId
    })
  // A reply the customer has, written by a plugin as the system
  const replyOf = async (authorPluginId: string | null, authorId: string | null = null) =>
    messageIn(await conversationOn(), {
      authorType:
        authorPluginId !== null && authorId === null ? AuthorType.SYSTEM : AuthorType.AGENT,
      authorId,
      authorPluginId,
      channelMessageId: `wamid-${randomUUID()}`
    })
  const row = (id: string) => owner.message.findUniqueOrThrow({ where: { id } })
  const audited = (id: string, operation: string) =>
    waitForAuditEntries(owner, { action: AuditAction.MESSAGE_PLUGIN_CHANGED, resourceId: id }).then(
      entries =>
        entries.filter(entry => (entry.metadata as { operation?: string })?.operation === operation)
    )

  describe('editing', () => {
    it('edits a note it wrote, and the row and the revision say the plugin, not a person', async () => {
      const id = await noteOf(pluginA)

      const response = await call('patch', PluginApiRoutes.messages.byId(id), keys.a, {
        content: 'second text',
        version: 1
      })

      expect(response.status).toBe(OK)
      expect(await row(id)).toMatchObject({
        content: 'second text',
        editedByType: AuthorType.SYSTEM,
        editedById: null,
        editedByPluginId: pluginA
      })
      expect(
        await owner.messageRevision.findFirstOrThrow({ where: { messageId: id } })
      ).toMatchObject({ content: 'first text', editedById: null, editedByPluginId: pluginA })
      const [entry] = await audited(id, 'edit')
      expect(entry).toMatchObject({ userId: null, storeId: ctx.storeA.id })
      expect(entry?.metadata).toMatchObject({ pluginId: pluginA })
    })

    it.each([
      ['a note of another plugin', () => noteOf(pluginB)],
      ['a note of a person', () => noteOf(null, ctx.agentA.id)]
    ])('refuses %s and leaves it as it was', async (_name, make) => {
      const id = await make()

      const response = await call('patch', PluginApiRoutes.messages.byId(id), keys.a, {
        content: 'taken over',
        version: 1
      })

      expect(response.status).toBe(FORBIDDEN)
      expect(await row(id)).toMatchObject({ content: 'first text', editedByPluginId: null })
    })

    it('queues the edit of a reply the customer has with the plugin that asked, and the worker records it as the editor', async () => {
      const id = await replyOf(pluginA)

      const response = await call('patch', PluginApiRoutes.messages.byId(id), keys.a, {
        content: 'second text'
      })

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({ pendingEdit: true })
      expect(await row(id)).toMatchObject({
        pendingEditPluginId: pluginA,
        editedByPluginId: null,
        editedById: null
      })

      await sender.sendEdit(firstJob<SendOutboundEditJob>(JobNames.SEND_OUTBOUND_EDIT), true)

      expect(edited).toHaveLength(1)
      expect(await row(id)).toMatchObject({
        content: 'second text',
        pendingEditPluginId: null,
        editedByType: AuthorType.SYSTEM,
        editedById: null,
        editedByPluginId: pluginA
      })
      expect(
        await owner.messageRevision.findFirstOrThrow({ where: { messageId: id } })
      ).toMatchObject({ editedById: null, editedByPluginId: pluginA })
    })

    it('records the plugin, not the person it wrote for, as the editor of a reply written on behalf of a person', async () => {
      const id = await replyOf(pluginA, ctx.agentA.id)

      await call('patch', PluginApiRoutes.messages.byId(id), keys.a, { content: 'second text' })
      await sender.sendEdit(firstJob<SendOutboundEditJob>(JobNames.SEND_OUTBOUND_EDIT), true)

      expect(await row(id)).toMatchObject({ editedById: null, editedByPluginId: pluginA })
    })

    it('records the person as before when a person edits a reply of their own', async () => {
      const id = await replyOf(null, ctx.agentA.id)

      await api(app, ctx.agentA, ctx.storeA)
        .patch(ApiRoutes.messages.byId(id))
        .send({ content: 'second text' })
      await sender.sendEdit(firstJob<SendOutboundEditJob>(JobNames.SEND_OUTBOUND_EDIT), true)

      expect(await row(id)).toMatchObject({
        editedById: ctx.agentA.id,
        editedByPluginId: null,
        pendingEditPluginId: null
      })
    })

    it.each([
      ['another plugin', () => replyOf(pluginB)],
      ['a person', () => replyOf(null, ctx.agentA.id)]
    ])('refuses the edit of a reply of %s', async (_name, make) => {
      const id = await make()

      const response = await call('patch', PluginApiRoutes.messages.byId(id), keys.a, {
        content: 'taken over'
      })

      expect(response.status).toBe(FORBIDDEN)
      expect(jobs(JobNames.SEND_OUTBOUND_EDIT)).toHaveLength(0)
    })
  })

  describe('deleting', () => {
    it('deletes a note it wrote and says the plugin did', async () => {
      const id = await noteOf(pluginA)

      const response = await call('delete', PluginApiRoutes.messages.byId(id), keys.a)

      expect(response.status).toBe(NO_CONTENT)
      expect(await row(id)).toMatchObject({
        deletedByType: AuthorType.SYSTEM,
        deletedById: null,
        deletedByPluginId: pluginA
      })
      expect((await row(id)).deletedAt).not.toBeNull()
      expect(await audited(id, 'delete')).toHaveLength(1)
    })

    it.each([
      ['a note of another plugin', () => noteOf(pluginB)],
      ['a note of a person', () => noteOf(null, ctx.agentA.id)],
      ['a reply of another plugin', () => replyOf(pluginB)],
      ['a reply of a person', () => replyOf(null, ctx.agentA.id)]
    ])('refuses %s, though the scope to delete is held', async (_name, make) => {
      const id = await make()

      const response = await call('delete', PluginApiRoutes.messages.byId(id), keys.a)

      expect(response.status).toBe(FORBIDDEN)
      expect(await row(id)).toMatchObject({
        deletedAt: null,
        deleteStatus: null,
        deletedByPluginId: null
      })
    })

    it('needs the scope to delete, which messages:write does not give', async () => {
      const id = await noteOf(pluginC)

      const response = await call('delete', PluginApiRoutes.messages.byId(id), keys.noDelete)

      expect(response.status).toBe(FORBIDDEN)
      expect((await row(id)).deletedAt).toBeNull()
    })

    it('queues the deletion of a reply the customer has with the plugin as the deleter, and nobody is the deleter if the channel refuses', async () => {
      const id = await replyOf(pluginA)
      deleteMessage = () =>
        Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false }))

      const response = await call('delete', PluginApiRoutes.messages.byId(id), keys.a)

      expect(response.status).toBe(NO_CONTENT)
      expect(await row(id)).toMatchObject({
        deleteStatus: DeliveryStatus.QUEUED,
        deletedById: null,
        deletedByPluginId: pluginA
      })
      await sender.sendDeletion(
        firstJob<SendOutboundDeleteJob>(JobNames.SEND_OUTBOUND_DELETE),
        true
      )
      expect(await row(id)).toMatchObject({
        deletedAt: null,
        deleteStatus: DeliveryStatus.FAILED,
        deletedByType: null,
        deletedById: null,
        deletedByPluginId: null
      })
    })
  })

  describe('sending a reply again', () => {
    it('puts a reply of its own back on its way and moves nothing of the conversation', async () => {
      const resolvedAt = new Date(Date.now() - 3_600_000)
      const conversationId = await conversationOn({
        status: ConversationStatus.RESOLVED,
        resolvedAt
      })
      const id = await messageIn(conversationId, {
        authorPluginId: pluginA,
        deliveryStatus: DeliveryStatus.FAILED
      })
      const before = await owner.conversation.findUniqueOrThrow({ where: { id: conversationId } })
      const lines = await owner.message.count({ where: { conversationId } })

      const response = await call('post', PluginApiRoutes.messages.resend(id), keys.a, {})

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({ id, deliveryStatus: DeliveryStatus.QUEUED })
      const after = await owner.conversation.findUniqueOrThrow({ where: { id: conversationId } })
      // A bot trying again is not the team answering: the resolution, the dates and the thread stay
      expect(after).toMatchObject({
        status: ConversationStatus.RESOLVED,
        lastMessageAt: before.lastMessageAt,
        firstResponseAt: before.firstResponseAt,
        firstAutomatedResponseAt: before.firstAutomatedResponseAt
      })
      expect(await owner.message.count({ where: { conversationId } })).toBe(lines)
      expect(await audited(id, 'resend')).toHaveLength(1)
    })

    it('refuses the failed reply of another plugin and of a person', async () => {
      const theirs = await messageIn(await conversationOn(), {
        authorPluginId: pluginB,
        deliveryStatus: DeliveryStatus.FAILED
      })
      const person = await messageIn(await conversationOn(), {
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id,
        deliveryStatus: DeliveryStatus.FAILED
      })

      for (const id of [theirs, person]) {
        const response = await call('post', PluginApiRoutes.messages.resend(id), keys.a, {})
        expect(response.status).toBe(FORBIDDEN)
        expect((await row(id)).deliveryStatus).toBe(DeliveryStatus.FAILED)
      }
    })

    it('does not count as the answer of the team when a person sends again what a plugin wrote as the system', async () => {
      const conversationId = await conversationOn({
        status: ConversationStatus.RESOLVED,
        resolvedAt: new Date(Date.now() - 3_600_000)
      })
      const id = await messageIn(conversationId, {
        authorPluginId: pluginA,
        deliveryStatus: DeliveryStatus.FAILED
      })

      const response = await api(app, ctx.agentA, ctx.storeA).post(ApiRoutes.messages.resend(id))

      expect(response.status).toBe(OK)
      const after = await owner.conversation.findUniqueOrThrow({ where: { id: conversationId } })
      expect(after.status).toBe(ConversationStatus.RESOLVED)
      expect(after.firstResponseAt).toBeNull()
    })

    it('refuses to send again the caption of a message of a person or of another plugin', async () => {
      const person = await messageIn(await conversationOn(), {
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id
      })
      const theirs = await messageIn(await conversationOn(), {
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id,
        authorPluginId: pluginB
      })

      for (const id of [person, theirs]) {
        const response = await call('post', PluginApiRoutes.messages.resendCaption(id), keys.a, {})
        expect(response.status).toBe(FORBIDDEN)
      }
    })

    it('refuses a reply that did not fail', async () => {
      const id = await messageIn(await conversationOn(), { authorPluginId: pluginA })

      const response = await call('post', PluginApiRoutes.messages.resend(id), keys.a, {})

      expect(response.status).toBe(CONFLICT)
    })
  })

  describe('discarding', () => {
    it('throws away a failed reply of its own, once, and says the plugin did', async () => {
      const id = await messageIn(await conversationOn(), {
        authorPluginId: pluginA,
        deliveryStatus: DeliveryStatus.FAILED
      })

      const first = await call('post', PluginApiRoutes.messages.discard(id), keys.a, {})
      const second = await call('post', PluginApiRoutes.messages.discard(id), keys.a, {})

      expect(first.status).toBe(NO_CONTENT)
      expect(second.status).toBe(NO_CONTENT)
      expect(await row(id)).toMatchObject({
        deletedByType: AuthorType.SYSTEM,
        deletedById: null,
        deletedByPluginId: pluginA
      })
      expect((await row(id)).discardedAt).not.toBeNull()
      await new Promise(resolve => setTimeout(resolve, 300))
      expect(await audited(id, 'discard')).toHaveLength(1)
    })

    it('refuses the failed reply of another plugin and needs the scope to delete', async () => {
      const theirs = await messageIn(await conversationOn(), {
        authorPluginId: pluginB,
        deliveryStatus: DeliveryStatus.FAILED
      })
      const mine = await messageIn(await conversationOn(), {
        authorPluginId: pluginC,
        deliveryStatus: DeliveryStatus.FAILED
      })

      const other = await call('post', PluginApiRoutes.messages.discard(theirs), keys.a, {})
      const unscoped = await call('post', PluginApiRoutes.messages.discard(mine), keys.noDelete, {})

      expect(other.status).toBe(FORBIDDEN)
      expect(unscoped.status).toBe(FORBIDDEN)
      expect((await row(theirs)).discardedAt).toBeNull()
      expect((await row(mine)).discardedAt).toBeNull()
    })
  })

  describe('reacting', () => {
    const customerMessage = async (): Promise<string> =>
      messageIn(await conversationOn(), {
        authorType: AuthorType.CUSTOMER,
        channelMessageId: `wamid-${randomUUID()}`
      })
    const react = (id: string, emoji: string | null, key = keys.a) =>
      call('put', PluginApiRoutes.messages.reaction(id), key, { emoji })
    const reactionsOf = (messageId: string) =>
      owner.messageReaction.findMany({ where: { messageId }, orderBy: { createdAt: 'asc' } })

    it('reacts as the system with the plugin on the row, sends it to the channel and settles it', async () => {
      const id = await customerMessage()

      const response = await react(id, '👍')

      expect(response.status).toBe(NO_CONTENT)
      const [reaction] = await reactionsOf(id)
      expect(reaction).toMatchObject({
        authorType: AuthorType.SYSTEM,
        pluginId: pluginA,
        userId: null,
        customerIdentityId: null,
        emoji: '👍',
        deliveryStatus: DeliveryStatus.QUEUED
      })
      const [queued] = jobs<SendOutboundReactionJob>(JobNames.SEND_OUTBOUND_REACTION)
      expect(queued).toMatchObject({ messageId: id, userId: null, pluginId: pluginA })

      await reactionSender.send(JSON.parse(JSON.stringify(queued)) as SendOutboundReactionJob, true)

      expect(sentReactions).toHaveLength(1)
      expect((await reactionsOf(id))[0]?.deliveryStatus).toBe(DeliveryStatus.SENT)
      expect(await audited(id, 'react')).toHaveLength(1)
    })

    it('keeps one reaction for each plugin and person, changes it with a new emoji and takes it back with null', async () => {
      const id = await customerMessage()

      await react(id, '👍')
      await react(id, '❤')
      await react(id, '🔥', keys.b)

      const both = await reactionsOf(id)
      expect(both.map(item => [item.pluginId, item.emoji])).toEqual([
        [pluginA, '❤'],
        [pluginB, '🔥']
      ])

      const removed = await react(id, null)

      expect(removed.status).toBe(NO_CONTENT)
      expect((await reactionsOf(id)).map(item => item.pluginId)).toEqual([pluginB])
    })

    it('does not touch the reaction of a person of the same message', async () => {
      const id = await customerMessage()
      await owner.messageReaction.create({
        data: {
          storeId: ctx.storeA.id,
          messageId: id,
          authorType: AuthorType.AGENT,
          userId: ctx.agentA.id,
          emoji: '😀'
        }
      })

      await react(id, '👍')
      await react(id, null)

      expect(await reactionsOf(id)).toMatchObject([
        { authorType: AuthorType.AGENT, userId: ctx.agentA.id, pluginId: null, emoji: '😀' }
      ])
    })

    it('has its stale reactions sent again by the sweep, with the plugin on the job', async () => {
      const id = await customerMessage()
      await react(id, '👍')
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
      await owner.messageReaction.updateMany({
        where: { messageId: id },
        data: { updatedAt: new Date(Date.now() - OutboundLimits.REQUEUE_AFTER_MS - 30_000) }
      })

      const done = await sweep.requeueStaleReactions()

      expect(done.requeued).toBeGreaterThanOrEqual(1)
      expect(
        jobs<SendOutboundReactionJob>(JobNames.SEND_OUTBOUND_REACTION).find(
          job => job.messageId === id
        )
      ).toMatchObject({ userId: null, pluginId: pluginA })
    })

    it('is refused without messages:write', async () => {
      const id = await customerMessage()
      await owner.pluginInstallation.updateMany({
        where: { pluginId: pluginC },
        data: { scopes: [PluginScopes.CONVERSATIONS_READ] }
      })

      const response = await react(id, '👍', keys.noDelete)

      await owner.pluginInstallation.updateMany({
        where: { pluginId: pluginC },
        data: { scopes: [PluginScopes.CONVERSATIONS_READ, PluginScopes.MESSAGES_WRITE] }
      })
      expect(response.status).toBe(FORBIDDEN)
      expect(await reactionsOf(id)).toHaveLength(0)
    })
  })

  describe('what the database keeps', () => {
    it('refuses a change with both a person and a plugin as its author, and a reaction with both', async () => {
      const id = await noteOf(pluginA)
      const message = await messageIn(await conversationOn(), {
        authorType: AuthorType.CUSTOMER,
        channelMessageId: `wamid-${randomUUID()}`
      })

      await expect(
        owner.message.update({
          where: { id },
          data: { editedById: ctx.agentA.id, editedByPluginId: pluginA }
        })
      ).rejects.toThrow()
      await expect(
        owner.message.update({
          where: { id },
          data: { deletedById: ctx.agentA.id, deletedByPluginId: pluginA }
        })
      ).rejects.toThrow()
      await expect(
        owner.messageRevision.create({
          data: {
            storeId: ctx.storeA.id,
            messageId: id,
            version: 9,
            editedByType: AuthorType.AGENT,
            editedById: ctx.agentA.id,
            editedByPluginId: pluginA
          }
        })
      ).rejects.toThrow()
      await expect(
        owner.messageReaction.create({
          data: {
            storeId: ctx.storeA.id,
            messageId: message,
            authorType: AuthorType.AGENT,
            userId: ctx.agentA.id,
            pluginId: pluginA,
            emoji: '👍'
          }
        })
      ).rejects.toThrow()
      await expect(
        owner.messageReaction.create({
          data: {
            storeId: ctx.storeA.id,
            messageId: message,
            authorType: AuthorType.SYSTEM,
            emoji: '👍'
          }
        })
      ).rejects.toThrow()
    })

    it('refuses a second reaction of the same plugin on the same target', async () => {
      const message = await messageIn(await conversationOn(), {
        authorType: AuthorType.CUSTOMER,
        channelMessageId: `wamid-${randomUUID()}`
      })
      const data = {
        storeId: ctx.storeA.id,
        messageId: message,
        authorType: AuthorType.SYSTEM,
        pluginId: pluginA,
        emoji: '👍'
      }
      await owner.messageReaction.create({ data })

      await expect(owner.messageReaction.create({ data })).rejects.toThrow()
    })

    it('never stores an empty or a plugin: id as the person of anything a plugin did', async () => {
      const rows = await owner.message.findMany({
        where: {
          storeId: ctx.storeA.id,
          OR: [{ editedByPluginId: { not: null } }, { deletedByPluginId: { not: null } }]
        },
        select: { editedById: true, deletedById: true }
      })
      const reactions = await owner.messageReaction.findMany({
        where: { storeId: ctx.storeA.id, pluginId: { not: null } },
        select: { userId: true }
      })

      expect(rows.length + reactions.length).toBeGreaterThan(0)
      for (const item of [
        ...rows.flatMap(r => [r.editedById, r.deletedById]),
        ...reactions.map(r => r.userId)
      ]) {
        expect(item).toBeNull()
      }
      const entries = await owner.auditLog.findMany({
        where: { storeId: ctx.storeA.id, action: AuditAction.MESSAGE_PLUGIN_CHANGED }
      })
      expect(entries.length).toBeGreaterThan(0)
      expect(JSON.stringify(entries)).not.toContain(PLUGIN_ACTOR_PREFIX)
      expect(entries.every(entry => entry.userId === null)).toBe(true)
    })
  })

  it('still writes a message through the create route (the suite shares its key with the route of M1b)', async () => {
    const response = await call('post', PluginApiRoutes.messages.create, keys.a, {
      type: 'note',
      conversationId: await conversationOn(),
      content: 'a note',
      idempotencyKey: randomUUID()
    })

    expect(response.status).toBe(CREATED)
  })
})
