import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ChannelIds,
  CONVERSATION_RESOURCE_TYPE,
  ConversationStatus,
  MessageType
} from '@platform/core/domain'
import { Events } from '@platform/core/events'
import { StorageService } from '@platform/core/storage-module'

import { createConversation, createConversationOf, createMessage, createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const NO_CONTENT = 204
const FORBIDDEN = 403
const NOT_FOUND = 404

// The manual deletion of a conversation (Step 5.4 PR C, TDD_05 §10.4): the conversation, its messages and notes, the
// reactions and revisions, and every file of it are gone for good; the customer and the orders stay.
describe('Deleting a conversation by hand', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let heard: { event: string; payload: Record<string, unknown> }[] = []
  let deleted: jest.SpiedFunction<StorageService['delete']>

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
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
    heard = []
    deleted = jest
      .spyOn(app.get(StorageService, { strict: false }), 'delete')
      .mockResolvedValue(undefined)
  })
  afterEach(() => {
    deleted.mockRestore()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)

  // A conversation with a customer message, a note, a reaction, a revision and two files (one with sizes)
  async function fullConversation(storeId = ctx.storeA.id) {
    const conversation = await createConversationOf(owner, { storeId })
    const message = await createMessage(owner, {
      storeId,
      conversationId: conversation.id,
      content: 'where is my parcel',
      authorType: AuthorType.CUSTOMER
    })
    const note = await createMessage(owner, {
      storeId,
      conversationId: conversation.id,
      content: 'call them back',
      type: MessageType.INTERNAL_NOTE,
      authorType: AuthorType.AGENT,
      authorId: ctx.adminA.id
    })
    await owner.messageReaction.create({
      data: {
        storeId,
        messageId: message.id,
        authorType: AuthorType.AGENT,
        userId: ctx.adminA.id,
        emoji: '👍'
      }
    })
    await owner.messageRevision.create({
      data: {
        storeId,
        messageId: note.id,
        version: 1,
        content: 'older note',
        editedByType: AuthorType.AGENT,
        editedById: ctx.adminA.id
      }
    })
    const keys = {
      plain: `${prefix}/${randomUUID()}/plain.pdf`,
      full: `${prefix}/${randomUUID()}/full.webp`,
      medium: `${prefix}/${randomUUID()}/medium.webp`,
      thumb: `${prefix}/${randomUUID()}/thumb.webp`
    }
    const file = (key: string, variants?: object) =>
      owner.media.create({
        data: {
          storeId,
          purpose: 'message',
          messageId: message.id,
          customerId: conversation.customerId,
          key,
          filename: 'f',
          contentType: 'application/octet-stream',
          fileSize: 10,
          status: 'clean',
          ...(variants === undefined ? {} : { variants })
        },
        select: { id: true }
      })
    const plain = await file(keys.plain)
    const picture = await file(keys.full, {
      full: keys.full,
      medium: keys.medium,
      thumb: keys.thumb
    })
    return { conversation, message, note, files: [plain.id, picture.id], keys }
  }

  it('removes the conversation with everything in it, and the files from the storage', async () => {
    const { conversation, message, note, files, keys } = await fullConversation()

    await asAdmin().delete(ApiRoutes.conversations.byId(conversation.id)).expect(NO_CONTENT)

    expect(await owner.conversation.findUnique({ where: { id: conversation.id } })).toBeNull()
    expect(await owner.message.count({ where: { conversationId: conversation.id } })).toBe(0)
    expect(await owner.messageReaction.count({ where: { messageId: message.id } })).toBe(0)
    expect(await owner.messageRevision.count({ where: { messageId: note.id } })).toBe(0)
    expect(await owner.media.count({ where: { id: { in: files } } })).toBe(0)
    // The original, and the three sizes of the picture (the key of the picture is its full size, deleted once)
    expect(deleted.mock.calls.map(([key]) => key).sort()).toEqual(Object.values(keys).sort())
  })

  it('leaves the customer, their other conversations and the orders that came from it', async () => {
    const { conversation } = await fullConversation()
    const sibling = await createConversation(owner, {
      storeId: ctx.storeA.id,
      customerId: conversation.customerId,
      customerIdentityId: conversation.customerIdentityId,
      channelType: ChannelIds.INSTAGRAM
    })
    const order = await createOrder(owner, { storeId: ctx.storeA.id })
    await owner.order.update({ where: { id: order.id }, data: { conversationId: conversation.id } })

    await asAdmin().delete(ApiRoutes.conversations.byId(conversation.id)).expect(NO_CONTENT)

    expect(
      await owner.customer.findUnique({ where: { id: conversation.customerId } })
    ).not.toBeNull()
    expect(await owner.conversation.findUnique({ where: { id: sibling.id } })).not.toBeNull()
    const kept = await owner.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(kept.conversationId).toBeNull()
  })

  it('deletes a conversation in any status, assigned to somebody else', async () => {
    const conversation = await createConversationOf(owner, {
      storeId: ctx.storeA.id,
      status: ConversationStatus.ARCHIVED,
      assignedTo: ctx.agentA.id
    })

    await asAdmin().delete(ApiRoutes.conversations.byId(conversation.id)).expect(NO_CONTENT)

    expect(await owner.conversation.findUnique({ where: { id: conversation.id } })).toBeNull()
  })

  it('says it was deleted to the realtime layer, with ids and nothing of what it held', async () => {
    const { conversation } = await fullConversation()

    await asAdmin().delete(ApiRoutes.conversations.byId(conversation.id)).expect(NO_CONTENT)

    const event = heard.find(item => item.event === Events.CONVERSATION_DELETED)
    expect(event?.payload).toMatchObject({
      storeId: ctx.storeA.id,
      conversationId: conversation.id,
      customerId: conversation.customerId
    })
    expect(JSON.stringify(event?.payload)).not.toContain('where is my parcel')
  })

  it('audits who deleted what and how much, never the text', async () => {
    const { conversation } = await fullConversation()

    await asAdmin().delete(ApiRoutes.conversations.byId(conversation.id)).expect(NO_CONTENT)

    const [entry] = await waitForAuditEntries(owner, {
      action: AuditAction.CONVERSATION_DELETED,
      resourceId: conversation.id
    })
    expect(entry).toMatchObject({
      storeId: ctx.storeA.id,
      userId: ctx.adminA.id,
      resourceType: CONVERSATION_RESOURCE_TYPE
    })
    expect(entry?.metadata).toMatchObject({
      customerId: conversation.customerId,
      messages: 2,
      files: 2
    })
    expect(JSON.stringify(entry)).not.toContain('where is my parcel')
    expect(JSON.stringify(entry)).not.toContain('call them back')
  })

  it('still deletes when the storage fails: the rows are gone and the cleanup of the worker takes the objects', async () => {
    const { conversation, files } = await fullConversation()
    deleted.mockRejectedValue(new Error('storage down'))

    await asAdmin().delete(ApiRoutes.conversations.byId(conversation.id)).expect(NO_CONTENT)

    expect(await owner.conversation.findUnique({ where: { id: conversation.id } })).toBeNull()
    expect(await owner.media.count({ where: { id: { in: files } } })).toBe(0)
  })

  it('is for who holds conversations:delete: an agent and a viewer change nothing', async () => {
    const { conversation, files } = await fullConversation()

    for (const actor of [ctx.agentA, ctx.viewerA]) {
      await api(app, actor, ctx.storeA)
        .delete(ApiRoutes.conversations.byId(conversation.id))
        .expect(FORBIDDEN)
    }

    expect(await owner.conversation.findUnique({ where: { id: conversation.id } })).not.toBeNull()
    expect(await owner.media.count({ where: { id: { in: files } } })).toBe(2)
    expect(deleted).not.toHaveBeenCalled()
  })

  it('does not reach a conversation of another store, and an id that does not exist is the same answer', async () => {
    const theirs = await fullConversation(ctx.storeB.id)
    const sibling = await fullConversation(ctx.storeA2.id)

    await api(app, ctx.adminA, ctx.storeA)
      .delete(ApiRoutes.conversations.byId(theirs.conversation.id))
      .expect(NOT_FOUND)
    await asAdmin().delete(ApiRoutes.conversations.byId(sibling.conversation.id)).expect(NOT_FOUND)
    await asAdmin().delete(ApiRoutes.conversations.byId(randomUUID())).expect(NOT_FOUND)

    for (const kept of [theirs, sibling]) {
      expect(
        await owner.conversation.findUnique({ where: { id: kept.conversation.id } })
      ).not.toBeNull()
      expect(await owner.media.count({ where: { id: { in: kept.files } } })).toBe(2)
    }
    expect(deleted).not.toHaveBeenCalled()
  })

  it('is one answer the second time: the conversation is no longer there', async () => {
    const { conversation } = await fullConversation()
    await asAdmin().delete(ApiRoutes.conversations.byId(conversation.id)).expect(NO_CONTENT)

    await asAdmin().delete(ApiRoutes.conversations.byId(conversation.id)).expect(NOT_FOUND)
  })
})
