import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { AuthorType, ConversationStatus, DeliveryStatus, MessageType } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Events } from '@platform/core/events'
import { PluginRegistry } from '@platform/plugins/runtime'

import {
  buildChannelPlugin,
  createChannelConnection,
  createConversation,
  createCustomerIdentity
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const NO_CONTENT = 204
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const CHANNEL = 'discard_test_channel'
const TEXT = 'the words of a reply that never went'

interface ErrorBody {
  error: { code: string }
}
interface ThreadBody {
  data: { id: string; replyTo: { id: string } | null }[]
}
interface ConversationListBody {
  data: { id: string; lastMessage: { id: string; contentPreview: string | null } | null }[]
}

// A reply of the team that failed for good can be thrown away: it is nowhere in the thread, nothing is said to
// the channel, and only the audit says that it was there
describe('Throwing away a reply that failed', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  const deleted: { messageId: string; storeId: string }[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    app.get(PluginRegistry, { strict: false }).register(buildChannelPlugin({ id: CHANNEL }))
    app
      .get(EventEmitter2)
      .on(Events.MESSAGE_DELETED, (event: (typeof deleted)[number]) => deleted.push(event))
  })
  afterAll(async () => {
    app.get(PluginRegistry, { strict: false }).unregister(CHANNEL)
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    deleted.length = 0
  })

  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const asViewer = () => api(app, ctx.viewerA, ctx.storeA)
  const asAdminB = () => api(app, ctx.adminB, ctx.storeB)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  const row = (id: string) => owner.message.findUniqueOrThrow({ where: { id } })

  async function conversation(storeId = ctx.storeA.id, status?: ConversationStatus) {
    const identity = await createCustomerIdentity(owner, { storeId, channelType: CHANNEL })
    const connection = await createChannelConnection(owner, { storeId, channelType: CHANNEL })
    return createConversation(owner, {
      storeId,
      customerId: identity.customerId,
      customerIdentityId: identity.id,
      channelType: CHANNEL,
      channelConnectionId: connection.id,
      ...(status === undefined ? {} : { status })
    })
  }

  // A reply of the team in the state given; by default it failed for good and never left
  async function reply(
    conversationId: string,
    over: {
      storeId?: string
      type?: MessageType
      authorType?: AuthorType
      deliveryStatus?: DeliveryStatus
      failureDefinitive?: boolean | null
      channelMessageId?: string | null
      deletedAt?: Date | null
      content?: string
    } = {}
  ) {
    return owner.message.create({
      data: {
        storeId: over.storeId ?? ctx.storeA.id,
        conversationId,
        type: over.type ?? MessageType.TEXT,
        content: over.content ?? TEXT,
        authorType: over.authorType ?? AuthorType.AGENT,
        authorId: ctx.agentA.id,
        deliveryStatus: over.deliveryStatus ?? DeliveryStatus.FAILED,
        deliveryError: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        failureDefinitive: over.failureDefinitive === undefined ? true : over.failureDefinitive,
        channelMessageId: over.channelMessageId ?? null,
        deletedAt: over.deletedAt ?? null,
        ...(over.type === MessageType.TEMPLATE
          ? { metadata: { template: { name: 'order_ready', language: 'es', variables: [] } } }
          : {})
      }
    })
  }

  async function threadOf(conversationId: string) {
    const response = await asAgent().get(ApiRoutes.conversations.messages(conversationId))
    expect(response.status).toBe(OK)
    return (response.body as ThreadBody).data
  }

  describe('a reply that failed for good', () => {
    it('is thrown away: gone from the thread, marked, and announced as a deletion', async () => {
      const chat = await conversation()
      const failed = await reply(chat.id)
      expect((await threadOf(chat.id)).map(item => item.id)).toContain(failed.id)

      const response = await asAgent().post(ApiRoutes.messages.discard(failed.id))

      expect(response.status).toBe(NO_CONTENT)
      expect((await threadOf(chat.id)).map(item => item.id)).not.toContain(failed.id)
      const stored = await row(failed.id)
      expect(stored.discardedAt).not.toBeNull()
      expect(stored.deletedAt).not.toBeNull()
      expect(stored.deletedByType).toBe(AuthorType.AGENT)
      expect(stored.deletedById).toBe(ctx.agentA.id)
      // Kept like the text of a deleted message (and purged with it), not shown anywhere
      expect(stored.content).toBe(TEXT)
      expect(deleted.map(event => event.messageId)).toEqual([failed.id])
    })

    it('leaves a trace in the audit that says who, of what kind and why it failed, and never the text', async () => {
      const chat = await conversation()
      const failed = await reply(chat.id)

      await asAgent().post(ApiRoutes.messages.discard(failed.id)).expect(NO_CONTENT)

      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.MESSAGE_DISCARDED,
        resourceId: failed.id
      })
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({
        userId: ctx.agentA.id,
        storeId: ctx.storeA.id,
        resourceType: 'message',
        metadata: { type: MessageType.TEXT, deliveryError: ErrorCodes.CHANNEL_CREDENTIALS_INVALID }
      })
      expect(entries[0]?.timestamp).toBeInstanceOf(Date)
      expect(JSON.stringify(entries)).not.toContain(TEXT)
    })

    it('is once, whoever asks twice: no second event, no second audit entry', async () => {
      const chat = await conversation()
      const failed = await reply(chat.id)

      const first = await asAgent().post(ApiRoutes.messages.discard(failed.id))
      const second = await asAgent().post(ApiRoutes.messages.discard(failed.id))
      const other = await api(app, ctx.adminA, ctx.storeA).post(
        ApiRoutes.messages.discard(failed.id)
      )

      expect([first.status, second.status, other.status]).toEqual([
        NO_CONTENT,
        NO_CONTENT,
        NO_CONTENT
      ])
      expect(deleted).toHaveLength(1)
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.MESSAGE_DISCARDED,
        resourceId: failed.id
      })
      expect(entries).toHaveLength(1)
    })

    it('does not show in the preview of the conversation, which falls back to the message before', async () => {
      const chat = await conversation()
      await owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId: chat.id,
          type: MessageType.TEXT,
          content: 'the customer wrote',
          authorType: AuthorType.CUSTOMER,
          createdAt: new Date(Date.now() - 60_000)
        }
      })
      const failed = await reply(chat.id)
      const preview = async () => {
        const response = await asAgent().get(ApiRoutes.conversations.list).query({ limit: 100 })
        return (response.body as ConversationListBody).data.find(item => item.id === chat.id)
          ?.lastMessage
      }
      expect((await preview())?.id).toBe(failed.id)

      await asAgent().post(ApiRoutes.messages.discard(failed.id)).expect(NO_CONTENT)

      expect((await preview())?.contentPreview).toBe('the customer wrote')
    })

    it('takes the files of the reply with it, and nothing of other messages', async () => {
      const chat = await conversation()
      const failed = await reply(chat.id, { type: MessageType.IMAGE })
      const kept = await reply(chat.id, { deliveryStatus: DeliveryStatus.SENT })
      const media = (messageId: string) =>
        owner.media.create({
          data: {
            storeId: ctx.storeA.id,
            messageId,
            purpose: 'message',
            key: `stores/${ctx.storeA.id}/messages/${randomUUID()}/f.png`,
            filename: 'f.png',
            contentType: 'image/png',
            fileSize: 3,
            status: 'clean'
          },
          select: { id: true }
        })
      const gone = await media(failed.id)
      const stays = await media(kept.id)

      await asAgent().post(ApiRoutes.messages.discard(failed.id)).expect(NO_CONTENT)

      expect(await owner.media.findUnique({ where: { id: gone.id } })).toBeNull()
      expect(await owner.media.findUnique({ where: { id: stays.id } })).not.toBeNull()
    })

    it('is not made again by a client that asks again with the same key', async () => {
      const chat = await conversation()
      const key = randomUUID()
      const created = await asAgent().post(ApiRoutes.messages.create).send({
        type: MessageType.TEXT,
        conversationId: chat.id,
        content: 'a reply to be thrown away',
        idempotencyKey: key
      })
      await owner.message.update({
        where: { id: (created.body as { id: string }).id },
        data: {
          deliveryStatus: DeliveryStatus.FAILED,
          deliveryError: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
          failureDefinitive: true
        }
      })
      await asAgent()
        .post(ApiRoutes.messages.discard((created.body as { id: string }).id))
        .expect(NO_CONTENT)

      const again = await asAgent().post(ApiRoutes.messages.create).send({
        type: MessageType.TEXT,
        conversationId: chat.id,
        content: 'a reply to be thrown away',
        idempotencyKey: key
      })

      expect(again.status).toBe(CONFLICT)
      expect(await owner.message.count({ where: { conversationId: chat.id } })).toBe(1)
    })

    it('settles the notification that said the reply failed', async () => {
      const chat = await conversation()
      const failed = await reply(chat.id)
      const notification = await owner.notification.create({
        data: {
          userId: ctx.agentA.id,
          storeId: ctx.storeA.id,
          type: 'message.failed',
          severity: 'warning',
          messageKey: 'notifications.message.failed',
          resourceType: 'message',
          resourceId: failed.id
        }
      })

      await asAgent().post(ApiRoutes.messages.discard(failed.id)).expect(NO_CONTENT)

      expect(
        (await owner.notification.findUniqueOrThrow({ where: { id: notification.id } })).readAt
      ).not.toBeNull()
    })

    it('is no longer quoted by a reply, and cannot be answered', async () => {
      const chat = await conversation()
      const failed = await reply(chat.id)
      const later = await owner.message.create({
        data: {
          storeId: ctx.storeA.id,
          conversationId: chat.id,
          type: MessageType.TEXT,
          content: 'a reply that quotes it',
          authorType: AuthorType.AGENT,
          authorId: ctx.agentA.id,
          replyToMessageId: failed.id
        }
      })
      await asAgent().post(ApiRoutes.messages.discard(failed.id)).expect(NO_CONTENT)

      const quoted = (await threadOf(chat.id)).find(item => item.id === later.id)
      const answering = await asAgent().post(ApiRoutes.messages.create).send({
        type: MessageType.TEXT,
        conversationId: chat.id,
        content: 'answering it',
        replyToMessageId: failed.id,
        idempotencyKey: randomUUID()
      })

      expect(quoted?.replyTo).toBeNull()
      expect(answering.status).toBeGreaterThanOrEqual(400)
      expect(answering.status).toBeLessThan(500)
    })

    it('cannot be sent again or edited once it is gone', async () => {
      const chat = await conversation()
      const failed = await reply(chat.id)
      await asAgent().post(ApiRoutes.messages.discard(failed.id)).expect(NO_CONTENT)

      const resend = await asAgent().post(ApiRoutes.messages.resend(failed.id))
      const edit = await asAgent()
        .patch(ApiRoutes.messages.byId(failed.id))
        .send({ content: 'new text', version: 1 })

      expect(resend.status).toBe(CONFLICT)
      expect(edit.status).toBe(CONFLICT)
      expect((await row(failed.id)).deliveryStatus).toBe(DeliveryStatus.FAILED)
    })
  })

  describe('where it is thrown away', () => {
    it('does not reach a reply of a conversation the member cannot see (one marked as spam is hidden)', async () => {
      const chat = await conversation(ctx.storeA.id, ConversationStatus.SPAM)
      const failed = await reply(chat.id)

      const response = await asAgent().post(ApiRoutes.messages.discard(failed.id))

      expect(response.status).toBe(NOT_FOUND)
      expect((await row(failed.id)).discardedAt).toBeNull()
    })

    it('leaves nothing to react to', async () => {
      const chat = await conversation()
      const failed = await reply(chat.id)
      await asAgent().post(ApiRoutes.messages.discard(failed.id)).expect(NO_CONTENT)

      const reaction = await asAgent()
        .put(ApiRoutes.messages.reaction(failed.id))
        .send({ emoji: '👍' })

      expect(reaction.status).toBe(CONFLICT)
      expect(await owner.messageReaction.count({ where: { messageId: failed.id } })).toBe(0)
    })
  })

  describe('a reply that may have gone', () => {
    it.each([
      ['a failure that may have reached the customer', { failureDefinitive: false }],
      ['a failure from before this was recorded', { failureDefinitive: null }]
    ])('is not thrown away: %s', async (_name, over) => {
      const chat = await conversation()
      const failed = await reply(chat.id, over)

      const response = await asAgent().post(ApiRoutes.messages.discard(failed.id))

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.MESSAGE_DISCARD_OUTCOME_UNKNOWN)
      expect((await row(failed.id)).discardedAt).toBeNull()
      expect((await threadOf(chat.id)).map(item => item.id)).toContain(failed.id)
      expect(deleted).toHaveLength(0)
      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.MESSAGE_DISCARDED, resourceId: failed.id }
        })
      ).toBe(0)
    })

    it('keeps the doubt through a resend, and starts clean only after a failure that was definitive', async () => {
      const chat = await conversation()
      const definitiveOne = await reply(chat.id)
      const doubtful = await reply(chat.id, { failureDefinitive: false })
      const legacy = await reply(chat.id, { failureDefinitive: null })

      for (const message of [definitiveOne, doubtful, legacy]) {
        await asAgent().post(ApiRoutes.messages.resend(message.id)).expect(OK)
      }

      // Queued again: clean only when the failure before was known not to have gone
      expect((await row(definitiveOne.id)).failureDefinitive).toBeNull()
      expect((await row(doubtful.id)).failureDefinitive).toBe(false)
      expect((await row(legacy.id)).failureDefinitive).toBe(false)
      for (const message of [definitiveOne, doubtful, legacy]) {
        expect((await row(message.id)).deliveryStatus).toBe(DeliveryStatus.QUEUED)
        expect((await asAgent().post(ApiRoutes.messages.discard(message.id))).status).toBe(CONFLICT)
      }
    })

    it('is decided once when a discard and a resend arrive together: never both', async () => {
      const chat = await conversation()
      for (let round = 0; round < 8; round += 1) {
        const failed = await reply(chat.id)

        const [discard, resend] = await Promise.all([
          asAgent().post(ApiRoutes.messages.discard(failed.id)),
          asAgent().post(ApiRoutes.messages.resend(failed.id))
        ])

        const stored = await row(failed.id)
        const discarded = stored.discardedAt !== null
        // Exactly one wins, and the row says the same as the answers
        expect(discarded).toBe(discard.status === NO_CONTENT)
        expect(stored.deliveryStatus === DeliveryStatus.QUEUED).toBe(resend.status === OK)
        expect(discarded && stored.deliveryStatus === DeliveryStatus.QUEUED).toBe(false)
        expect([discard.status === NO_CONTENT, resend.status === OK].filter(Boolean)).toHaveLength(
          1
        )
      }
    })
  })

  describe('what is not a reply that failed', () => {
    it.each([
      ['one that was sent', { deliveryStatus: DeliveryStatus.SENT }],
      ['one that is on its way', { deliveryStatus: DeliveryStatus.QUEUED }],
      ['one that failed but has an id at the channel', { channelMessageId: 'wamid.123' }],
      ['one that was deleted', { deletedAt: new Date() }],
      ['a message of the customer', { authorType: AuthorType.CUSTOMER }],
      ['a note', { type: MessageType.INTERNAL_NOTE }]
    ])('is a conflict: %s', async (_name, over) => {
      const chat = await conversation()
      const target = await reply(chat.id, over)

      const response = await asAgent().post(ApiRoutes.messages.discard(target.id))

      expect(response.status).toBe(CONFLICT)
      expect((await row(target.id)).discardedAt).toBeNull()
      expect(deleted).toHaveLength(0)
    })
  })

  describe('who may', () => {
    it('is who may send it again: not a member who only reads', async () => {
      const chat = await conversation()
      const failed = await reply(chat.id)

      const response = await asViewer().post(ApiRoutes.messages.discard(failed.id))

      expect(response.status).toBe(FORBIDDEN)
      expect((await row(failed.id)).discardedAt).toBeNull()
    })

    it('needs the permission to send templates for a template, and the one for text for text', async () => {
      const chat = await conversation()
      const template = await reply(chat.id, { type: MessageType.TEMPLATE })
      const text = await reply(chat.id)
      const textOnly = await actorWithPermissions(owner, app, {
        prefix,
        name: 'text-only',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_SEND]
      })
      const templatesOnly = await actorWithPermissions(owner, app, {
        prefix,
        name: 'templates-only',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_SEND_TEMPLATE]
      })

      const wrongForTemplate = await api(app, textOnly, ctx.storeA).post(
        ApiRoutes.messages.discard(template.id)
      )
      const wrongForText = await api(app, templatesOnly, ctx.storeA).post(
        ApiRoutes.messages.discard(text.id)
      )
      const rightForTemplate = await api(app, templatesOnly, ctx.storeA).post(
        ApiRoutes.messages.discard(template.id)
      )
      const rightForText = await api(app, textOnly, ctx.storeA).post(
        ApiRoutes.messages.discard(text.id)
      )

      expect(wrongForTemplate.status).toBe(FORBIDDEN)
      expect(wrongForText.status).toBe(FORBIDDEN)
      expect(rightForTemplate.status).toBe(NO_CONTENT)
      expect(rightForText.status).toBe(NO_CONTENT)
    })

    it('does not reach a reply of another store, and tells it as a reply that is not there', async () => {
      const chat = await conversation()
      const failed = await reply(chat.id)
      const nowhere = await asAgent().post(ApiRoutes.messages.discard(randomUUID()))

      const stranger = await asAdminB().post(ApiRoutes.messages.discard(failed.id))

      expect(stranger.status).toBe(NOT_FOUND)
      expect(stranger.status).toBe(nowhere.status)
      expect(codeOf(stranger.body)).toBe(codeOf(nowhere.body))
      expect((await row(failed.id)).discardedAt).toBeNull()
      expect(deleted).toHaveLength(0)
    })

    it('refuses an id that is not an id', async () => {
      const response = await asAgent().post(ApiRoutes.messages.discard('not-an-id'))

      expect(response.status).toBe(400)
    })
  })
})
