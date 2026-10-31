import type { INestApplication } from '@nestjs/common'

import {
  conversationDetailSchema,
  messagingWindowSchema,
  conversationOriginListSchema,
  messagePageSchema,
  messageSchema,
  type SendTemplateInput
} from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'
import { AuthorType, DeliveryStatus, MessageType, SystemMessageEvents } from '@platform/core/domain'
import { createMessageSchema } from '@platform/core/messaging'

import { createConversationOf, createConversationOriginOf } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const MINUTE_MS = 60_000

// What the api sends and the web client leaves out on purpose, until the step that draws it reads it
// (empty since Step 3.2 PR B4, which reads `version`, `mentions` and the editor). A field in this list that the client starts
// reading, or a new one the api starts sending, fails the suite: the list is exact, so a field never
// disappears from the page by accident.
const NOT_READ_BY_THE_WEB_YET: string[] = []

const keysOf = (value: unknown): string[] => Object.keys(value as Record<string, unknown>).sort()

describe('What the web client parses of the inbox api', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let conversationId: string
  let firstMessageId: string

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)

    const storeId = ctx.storeA.id
    const conversation = await createConversationOf(owner, {
      storeId,
      lastMessageAt: new Date()
    })
    conversationId = conversation.id
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MINUTE_MS)
    const base = { storeId, conversationId }

    // Every shape of message the thread draws: the customer's, a reply that was read and quotes the
    // first one, a note, a line of the system, one that was edited and waits for the channel, one the
    // customer deleted, and one that carries a link
    const first = await owner.message.create({
      data: {
        ...base,
        type: MessageType.TEXT,
        content: 'Do you have it in blue?',
        authorType: AuthorType.CUSTOMER,
        channelMessageId: `wamid-${prefix}-1`,
        createdAt: at(60)
      }
    })
    firstMessageId = first.id
    await owner.message.create({
      data: {
        ...base,
        type: MessageType.TEXT,
        content: 'Yes, we do',
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id,
        deliveryStatus: DeliveryStatus.READ,
        replyToMessageId: first.id,
        createdAt: at(50)
      }
    })
    await owner.message.create({
      data: {
        ...base,
        type: MessageType.INTERNAL_NOTE,
        content: 'Check the stock first',
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id,
        mentions: [ctx.adminA.id],
        createdAt: at(40)
      }
    })
    await owner.message.create({
      data: {
        ...base,
        type: MessageType.SYSTEM,
        content: '',
        authorType: AuthorType.SYSTEM,
        metadata: {
          event: SystemMessageEvents.ASSIGNED,
          actor: { type: 'user', id: ctx.adminA.id },
          causedBy: null,
          from: null,
          to: null,
          reason: null,
          snoozedUntil: null,
          assignedTo: ctx.agentA.id,
          previousAssignee: null
        },
        createdAt: at(30)
      }
    })
    await owner.message.create({
      data: {
        ...base,
        type: MessageType.TEXT,
        content: 'Original text',
        pendingContent: 'Edited text',
        editedAt: at(20),
        editedByType: AuthorType.AGENT,
        editedById: ctx.agentA.id,
        editStatus: DeliveryStatus.QUEUED,
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id,
        deliveryStatus: DeliveryStatus.SENT,
        createdAt: at(20)
      }
    })
    await owner.message.create({
      data: {
        ...base,
        type: MessageType.TEXT,
        content: 'Deleted text',
        authorType: AuthorType.CUSTOMER,
        deletedAt: at(10),
        deletedByType: AuthorType.CUSTOMER,
        createdAt: at(10)
      }
    })
    await owner.message.create({
      data: {
        ...base,
        type: MessageType.TEXT,
        content: 'Look at this',
        authorType: AuthorType.CUSTOMER,
        metadata: { attachmentUrl: 'https://scontent.cdninstagram.com/story.jpg' },
        createdAt: at(5)
      }
    })
    await owner.messageReaction.create({
      data: {
        storeId,
        messageId: first.id,
        authorType: AuthorType.AGENT,
        userId: ctx.agentA.id,
        emoji: '👍',
        deliveryStatus: DeliveryStatus.QUEUED
      }
    })
    await owner.conversationOrigin.create({
      data: {
        storeId,
        conversationId,
        messageId: first.id,
        kind: 'ad',
        title: 'Spring sale',
        sourceUrl: 'https://example.com/ad',
        thumbnailUrl: 'https://scontent.cdninstagram.com/ad.jpg'
      }
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)

  describe('the thread', () => {
    it('is accepted whole by the schema of the client', async () => {
      const response = await asAdmin().get(ApiRoutes.conversations.messages(conversationId))

      expect(response.status).toBe(OK)
      const page = messagePageSchema.parse(response.body)
      expect(page.data).toHaveLength(7)
      // What the client reads survives the parse: nothing it draws is lost on the way
      const byContent = new Map(page.data.map(message => [message.content, message]))
      expect(byContent.get('Yes, we do')).toMatchObject({
        deliveryStatus: DeliveryStatus.READ,
        replyToMessageId: firstMessageId,
        replyTo: { id: firstMessageId, content: 'Do you have it in blue?', deleted: false }
      })
      expect(byContent.get('Original text')).toMatchObject({
        pendingEdit: true,
        editStatus: DeliveryStatus.QUEUED
      })
      expect(byContent.get('Look at this')?.attachmentUrl).toBe(
        'https://scontent.cdninstagram.com/story.jpg'
      )
      expect(byContent.get('Do you have it in blue?')?.reactions).toEqual([
        expect.objectContaining({ emoji: '👍', deliveryStatus: DeliveryStatus.QUEUED })
      ])
      const deleted = page.data.find(message => message.deletedAt !== null)
      expect(deleted).toMatchObject({
        content: null,
        deletedByType: AuthorType.CUSTOMER,
        deletedById: null
      })
      const line = page.data.find(message => message.type === String(MessageType.SYSTEM))
      expect(line?.system).toMatchObject({
        event: SystemMessageEvents.ASSIGNED,
        actor: { type: 'user', id: ctx.adminA.id },
        assignedTo: ctx.agentA.id
      })
    })

    it('sends no field that the client neither reads nor lists as left out on purpose', async () => {
      const response = await asAdmin().get(ApiRoutes.conversations.messages(conversationId))
      const sent = (response.body as { data: Record<string, unknown>[] }).data

      const known = Object.keys(messageSchema.shape)
      for (const message of sent) {
        const unread = keysOf(message).filter(key => !known.includes(key))
        expect(unread).toEqual(NOT_READ_BY_THE_WEB_YET)
        // And the client asks for nothing the api does not send
        expect(known.filter(key => !(key in message))).toEqual([])
      }
      // The same for what sits inside a message
      const reactionKeys = Object.keys(messageSchema.shape.reactions.element.shape).sort()
      const quoteKeys = Object.keys(messageSchema.shape.replyTo.unwrap().shape).sort()
      for (const message of sent) {
        for (const reaction of message['reactions'] as unknown[]) {
          expect(keysOf(reaction)).toEqual(reactionKeys)
        }
        if (message['replyTo'] !== null) expect(keysOf(message['replyTo'])).toEqual(quoteKeys)
      }
    })
  })

  describe('the origins of a conversation', () => {
    it('are accepted by the schema of the client, with no field left unread', async () => {
      const response = await asAdmin().get(ApiRoutes.conversations.origins(conversationId))

      expect(response.status).toBe(OK)
      const origins = conversationOriginListSchema.parse(response.body)
      expect(origins).toEqual([
        expect.objectContaining({ kind: 'ad', title: 'Spring sale', messageId: firstMessageId })
      ])
      const sent = response.body as unknown[]
      expect(keysOf(sent[0])).toEqual(
        Object.keys(conversationOriginListSchema.element.shape).sort()
      )
    })

    it('are the ones the builders of the other suites write', async () => {
      const origin = await createConversationOriginOf(owner, { storeId: ctx.storeA.id })
      const conversation = await owner.conversationOrigin.findUniqueOrThrow({
        where: { id: origin.id },
        select: { conversationId: true }
      })

      const response = await asAdmin().get(
        ApiRoutes.conversations.origins(conversation.conversationId)
      )

      expect(conversationOriginListSchema.parse(response.body)).toEqual([
        expect.objectContaining({ id: origin.id })
      ])
    })
  })

  describe('the conversation of the header', () => {
    it('is accepted by the schema of the client', async () => {
      const response = await asAdmin().get(ApiRoutes.conversations.byId(conversationId))

      expect(response.status).toBe(OK)
      const conversation = conversationDetailSchema.parse(response.body)
      expect(conversation.channelConnectionId).toEqual(expect.any(String))
    })
  })

  describe('the messaging window of the composer', () => {
    it('is accepted by the schema of the client', async () => {
      const response = await asAdmin().get(ApiRoutes.conversations.messagingWindow(conversationId))

      expect(response.status).toBe(OK)
      expect(messagingWindowSchema.safeParse(response.body).success).toBe(true)
    })
  })

  describe('the template the dialog sends', () => {
    it('is the body the api accepts, with nothing extra and nothing missing', () => {
      // Typed as the client builds it: a field renamed on either side stops compiling or parsing
      const body: SendTemplateInput = {
        type: MessageType.TEMPLATE,
        conversationId,
        templateName: 'order_update',
        language: 'es',
        variables: ['Ana', '1042'],
        idempotencyKey: crypto.randomUUID()
      }

      expect(createMessageSchema.safeParse(body).success).toBe(true)
    })
  })
})
