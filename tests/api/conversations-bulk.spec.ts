import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { RoleNames } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { BulkActions, BulkLimits, ConversationStatus } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Events } from '@platform/core/events'

import { createConversationOf, createTag } from '../builders'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface BulkBody {
  succeeded: string[]
  failed: { id: string; code: string }[]
  truncated: boolean
}
interface DetailBody {
  id: string
  unreadCount: number
}

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const HOUR_MS = 3_600_000

describe('Marking unread and acting on many conversations', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let agent2: { id: string; email: string; token: string }
  let heard: { event: string; payload: Record<string, unknown> }[] = []

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
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const asViewer = () => api(app, ctx.viewerA, ctx.storeA)
  const row = (id: string) => owner.conversation.findUniqueOrThrow({ where: { id } })
  const mk = async (
    extra: Partial<Parameters<typeof createConversationOf>[1]> = {},
    inboundAgoMs: number | null = HOUR_MS
  ) => {
    const conversation = await createConversationOf(owner, { storeId: ctx.storeA.id, ...extra })
    if (inboundAgoMs !== null) {
      await owner.conversation.update({
        where: { id: conversation.id },
        data: { lastInboundAt: new Date(Date.now() - inboundAgoMs) }
      })
    }
    return conversation
  }
  const bulk = (
    as: () => ReturnType<typeof api>,
    action: string,
    target: Record<string, unknown>,
    params?: Record<string, unknown>
  ) =>
    as()
      .post(ApiRoutes.conversations.bulk)
      .send({ action, ...target, ...(params === undefined ? {} : { params }) })
  const ids = (...conversations: { id: string }[]) => ({
    conversationIds: conversations.map(item => item.id)
  })

  describe('marking one conversation unread', () => {
    it('counts it as unread again, just before the last message of the customer', async () => {
      const conversation = await mk({ unreadCount: 0 }, HOUR_MS)
      const lastInbound = (await row(conversation.id)).lastInboundAt as Date

      const response = await asAgent().post(ApiRoutes.conversations.unread(conversation.id))

      expect(response.status).toBe(OK)
      expect((response.body as DetailBody).unreadCount).toBe(1)
      const stored = await row(conversation.id)
      expect(stored.unreadCount).toBe(1)
      expect(stored.lastReadAt?.getTime()).toBe(lastInbound.getTime() - 1)
      // Nobody has read it as it stands
      expect(stored.lastReadBy).toBeNull()
    })

    it('does not lower a count that was higher', async () => {
      const conversation = await mk({ unreadCount: 5 })

      await asAgent().post(ApiRoutes.conversations.unread(conversation.id)).expect(OK)

      expect((await row(conversation.id)).unreadCount).toBe(5)
    })

    it('undoes opening the thread, and is announced to the tabs of who did it', async () => {
      const conversation = await mk({ unreadCount: 2 })
      await asAgent().post(ApiRoutes.conversations.read(conversation.id)).expect(OK)
      expect((await row(conversation.id)).unreadCount).toBe(0)
      heard = []

      await asAgent().post(ApiRoutes.conversations.unread(conversation.id)).expect(OK)

      expect((await row(conversation.id)).unreadCount).toBe(1)
      const unread = heard.filter(item => item.event === Events.CONVERSATION_UNREAD)
      expect(unread.map(item => item.payload)).toEqual([
        expect.objectContaining({
          conversationId: conversation.id,
          userId: ctx.agentA.id,
          storeId: ctx.storeA.id
        })
      ])
    })

    it('has nothing to mark in a conversation the customer never wrote in', async () => {
      const conversation = await mk({}, null)

      const response = await asAgent().post(ApiRoutes.conversations.unread(conversation.id))

      expect(response.status).toBe(CONFLICT)
      expect((await row(conversation.id)).unreadCount).toBe(0)
    })

    it('is for who works the conversation, as opening it is', async () => {
      const conversation = await mk()

      const response = await asViewer().post(ApiRoutes.conversations.unread(conversation.id))

      expect(response.status).toBe(FORBIDDEN)
      expect((await row(conversation.id)).unreadCount).toBe(0)
    })

    it('does not reach a conversation of another store or one of another agent', async () => {
      const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id })
      const theirs = await mk({ assignedTo: agent2.id })

      const abroad = await asAgent().post(ApiRoutes.conversations.unread(foreign.id))
      const hidden = await asAgent().post(ApiRoutes.conversations.unread(theirs.id))

      expect(abroad.status).toBe(NOT_FOUND)
      expect(hidden.status).toBe(NOT_FOUND)
      expect((await row(theirs.id)).unreadCount).toBe(0)
    })
  })

  describe('the shape of a bulk request', () => {
    it('takes the conversations or a filter, never both and never neither', async () => {
      const conversation = await mk()

      const both = await bulk(asAdmin, BulkActions.MARK_READ, {
        ...ids(conversation),
        filter: {}
      })
      const neither = await bulk(asAdmin, BulkActions.MARK_READ, {})

      expect(both.status).toBe(BAD_REQUEST)
      expect(neither.status).toBe(BAD_REQUEST)
    })

    it('refuses a filter that names nothing, which would reach every conversation', async () => {
      const conversation = await mk()

      const response = await bulk(asAdmin, BulkActions.ARCHIVE, { filter: {} })

      expect(response.status).toBe(BAD_REQUEST)
      expect((await row(conversation.id)).status).toBe(ConversationStatus.OPEN)
    })

    it.each([
      ['an action that is Phase 2', 'send_template'],
      ['an action that waits for the exports center', 'export_csv'],
      ['an action that does not exist', 'explode']
    ])('refuses %s', async (_name, action) => {
      const conversation = await mk()

      const response = await bulk(asAdmin, action, ids(conversation))

      expect(response.status).toBe(BAD_REQUEST)
    })

    it('refuses a name listed twice, more than the cap, and no one at all', async () => {
      const conversation = await mk()
      const many = Array.from({ length: BulkLimits.MAX_ITEMS + 1 }, () => randomUUID())

      const twice = await bulk(asAdmin, BulkActions.MARK_READ, {
        conversationIds: [conversation.id, conversation.id]
      })
      const tooMany = await bulk(asAdmin, BulkActions.MARK_READ, { conversationIds: many })
      const none = await bulk(asAdmin, BulkActions.MARK_READ, { conversationIds: [] })

      expect([twice.status, tooMany.status, none.status]).toEqual([
        BAD_REQUEST,
        BAD_REQUEST,
        BAD_REQUEST
      ])
    })

    it('needs the params of the action and refuses the ones it does not take', async () => {
      const conversation = await mk()

      const missing = await bulk(asAdmin, BulkActions.ADD_TAG, ids(conversation))
      const extra = await bulk(asAdmin, BulkActions.MARK_READ, ids(conversation), { tagId: 'x' })
      const archivedStatus = await bulk(asAdmin, BulkActions.SET_STATUS, ids(conversation), {
        status: ConversationStatus.ARCHIVED
      })

      expect([missing.status, extra.status, archivedStatus.status]).toEqual([
        BAD_REQUEST,
        BAD_REQUEST,
        BAD_REQUEST
      ])
    })
  })

  describe('changing many conversations', () => {
    it('changes the ones named, and says which it could not, with our code', async () => {
      const first = await mk()
      const second = await mk()
      const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id })

      const response = await bulk(asAdmin, BulkActions.SET_STATUS, ids(first, second, foreign), {
        status: ConversationStatus.PENDING
      })

      expect(response.status).toBe(OK)
      const body = response.body as BulkBody
      expect(body.succeeded.sort()).toEqual([first.id, second.id].sort())
      expect(body.failed).toEqual([{ id: foreign.id, code: ErrorCodes.RESOURCE_NOT_FOUND }])
      expect(body.truncated).toBe(false)
      expect((await row(first.id)).status).toBe(ConversationStatus.PENDING)
      expect((await row(foreign.id)).status).toBe(ConversationStatus.OPEN)
    })

    it('does not touch what the caller cannot see, and does not say it exists', async () => {
      const theirs = await mk({ assignedTo: agent2.id })

      const response = await bulk(asAgent, BulkActions.SET_STATUS, ids(theirs), {
        status: ConversationStatus.RESOLVED
      })

      expect((response.body as BulkBody).failed).toEqual([
        { id: theirs.id, code: ErrorCodes.RESOURCE_NOT_FOUND }
      ])
      expect((await row(theirs.id)).status).toBe(ConversationStatus.OPEN)
    })

    it('reaches what a filter matches, and only what the caller sees', async () => {
      const mine = await mk({ assignedTo: ctx.agentA.id })
      const nobody = await mk()
      const theirs = await mk({ assignedTo: agent2.id })

      const response = await bulk(asAgent, BulkActions.MARK_UNREAD, {
        filter: { assigned: 'me' }
      })

      expect(response.status).toBe(OK)
      const body = response.body as BulkBody
      expect(body.succeeded).toContain(mine.id)
      expect(body.succeeded).not.toContain(theirs.id)
      expect(body.succeeded).not.toContain(nobody.id)
      expect((await row(theirs.id)).unreadCount).toBe(0)
    })

    it('records what was asked in the audit entry: the params and the filter', async () => {
      const conversation = await mk({ assignedTo: ctx.agentA.id })

      await bulk(asAdmin, BulkActions.ASSIGN_TO_AGENT, ids(conversation), {
        userId: agent2.id
      }).expect(OK)

      const find = () =>
        owner.auditLog.findMany({
          where: {
            action: AuditAction.BULK_ACTION_EXECUTED,
            userId: ctx.adminA.id,
            metadata: { path: ['action'], equals: BulkActions.ASSIGN_TO_AGENT }
          }
        })
      let entries = await find()
      for (let attempt = 0; attempt < 50 && entries.length === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100))
        entries = await find()
      }
      expect(entries.at(-1)?.metadata).toMatchObject({ params: { userId: agent2.id } })
    })

    it('assigns to the caller, to someone, and releases', async () => {
      const first = await mk()
      const second = await mk()

      const toMe = await bulk(asAgent, BulkActions.ASSIGN_TO_ME, ids(first, second))
      expect((toMe.body as BulkBody).succeeded).toHaveLength(2)
      expect((await row(first.id)).assignedTo).toBe(ctx.agentA.id)

      const toOther = await bulk(asAdmin, BulkActions.ASSIGN_TO_AGENT, ids(first, second), {
        userId: agent2.id
      })
      expect((toOther.body as BulkBody).succeeded).toHaveLength(2)
      expect((await row(second.id)).assignedTo).toBe(agent2.id)

      const released = await bulk(asAdmin, BulkActions.UNASSIGN, ids(first, second))
      expect((released.body as BulkBody).succeeded).toHaveLength(2)
      expect((await row(first.id)).assignedTo).toBeNull()
    })

    it('does not let an agent hand conversations to someone else', async () => {
      const conversation = await mk()

      const response = await bulk(asAgent, BulkActions.ASSIGN_TO_AGENT, ids(conversation), {
        userId: agent2.id
      })

      expect((response.body as BulkBody).failed).toEqual([
        { id: conversation.id, code: ErrorCodes.PERMISSION_DENIED }
      ])
      expect((await row(conversation.id)).assignedTo).toBeNull()
    })

    it('archives a resolved conversation for who may archive, and tells the others they may not', async () => {
      const first = await mk({ status: ConversationStatus.RESOLVED })
      const second = await mk({ status: ConversationStatus.RESOLVED })

      const refused = await bulk(asAgent, BulkActions.ARCHIVE, ids(first))
      const done = await bulk(asAdmin, BulkActions.ARCHIVE, ids(second))

      expect((refused.body as BulkBody).failed).toEqual([
        { id: first.id, code: ErrorCodes.PERMISSION_DENIED }
      ])
      expect((done.body as BulkBody).succeeded).toEqual([second.id])
      expect((await row(first.id)).status).toBe(ConversationStatus.RESOLVED)
      expect((await row(second.id)).status).toBe(ConversationStatus.ARCHIVED)
    })

    it('keeps the transitions of one conversation: an open one is not archived', async () => {
      const open = await mk()

      const response = await bulk(asAdmin, BulkActions.ARCHIVE, ids(open))

      expect((response.body as BulkBody).failed).toEqual([
        { id: open.id, code: ErrorCodes.CONVERSATION_INVALID_STATUS_TRANSITION }
      ])
      expect((await row(open.id)).status).toBe(ConversationStatus.OPEN)
    })

    it('adds and removes a tag of the store, and not one of another store', async () => {
      const first = await mk()
      const second = await mk()
      const tag = await createTag(owner, { storeId: ctx.storeA.id })
      const foreignTag = await createTag(owner, { storeId: ctx.storeB.id })

      const added = await bulk(asAgent, BulkActions.ADD_TAG, ids(first, second), { tagId: tag.id })
      const tagsOf = async (id: string) =>
        (await owner.conversation.findUniqueOrThrow({ where: { id }, select: { tags: true } })).tags
      expect((added.body as BulkBody).succeeded).toHaveLength(2)
      expect(await tagsOf(first.id)).toHaveLength(1)

      const stranger = await bulk(asAgent, BulkActions.ADD_TAG, ids(first), {
        tagId: foreignTag.id
      })
      expect((stranger.body as BulkBody).failed).toEqual([
        { id: first.id, code: ErrorCodes.RESOURCE_NOT_FOUND }
      ])

      const removed = await bulk(asAgent, BulkActions.REMOVE_TAG, ids(first), { tagId: tag.id })
      expect((removed.body as BulkBody).succeeded).toEqual([first.id])
      expect(await tagsOf(first.id)).toHaveLength(0)
      expect(await tagsOf(second.id)).toHaveLength(1)
    })

    it('marks read and unread, and the work actions are for who works the conversation', async () => {
      const conversation = await mk({ unreadCount: 3 })

      const read = await bulk(asAgent, BulkActions.MARK_READ, ids(conversation))
      expect((read.body as BulkBody).succeeded).toEqual([conversation.id])
      expect((await row(conversation.id)).unreadCount).toBe(0)

      const unread = await bulk(asAgent, BulkActions.MARK_UNREAD, ids(conversation))
      expect((unread.body as BulkBody).succeeded).toEqual([conversation.id])
      expect((await row(conversation.id)).unreadCount).toBe(1)

      const viewer = await bulk(asViewer, BulkActions.MARK_READ, ids(conversation))
      expect(viewer.status).toBe(FORBIDDEN)
    })
  })

  describe('round robin to a team', () => {
    it('shares the conversations nobody has between the people named, the least loaded first', async () => {
      // New people, so that the loads of the earlier tests do not count
      const [one, other] = await Promise.all(
        ['rrOne', 'rrOther'].map(name =>
          createActor(owner, app, {
            prefix,
            name,
            organizationId: ctx.orgA.id,
            storeId: ctx.storeA.id,
            roleId: ctx.roleIds[RoleNames.AGENT]
          })
        )
      )
      if (one === undefined || other === undefined) throw new Error('the team was not made')
      const conversations = await Promise.all([mk(), mk(), mk(), mk()])
      // One of them starts with a conversation more than the other
      await mk({ assignedTo: one.id })

      const response = await bulk(asAdmin, BulkActions.ROUND_ROBIN_TO_TEAM, ids(...conversations), {
        userIds: [one.id, other.id]
      })

      expect(response.status).toBe(OK)
      expect((response.body as BulkBody).succeeded).toHaveLength(4)
      const loadOf = (userId: string) =>
        owner.conversation.count({
          where: { storeId: ctx.storeA.id, assignedTo: userId, status: ConversationStatus.OPEN }
        })
      const [loadOne, loadOther] = await Promise.all([loadOf(one.id), loadOf(other.id)])
      // Five conversations between two people: the one who started with fewer ends with the same or
      // one more, never two more. Which of them takes the odd one is the order of their ids.
      expect(loadOne + loadOther).toBe(5)
      expect(Math.abs(loadOne - loadOther)).toBeLessThanOrEqual(1)
      expect(loadOther).toBeGreaterThanOrEqual(2)
    })

    it('does not take a conversation from the person who has it', async () => {
      const taken = await mk({ assignedTo: agent2.id })

      const response = await bulk(asAdmin, BulkActions.ROUND_ROBIN_TO_TEAM, ids(taken), {
        userIds: [ctx.agentA.id, ctx.adminA.id]
      })

      expect((response.body as BulkBody).failed).toEqual([
        { id: taken.id, code: ErrorCodes.RESOURCE_CONFLICT }
      ])
      expect((await row(taken.id)).assignedTo).toBe(agent2.id)
    })

    it('does not give a conversation to someone who is not in the store', async () => {
      const conversation = await mk()

      const response = await bulk(asAdmin, BulkActions.ROUND_ROBIN_TO_TEAM, ids(conversation), {
        userIds: [ctx.adminB.id, randomUUID()]
      })

      expect((response.body as BulkBody).failed).toEqual([
        { id: conversation.id, code: ErrorCodes.RESOURCE_NOT_FOUND }
      ])
      expect((await row(conversation.id)).assignedTo).toBeNull()
    })

    it('needs the permission to assign, before anything changes', async () => {
      const conversation = await mk()

      const response = await bulk(asAgent, BulkActions.ROUND_ROBIN_TO_TEAM, ids(conversation), {
        userIds: [ctx.agentA.id, agent2.id]
      })

      expect(response.status).toBe(FORBIDDEN)
      expect((await row(conversation.id)).assignedTo).toBeNull()
    })

    it('takes at least two people', async () => {
      const conversation = await mk()

      const response = await bulk(asAdmin, BulkActions.ROUND_ROBIN_TO_TEAM, ids(conversation), {
        userIds: [ctx.agentA.id]
      })

      expect(response.status).toBe(BAD_REQUEST)
    })
  })

  describe('the record of it', () => {
    it('audits one entry for the whole action, with its counts and not the conversations', async () => {
      const first = await mk()
      const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id })

      await bulk(asAdmin, BulkActions.MARK_READ, ids(first, foreign)).expect(OK)

      const find = () =>
        owner.auditLog.findMany({
          where: {
            action: AuditAction.BULK_ACTION_EXECUTED,
            userId: ctx.adminA.id,
            metadata: { path: ['action'], equals: BulkActions.MARK_READ }
          }
        })
      let entries = await find()
      for (let attempt = 0; attempt < 50 && entries.length === 0; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100))
        entries = await find()
      }
      expect(entries).toHaveLength(1)
      const entry = entries[0]
      expect(entry?.storeId).toBe(ctx.storeA.id)
      expect(entry?.metadata).toEqual({
        action: BulkActions.MARK_READ,
        requested: 2,
        succeeded: 1,
        failed: 1,
        byFilter: false
      })
    })
  })
})
