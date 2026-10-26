import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions, RoleNames } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ConversationStatus,
  DeliveryStatus,
  MembershipStatus,
  MessageLimits,
  MessageType,
  PaginationLimits
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { ConversationsService } from '../../apps/api/src/modules/conversations/conversations.service'
import { createConversationOf, createMessage } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { anonymousApi, api } from '../helpers/http'

interface ErrorBody {
  error: { code: string }
}
interface MessageBody {
  id: string
  conversationId: string
  type: string
  content: string | null
  authorType: string
  authorId: string | null
  replyToMessageId: string | null
  deliveryStatus: string | null
  mentions: string[]
  createdAt: string
}
interface ThreadBody {
  data: MessageBody[]
  nextCursor: string | null
  hasMore: boolean
}

const OK = 200
const CREATED = 201
const UNAUTHORIZED = 401
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const INTERNAL_SERVER_ERROR = 500

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

describe('The messages of a conversation', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let agent2: { id: string; email: string; token: string }

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    agent2 = await createActor(owner, app, {
      prefix,
      name: 'agent2A',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: ctx.roleIds[RoleNames.AGENT]
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const asAgent2 = () => api(app, agent2, ctx.storeA)
  const asViewer = () => api(app, ctx.viewerA, ctx.storeA)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code
  // What the validation pipe says is wrong, by field and kind: the wording is not asserted
  const issuesOf = (body: unknown) =>
    (
      (body as { error: { metadata?: { issues?: { path: string; code: string }[] } } }).error
        .metadata?.issues ?? []
    ).map(issue => `${issue.path}:${issue.code}`)
  const mk = (extra: Partial<Parameters<typeof createConversationOf>[1]> = {}) =>
    createConversationOf(owner, { storeId: ctx.storeA.id, ...extra })
  const row = (id: string) => owner.conversation.findUniqueOrThrow({ where: { id } })
  const messagesOf = (conversationId: string) =>
    owner.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } })
  const reply = (conversationId: string, extra: Record<string, unknown> = {}) => ({
    type: MessageType.TEXT,
    conversationId,
    content: 'On its way',
    idempotencyKey: randomUUID(),
    ...extra
  })
  const note = (conversationId: string, extra: Record<string, unknown> = {}) => ({
    type: MessageType.INTERNAL_NOTE,
    conversationId,
    content: 'Check the stock first',
    ...extra
  })

  describe('writing a reply', () => {
    it('stores it as queued, by the agent, and moves the date of the conversation', async () => {
      const { id } = await mk({ lastMessageAt: minutesAgo(30), unreadCount: 3 })
      const before = new Date()

      const response = await asAgent().post(ApiRoutes.messages.create).send(reply(id))

      expect(response.status).toBe(CREATED)
      const body = response.body as MessageBody
      expect(body).toMatchObject({
        conversationId: id,
        type: MessageType.TEXT,
        content: 'On its way',
        authorType: AuthorType.AGENT,
        authorId: ctx.agentA.id,
        deliveryStatus: DeliveryStatus.QUEUED,
        mentions: []
      })
      expect(body).not.toHaveProperty('storeId')
      expect(body).not.toHaveProperty('metadata')
      const conversation = await row(id)
      expect(conversation.lastMessageAt?.getTime()).toBe(new Date(body.createdAt).getTime())
      expect(conversation.lastMessageAt?.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1)
      expect(conversation.status).toBe(ConversationStatus.OPEN)
      expect(conversation.unreadCount).toBe(3)
    })

    it('sets the first answer once, the last answer every time, and a note sets neither', async () => {
      const { id } = await mk()
      await asAgent().post(ApiRoutes.messages.create).send(note(id)).expect(CREATED)
      const afterNote = await row(id)

      const first = await asAgent().post(ApiRoutes.messages.create).send(reply(id))
      const afterFirst = await row(id)
      const second = await asAgent().post(ApiRoutes.messages.create).send(reply(id))
      const afterSecond = await row(id)

      expect([afterNote.firstResponseAt, afterNote.lastOutboundAt]).toEqual([null, null])
      expect(afterFirst.firstResponseAt?.getTime()).toBe(
        new Date((first.body as MessageBody).createdAt).getTime()
      )
      expect(afterFirst.lastOutboundAt).toEqual(afterFirst.firstResponseAt)
      expect(afterSecond.firstResponseAt).toEqual(afterFirst.firstResponseAt)
      expect(afterSecond.lastOutboundAt?.getTime()).toBe(
        new Date((second.body as MessageBody).createdAt).getTime()
      )
    })

    it('keeps the line breaks and trims the ends', async () => {
      const { id } = await mk()

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { content: '  one\ntwo  ' }))

      expect(response.status).toBe(CREATED)
      expect((response.body as MessageBody).content).toBe('one\ntwo')
    })

    it('does not move the date of the conversation back', async () => {
      const later = new Date(Date.now() + 3_600_000)
      const { id } = await mk({ lastMessageAt: later })

      await asAgent().post(ApiRoutes.messages.create).send(reply(id)).expect(CREATED)

      expect((await row(id)).lastMessageAt?.getTime()).toBe(later.getTime())
    })

    it('keeps a later last answer and an earlier first answer that the conversation already had', async () => {
      const later = new Date(Date.now() + 3_600_000)
      const earlier = minutesAgo(120)
      const { id } = await mk()
      await owner.conversation.update({
        where: { id },
        data: { lastOutboundAt: later, firstResponseAt: earlier }
      })

      await asAgent().post(ApiRoutes.messages.create).send(reply(id)).expect(CREATED)

      const after = await row(id)
      expect(after.lastOutboundAt?.getTime()).toBe(later.getTime())
      expect(after.firstResponseAt?.getTime()).toBe(earlier.getTime())
    })

    it('puts the conversation first in the list with the reply as its last message', async () => {
      // Its own store, so that no other conversation of the suite is in the list
      const admin = api(app, ctx.adminA2, ctx.storeA2)
      const mine = (extra: Partial<Parameters<typeof createConversationOf>[1]>) =>
        createConversationOf(owner, { storeId: ctx.storeA2.id, ...extra })
      const older = await mine({ lastMessageAt: minutesAgo(60) })
      const newer = await mine({ lastMessageAt: minutesAgo(10) })
      await createMessage(owner, {
        storeId: ctx.storeA2.id,
        conversationId: older.id,
        content: 'older',
        createdAt: minutesAgo(60)
      })

      const before = await admin.get(ApiRoutes.conversations.list)
      await admin
        .post(ApiRoutes.messages.create)
        .send(reply(older.id, { content: 'newest' }))
        .expect(CREATED)
      const after = await admin.get(ApiRoutes.conversations.list)

      const idsOf = (body: unknown) =>
        (body as { data: { id: string }[] }).data.map(item => item.id)
      expect(idsOf(before.body).slice(0, 2)).toEqual([newer.id, older.id])
      expect(idsOf(after.body).slice(0, 2)).toEqual([older.id, newer.id])
      const first = (after.body as { data: { lastMessage: { contentPreview: string } | null }[] })
        .data[0]
      expect(first?.lastMessage?.contentPreview).toBe('newest')
    })
  })

  describe('the idempotency key', () => {
    it('returns the message that was already made, with 200', async () => {
      const { id } = await mk()
      const body = reply(id)

      const first = await asAgent().post(ApiRoutes.messages.create).send(body)
      const second = await asAgent().post(ApiRoutes.messages.create).send(body)

      expect(first.status).toBe(CREATED)
      expect(second.status).toBe(OK)
      expect((second.body as MessageBody).id).toBe((first.body as MessageBody).id)
      expect(await messagesOf(id)).toHaveLength(1)
    })

    it('returns the first message even if the retry says something else', async () => {
      const { id } = await mk()
      const key = randomUUID()
      const first = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { idempotencyKey: key, content: 'first' }))

      const retry = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { idempotencyKey: key, content: 'edited' }))

      expect(retry.status).toBe(OK)
      expect((retry.body as MessageBody).id).toBe((first.body as MessageBody).id)
      expect((retry.body as MessageBody).content).toBe('first')
    })

    it('makes one message out of requests that arrive together', async () => {
      const { id } = await mk()
      const body = reply(id)

      const answers = await Promise.all(
        Array.from({ length: 6 }, () => asAgent().post(ApiRoutes.messages.create).send(body))
      )

      expect(answers.filter(answer => answer.status === CREATED)).toHaveLength(1)
      expect(answers.filter(answer => answer.status === OK)).toHaveLength(5)
      expect(new Set(answers.map(answer => (answer.body as MessageBody).id)).size).toBe(1)
      expect(await messagesOf(id)).toHaveLength(1)
    })

    it('answers a retry after the conversation was resolved, without reopening it again', async () => {
      const { id } = await mk({ status: ConversationStatus.RESOLVED })
      const body = reply(id)
      await asAgent().post(ApiRoutes.messages.create).send(body).expect(CREATED)
      await asAgent()
        .patch(ApiRoutes.conversations.status(id))
        .send({ status: ConversationStatus.RESOLVED })
        .expect(OK)

      const retry = await asAgent().post(ApiRoutes.messages.create).send(body)

      expect(retry.status).toBe(OK)
      expect((await row(id)).status).toBe(ConversationStatus.RESOLVED)
    })

    it('does not answer with the message of someone else, or of another type', async () => {
      const { id } = await mk()
      const key = randomUUID()
      await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { idempotencyKey: key }))
        .expect(CREATED)

      const other = await asAgent2()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { idempotencyKey: key }))
      const asNote = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(note(id, { idempotencyKey: key }))

      expect(other.status).toBe(CONFLICT)
      expect(codeOf(other.body)).toBe(ErrorCodes.RESOURCE_CONFLICT)
      expect(asNote.status).toBe(CONFLICT)
      expect(codeOf(asNote.body)).toBe(ErrorCodes.RESOURCE_CONFLICT)
      // The refusal says nothing of the message that holds the key
      expect(JSON.stringify(other.body)).not.toContain('On its way')
      expect(await messagesOf(id)).toHaveLength(1)
    })

    it('answers a repeated note with the first one', async () => {
      const { id } = await mk()
      const body = note(id, { idempotencyKey: randomUUID() })

      const first = await asAgent().post(ApiRoutes.messages.create).send(body)
      const second = await asAgent().post(ApiRoutes.messages.create).send(body)

      expect([first.status, second.status]).toEqual([CREATED, OK])
      expect((second.body as MessageBody).id).toBe((first.body as MessageBody).id)
      expect(await messagesOf(id)).toHaveLength(1)
    })

    it('is per conversation: the same key in another one is another message', async () => {
      const first = await mk()
      const second = await mk()
      const key = randomUUID()

      const one = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(first.id, { idempotencyKey: key }))
      const two = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(second.id, { idempotencyKey: key }))

      expect([one.status, two.status]).toEqual([CREATED, CREATED])
    })

    it('is required to reply and optional in a note', async () => {
      const { id } = await mk()
      const withoutKey: Record<string, unknown> = reply(id)
      delete withoutKey.idempotencyKey

      const noKey = await asAgent().post(ApiRoutes.messages.create).send(withoutKey)
      const twice = [
        await asAgent().post(ApiRoutes.messages.create).send(note(id)),
        await asAgent().post(ApiRoutes.messages.create).send(note(id))
      ]

      expect(noKey.status).toBe(BAD_REQUEST)
      expect(codeOf(noKey.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(twice.map(answer => answer.status)).toEqual([CREATED, CREATED])
      // Two notes without a key are two notes, and the reply without one was not stored
      expect(await messagesOf(id)).toHaveLength(2)
    })
  })

  describe('what the conversation does when it is answered', () => {
    it.each([ConversationStatus.RESOLVED, ConversationStatus.ARCHIVED])(
      'reopens a %s conversation',
      async status => {
        const { id } = await mk({ status })
        await owner.conversation.update({
          where: { id },
          data: { resolvedAt: new Date(), archivedAt: new Date(), resolutionReason: 'done' }
        })

        const response = await asAdmin().post(ApiRoutes.messages.create).send(reply(id))

        expect(response.status).toBe(CREATED)
        const conversation = await row(id)
        expect(conversation.status).toBe(ConversationStatus.OPEN)
        expect(conversation.resolvedAt).toBeNull()
        expect(conversation.archivedAt).toBeNull()
        expect(conversation.resolutionReason).toBeNull()
      }
    )

    it('reopens a snoozed conversation', async () => {
      const { id } = await mk({ status: ConversationStatus.SNOOZED })
      await owner.conversation.update({
        where: { id },
        data: { snoozedUntil: new Date(Date.now() + 3_600_000) }
      })

      await asAgent().post(ApiRoutes.messages.create).send(reply(id)).expect(CREATED)

      const conversation = await row(id)
      expect(conversation.status).toBe(ConversationStatus.OPEN)
      expect(conversation.snoozedUntil).toBeNull()
    })

    it('leaves a pending conversation pending', async () => {
      const { id } = await mk({ status: ConversationStatus.PENDING })

      await asAgent().post(ApiRoutes.messages.create).send(reply(id)).expect(CREATED)

      expect((await row(id)).status).toBe(ConversationStatus.PENDING)
    })

    it('does not answer spam, and keeps it as spam', async () => {
      const { id } = await mk({ status: ConversationStatus.SPAM })

      const response = await asAdmin().post(ApiRoutes.messages.create).send(reply(id))

      expect(response.status).toBe(CONFLICT)
      expect(codeOf(response.body)).toBe(ErrorCodes.CONVERSATION_INVALID_STATUS_TRANSITION)
      expect((await row(id)).status).toBe(ConversationStatus.SPAM)
      expect(await messagesOf(id)).toHaveLength(0)
    })

    it('does not show an archived conversation to who may not archive, nor take a reply for it', async () => {
      const { id } = await mk({ status: ConversationStatus.ARCHIVED })

      const response = await asAgent().post(ApiRoutes.messages.create).send(reply(id))

      expect(response.status).toBe(NOT_FOUND)
      expect((await row(id)).status).toBe(ConversationStatus.ARCHIVED)
      expect(await messagesOf(id)).toHaveLength(0)
    })

    it('does not keep the message or the dates if the reopening fails after them', async () => {
      const { id } = await mk({ status: ConversationStatus.RESOLVED })
      const before = await row(id)
      const conversations = app.get(ConversationsService, { strict: false })
      const original = conversations.applyStatus.bind(conversations)
      conversations.applyStatus = () => Promise.reject(new Error('the reopening failed'))

      let response: { status: number }
      try {
        response = await asAgent().post(ApiRoutes.messages.create).send(reply(id))
      } finally {
        conversations.applyStatus = original
      }

      expect(response.status).toBe(INTERNAL_SERVER_ERROR)
      expect(await messagesOf(id)).toHaveLength(0)
      // recordReply had written the dates when the reopening failed: they went back with the message
      const after = await row(id)
      expect(after.status).toBe(ConversationStatus.RESOLVED)
      expect(after.lastMessageAt).toEqual(before.lastMessageAt)
      expect(after.lastOutboundAt).toBeNull()
      expect(after.firstResponseAt).toBeNull()
    })

    it.each([ConversationStatus.RESOLVED, ConversationStatus.SNOOZED])(
      'reopens a %s conversation for a role that only sends: replying is the permission that counts',
      async status => {
        const { id } = await mk({ status })
        const onlySends = await actorWithPermissions(owner, app, {
          prefix,
          name: `reopensA${randomUUID().slice(0, 6)}`,
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          permissions: [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_SEND]
        })

        const response = await api(app, onlySends, ctx.storeA)
          .post(ApiRoutes.messages.create)
          .send(reply(id))

        expect(response.status).toBe(CREATED)
        expect((await row(id)).status).toBe(ConversationStatus.OPEN)
      }
    )
  })

  describe('an internal note', () => {
    it('is stored without delivery, and changes neither the date nor the status', async () => {
      const { id } = await mk({
        status: ConversationStatus.RESOLVED,
        lastMessageAt: minutesAgo(20)
      })
      const before = (await row(id)).lastMessageAt

      const response = await asAgent().post(ApiRoutes.messages.create).send(note(id))

      expect(response.status).toBe(CREATED)
      expect(response.body).toMatchObject({
        type: MessageType.INTERNAL_NOTE,
        authorType: AuthorType.AGENT,
        deliveryStatus: null
      })
      const conversation = await row(id)
      expect(conversation.status).toBe(ConversationStatus.RESOLVED)
      expect(conversation.lastMessageAt).toEqual(before)
    })

    it('can be written in a spam conversation', async () => {
      const { id } = await mk({ status: ConversationStatus.SPAM })

      const response = await asAdmin().post(ApiRoutes.messages.create).send(note(id))

      expect(response.status).toBe(CREATED)
      expect((await row(id)).status).toBe(ConversationStatus.SPAM)
    })

    it('mentions the members who read the conversations of the store', async () => {
      const { id } = await mk()

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(note(id, { mentions: [agent2.id, ctx.adminA.id] }))

      expect(response.status).toBe(CREATED)
      expect((response.body as MessageBody).mentions.sort()).toEqual(
        [agent2.id, ctx.adminA.id].sort()
      )
    })

    it.each([
      ['someone who does not exist', () => randomUUID()],
      ['a member of another store', () => ctx.adminB.id]
    ])('refuses a mention of %s', async (_name, who) => {
      const { id } = await mk()

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(note(id, { mentions: [who()] }))

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(await messagesOf(id)).toHaveLength(0)
    })

    it.each([
      ['conversations', [Permissions.MESSAGES_VIEW, Permissions.MESSAGES_INTERNAL_NOTE]],
      ['the thread', [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_INTERNAL_NOTE]],
      ['the notes', [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW]],
      ['anything of the inbox', [Permissions.TEAM_VIEW]]
    ])('refuses a mention of a role that cannot read %s', async (what, permissions) => {
      const { id } = await mk()
      const member = await actorWithPermissions(owner, app, {
        prefix,
        name: `lacks${what.replaceAll(' ', '')}${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions
      })

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(note(id, { mentions: [member.id] }))

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(await messagesOf(id)).toHaveLength(0)
    })

    it.each([
      ['whose membership was revoked', { status: MembershipStatus.REVOKED, revokedAt: null }],
      ['whose membership has a revocation date', { revokedAt: new Date() }]
    ])('refuses a mention of a member %s', async (_name, change) => {
      const { id } = await mk()
      const member = await createActor(owner, app, {
        prefix,
        name: `removed${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      await owner.membership.updateMany({
        where: { userId: member.id, storeId: ctx.storeA.id },
        data: change
      })

      const response = await asAdmin()
        .post(ApiRoutes.messages.create)
        .send(note(id, { mentions: [member.id] }))

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(await messagesOf(id)).toHaveLength(0)
    })

    describe('who can read the note', () => {
      const mention = (conversationId: string, userId: string) =>
        asAdmin()
          .post(ApiRoutes.messages.create)
          .send(note(conversationId, { mentions: [userId] }))

      it('refuses someone who cannot open a conversation assigned to another agent', async () => {
        const { id } = await mk({ assignedTo: ctx.adminA.id })

        const response = await mention(id, agent2.id)

        expect(response.status).toBe(BAD_REQUEST)
        expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
        expect(await messagesOf(id)).toHaveLength(0)
      })

      it('takes the assignee, and who sees every conversation', async () => {
        const { id } = await mk({ assignedTo: agent2.id })

        const assignee = await mention(id, agent2.id)
        const sees = await asAgent2()
          .post(ApiRoutes.messages.create)
          .send(note(id, { mentions: [ctx.adminA.id] }))

        expect([assignee.status, sees.status]).toEqual([CREATED, CREATED])
        // Kept as written: in the row and in the thread
        const stored = await messagesOf(id)
        expect(stored.flatMap(message => message.mentions).sort()).toEqual(
          [agent2.id, ctx.adminA.id].sort()
        )
      })

      it('refuses someone who cannot read the notes or the thread', async () => {
        const { id } = await mk()

        // The read-only role reads the thread but not the notes
        const viewer = await mention(id, ctx.viewerA.id)

        expect(viewer.status).toBe(BAD_REQUEST)
      })

      it.each([ConversationStatus.ARCHIVED, ConversationStatus.SPAM])(
        'refuses, in a %s conversation, someone who may not archive',
        async status => {
          const { id } = await mk({ status })

          const agent = await mention(id, agent2.id)
          const admin = await mention(id, ctx.adminA.id)

          expect([agent.status, admin.status]).toEqual([BAD_REQUEST, CREATED])
        }
      )
    })

    it('mentions a role that holds exactly the three permissions that read a note', async () => {
      const { id } = await mk()
      const member = await actorWithPermissions(owner, app, {
        prefix,
        name: `readsNote${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [
          Permissions.CONVERSATIONS_VIEW,
          Permissions.MESSAGES_VIEW,
          Permissions.MESSAGES_INTERNAL_NOTE
        ]
      })

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(note(id, { mentions: [member.id] }))

      expect(response.status).toBe(CREATED)
    })

    it('keeps a mention in one spelling, so the same person in capitals is repeated', async () => {
      const { id } = await mk()

      const repeated = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(note(id, { mentions: [agent2.id, agent2.id.toUpperCase()] }))
      const upper = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(note(id, { mentions: [agent2.id.toUpperCase()] }))

      expect(repeated.status).toBe(BAD_REQUEST)
      expect(upper.status).toBe(CREATED)
      expect((upper.body as MessageBody).mentions).toEqual([agent2.id])
    })

    it('refuses a mention written twice', async () => {
      const { id } = await mk()

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(note(id, { mentions: [agent2.id, agent2.id] }))

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(issuesOf(response.body)).toContain('mentions:custom')
    })

    it('refuses more mentions than the limit, before looking at who they are', async () => {
      const { id } = await mk()
      const many = Array.from({ length: MessageLimits.MAX_MENTIONS + 1 }, () => randomUUID())

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(note(id, { mentions: many }))

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(issuesOf(response.body)).toContain('mentions:too_big')
    })

    it('refuses mentions in a reply', async () => {
      const { id } = await mk()

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { mentions: [agent2.id] }))

      expect(response.status).toBe(BAD_REQUEST)
    })
  })

  describe('answering a message', () => {
    it('keeps the id of the message it answers', async () => {
      const { id } = await mk()
      const target = await createMessage(owner, { storeId: ctx.storeA.id, conversationId: id })

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { replyToMessageId: target.id }))

      expect(response.status).toBe(CREATED)
      expect((response.body as MessageBody).replyToMessageId).toBe(target.id)
    })

    it('refuses a message of another conversation, of another store, or that does not exist', async () => {
      const { id } = await mk()
      const elsewhere = await mk()
      const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id })
      const otherConversation = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: elsewhere.id
      })
      const otherStore = await createMessage(owner, {
        storeId: ctx.storeB.id,
        conversationId: foreign.id
      })

      for (const target of [otherConversation.id, otherStore.id, randomUUID()]) {
        const response = await asAgent()
          .post(ApiRoutes.messages.create)
          .send(reply(id, { replyToMessageId: target }))
        expect(response.status).toBe(NOT_FOUND)
      }
      expect(await messagesOf(id)).toHaveLength(0)
    })

    it('refuses, in a note, a message of another conversation', async () => {
      const { id } = await mk()
      const elsewhere = await mk()
      const target = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: elsewhere.id
      })

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(note(id, { replyToMessageId: target.id }))

      expect(response.status).toBe(NOT_FOUND)
      expect(await messagesOf(id)).toHaveLength(0)
    })

    it('does not quote an internal note in a reply to the customer', async () => {
      const { id } = await mk()
      const inner = await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: id,
        type: MessageType.INTERNAL_NOTE
      })

      const asReply = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { replyToMessageId: inner.id }))
      const asNote = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(note(id, { replyToMessageId: inner.id }))

      expect(asReply.status).toBe(NOT_FOUND)
      expect(asNote.status).toBe(CREATED)
    })
  })

  describe('what the caller may do', () => {
    it('needs MESSAGES_SEND to reply and MESSAGES_INTERNAL_NOTE to write a note', async () => {
      const { id } = await mk()
      const onlySends = await actorWithPermissions(owner, app, {
        prefix,
        name: 'sendsA',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_SEND]
      })
      const onlyNotes = await actorWithPermissions(owner, app, {
        prefix,
        name: 'notesA',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_INTERNAL_NOTE]
      })

      const sendsNote = await api(app, onlySends, ctx.storeA)
        .post(ApiRoutes.messages.create)
        .send(note(id))
      const notesReply = await api(app, onlyNotes, ctx.storeA)
        .post(ApiRoutes.messages.create)
        .send(reply(id))
      const sendsReply = await api(app, onlySends, ctx.storeA)
        .post(ApiRoutes.messages.create)
        .send(reply(id))
      const notesNote = await api(app, onlyNotes, ctx.storeA)
        .post(ApiRoutes.messages.create)
        .send(note(id))

      expect([sendsNote.status, notesReply.status]).toEqual([FORBIDDEN, FORBIDDEN])
      expect(codeOf(sendsNote.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      expect([sendsReply.status, notesNote.status]).toEqual([CREATED, CREATED])
    })

    it('does not let the read-only role write', async () => {
      const { id } = await mk()

      const asReply = await asViewer().post(ApiRoutes.messages.create).send(reply(id))
      const asNote = await asViewer().post(ApiRoutes.messages.create).send(note(id))

      expect([asReply.status, asNote.status]).toEqual([FORBIDDEN, FORBIDDEN])
      expect(await messagesOf(id)).toHaveLength(0)
    })

    it('does not let an agent write in a conversation that is not theirs to see', async () => {
      const { id } = await mk({ assignedTo: ctx.adminA.id })

      const response = await asAgent().post(ApiRoutes.messages.create).send(reply(id))

      expect(response.status).toBe(NOT_FOUND)
      expect(await messagesOf(id)).toHaveLength(0)
    })

    it('lets who sees everything write in a conversation assigned to someone else', async () => {
      const { id } = await mk({ assignedTo: ctx.agentA.id })

      const response = await asAdmin().post(ApiRoutes.messages.create).send(reply(id))

      expect(response.status).toBe(CREATED)
    })

    it('does not know a conversation of another store', async () => {
      const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id })

      const response = await asAdmin().post(ApiRoutes.messages.create).send(reply(foreign.id))

      expect(response.status).toBe(NOT_FOUND)
      expect(await messagesOf(foreign.id)).toHaveLength(0)
    })
  })

  describe('the guards of the routes', () => {
    it('answers 401 to a request with no token', async () => {
      const { id } = await mk()

      const post = await anonymousApi(app).post(ApiRoutes.messages.create).send(reply(id))
      const get = await anonymousApi(app).get(ApiRoutes.conversations.messages(id))

      expect([post.status, get.status]).toEqual([UNAUTHORIZED, UNAUTHORIZED])
    })

    it('needs the sight of the conversations besides the permission to write or read', async () => {
      const { id } = await mk()
      const sendsOnly = await actorWithPermissions(owner, app, {
        prefix,
        name: `sendsOnly${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.MESSAGES_SEND, Permissions.MESSAGES_INTERNAL_NOTE]
      })
      const readsOnly = await actorWithPermissions(owner, app, {
        prefix,
        name: `readsOnly${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.MESSAGES_VIEW]
      })

      const reply403 = await api(app, sendsOnly, ctx.storeA)
        .post(ApiRoutes.messages.create)
        .send(reply(id))
      const note403 = await api(app, sendsOnly, ctx.storeA)
        .post(ApiRoutes.messages.create)
        .send(note(id))
      const thread403 = await api(app, readsOnly, ctx.storeA).get(
        ApiRoutes.conversations.messages(id)
      )

      expect([reply403.status, note403.status, thread403.status]).toEqual([
        FORBIDDEN,
        FORBIDDEN,
        FORBIDDEN
      ])
      expect(await messagesOf(id)).toHaveLength(0)
    })

    it('refuses an id that is not a uuid in the path of the thread', async () => {
      const response = await asAgent().get(ApiRoutes.conversations.messages('not-a-uuid'))

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })

    it('does not show spam to who may not archive: no reply, no note, no thread', async () => {
      const { id } = await mk({ status: ConversationStatus.SPAM })
      await createMessage(owner, { storeId: ctx.storeA.id, conversationId: id, content: 'junk' })

      const asReply = await asAgent().post(ApiRoutes.messages.create).send(reply(id))
      const asNote = await asAgent().post(ApiRoutes.messages.create).send(note(id))
      const thread = await asAgent().get(ApiRoutes.conversations.messages(id))

      expect([asReply.status, asNote.status, thread.status]).toEqual([
        NOT_FOUND,
        NOT_FOUND,
        NOT_FOUND
      ])
      expect(await messagesOf(id)).toHaveLength(1)
    })
  })

  describe('what a repeated key leaves untouched', () => {
    it('does not move the dates or the status again', async () => {
      const { id } = await mk({ status: ConversationStatus.RESOLVED })
      const body = reply(id)
      await asAgent().post(ApiRoutes.messages.create).send(body).expect(CREATED)
      const afterFirst = await row(id)
      // Someone resolves it again before the client retries
      await asAgent()
        .patch(ApiRoutes.conversations.status(id))
        .send({ status: ConversationStatus.RESOLVED })
        .expect(OK)

      const retry = await asAgent().post(ApiRoutes.messages.create).send(body)

      expect(retry.status).toBe(OK)
      const after = await row(id)
      expect(after.status).toBe(ConversationStatus.RESOLVED)
      expect(after.lastMessageAt).toEqual(afterFirst.lastMessageAt)
      expect(after.lastOutboundAt).toEqual(afterFirst.lastOutboundAt)
      expect(after.firstResponseAt).toEqual(afterFirst.firstResponseAt)
    })

    it('tells nothing of the message that holds the key to someone else', async () => {
      const { id } = await mk()
      const key = randomUUID()
      const first = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { idempotencyKey: key }))

      const other = await asAgent2()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { idempotencyKey: key }))

      const text = JSON.stringify(other.body)
      expect(text).not.toContain((first.body as MessageBody).id)
      expect(text).not.toContain(ctx.agentA.id)
    })
  })

  describe('what the body may hold', () => {
    it.each([
      ['an empty text', { content: '   ' }],
      ['a text that is too long', { content: 'x'.repeat(MessageLimits.CONTENT_MAX_LENGTH + 1) }],
      ['a NUL character', { content: 'a\0b' }],
      ['a lone surrogate', { content: 'a\ud800b' }],
      [
        'a text over the bound of the cheap guard',
        { content: 'x'.repeat(MessageLimits.CONTENT_MAX_LENGTH * 2 + 1) }
      ],
      ['a store', { storeId: randomUUID() }],
      ['an author', { authorType: AuthorType.CUSTOMER }],
      ['a delivery status', { deliveryStatus: DeliveryStatus.DELIVERED }],
      ['media', { mediaIds: [randomUUID()] }],
      ['a key with spaces', { idempotencyKey: 'not a key' }],
      [
        'a key that is too long',
        { idempotencyKey: 'k'.repeat(MessageLimits.IDEMPOTENCY_KEY_MAX_LENGTH + 1) }
      ],
      ['a type that is not written by hand', { type: MessageType.SYSTEM }],
      ['no conversation', { conversationId: 'nope' }]
    ])('refuses %s', async (_name, extra) => {
      const { id } = await mk()

      const response = await asAgent().post(ApiRoutes.messages.create).send(reply(id, extra))

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(await messagesOf(id)).toHaveLength(0)
    })

    it('bounds the work of the character count: a text over twice the limit is refused by size', async () => {
      const { id } = await mk()

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { content: 'x'.repeat(MessageLimits.CONTENT_MAX_LENGTH * 2 + 1) }))

      expect(issuesOf(response.body)).toContain('content:too_big')
    })

    it('counts characters and not UTF-16 units: 4096 emoji fit and 4097 do not', async () => {
      const { id } = await mk()

      const fits = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { content: '😀'.repeat(MessageLimits.CONTENT_MAX_LENGTH) }))
      // 4097 characters in 4194 UTF-16 units: under the bound of the cheap guard, over the limit
      const over = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { content: `${'x'.repeat(4000)}${'😀'.repeat(97)}` }))

      expect(fits.status).toBe(CREATED)
      expect(over.status).toBe(BAD_REQUEST)
      expect(issuesOf(over.body)).toContain('content:custom')
    })

    it('takes a text of the longest length', async () => {
      const { id } = await mk()

      const response = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { content: 'x'.repeat(MessageLimits.CONTENT_MAX_LENGTH) }))

      expect(response.status).toBe(CREATED)
    })
  })

  describe('the thread', () => {
    it('lists the newest first, in pages that neither repeat nor skip', async () => {
      const { id } = await mk()
      const tie = minutesAgo(5)
      const made: string[] = []
      for (const [index, createdAt] of [
        minutesAgo(30),
        tie,
        tie,
        minutesAgo(1),
        minutesAgo(50)
      ].entries()) {
        const { id: messageId } = await createMessage(owner, {
          storeId: ctx.storeA.id,
          conversationId: id,
          content: `m${index}`,
          createdAt
        })
        made.push(messageId)
      }
      const expected = (await messagesOf(id))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1))
        .map(message => message.id)

      const seen: string[] = []
      let cursor: string | null = null
      let pages = 0
      do {
        const query = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`
        const response = await asAgent().get(`${ApiRoutes.conversations.messages(id)}${query}`)
        expect(response.status).toBe(OK)
        const page = response.body as ThreadBody
        seen.push(...page.data.map(message => message.id))
        expect(page.hasMore).toBe(page.nextCursor !== null)
        cursor = page.nextCursor
        pages += 1
      } while (cursor !== null)

      expect(pages).toBe(3)
      expect(seen).toEqual(expected)
      expect(new Set(seen).size).toBe(made.length)
    })

    it('hides the internal notes from who may not write them', async () => {
      const { id } = await mk()
      await createMessage(owner, { storeId: ctx.storeA.id, conversationId: id, content: 'visible' })
      await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: id,
        content: 'secret',
        type: MessageType.INTERNAL_NOTE
      })
      const reader = await actorWithPermissions(owner, app, {
        prefix,
        name: 'readerA',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW]
      })

      const plain = await api(app, reader, ctx.storeA).get(ApiRoutes.conversations.messages(id))
      const team = await asAgent().get(ApiRoutes.conversations.messages(id))

      expect((plain.body as ThreadBody).data.map(message => message.content)).toEqual(['visible'])
      expect((team.body as ThreadBody).data.map(message => message.content).sort()).toEqual([
        'secret',
        'visible'
      ])
    })

    it('needs MESSAGES_VIEW and the sight of the conversation', async () => {
      const mine = await mk()
      const theirs = await mk({ assignedTo: ctx.adminA.id })
      const blind = await actorWithPermissions(owner, app, {
        prefix,
        name: 'noMessagesA',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW]
      })

      const noPermission = await api(app, blind, ctx.storeA).get(
        ApiRoutes.conversations.messages(mine.id)
      )
      const notSeen = await asAgent().get(ApiRoutes.conversations.messages(theirs.id))
      const missing = await asAgent().get(ApiRoutes.conversations.messages(randomUUID()))

      expect(noPermission.status).toBe(FORBIDDEN)
      expect(notSeen.status).toBe(NOT_FOUND)
      expect(missing.status).toBe(NOT_FOUND)
      expect((notSeen.body as ErrorBody).error).toEqual((missing.body as ErrorBody).error)
    })

    it('hides the thread of an archived conversation from who may not archive', async () => {
      const { id } = await mk({ status: ConversationStatus.ARCHIVED })

      const agent = await asAgent().get(ApiRoutes.conversations.messages(id))
      const admin = await asAdmin().get(ApiRoutes.conversations.messages(id))

      expect(agent.status).toBe(NOT_FOUND)
      expect(admin.status).toBe(OK)
    })

    it.each([
      ['a limit of zero', 'limit=0'],
      ['a limit over the maximum', `limit=${PaginationLimits.MAX + 1}`],
      ['a limit that is not a number', 'limit=abc'],
      ['a cursor that is not ours', 'cursor=not-a-cursor'],
      [
        'a cursor with an id that is not a uuid',
        `cursor=${Buffer.from(JSON.stringify([new Date().toISOString(), 'nope'])).toString('base64url')}`
      ],
      [
        'a cursor with a date that is not a date',
        `cursor=${Buffer.from(JSON.stringify(['yesterday', randomUUID()])).toString('base64url')}`
      ],
      [
        'a cursor that is valid but too long',
        `cursor=${Buffer.from(`${JSON.stringify([new Date().toISOString(), randomUUID()])}${' '.repeat(300)}`).toString('base64url')}`
      ],
      ['a parameter it does not know', 'storeId=x']
    ])('refuses %s', async (_name, query) => {
      const { id } = await mk()

      const response = await asAgent().get(`${ApiRoutes.conversations.messages(id)}?${query}`)

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })

    it('pages by the default size, and by the largest one when asked', async () => {
      const { id } = await mk()
      const over = PaginationLimits.MAX + 1
      await owner.message.createMany({
        data: Array.from({ length: over }, (_unused, index) => ({
          storeId: ctx.storeA.id,
          conversationId: id,
          type: MessageType.TEXT,
          content: `bulk ${index}`,
          authorType: AuthorType.CUSTOMER,
          createdAt: minutesAgo(over - index)
        }))
      })
      const path = ApiRoutes.conversations.messages(id)

      const byDefault = (await asAgent().get(path)).body as ThreadBody
      const largest = (await asAgent().get(`${path}?limit=${PaginationLimits.MAX}`))
        .body as ThreadBody

      expect(byDefault.data).toHaveLength(PaginationLimits.DEFAULT)
      expect(byDefault.hasMore).toBe(true)
      expect(largest.data).toHaveLength(PaginationLimits.MAX)
      expect(largest.hasMore).toBe(true)
    })

    it('pages a reader who does not see the notes without short pages or a false hasMore', async () => {
      const { id } = await mk()
      // Visible messages with a note between each pair, oldest to newest: v0 n0 v1 n1 v2 n2 v3
      for (let index = 0; index < 4; index += 1) {
        await createMessage(owner, {
          storeId: ctx.storeA.id,
          conversationId: id,
          content: `v${index}`,
          createdAt: minutesAgo(100 - index * 10)
        })
        if (index < 3) {
          await createMessage(owner, {
            storeId: ctx.storeA.id,
            conversationId: id,
            content: `n${index}`,
            type: MessageType.INTERNAL_NOTE,
            createdAt: minutesAgo(95 - index * 10)
          })
        }
      }
      const reader = await actorWithPermissions(owner, app, {
        prefix,
        name: `pagedA${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW]
      })
      const path = ApiRoutes.conversations.messages(id)

      const first = (await api(app, reader, ctx.storeA).get(`${path}?limit=2`)).body as ThreadBody
      const second = (
        await api(app, reader, ctx.storeA).get(`${path}?limit=2&cursor=${first.nextCursor ?? ''}`)
      ).body as ThreadBody

      expect(first.data.map(message => message.content)).toEqual(['v3', 'v2'])
      expect(first.hasMore).toBe(true)
      expect(second.data.map(message => message.content)).toEqual(['v1', 'v0'])
      expect(second.hasMore).toBe(false)
      expect(second.nextCursor).toBeNull()
    })

    it('does not list a message of another store that sits in the conversation', async () => {
      const { id } = await mk()
      await createMessage(owner, { storeId: ctx.storeA.id, conversationId: id, content: 'mine' })
      const stray = await createMessage(owner, {
        storeId: ctx.storeB.id,
        conversationId: id,
        content: 'stray'
      })

      const thread = await asAgent().get(ApiRoutes.conversations.messages(id))
      const quoted = await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { replyToMessageId: stray.id }))

      expect((thread.body as ThreadBody).data.map(message => message.content)).toEqual(['mine'])
      expect(quoted.status).toBe(NOT_FOUND)
    })

    it('shows the reply that was just written, in order', async () => {
      const { id } = await mk()
      await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: id,
        content: 'hello?',
        createdAt: minutesAgo(3)
      })
      await asAgent()
        .post(ApiRoutes.messages.create)
        .send(reply(id, { content: 'hi' }))
        .expect(CREATED)

      const thread = await asAgent().get(ApiRoutes.conversations.messages(id))

      expect((thread.body as ThreadBody).data.map(message => message.content)).toEqual([
        'hi',
        'hello?'
      ])
    })
  })
})
