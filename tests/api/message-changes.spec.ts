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
import {
  JobNames,
  QueueNames,
  type SendOutboundDeleteJob,
  type SendOutboundEditJob
} from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'
import {
  ChannelCapability,
  type ChannelContext,
  type DeleteMessageParams,
  type EditMessageParams,
  PluginError
} from '@platform/plugins/sdk'

import { MessageChangeSender } from '../../apps/worker/src/outbound/message-change-sender.service'
import { MessageChangeStatusWriter } from '../../apps/worker/src/outbound/message-change-status.writer'
import { ReactionStatusWriter } from '../../apps/worker/src/outbound/reaction-status.writer'
import { DeletedMessagePurgeScheduler } from '../../apps/worker/src/schedulers/deleted-message-purge.scheduler'
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
const NO_CONTENT = 204
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const PLAIN_TEXT_CHANNEL = 'plain_channel'
const DAY_MS = 86_400_000

interface ThreadBody {
  data: {
    id: string
    content: string | null
    version: number
    pendingEdit: boolean
    editStatus: string | null
    editError: string | null
    deletedAt: string | null
    deleteStatus: string | null
    deleteError: string | null
  }[]
}

const codeOf = (body: unknown): string => (body as { error: { code: string } }).error.code

describe('An agent editing and deleting a message', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let sender: MessageChangeSender
  let sweep: OutboundRequeueScheduler
  let purge: DeletedMessagePurgeScheduler
  let edited: EditMessageParams[] = []
  let deleted: DeleteMessageParams[] = []
  let editMessage: (ctx: ChannelContext, params: EditMessageParams) => Promise<void>
  let deleteMessage: (ctx: ChannelContext, params: DeleteMessageParams) => Promise<void>

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const prisma = app.get(PrismaService, { strict: false })
    const registry = app.get(PluginRegistry, { strict: false })
    registry.register(
      buildChannelPlugin({
        capabilities: [
          ChannelCapability.TEXT,
          ChannelCapability.EDIT_MESSAGE,
          ChannelCapability.DELETE_MESSAGE
        ],
        editMessage: (c, p) => editMessage(c, p),
        deleteMessage: (c, p) => deleteMessage(c, p)
      })
    )
    registry.register(buildChannelPlugin({ id: PLAIN_TEXT_CHANNEL }))
    const events = app.get(DomainEvents, { strict: false })
    // The rows of the suite hold bytes that are no ciphertext: the context is what the plugin gets
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
    purge = new DeletedMessagePurgeScheduler(
      undefined as never, // the lock is not what is tested
      prisma,
      await app.resolve(PinoLogger)
    )
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    edited = []
    deleted = []
    queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
    editMessage = (_ctx, params) => {
      edited.push(params)
      return Promise.resolve()
    }
    deleteMessage = (_ctx, params) => {
      deleted.push(params)
      return Promise.resolve()
    }
  })

  const conversationOn = async (pluginId: string): Promise<string> => {
    const storeId = ctx.storeA.id
    const identity = await createCustomerIdentity(owner, { storeId, channelType: pluginId })
    const connection = await createChannelConnection(owner, { storeId, channelType: pluginId })
    const conversation = await createConversation(owner, {
      storeId,
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType: pluginId,
      channelConnectionId: connection.id
    })
    return conversation.id
  }
  const messageIn = async (
    conversationId: string,
    over: {
      type?: MessageType
      authorType?: AuthorType
      authorId?: string | null
      content?: string
      channelMessageId?: string | null
    }
  ): Promise<string> => {
    const row = await owner.message.create({
      data: {
        storeId: ctx.storeA.id,
        conversationId,
        type: over.type ?? MessageType.TEXT,
        content: over.content ?? 'hello',
        authorType: over.authorType ?? AuthorType.AGENT,
        authorId: over.authorId === undefined ? ctx.agentA.id : over.authorId,
        channelMessageId: over.channelMessageId === undefined ? null : over.channelMessageId
      },
      select: { id: true }
    })
    return row.id
  }
  const noteBy = async (authorId: string, content = 'note v1'): Promise<string> =>
    messageIn(await conversationOn(TEST_CHANNEL_ID), {
      type: MessageType.INTERNAL_NOTE,
      authorId,
      content,
      channelMessageId: null
    })
  // A reply the customer has, written by the agent of the context
  const replyOn = async (pluginId = TEST_CHANNEL_ID, authorId = ctx.agentA.id): Promise<string> =>
    messageIn(await conversationOn(pluginId), {
      authorId,
      content: 'first text',
      channelMessageId: `wamid-${randomUUID()}`
    })

  const edit = (id: string, body: object, who = ctx.agentA) =>
    api(app, who, ctx.storeA).patch(ApiRoutes.messages.byId(id)).send(body)
  const remove = (id: string, who = ctx.agentA) =>
    api(app, who, ctx.storeA).delete(ApiRoutes.messages.byId(id))
  const row = (id: string) =>
    owner.message.findUniqueOrThrow({
      where: { id },
      select: {
        content: true,
        version: true,
        pendingContent: true,
        editStatus: true,
        editError: true,
        editedAt: true,
        editedByType: true,
        editedById: true,
        deletedAt: true,
        deletedByType: true,
        deletedById: true,
        deleteStatus: true,
        deleteError: true,
        conversationId: true
      }
    })
  const job = <T>(name: string): T => {
    const jobs = queueOf(app, QueueNames.OUTBOUND).jobs.filter(item => item.name === name)
    expect(jobs).toHaveLength(1)
    return jobs[0]?.data as T
  }

  describe('a note', () => {
    it('is edited by anyone who reads notes, with the version they saw, and keeps a revision', async () => {
      const id = await noteBy(ctx.agentA.id)

      const response = await edit(id, { content: 'note v2', version: 1 }, ctx.adminA)

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({ content: 'note v2', version: 2, pendingEdit: false })
      expect(await row(id)).toMatchObject({
        content: 'note v2',
        version: 2,
        editedByType: AuthorType.AGENT,
        editedById: ctx.adminA.id
      })
      const revisions = await owner.messageRevision.findMany({ where: { messageId: id } })
      expect(revisions).toEqual([
        expect.objectContaining({
          version: 1,
          content: 'note v1',
          editedById: ctx.adminA.id,
          storeId: ctx.storeA.id
        })
      ])
    })

    it('is refused with the current text when someone changed it since', async () => {
      const id = await noteBy(ctx.agentA.id)
      await edit(id, { content: 'note v2', version: 1 })

      const stale = await edit(id, { content: 'my version', version: 1 }, ctx.adminA)

      expect(stale.status).toBe(CONFLICT)
      expect(codeOf(stale.body)).toBe(ErrorCodes.RESOURCE_CONFLICT)
      expect((await row(id)).content).toBe('note v2')
      expect(await owner.messageRevision.count({ where: { messageId: id } })).toBe(1)
    })

    it('needs the version it was read at', async () => {
      const id = await noteBy(ctx.agentA.id)

      const response = await edit(id, { content: 'note v2' })

      expect(response.status).toBe(BAD_REQUEST)
      expect((await row(id)).content).toBe('note v1')
    })

    it('is not edited by who may not read notes', async () => {
      const id = await noteBy(ctx.agentA.id)

      const response = await edit(id, { content: 'x', version: 1 }, ctx.viewerA)

      expect(response.status).toBe(FORBIDDEN)
      expect((await row(id)).content).toBe('note v1')
    })

    it('is deleted by its author, and the thread shows it without its text', async () => {
      const id = await noteBy(ctx.agentA.id)

      const response = await remove(id)

      expect(response.status).toBe(NO_CONTENT)
      expect(await row(id)).toMatchObject({
        deletedByType: AuthorType.AGENT,
        deletedById: ctx.agentA.id,
        deleteStatus: null
      })
      expect((await row(id)).deletedAt).not.toBeNull()
      const stored = await row(id)
      const thread = await api(app, ctx.agentA, ctx.storeA).get(
        ApiRoutes.conversations.messages(stored.conversationId)
      )
      expect((thread.body as ThreadBody).data[0]).toMatchObject({ id, content: null })
      expect((thread.body as ThreadBody).data[0]?.deletedAt).not.toBeNull()
    })

    it('is deleted by who holds the permission to delete, and not by another agent', async () => {
      const id = await noteBy(ctx.adminA.id)

      const refused = await remove(id, ctx.agentA)
      expect(refused.status).toBe(FORBIDDEN)
      expect((await row(id)).deletedAt).toBeNull()

      const allowed = await remove(id, ctx.adminA)
      expect(allowed.status).toBe(NO_CONTENT)
      expect((await row(id)).deletedAt).not.toBeNull()
    })

    it('is deleted once: asking again changes nothing', async () => {
      const id = await noteBy(ctx.agentA.id)
      await remove(id)
      const first = (await row(id)).deletedAt

      const again = await remove(id)

      expect(again.status).toBe(NO_CONTENT)
      expect((await row(id)).deletedAt).toEqual(first)
    })

    it('cannot be edited once deleted', async () => {
      const id = await noteBy(ctx.agentA.id)
      await remove(id)

      const response = await edit(id, { content: 'x', version: 1 })

      expect(response.status).toBe(CONFLICT)
    })
  })

  describe('a reply the customer has', () => {
    it('is refused with 409 when the channel cannot edit or delete', async () => {
      const id = await replyOn(PLAIN_TEXT_CHANNEL)

      const edited = await edit(id, { content: 'second text' })
      const deleted = await remove(id)

      expect(edited.status).toBe(CONFLICT)
      expect(codeOf(edited.body)).toBe(ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED)
      expect(deleted.status).toBe(CONFLICT)
      expect(codeOf(deleted.body)).toBe(ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED)
      expect(await row(id)).toMatchObject({ content: 'first text', editStatus: null })
      expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(0)
    })

    it('is edited only by its author', async () => {
      const id = await replyOn(TEST_CHANNEL_ID, ctx.adminA.id)

      const response = await edit(id, { content: 'second text' })

      expect(response.status).toBe(FORBIDDEN)
      expect((await row(id)).editStatus).toBeNull()
    })

    it('keeps its text while the edit waits, then replaces it when the channel takes it', async () => {
      const id = await replyOn()

      const response = await edit(id, { content: 'second text' })

      expect(response.status).toBe(OK)
      expect(response.body).toMatchObject({
        content: 'first text',
        pendingEdit: true,
        editStatus: DeliveryStatus.QUEUED
      })
      const queued = job<SendOutboundEditJob>(JobNames.SEND_OUTBOUND_EDIT)
      expect(queued).toMatchObject({ storeId: ctx.storeA.id, messageId: id })

      await sender.sendEdit(queued, true)

      expect(edited).toEqual([
        expect.objectContaining({
          content: 'second text',
          targetExternalId: expect.any(String) as string
        })
      ])
      expect(await row(id)).toMatchObject({
        content: 'second text',
        pendingContent: null,
        editStatus: DeliveryStatus.SENT,
        editedByType: AuthorType.AGENT,
        editedById: ctx.agentA.id
      })
      expect(await owner.messageRevision.count({ where: { messageId: id } })).toBe(1)
    })

    it('keeps its text when the channel refuses the edit, and says why', async () => {
      const id = await replyOn()
      editMessage = () =>
        Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false }))
      await edit(id, { content: 'second text' })

      await sender.sendEdit(job<SendOutboundEditJob>(JobNames.SEND_OUTBOUND_EDIT), true)

      expect(await row(id)).toMatchObject({
        content: 'first text',
        pendingContent: null,
        editStatus: DeliveryStatus.FAILED,
        editError: ErrorCodes.CHANNEL_MESSAGE_FAILED
      })
      expect(await owner.messageRevision.count({ where: { messageId: id } })).toBe(0)
    })

    it('refuses a second edit while one is on its way, and sends nothing for the same text', async () => {
      const id = await replyOn()
      await edit(id, { content: 'second text' })

      const second = await edit(id, { content: 'third text' })
      const same = await edit(await replyOn(), { content: 'first text' })

      expect(second.status).toBe(CONFLICT)
      expect(same.status).toBe(OK)
      expect(queueOf(app, QueueNames.OUTBOUND).jobs).toHaveLength(1)
    })

    it('is deleted for everyone only when the channel takes it', async () => {
      const id = await replyOn()

      const response = await remove(id)

      expect(response.status).toBe(NO_CONTENT)
      expect(await row(id)).toMatchObject({
        deletedAt: null,
        deleteStatus: DeliveryStatus.QUEUED,
        deletedById: ctx.agentA.id
      })
      await sender.sendDeletion(job<SendOutboundDeleteJob>(JobNames.SEND_OUTBOUND_DELETE), true)

      expect(deleted).toHaveLength(1)
      const after = await row(id)
      expect(after.deletedAt).not.toBeNull()
      expect(after.deleteStatus).toBe(DeliveryStatus.SENT)
    })

    it('stays shown when the channel refuses the deletion, and nobody is recorded as the deleter', async () => {
      const id = await replyOn()
      deleteMessage = () =>
        Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false }))
      await remove(id)

      await sender.sendDeletion(job<SendOutboundDeleteJob>(JobNames.SEND_OUTBOUND_DELETE), true)

      expect(await row(id)).toMatchObject({
        deletedAt: null,
        deleteStatus: DeliveryStatus.FAILED,
        deleteError: ErrorCodes.CHANNEL_MESSAGE_FAILED,
        deletedById: null
      })
    })

    it('is deleted by who holds the permission to delete, though they are not its author', async () => {
      const id = await replyOn()

      const refused = await remove(id, ctx.viewerA)
      const allowed = await remove(id, ctx.adminA)

      expect(refused.status).toBe(FORBIDDEN)
      expect(allowed.status).toBe(NO_CONTENT)
      expect((await row(id)).deletedById).toBe(ctx.adminA.id)
    })

    it('is not deleted while an edit of it is on its way', async () => {
      const id = await replyOn()
      await edit(id, { content: 'second text' })

      const response = await remove(id)

      expect(response.status).toBe(CONFLICT)
      expect((await row(id)).deleteStatus).toBeNull()
    })

    it('is not edited by a late job once the customer deleted it, and the request is dropped', async () => {
      const id = await replyOn()
      await edit(id, { content: 'second text' })
      const queued = job<SendOutboundEditJob>(JobNames.SEND_OUTBOUND_EDIT)
      await owner.message.update({ where: { id }, data: { deletedAt: new Date() } })

      await sender.sendEdit(queued, true)

      expect(edited).toHaveLength(0)
      expect(await row(id)).toMatchObject({
        content: 'first text',
        pendingContent: null,
        editStatus: null
      })
      expect(await owner.messageRevision.count({ where: { messageId: id } })).toBe(0)
    })

    it('tells who may not delete a message so even when it is deleted already', async () => {
      const id = await noteBy(ctx.adminA.id)
      await remove(id, ctx.adminA)

      const response = await remove(id, ctx.agentA)

      expect(response.status).toBe(FORBIDDEN)
    })

    it('numbers the revisions of a reply 1, 2 even when an edit was refused in between', async () => {
      const id = await replyOn()
      editMessage = () =>
        Promise.reject(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false }))
      await edit(id, { content: 'refused text' })
      await sender.sendEdit(job<SendOutboundEditJob>(JobNames.SEND_OUTBOUND_EDIT), true)
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
      editMessage = () => Promise.resolve()

      await edit(id, { content: 'second text' })
      await sender.sendEdit(job<SendOutboundEditJob>(JobNames.SEND_OUTBOUND_EDIT), true)

      const revisions = await owner.messageRevision.findMany({ where: { messageId: id } })
      expect(revisions.map(revision => revision.version)).toEqual([1])
      expect((await row(id)).content).toBe('second text')
    })

    it('asks nothing of the channel for a job that is no longer waiting', async () => {
      const id = await replyOn()
      await remove(id)
      const queued = job<SendOutboundDeleteJob>(JobNames.SEND_OUTBOUND_DELETE)
      await sender.sendDeletion(queued, true)

      await sender.sendDeletion(queued, true)

      expect(deleted).toHaveLength(1)
    })
  })

  describe('a message that is not the team’s', () => {
    it('is never edited or deleted from here', async () => {
      const id = await messageIn(await conversationOn(TEST_CHANNEL_ID), {
        authorType: AuthorType.CUSTOMER,
        authorId: null,
        channelMessageId: `wamid-${randomUUID()}`
      })

      const edited = await edit(id, { content: 'x' }, ctx.adminA)
      const deleted = await remove(id, ctx.adminA)

      expect(edited.status).toBe(CONFLICT)
      expect(deleted.status).toBe(CONFLICT)
      expect(await row(id)).toMatchObject({ content: 'hello', deletedAt: null })
    })

    it('answers 404 for a message of another store', async () => {
      const id = await noteBy(ctx.agentA.id)

      const response = await api(app, ctx.adminB, ctx.storeB)
        .patch(ApiRoutes.messages.byId(id))
        .send({ content: 'x', version: 1 })

      expect(response.status).toBe(NOT_FOUND)
    })
  })

  describe('the text of a deleted message', () => {
    const deletedByCustomer = async (): Promise<string> => {
      const id = await messageIn(await conversationOn(TEST_CHANNEL_ID), {
        authorType: AuthorType.CUSTOMER,
        authorId: null,
        content: 'something I regret'
      })
      await owner.message.update({
        where: { id },
        data: { deletedAt: new Date(), deletedByType: AuthorType.CUSTOMER }
      })
      return id
    }
    const read = (id: string, who = ctx.adminA) =>
      api(app, who, ctx.storeA).get(ApiRoutes.messages.deletedContent(id))

    it('is not part of the thread, and is read with its own permission, which is audited', async () => {
      const id = await deletedByCustomer()
      const stored = await row(id)
      const thread = await api(app, ctx.agentA, ctx.storeA).get(
        ApiRoutes.conversations.messages(stored.conversationId)
      )
      expect((thread.body as ThreadBody).data[0]).toMatchObject({ id, content: null })

      const refused = await read(id, ctx.agentA)
      const allowed = await read(id)

      expect(refused.status).toBe(FORBIDDEN)
      expect(allowed.status).toBe(OK)
      expect(allowed.body).toEqual({ content: 'something I regret' })
      const audited = await owner.auditLog.findMany({
        where: { resourceId: id, action: 'message.deleted_content_viewed' }
      })
      expect(audited).toHaveLength(1)
      expect(audited[0]?.userId).toBe(ctx.adminA.id)
    })

    it('is not there for a message that was not deleted', async () => {
      const id = await noteBy(ctx.agentA.id)

      const response = await read(id)

      expect(response.status).toBe(NOT_FOUND)
    })

    it('is purged after the retention, with its revisions, and the tombstone stays', async () => {
      const old = await deletedByCustomer()
      const recent = await deletedByCustomer()
      await owner.message.update({
        where: { id: old },
        data: { deletedAt: new Date(Date.now() - 31 * DAY_MS) }
      })
      await owner.messageRevision.create({
        data: {
          storeId: ctx.storeA.id,
          messageId: old,
          version: 1,
          content: 'an older text',
          editedByType: AuthorType.CUSTOMER
        }
      })

      await purge.purge()

      expect(await row(old)).toMatchObject({ content: null })
      expect((await row(old)).deletedAt).not.toBeNull()
      expect(
        (await owner.message.findUniqueOrThrow({ where: { id: old } })).contentPurgedAt
      ).not.toBeNull()
      expect(
        (await owner.messageRevision.findFirstOrThrow({ where: { messageId: old } })).content
      ).toBeNull()
      expect((await row(recent)).content).toBe('something I regret')
      expect((await read(old)).status).toBe(NOT_FOUND)
      expect((await read(recent)).status).toBe(OK)
    })
  })

  describe('a request whose job was lost', () => {
    it('is queued again after two minutes, and shows as failed after an hour', async () => {
      const lost = await replyOn()
      const abandoned = await replyOn()
      await edit(lost, { content: 'second text' })
      await edit(abandoned, { content: 'second text' })
      queueOf(app, QueueNames.OUTBOUND).jobs.length = 0
      await owner.message.update({
        where: { id: lost },
        data: { changeRequestedAt: new Date(Date.now() - 5 * 60_000) }
      })
      await owner.message.update({
        where: { id: abandoned },
        data: { changeRequestedAt: new Date(Date.now() - 2 * 3_600_000) }
      })

      const done = await sweep.requeueStaleChanges()

      expect(done).toEqual({ requeued: 1, gaveUp: 1 })
      expect(job<SendOutboundEditJob>(JobNames.SEND_OUTBOUND_EDIT).messageId).toBe(lost)
      expect(await row(abandoned)).toMatchObject({
        content: 'first text',
        editStatus: DeliveryStatus.FAILED,
        editError: ErrorCodes.CHANNEL_MESSAGE_FAILED
      })
      expect((await row(lost)).editStatus).toBe(DeliveryStatus.QUEUED)
    })
  })
})
