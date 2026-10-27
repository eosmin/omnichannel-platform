import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type Permission, Permissions, RoleNames } from '@platform/core/auth'
import { ensureStore, type OwnerClient } from '@platform/core/database-testing'
import {
  AuthorType,
  ChannelType,
  ConversationAssignedFilters,
  ConversationStatus,
  MembershipStatus,
  MessageType,
  SystemMessageEvents
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { encodeConversationCursor, ConversationsService } from '@platform/core/messaging'

import {
  createChannelConnection,
  createConversationOf,
  createCustomer,
  createCustomerIdentity,
  createMessage,
  createRole,
  createTag
} from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { anonymousApi, api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface ItemBody {
  id: string
  status: string
  channelType: string
  assignedTo: string | null
  unreadCount: number
  lastMessageAt: string | null
  snoozedUntil: string | null
  resolvedAt: string | null
  resolutionReason: string | null
  customer: { id: string; name: string | null; displayIdentity: string }
  lastMessage: { id: string; contentPreview: string | null; authorType: string } | null
  tags: { id: string; name: string }[]
}
interface PageBody {
  data: ItemBody[]
  nextCursor: string | null
  hasMore: boolean
}
interface CountsBody {
  all: number
  mine: number
  unassigned: number
  byStatus: Record<string, number>
  byChannel: Record<string, number>
  byAgent: { userId: string; count: number }[]
}

const OK = 200
const NO_CONTENT = 204
const UNAUTHORIZED = 401
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

describe('The conversations of a store', () => {
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
  const mk = (extra: Partial<Parameters<typeof createConversationOf>[1]> = {}) =>
    createConversationOf(owner, { storeId: ctx.storeA.id, ...extra })
  const row = (id: string) => owner.conversation.findUniqueOrThrow({ where: { id } })

  // The owner holds a lock in an open transaction, the request is sent, and the transaction is
  // committed only once Postgres says that a backend is blocked by it (`pg_blocking_pids` of the
  // transaction's own process): the request is certain to have met the lock and not to have
  // arrived late, and no other suite can be mistaken for it. If nothing ever waits, the code does
  // not take the lock, and the test fails saying so.
  const holding = async (
    hold: (tx: Parameters<Parameters<OwnerClient['$transaction']>[0]>[0]) => Promise<void>,
    request: () => Promise<{ status: number }>
  ): Promise<number> => {
    let answer: Promise<{ status: number }> | undefined
    let waited = false
    // The owner client on purpose: the test holds a lock the way another process would
    // eslint-disable-next-line no-restricted-syntax -- not the tenant client of the app
    await owner.$transaction(
      async tx => {
        const [{ pid = 0 } = {}] = await tx.$queryRaw<{ pid: number }[]>`
          SELECT pg_backend_pid()::int AS pid`
        await hold(tx)
        // supertest sends nothing until it is awaited: `then` is what puts the request on the wire
        answer = request().then(response => response)
        for (let attempt = 0; attempt < 200 && !waited; attempt += 1) {
          const [{ blocked = 0 } = {}] = await owner.$queryRaw<{ blocked: number }[]>`
            SELECT count(*)::int AS blocked FROM pg_stat_activity
            WHERE ${pid} = ANY(pg_blocking_pids(pid))`
          waited = blocked > 0
          if (!waited) await new Promise(resolve => setTimeout(resolve, 50))
        }
      },
      { timeout: 30_000 }
    )
    const status = (await answer)?.status ?? 0
    if (!waited) throw new Error(`the request never waited for the lock (it answered ${status})`)
    return status
  }

  describe('the list', () => {
    // Its own store, so that the order and the counts do not depend on the other tests
    let admin: ReturnType<typeof api>
    let agent: ReturnType<typeof api>
    let agentId: string
    const expectedOrder: string[] = []

    beforeAll(async () => {
      admin = api(app, ctx.adminA2, ctx.storeA2)
      const second = await createActor(owner, app, {
        prefix,
        name: 'agentA2',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA2.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      agentId = second.id
      agent = api(app, second, ctx.storeA2)
      const make = (extra: Partial<Parameters<typeof createConversationOf>[1]>) =>
        createConversationOf(owner, { storeId: ctx.storeA2.id, ...extra })

      const tie = minutesAgo(30)
      const made = [
        await make({ lastMessageAt: minutesAgo(5), channelType: ChannelType.WHATSAPP }),
        await make({ lastMessageAt: tie, assignedTo: agentId }),
        await make({ lastMessageAt: tie, assignedTo: ctx.adminA2.id }),
        await make({ lastMessageAt: minutesAgo(60), status: ConversationStatus.PENDING }),
        await make({ lastMessageAt: minutesAgo(90), status: ConversationStatus.RESOLVED }),
        await make({ lastMessageAt: null }),
        await make({ lastMessageAt: null })
      ]
      await make({ lastMessageAt: minutesAgo(1), status: ConversationStatus.SPAM })
      await make({ lastMessageAt: minutesAgo(2), status: ConversationStatus.ARCHIVED })
      const rows = await owner.conversation.findMany({
        where: { id: { in: made.map(item => item.id) } },
        select: { id: true, lastMessageAt: true }
      })
      // The order the list promises: newest message first, ties by id descending, no message last
      rows.sort((a, b) => {
        if (a.lastMessageAt === null || b.lastMessageAt === null) {
          if (a.lastMessageAt === b.lastMessageAt) return b.id.localeCompare(a.id)
          return a.lastMessageAt === null ? 1 : -1
        }
        const byDate = b.lastMessageAt.getTime() - a.lastMessageAt.getTime()
        return byDate !== 0 ? byDate : b.id.localeCompare(a.id)
      })
      expectedOrder.push(...rows.map(item => item.id))
      const first = made[0]
      if (first !== undefined) {
        await createMessage(owner, {
          storeId: ctx.storeA2.id,
          conversationId: first.id,
          content: 'older',
          createdAt: minutesAgo(10)
        })
        await createMessage(owner, {
          storeId: ctx.storeA2.id,
          conversationId: first.id,
          content: 'x'.repeat(300),
          authorType: AuthorType.AGENT,
          createdAt: minutesAgo(5)
        })
      }
    })

    it.each([2, 3])(
      'returns pages of %i in the promised order without repeating or skipping a row, ties included',
      async pageSize => {
        const seen: string[] = []
        let cursor: string | undefined
        for (let page = 0; page < 10; page += 1) {
          const response = await admin
            .get(ApiRoutes.conversations.list)
            .query({ limit: pageSize, ...(cursor === undefined ? {} : { cursor }) })
          expect(response.status).toBe(OK)
          const body = response.body as PageBody
          seen.push(...body.data.map(item => item.id))
          if (!body.hasMore) {
            expect(body.nextCursor).toBeNull()
            break
          }
          expect(body.nextCursor).not.toBeNull()
          cursor = body.nextCursor ?? undefined
        }

        expect(seen).toEqual(expectedOrder)
      }
    )

    it('ends on a full page without promising another one', async () => {
      const response = await admin
        .get(ApiRoutes.conversations.list)
        .query({ limit: expectedOrder.length })

      const body = response.body as PageBody
      expect(body.data).toHaveLength(expectedOrder.length)
      expect(body.hasMore).toBe(false)
      expect(body.nextCursor).toBeNull()
    })

    it('hides spam and archived unless asked for them by status', async () => {
      const all = (await admin.get(ApiRoutes.conversations.list).query({ limit: 100 }))
        .body as PageBody
      const spam = (
        await admin.get(ApiRoutes.conversations.list).query({ status: ConversationStatus.SPAM })
      ).body as PageBody

      expect(all.data.map(item => item.status)).not.toContain(ConversationStatus.SPAM)
      expect(all.data.map(item => item.status)).not.toContain(ConversationStatus.ARCHIVED)
      expect(spam.data).toHaveLength(1)
    })

    it('filters by assignee, status and channel', async () => {
      const query = async (params: Record<string, string>) =>
        (
          (await admin.get(ApiRoutes.conversations.list).query({ limit: 100, ...params }))
            .body as PageBody
        ).data

      const mine = await query({ assigned: agentId })
      const unassigned = await query({ assigned: ConversationAssignedFilters.UNASSIGNED })
      const pending = await query({ status: ConversationStatus.PENDING })
      const whatsapp = await query({ channelType: ChannelType.WHATSAPP })

      const myOwn = await admin
        .get(ApiRoutes.conversations.list)
        .query({ limit: 100, assigned: ConversationAssignedFilters.ME })

      expect(mine.map(item => item.assignedTo)).toEqual([agentId])
      expect(unassigned.every(item => item.assignedTo === null)).toBe(true)
      expect(unassigned).toHaveLength(5)
      expect((myOwn.body as PageBody).data.map(item => item.assignedTo)).toEqual([ctx.adminA2.id])
      expect(pending).toHaveLength(1)
      expect(whatsapp).toHaveLength(1)
    })

    it('filters by tag', async () => {
      const tag = await createTag(owner, { storeId: ctx.storeA2.id })
      const target = expectedOrder[0] ?? ''
      await owner.conversation.update({
        where: { id: target },
        data: { tags: { connect: { id: tag.id } } }
      })

      const response = await admin.get(ApiRoutes.conversations.list).query({ tagId: tag.id })

      expect((response.body as PageBody).data.map(item => item.id)).toEqual([target])
      expect((response.body as PageBody).data[0]?.tags.map(item => item.id)).toEqual([tag.id])
    })

    it('shows the last message cut to a preview, and who the customer is', async () => {
      const response = await admin.get(ApiRoutes.conversations.list).query({ limit: 100 })

      const withMessage = (response.body as PageBody).data.find(item => item.lastMessage !== null)
      const without = (response.body as PageBody).data.find(item => item.lastMessage === null)
      expect(withMessage?.lastMessage?.authorType).toBe(AuthorType.AGENT)
      expect(withMessage?.lastMessage?.contentPreview).toHaveLength(140)
      expect(without?.customer.displayIdentity).toBeTruthy()
    })

    it('lists spam and archived only to who may archive', async () => {
      const byAgent = await agent
        .get(ApiRoutes.conversations.list)
        .query({ status: ConversationStatus.SPAM })
      const byAdmin = await admin
        .get(ApiRoutes.conversations.list)
        .query({ status: ConversationStatus.ARCHIVED })

      expect(byAgent.status).toBe(FORBIDDEN)
      expect((byAdmin.body as PageBody).data).toHaveLength(1)
    })

    it('does not show the last message to a role that cannot read messages, nor a note to one that cannot read notes', async () => {
      const store = ctx.storeB.id
      const adminOfB = api(app, ctx.adminB, ctx.storeB)
      const conversation = await createConversationOf(owner, { storeId: store, assignedTo: null })
      await createMessage(owner, {
        storeId: store,
        conversationId: conversation.id,
        content: 'for the customer',
        authorType: AuthorType.AGENT,
        createdAt: minutesAgo(3)
      })
      await createMessage(owner, {
        storeId: store,
        conversationId: conversation.id,
        content: 'private note',
        authorType: AuthorType.AGENT,
        type: MessageType.INTERNAL_NOTE,
        createdAt: minutesAgo(2)
      })
      const make = async (name: string, permissions: Permission[]) =>
        api(
          app,
          await createActor(owner, app, {
            prefix,
            name,
            organizationId: ctx.orgB.id,
            storeId: store,
            roleId: (
              await createRole(owner, { storeId: store, name: `${prefix}-${name}`, permissions })
            ).id
          }),
          ctx.storeB
        )
      const noMessages = await make('no-messages', [Permissions.CONVERSATIONS_VIEW])
      const noNotes = await make('no-notes', [
        Permissions.CONVERSATIONS_VIEW,
        Permissions.MESSAGES_VIEW
      ])
      const preview = async (client: ReturnType<typeof api>) =>
        ((await client.get(ApiRoutes.conversations.byId(conversation.id))).body as ItemBody)
          .lastMessage

      expect(await preview(noMessages)).toBeNull()
      expect((await preview(noNotes))?.contentPreview).toBe('for the customer')
      expect((await preview(adminOfB))?.contentPreview).toBe('private note')
    })

    it('cuts the preview by characters, never in the middle of an emoji', async () => {
      const adminOfB = api(app, ctx.adminB, ctx.storeB)
      const conversation = await createConversationOf(owner, {
        storeId: ctx.storeB.id,
        lastMessageAt: minutesAgo(1)
      })
      await createMessage(owner, {
        storeId: ctx.storeB.id,
        conversationId: conversation.id,
        content: '\u{1F600}'.repeat(200)
      })

      const response = await adminOfB.get(ApiRoutes.conversations.byId(conversation.id))

      const preview = (response.body as ItemBody).lastMessage?.contentPreview ?? ''
      expect(Array.from(preview)).toHaveLength(140)
      expect(preview).toBe('\u{1F600}'.repeat(140))
    })

    it('refuses a cursor that is not one, an unknown filter and a limit out of range', async () => {
      for (const params of [
        { cursor: 'not-a-cursor' },
        { cursor: 'A'.repeat(400) },
        { status: 'NOPE' },
        { assigned: 'someone' },
        { limit: '0' },
        { limit: '101' },
        { storeId: ctx.storeB.id }
      ]) {
        const response = await admin.get(ApiRoutes.conversations.list).query(params)
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('shows an agent without VIEW_ALL the conversations assigned to them and the ones nobody has', async () => {
      const response = await agent.get(ApiRoutes.conversations.list).query({ limit: 100 })

      const assigned = (response.body as PageBody).data.map(item => item.assignedTo)
      expect(assigned.every(userId => userId === null || userId === agentId)).toBe(true)
      expect(assigned).toContain(agentId)
      expect(assigned).not.toContain(ctx.adminA2.id)
    })

    it('counts what the viewer may see, without spam and archived', async () => {
      const full = (await admin.get(ApiRoutes.conversations.list).query({ countsOnly: 'true' }))
        .body as CountsBody
      const narrow = (await agent.get(ApiRoutes.conversations.list).query({ countsOnly: 'true' }))
        .body as CountsBody

      expect(full.all).toBe(7)
      expect(full.byStatus).toEqual({
        [ConversationStatus.OPEN]: 5,
        [ConversationStatus.PENDING]: 1,
        [ConversationStatus.RESOLVED]: 1
      })
      expect(full.byStatus[ConversationStatus.SPAM]).toBeUndefined()
      expect(full.unassigned).toBe(5)
      expect(full.mine).toBe(1)
      expect(full.byChannel[ChannelType.WHATSAPP]).toBe(1)
      expect(full.byAgent.map(item => item.userId).sort()).toEqual([agentId, ctx.adminA2.id].sort())
      // Every figure is a sum of the same groups
      for (const counts of [full, narrow]) {
        const total = (record: Record<string, number>) =>
          Object.values(record).reduce((a, b) => a + b, 0)
        expect(total(counts.byStatus)).toBe(counts.all)
        expect(total(counts.byChannel)).toBe(counts.all)
        expect(counts.unassigned + counts.byAgent.reduce((sum, item) => sum + item.count, 0)).toBe(
          counts.all
        )
      }
      expect(narrow.unassigned).toBe(5)
      expect(narrow.all).toBe(6)
      expect(narrow.mine).toBe(1)
      expect(narrow.byAgent).toEqual([{ userId: agentId, count: 1 }])
    })
  })

  describe('one conversation', () => {
    it('is read with its detail, and a conversation of another store does not exist', async () => {
      const own = await mk()
      const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id })

      const found = await asAdmin().get(ApiRoutes.conversations.byId(own.id))
      const missing = await asAdmin().get(ApiRoutes.conversations.byId(foreign.id))

      expect(found.status).toBe(OK)
      expect((found.body as ItemBody).id).toBe(own.id)
      expect(missing.status).toBe(NOT_FOUND)
      expect(codeOf(missing.body)).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
    })

    it('is hidden from an agent when it is assigned to someone else, in every route', async () => {
      const theirs = await mk({ assignedTo: ctx.adminA.id })

      const read = await asAgent().get(ApiRoutes.conversations.byId(theirs.id))
      const status = await asAgent()
        .patch(ApiRoutes.conversations.status(theirs.id))
        .send({ status: ConversationStatus.PENDING })
      const readState = await asAgent().post(ApiRoutes.conversations.read(theirs.id))
      const take = await asAgent()
        .patch(ApiRoutes.conversations.assign(theirs.id))
        .send({ userId: ctx.agentA.id })

      for (const response of [read, status, readState]) {
        expect(response.status).toBe(NOT_FOUND)
      }
      // Taking it is told who has it: the agent may have seen it unassigned a moment ago
      expect(take.status).toBe(CONFLICT)
      expect((take.body as ErrorBody).error.metadata).toEqual({ assignedTo: ctx.adminA.id })
      expect((await row(theirs.id)).assignedTo).toBe(ctx.adminA.id)
    })
  })

  describe('a conversation of another store', () => {
    it('does not exist for any route that writes it, and is left as it was', async () => {
      const foreign = await createConversationOf(owner, { storeId: ctx.storeB.id, unreadCount: 2 })
      const tag = await createTag(owner, { storeId: ctx.storeA.id })
      const soon = new Date(Date.now() + 60_000).toISOString()

      const answers = await Promise.all([
        asAdmin()
          .patch(ApiRoutes.conversations.status(foreign.id))
          .send({ status: ConversationStatus.PENDING }),
        asAdmin().post(ApiRoutes.conversations.snooze(foreign.id)).send({ until: soon }),
        asAdmin().patch(ApiRoutes.conversations.assign(foreign.id)).send({ userId: ctx.adminA.id }),
        asAdmin().post(ApiRoutes.conversations.read(foreign.id)),
        asAdmin().post(ApiRoutes.conversations.tags(foreign.id)).send({ tagId: tag.id }),
        asAdmin().delete(ApiRoutes.conversations.tagById(foreign.id, tag.id))
      ])

      expect(answers.map(answer => answer.status)).toEqual(answers.map(() => NOT_FOUND))
      const stored = await row(foreign.id)
      expect([stored.status, stored.assignedTo, stored.unreadCount, stored.snoozedUntil]).toEqual([
        ConversationStatus.OPEN,
        null,
        2,
        null
      ])
    })
  })

  describe('the status', () => {
    it('follows the transitions, sets what depends on it and clears it when reopened', async () => {
      const conversation = await mk()

      const resolved = await asAgent()
        .patch(ApiRoutes.conversations.status(conversation.id))
        .send({ status: ConversationStatus.RESOLVED, resolutionReason: 'answered' })
      const reopened = await asAgent()
        .patch(ApiRoutes.conversations.status(conversation.id))
        .send({ status: ConversationStatus.OPEN })

      expect(resolved.status).toBe(OK)
      expect((resolved.body as ItemBody).status).toBe(ConversationStatus.RESOLVED)
      expect((resolved.body as ItemBody).resolutionReason).toBe('answered')
      expect((resolved.body as ItemBody).resolvedAt).not.toBeNull()
      expect((reopened.body as ItemBody).status).toBe(ConversationStatus.OPEN)
      expect((reopened.body as ItemBody).resolvedAt).toBeNull()
      expect((reopened.body as ItemBody).resolutionReason).toBeNull()
    })

    it('refuses a jump the machine does not allow, and resolving twice, with their codes', async () => {
      const spam = await mk({ status: ConversationStatus.SPAM })
      const resolved = await mk({ status: ConversationStatus.RESOLVED })

      const jump = await asAdmin()
        .patch(ApiRoutes.conversations.status(spam.id))
        .send({ status: ConversationStatus.RESOLVED })
      const twice = await asAdmin()
        .patch(ApiRoutes.conversations.status(resolved.id))
        .send({ status: ConversationStatus.RESOLVED })

      expect(jump.status).toBe(CONFLICT)
      expect(codeOf(jump.body)).toBe(ErrorCodes.CONVERSATION_INVALID_STATUS_TRANSITION)
      expect((jump.body as ErrorBody).error.metadata).toEqual({
        from: ConversationStatus.SPAM,
        to: ConversationStatus.RESOLVED
      })
      expect(twice.status).toBe(CONFLICT)
      expect(codeOf(twice.body)).toBe(ErrorCodes.CONVERSATION_ALREADY_RESOLVED)
      expect((await row(spam.id)).status).toBe(ConversationStatus.SPAM)
    })

    it('does not snooze through the status route, and takes a reason only with resolving', async () => {
      const conversation = await mk()

      const snoozed = await asAdmin()
        .patch(ApiRoutes.conversations.status(conversation.id))
        .send({ status: ConversationStatus.SNOOZED })
      const reason = await asAdmin()
        .patch(ApiRoutes.conversations.status(conversation.id))
        .send({ status: ConversationStatus.PENDING, resolutionReason: 'why' })
      const unknown = await asAdmin()
        .patch(ApiRoutes.conversations.status(conversation.id))
        .send({ status: 'GONE' })

      for (const response of [snoozed, reason, unknown]) expect(response.status).toBe(BAD_REQUEST)
    })

    it('needs the permission of the destination: archive and spam, resolve, and not a read-only role', async () => {
      const conversation = await mk({ status: ConversationStatus.RESOLVED })
      const open = await mk()

      const agentArchives = await asAgent()
        .patch(ApiRoutes.conversations.status(conversation.id))
        .send({ status: ConversationStatus.ARCHIVED })
      const agentSpam = await asAgent()
        .patch(ApiRoutes.conversations.status(open.id))
        .send({ status: ConversationStatus.SPAM })
      const viewerPends = await asViewer()
        .patch(ApiRoutes.conversations.status(open.id))
        .send({ status: ConversationStatus.PENDING })
      const adminArchives = await asAdmin()
        .patch(ApiRoutes.conversations.status(conversation.id))
        .send({ status: ConversationStatus.ARCHIVED })

      for (const response of [agentArchives, agentSpam, viewerPends]) {
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      }
      expect(adminArchives.status).toBe(OK)
      expect((await row(conversation.id)).archivedAt).not.toBeNull()
    })

    it('takes only one of two requests that change the same conversation at once', async () => {
      for (let round = 0; round < 5; round += 1) {
        const conversation = await mk()

        const answers = await Promise.all([
          asAdmin()
            .patch(ApiRoutes.conversations.status(conversation.id))
            .send({ status: ConversationStatus.RESOLVED }),
          asAdmin()
            .patch(ApiRoutes.conversations.status(conversation.id))
            .send({ status: ConversationStatus.RESOLVED })
        ])

        expect(answers.map(answer => answer.status).sort()).toEqual([OK, CONFLICT])
      }
    })

    it.each([ConversationStatus.ARCHIVED, ConversationStatus.SPAM, ConversationStatus.SNOOZED])(
      'clears what a %s conversation had when it is reopened, and only who may archive reaches archived or spam',
      async from => {
        const conversation = await mk({ status: from })
        await owner.conversation.update({
          where: { id: conversation.id },
          data: {
            archivedAt: new Date(),
            snoozedUntil: new Date(Date.now() + 60_000),
            resolvedAt: new Date(),
            resolutionReason: 'old'
          }
        })

        const byAgent = await asAgent()
          .patch(ApiRoutes.conversations.status(conversation.id))
          .send({ status: ConversationStatus.OPEN })
        const byAdmin = await asAdmin()
          .patch(ApiRoutes.conversations.status(conversation.id))
          .send({ status: ConversationStatus.OPEN })

        // The agent reopens a snoozed one, and does not even see an archived or a spam one
        expect(byAgent.status).toBe(from === ConversationStatus.SNOOZED ? OK : NOT_FOUND)
        expect(byAdmin.status).toBe(from === ConversationStatus.SNOOZED ? CONFLICT : OK)
        const stored = await row(conversation.id)
        expect(stored.status).toBe(ConversationStatus.OPEN)
        expect([
          stored.archivedAt,
          stored.snoozedUntil,
          stored.resolvedAt,
          stored.resolutionReason
        ]).toEqual([null, null, null, null])
      }
    )
  })

  describe('the system lines of the thread', () => {
    const linesOf = (conversationId: string) =>
      owner.message.findMany({
        where: { conversationId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      })

    it('writes one for each change of status that people care about, with no text', async () => {
      const conversation = await mk()
      const status = (to: ConversationStatus, extra: object = {}) =>
        asAgent()
          .patch(ApiRoutes.conversations.status(conversation.id))
          .send({ status: to, ...extra })

      await status(ConversationStatus.PENDING)
      await status(ConversationStatus.RESOLVED, { resolutionReason: 'answered' })
      await status(ConversationStatus.OPEN)

      const lines = await linesOf(conversation.id)
      expect(lines.map(line => (line.metadata as { event: string }).event)).toEqual([
        SystemMessageEvents.RESOLVED,
        SystemMessageEvents.REOPENED
      ])
      expect(lines[0]).toMatchObject({
        type: MessageType.SYSTEM,
        authorType: AuthorType.SYSTEM,
        authorId: null,
        content: null
      })
      expect(lines[0]?.metadata).toMatchObject({
        actor: { type: 'user', id: ctx.agentA.id },
        from: ConversationStatus.PENDING,
        to: ConversationStatus.RESOLVED,
        reason: 'answered'
      })
    })

    it('keeps the date of the snooze and the wake of a snoozed conversation', async () => {
      const conversation = await mk()
      const until = new Date(Date.now() + 3_600_000)
      await asAgent()
        .post(ApiRoutes.conversations.snooze(conversation.id))
        .send({ until: until.toISOString() })
      await asAgent()
        .patch(ApiRoutes.conversations.status(conversation.id))
        .send({ status: ConversationStatus.OPEN })

      const lines = await linesOf(conversation.id)
      expect(lines.map(line => (line.metadata as { event: string }).event)).toEqual([
        SystemMessageEvents.SNOOZED,
        SystemMessageEvents.WOKEN
      ])
      expect(lines[0]?.metadata).toMatchObject({ snoozedUntil: until.toISOString() })
    })

    it('writes one for each assignment and release, and none when nothing changes', async () => {
      const conversation = await mk()
      const assign = (userId: string | null) =>
        asAdmin().patch(ApiRoutes.conversations.assign(conversation.id)).send({ userId })

      await assign(ctx.agentA.id)
      await assign(ctx.agentA.id)
      await assign(agent2.id)
      await assign(null)

      const lines = await linesOf(conversation.id)
      expect(lines.map(line => line.metadata)).toMatchObject([
        { event: SystemMessageEvents.ASSIGNED, assignedTo: ctx.agentA.id, previousAssignee: null },
        {
          event: SystemMessageEvents.ASSIGNED,
          assignedTo: agent2.id,
          previousAssignee: ctx.agentA.id
        },
        { event: SystemMessageEvents.UNASSIGNED, assignedTo: null, previousAssignee: agent2.id }
      ])
    })

    it('is not the last message, moves no date and raises no unread count', async () => {
      const lastMessageAt = minutesAgo(5)
      const conversation = await mk({ lastMessageAt, unreadCount: 2 })
      await asAdmin()
        .patch(ApiRoutes.conversations.status(conversation.id))
        .send({ status: ConversationStatus.RESOLVED })

      const after = await row(conversation.id)
      const list = await asAdmin().get(ApiRoutes.conversations.list)
      const listed = (list.body as PageBody).data.find(item => item.id === conversation.id)
      expect(after.lastMessageAt?.getTime()).toBe(lastMessageAt.getTime())
      expect(after.unreadCount).toBe(2)
      expect(listed?.lastMessage).toBeNull()
    })

    it('shows in the thread, with what it says happened', async () => {
      const conversation = await mk()
      await asAdmin()
        .patch(ApiRoutes.conversations.status(conversation.id))
        .send({ status: ConversationStatus.RESOLVED })

      const thread = await asAdmin().get(ApiRoutes.conversations.messages(conversation.id))
      const [line] = (thread.body as { data: { type: string; system: { event: string } | null }[] })
        .data
      expect(line).toMatchObject({
        type: MessageType.SYSTEM,
        system: { event: SystemMessageEvents.RESOLVED }
      })
    })

    it('cannot be the message that a reply answers', async () => {
      const conversation = await mk()
      await asAdmin()
        .patch(ApiRoutes.conversations.status(conversation.id))
        .send({ status: ConversationStatus.RESOLVED })
      const [line] = await linesOf(conversation.id)

      const reply = await asAdmin().post(ApiRoutes.messages.create).send({
        conversationId: conversation.id,
        type: MessageType.TEXT,
        content: 'hello',
        idempotencyKey: randomUUID(),
        replyToMessageId: line?.id
      })

      expect(reply.status).toBe(NOT_FOUND)
    })

    it('is not written when the change is refused', async () => {
      const conversation = await mk({ status: ConversationStatus.SPAM })
      const refused = await asAgent()
        .patch(ApiRoutes.conversations.status(conversation.id))
        .send({ status: ConversationStatus.RESOLVED })

      expect(refused.status).not.toBe(OK)
      expect(await linesOf(conversation.id)).toEqual([])
    })
  })

  describe('snoozing', () => {
    it('holds the conversation until a moment to come, and reopening clears it', async () => {
      const conversation = await mk()
      const until = new Date(Date.now() + 3 * 60 * 60_000)

      const snoozed = await asAgent()
        .post(ApiRoutes.conversations.snooze(conversation.id))
        .send({ until: until.toISOString() })
      const reopened = await asAgent()
        .patch(ApiRoutes.conversations.status(conversation.id))
        .send({ status: ConversationStatus.OPEN })

      expect(snoozed.status).toBe(OK)
      expect((snoozed.body as ItemBody).status).toBe(ConversationStatus.SNOOZED)
      expect(new Date((snoozed.body as ItemBody).snoozedUntil ?? '').getTime()).toBe(
        until.getTime()
      )
      expect((reopened.body as ItemBody).snoozedUntil).toBeNull()
    })

    it('refuses a moment in the past, one beyond a year, and a role without the permission', async () => {
      const conversation = await mk()
      const past = new Date(Date.now() - 1000).toISOString()
      const far = new Date(Date.now() + 400 * 24 * 60 * 60_000).toISOString()
      const soon = new Date(Date.now() + 60_000).toISOString()

      const inThePast = await asAgent()
        .post(ApiRoutes.conversations.snooze(conversation.id))
        .send({ until: past })
      const tooFar = await asAgent()
        .post(ApiRoutes.conversations.snooze(conversation.id))
        .send({ until: far })
      const notADate = await asAgent()
        .post(ApiRoutes.conversations.snooze(conversation.id))
        .send({ until: 'soon' })
      const viewer = await asViewer()
        .post(ApiRoutes.conversations.snooze(conversation.id))
        .send({ until: soon })
      const resolved = await mk({ status: ConversationStatus.RESOLVED })
      const wrongState = await asAgent()
        .post(ApiRoutes.conversations.snooze(resolved.id))
        .send({ until: soon })

      expect([inThePast.status, tooFar.status, notADate.status]).toEqual([
        BAD_REQUEST,
        BAD_REQUEST,
        BAD_REQUEST
      ])
      expect(viewer.status).toBe(FORBIDDEN)
      expect(wrongState.status).toBe(CONFLICT)
      expect((await row(conversation.id)).status).toBe(ConversationStatus.OPEN)
    })
  })

  describe('assigning', () => {
    it('lets an agent take a conversation nobody has, and release it', async () => {
      const conversation = await mk()

      const taken = await asAgent()
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: ctx.agentA.id })
      const released = await asAgent()
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: null })

      expect((taken.body as ItemBody).assignedTo).toBe(ctx.agentA.id)
      expect((released.body as ItemBody).assignedTo).toBeNull()
    })

    it('gives it to one of two agents who take it together, and tells the other who has it', async () => {
      for (let round = 0; round < 5; round += 1) {
        const conversation = await mk()

        const [one, two] = await Promise.all([
          asAgent()
            .patch(ApiRoutes.conversations.assign(conversation.id))
            .send({ userId: ctx.agentA.id }),
          asAgent2()
            .patch(ApiRoutes.conversations.assign(conversation.id))
            .send({ userId: agent2.id })
        ])

        expect([one.status, two.status].sort()).toEqual([OK, CONFLICT])
        const loser = one.status === CONFLICT ? one : two
        const winner = one.status === OK ? ctx.agentA.id : agent2.id
        expect((loser.body as ErrorBody).error.metadata).toEqual({ assignedTo: winner })
        expect((await row(conversation.id)).assignedTo).toBe(winner)
      }
    })

    it('lets only who may assign take it from someone else or hand it over', async () => {
      const conversation = await mk({ assignedTo: ctx.agentA.id })

      const steal = await asAgent2()
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: agent2.id })
      const handOver = await asAgent()
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: agent2.id })
      const releaseOthers = await asAgent2()
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: null })
      const reassigned = await asAdmin()
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: agent2.id })

      expect(steal.status).toBe(CONFLICT)
      expect(handOver.status).toBe(FORBIDDEN)
      expect(releaseOthers.status).toBe(NOT_FOUND)
      expect(reassigned.status).toBe(OK)
      expect((reassigned.body as ItemBody).assignedTo).toBe(agent2.id)
    })

    it('assigns only to a member of the store who may see its conversations', async () => {
      const conversation = await mk()
      const outsider = await createActor(owner, app, {
        prefix,
        name: 'outsider',
        organizationId: ctx.orgB.id,
        storeId: ctx.storeB.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })

      const toOutsider = await asAdmin()
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: outsider.id })
      const toViewer = await asAdmin()
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: ctx.viewerA.id })
      const toNobody = await asAdmin()
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: '00000000-0000-4000-8000-000000000000' })

      expect(toOutsider.status).toBe(NOT_FOUND)
      expect(toNobody.status).toBe(NOT_FOUND)
      expect(toViewer.status).toBe(OK) // a viewer may see conversations: the role is read-only, not blind
      expect((await row(conversation.id)).assignedTo).toBe(ctx.viewerA.id)
    })

    it('leaves a read-only role unable to take one', async () => {
      const conversation = await mk()

      const response = await asViewer()
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: ctx.viewerA.id })

      expect(response.status).toBe(FORBIDDEN)
    })

    it('leaves the conversations of a member unassigned when they leave the team', async () => {
      const leaver = await createActor(owner, app, {
        prefix,
        name: 'leaver',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      const conversation = await mk({ assignedTo: leaver.id })
      const other = await mk({ assignedTo: ctx.agentA.id })
      const membership = await owner.membership.findFirstOrThrow({
        where: { userId: leaver.id, storeId: ctx.storeA.id }
      })

      const removed = await asAdmin().delete(ApiRoutes.settings.memberById(membership.id))

      expect(removed.status).toBe(NO_CONTENT)
      expect((await row(conversation.id)).assignedTo).toBeNull()
      expect((await row(other.id)).assignedTo).toBe(ctx.agentA.id)
    })
  })

  describe('read state', () => {
    it('is not for a read-only role, which would reset what the whole team sees', async () => {
      const conversation = await mk({ unreadCount: 3 })

      const response = await asViewer().post(ApiRoutes.conversations.read(conversation.id))

      expect(response.status).toBe(FORBIDDEN)
      expect((await row(conversation.id)).unreadCount).toBe(3)
    })

    it('clears the unread count and records who read it', async () => {
      const conversation = await mk({ unreadCount: 4 })

      const response = await asAgent().post(ApiRoutes.conversations.read(conversation.id))

      expect(response.status).toBe(OK)
      expect((response.body as ItemBody).unreadCount).toBe(0)
      const stored = await row(conversation.id)
      expect(stored.lastReadBy).toBe(ctx.agentA.id)
      expect(stored.lastReadAt).not.toBeNull()
    })
  })

  describe('tags', () => {
    it('attaches a tag of the store once and detaches it', async () => {
      const conversation = await mk()
      const tag = await createTag(owner, { storeId: ctx.storeA.id })

      const first = await asAgent()
        .post(ApiRoutes.conversations.tags(conversation.id))
        .send({ tagId: tag.id })
      const again = await asAgent()
        .post(ApiRoutes.conversations.tags(conversation.id))
        .send({ tagId: tag.id })
      const removed = await asAgent().delete(
        ApiRoutes.conversations.tagById(conversation.id, tag.id)
      )

      expect((first.body as { id: string }[]).map(item => item.id)).toEqual([tag.id])
      expect(again.status).toBe(OK)
      expect(removed.status).toBe(NO_CONTENT)
      const after = await owner.conversation.findUniqueOrThrow({
        where: { id: conversation.id },
        select: { tags: true }
      })
      expect(after.tags).toEqual([])
    })

    it('does not know the tag of another store, and is not for a read-only role', async () => {
      const conversation = await mk()
      const foreign = await createTag(owner, { storeId: ctx.storeB.id })
      const own = await createTag(owner, { storeId: ctx.storeA.id })

      const unknown = await asAgent()
        .post(ApiRoutes.conversations.tags(conversation.id))
        .send({ tagId: foreign.id })
      const viewer = await asViewer()
        .post(ApiRoutes.conversations.tags(conversation.id))
        .send({ tagId: own.id })

      expect(unknown.status).toBe(NOT_FOUND)
      expect(viewer.status).toBe(FORBIDDEN)
    })
  })

  describe('creating one (the service the inbound pipeline calls)', () => {
    const service = () => app.get(ConversationsService, { strict: false })

    it('opens a conversation over an identity and a connection of the store', async () => {
      const identity = await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelType.WHATSAPP
      })
      const connection = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelType.WHATSAPP
      })

      const created = await service().create(ctx.storeA.id, {
        customerId: identity.customerId,
        customerIdentityId: identity.id,
        channelConnectionId: connection.id
      })

      expect(created.status).toBe(ConversationStatus.OPEN)
      expect(created.channelType).toBe(ChannelType.WHATSAPP)
      expect(created.customer.id).toBe(identity.customerId)
    })

    it('puts the conversation on the survivor when the customer was merged into another', async () => {
      const survivor = await createCustomer(owner, { storeId: ctx.storeA.id })
      const absorbed = await createCustomer(owner, { storeId: ctx.storeA.id })
      const identity = await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        customerId: survivor.id,
        channelType: ChannelType.WHATSAPP
      })
      await owner.customer.update({
        where: { id: absorbed.id },
        data: { mergedIntoId: survivor.id }
      })
      const connection = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelType.WHATSAPP
      })

      const created = await service().create(ctx.storeA.id, {
        customerId: absorbed.id,
        customerIdentityId: identity.id,
        channelConnectionId: connection.id
      })

      expect(created.customer.id).toBe(survivor.id)
    })

    it('refuses an identity or a connection of another store, and channels that do not match', async () => {
      const identity = await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelType.WHATSAPP
      })
      const foreignConnection = await createChannelConnection(owner, {
        storeId: ctx.storeB.id,
        channelType: ChannelType.WHATSAPP
      })
      const instagram = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelType.INSTAGRAM
      })
      const foreignIdentity = await createCustomerIdentity(owner, { storeId: ctx.storeB.id })
      const input = { customerId: identity.customerId, customerIdentityId: identity.id }

      await expect(
        service().create(ctx.storeA.id, { ...input, channelConnectionId: foreignConnection.id })
      ).rejects.toMatchObject({ code: ErrorCodes.RESOURCE_NOT_FOUND })
      await expect(
        service().create(ctx.storeA.id, { ...input, channelConnectionId: instagram.id })
      ).rejects.toMatchObject({ code: ErrorCodes.RESOURCE_CONFLICT })
      await expect(
        service().create(ctx.storeA.id, {
          customerId: foreignIdentity.customerId,
          customerIdentityId: foreignIdentity.id,
          channelConnectionId: instagram.id
        })
      ).rejects.toMatchObject({ code: ErrorCodes.RESOURCE_NOT_FOUND })
    })
  })

  describe('assignment, tags and creation under pressure', () => {
    const customRole = (name: string, permissions: Permission[]) =>
      actorWithPermissions(owner, app, {
        prefix,
        name,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions
      })

    it('does not answer 404 to a change it made: handing a conversation over takes it out of sight of the one who did it', async () => {
      const lead = await customRole('lead', [
        Permissions.CONVERSATIONS_VIEW,
        Permissions.CONVERSATIONS_RESOLVE,
        Permissions.CONVERSATIONS_ASSIGN
      ])
      const conversation = await mk()

      const handed = await api(app, lead, ctx.storeA)
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: agent2.id })

      expect(handed.status).toBe(OK)
      expect((handed.body as ItemBody).assignedTo).toBe(agent2.id)
    })

    it('does not give a conversation to a member who was removed, or whose role cannot see conversations', async () => {
      const removed = await customRole('removed-member', [Permissions.CONVERSATIONS_VIEW])
      await owner.membership.updateMany({
        where: { userId: removed.id, storeId: ctx.storeA.id },
        data: { status: MembershipStatus.REVOKED, revokedAt: new Date() }
      })
      const blind = await customRole('blind-member', [Permissions.TEAM_VIEW])
      const conversation = await mk()

      const toRemoved = await asAdmin()
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: removed.id })
      const toBlind = await asAdmin()
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: blind.id })

      expect([toRemoved.status, toBlind.status]).toEqual([NOT_FOUND, NOT_FOUND])
      expect((await row(conversation.id)).assignedTo).toBeNull()
    })

    it('never leaves a conversation with a member who is being removed at the same moment', async () => {
      for (let round = 0; round < 5; round += 1) {
        const leaver = await customRole(`racing-${round}`, [Permissions.CONVERSATIONS_VIEW])
        const membership = await owner.membership.findFirstOrThrow({
          where: { userId: leaver.id, storeId: ctx.storeA.id }
        })
        const conversation = await mk()

        const [assigned, removed] = await Promise.all([
          asAdmin()
            .patch(ApiRoutes.conversations.assign(conversation.id))
            .send({ userId: leaver.id }),
          asAdmin().delete(ApiRoutes.settings.memberById(membership.id))
        ])

        expect(removed.status).toBe(NO_CONTENT)
        expect([OK, NOT_FOUND]).toContain(assigned.status)
        expect((await row(conversation.id)).assignedTo).not.toBe(leaver.id)
      }
    })

    it('leaves the conversations of a member in the other stores when they leave one', async () => {
      const extraStore = await ensureStore(owner, ctx.orgA.id, `${prefix}-extra`)
      const inA = await createActor(owner, app, {
        prefix,
        name: 'two-stores',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      await createActor(owner, app, {
        prefix,
        name: 'two-stores',
        organizationId: ctx.orgA.id,
        storeId: extraStore.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      const elsewhere = await createConversationOf(owner, {
        storeId: extraStore.id,
        assignedTo: inA.id
      })
      const membership = await owner.membership.findFirstOrThrow({
        where: { userId: inA.id, storeId: ctx.storeA.id }
      })

      const removed = await asAdmin().delete(ApiRoutes.settings.memberById(membership.id))

      expect(removed.status).toBe(NO_CONTENT)
      expect((await row(elsewhere.id)).assignedTo).toBe(inA.id)
    })

    it('hides a conversation assigned to someone else from an agent in snoozing and tagging too', async () => {
      const theirs = await mk({ assignedTo: ctx.adminA.id })
      const tag = await createTag(owner, { storeId: ctx.storeA.id })
      const soon = new Date(Date.now() + 60_000).toISOString()

      const snooze = await asAgent()
        .post(ApiRoutes.conversations.snooze(theirs.id))
        .send({ until: soon })
      const attach = await asAgent()
        .post(ApiRoutes.conversations.tags(theirs.id))
        .send({ tagId: tag.id })
      const detach = await asAgent().delete(ApiRoutes.conversations.tagById(theirs.id, tag.id))

      expect([snooze.status, attach.status, detach.status]).toEqual([
        NOT_FOUND,
        NOT_FOUND,
        NOT_FOUND
      ])
    })

    it('answers without a 500 when a tag is deleted while it is attached', async () => {
      for (let round = 0; round < 5; round += 1) {
        const conversation = await mk()
        const tag = await createTag(owner, { storeId: ctx.storeA.id })

        const [attached, deleted] = await Promise.all([
          asAgent().post(ApiRoutes.conversations.tags(conversation.id)).send({ tagId: tag.id }),
          asAdmin().delete(ApiRoutes.settings.tagById(tag.id))
        ])

        expect([OK, NOT_FOUND]).toContain(attached.status)
        expect(deleted.status).toBe(NO_CONTENT)
        const after = await owner.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
          select: { tags: true }
        })
        expect(after.tags).toEqual([])
      }
    })

    const service = () => app.get(ConversationsService, { strict: false })
    const chain = async (length: number) => {
      const customers = []
      for (let i = 0; i <= length; i += 1)
        customers.push(await createCustomer(owner, { storeId: ctx.storeA.id }))
      for (let i = 0; i < length; i += 1) {
        await owner.customer.update({
          where: { id: customers[i]?.id ?? '' },
          data: { mergedIntoId: customers[i + 1]?.id }
        })
      }
      const first = customers[0]
      const last = customers[length]
      const identity = await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        customerId: last?.id ?? '',
        channelType: ChannelType.WHATSAPP
      })
      const connection = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelType.WHATSAPP
      })
      return {
        first: first?.id ?? '',
        last: last?.id ?? '',
        identity: identity.id,
        connection: connection.id
      }
    }

    it('follows a chain of merges of five redirects and no more', async () => {
      const five = await chain(5)
      const six = await chain(6)

      const reached = await service().create(ctx.storeA.id, {
        customerId: five.first,
        customerIdentityId: five.identity,
        channelConnectionId: five.connection
      })
      await expect(
        service().create(ctx.storeA.id, {
          customerId: six.first,
          customerIdentityId: six.identity,
          channelConnectionId: six.connection
        })
      ).rejects.toMatchObject({ code: ErrorCodes.RESOURCE_CONFLICT })

      expect(reached.customer.id).toBe(five.last)
    })

    it('does not take an identity of another store for the identity of the customer', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      const foreign = await createCustomerIdentity(owner, {
        storeId: ctx.storeB.id,
        channelType: ChannelType.WHATSAPP
      })
      const connection = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelType.WHATSAPP
      })

      await expect(
        service().create(ctx.storeA.id, {
          customerId: customer.id,
          customerIdentityId: foreign.id,
          channelConnectionId: connection.id
        })
      ).rejects.toMatchObject({
        code: ErrorCodes.RESOURCE_NOT_FOUND,
        message: 'customer identity not found'
      })
    })
  })

  describe('visibility, permissions and filters', () => {
    const asRole = async (name: string, permissions: Permission[]) =>
      api(
        app,
        await createActor(owner, app, {
          prefix,
          name,
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          roleId: (
            await createRole(owner, {
              storeId: ctx.storeA.id,
              name: `${prefix}-${name}`,
              permissions
            })
          ).id
        }),
        ctx.storeA
      )

    it('does not show an agent who cannot archive a conversation that is spam or archived, in any route', async () => {
      const spam = await mk({ status: ConversationStatus.SPAM })
      const archived = await mk({ status: ConversationStatus.ARCHIVED })
      const tag = await createTag(owner, { storeId: ctx.storeA.id })

      for (const hidden of [spam, archived]) {
        const answers = await Promise.all([
          asAgent().get(ApiRoutes.conversations.byId(hidden.id)),
          asAgent()
            .patch(ApiRoutes.conversations.assign(hidden.id))
            .send({ userId: ctx.agentA.id }),
          asAgent().post(ApiRoutes.conversations.read(hidden.id)),
          asAgent().post(ApiRoutes.conversations.tags(hidden.id)).send({ tagId: tag.id })
        ])
        expect(answers.map(answer => answer.status)).toEqual([
          NOT_FOUND,
          NOT_FOUND,
          NOT_FOUND,
          NOT_FOUND
        ])
        expect((await asAdmin().get(ApiRoutes.conversations.byId(hidden.id))).status).toBe(OK)
      }
    })

    it('answers nothing about a conversation of someone else to a no-op assignment', async () => {
      const theirs = await mk({ assignedTo: ctx.adminA.id })

      const response = await asAgent()
        .patch(ApiRoutes.conversations.assign(theirs.id))
        .send({ userId: ctx.adminA.id })

      expect(response.status).toBe(NOT_FOUND)
    })

    it('keeps what a role may read of the last message in the answer to an assignment', async () => {
      const taker = await createActor(owner, app, {
        prefix,
        name: 'takes-blind',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: (
          await createRole(owner, {
            storeId: ctx.storeA.id,
            name: `${prefix}-takes-blind`,
            permissions: [Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_RESOLVE]
          })
        ).id
      })
      const conversation = await mk()
      await createMessage(owner, {
        storeId: ctx.storeA.id,
        conversationId: conversation.id,
        content: 'secret',
        type: MessageType.INTERNAL_NOTE
      })

      const taken = await api(app, taker, ctx.storeA)
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: taker.id })

      expect(taken.status).toBe(OK)
      expect((taken.body as ItemBody).lastMessage).toBeNull()
    })

    it('refuses the counts together with a filter or a cursor', async () => {
      const cursor = encodeConversationCursor({ lastMessageAt: null, id: ctx.storeA.id })
      for (const filter of [
        { cursor },
        { channelType: ChannelType.WHATSAPP },
        { status: ConversationStatus.SPAM },
        { assigned: ConversationAssignedFilters.ME },
        { tagId: '00000000-0000-4000-8000-000000000000' }
      ]) {
        const response = await asAgent()
          .get(ApiRoutes.conversations.list)
          .query({ countsOnly: 'true', ...filter })
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('asks for the permission to see conversations, and for a token', async () => {
      const blind = await asRole('sees-nothing', [Permissions.TEAM_VIEW])
      const conversation = await mk()
      const routes = [ApiRoutes.conversations.list, ApiRoutes.conversations.byId(conversation.id)]

      for (const route of routes) {
        expect((await blind.get(route)).status).toBe(FORBIDDEN)
        expect((await anonymousApi(app).get(route)).status).toBe(UNAUTHORIZED)
      }
      expect(
        (await blind.get(ApiRoutes.conversations.list).query({ countsOnly: 'true' })).status
      ).toBe(FORBIDDEN)
    })

    it('detaches only a tag of the store, is idempotent, and is not for a read-only role', async () => {
      const conversation = await mk()
      const own = await createTag(owner, { storeId: ctx.storeA.id })
      const foreign = await createTag(owner, { storeId: ctx.storeB.id })

      const notAttached = await asAgent().delete(
        ApiRoutes.conversations.tagById(conversation.id, own.id)
      )
      const foreignTag = await asAgent().delete(
        ApiRoutes.conversations.tagById(conversation.id, foreign.id)
      )
      const unknownTag = await asAgent().delete(
        ApiRoutes.conversations.tagById(conversation.id, '00000000-0000-4000-8000-000000000000')
      )
      const viewer = await asViewer().delete(
        ApiRoutes.conversations.tagById(conversation.id, own.id)
      )

      expect(notAttached.status).toBe(NO_CONTENT)
      expect(foreignTag.status).toBe(NOT_FOUND)
      expect(unknownTag.status).toBe(NOT_FOUND)
      expect(viewer.status).toBe(FORBIDDEN)
    })

    it('does not let an agent without VIEW_ALL read what is assigned to someone else through the filters', async () => {
      const mine = await mk({ assignedTo: ctx.agentA.id })
      const theirs = await mk({ assignedTo: ctx.adminA.id })
      const tag = await createTag(owner, { storeId: ctx.storeA.id })
      await owner.conversation.update({
        where: { id: theirs.id },
        data: { tags: { connect: { id: tag.id } } }
      })

      const byAssignee = await asAgent()
        .get(ApiRoutes.conversations.list)
        .query({ assigned: ctx.adminA.id, limit: 100 })
      const byTag = await asAgent().get(ApiRoutes.conversations.list).query({ tagId: tag.id })
      const own = await asAgent()
        .get(ApiRoutes.conversations.list)
        .query({ assigned: ConversationAssignedFilters.ME, limit: 100 })

      expect((byAssignee.body as PageBody).data).toEqual([])
      expect((byTag.body as PageBody).data).toEqual([])
      expect((own.body as PageBody).data.map(item => item.id)).toContain(mine.id)
    })
  })

  describe('what the locks decide, with the conflicting lock held by the test', () => {
    it('does not assign to a member whose removal is being committed', async () => {
      const leaver = await createActor(owner, app, {
        prefix,
        name: 'locked-leaver',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      const membership = await owner.membership.findFirstOrThrow({
        where: { userId: leaver.id, storeId: ctx.storeA.id }
      })
      const conversation = await mk()

      const status = await holding(
        async tx => {
          await tx.membership.update({
            where: { id: membership.id },
            data: { status: MembershipStatus.REVOKED, revokedAt: new Date() }
          })
        },
        () =>
          asAdmin()
            .patch(ApiRoutes.conversations.assign(conversation.id))
            .send({ userId: leaver.id })
      )

      expect(status).toBe(NOT_FOUND)
      expect((await row(conversation.id)).assignedTo).toBeNull()
    })

    it('does not attach a tag whose deletion is being committed', async () => {
      const conversation = await mk()
      const tag = await createTag(owner, { storeId: ctx.storeA.id })

      const status = await holding(
        async tx => {
          await tx.tag.delete({ where: { id: tag.id } })
        },
        () => asAgent().post(ApiRoutes.conversations.tags(conversation.id)).send({ tagId: tag.id })
      )

      expect(status).toBe(NOT_FOUND)
    })
  })

  describe('limits and writes of each status', () => {
    it('takes a resolution reason of 500 characters and refuses 501 or a NUL', async () => {
      const reasons = [
        ['x'.repeat(500), OK],
        ['x'.repeat(501), BAD_REQUEST],
        ['a\u0000b', BAD_REQUEST]
      ] as const
      for (const [reason, expected] of reasons) {
        const conversation = await mk()
        const response = await asAdmin()
          .patch(ApiRoutes.conversations.status(conversation.id))
          .send({ status: ConversationStatus.RESOLVED, resolutionReason: reason })
        expect(response.status).toBe(expected)
      }
    })
  })

  describe('creating one: whose identity it is', () => {
    it('does not take the identity of another customer of the same store', async () => {
      const customer = await createCustomer(owner, { storeId: ctx.storeA.id })
      const other = await createCustomerIdentity(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelType.WHATSAPP
      })
      const connection = await createChannelConnection(owner, {
        storeId: ctx.storeA.id,
        channelType: ChannelType.WHATSAPP
      })

      await expect(
        app.get(ConversationsService, { strict: false }).create(ctx.storeA.id, {
          customerId: customer.id,
          customerIdentityId: other.id,
          channelConnectionId: connection.id
        })
      ).rejects.toMatchObject({ code: ErrorCodes.RESOURCE_NOT_FOUND })
    })
  })

  describe('assigning without the permission to assign', () => {
    it('refuses to release or hand over what someone else holds, to a role that sees all', async () => {
      const watcher = await createActor(owner, app, {
        prefix,
        name: 'sees-all',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: (
          await createRole(owner, {
            storeId: ctx.storeA.id,
            name: `${prefix}-sees-all`,
            permissions: [
              Permissions.CONVERSATIONS_VIEW,
              Permissions.CONVERSATIONS_VIEW_ALL,
              Permissions.CONVERSATIONS_RESOLVE
            ]
          })
        ).id
      })
      const conversation = await mk({ assignedTo: ctx.agentA.id })

      const release = await api(app, watcher, ctx.storeA)
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: null })
      const handOver = await api(app, watcher, ctx.storeA)
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: agent2.id })

      expect([release.status, handOver.status]).toEqual([FORBIDDEN, FORBIDDEN])
      expect((await row(conversation.id)).assignedTo).toBe(ctx.agentA.id)
    })
  })

  describe('tags and dates at their limits', () => {
    it('holds at most 20 tags in a conversation, and attaching one it has is not another', async () => {
      const conversation = await mk()
      const tags = await Promise.all(
        Array.from({ length: 21 }, () => createTag(owner, { storeId: ctx.storeA.id }))
      )
      for (const tag of tags.slice(0, 20)) {
        const attached = await asAgent()
          .post(ApiRoutes.conversations.tags(conversation.id))
          .send({ tagId: tag.id })
        expect(attached.status).toBe(OK)
      }

      const again = await asAgent()
        .post(ApiRoutes.conversations.tags(conversation.id))
        .send({ tagId: tags[0]?.id })
      const over = await asAgent()
        .post(ApiRoutes.conversations.tags(conversation.id))
        .send({ tagId: tags[20]?.id })

      expect(again.status).toBe(OK)
      expect(over.status).toBe(CONFLICT)
      expect((over.body as ErrorBody).error.metadata).toEqual({ limit: 20 })
    })

    it('needs the permission to see for every route that writes, not only the one of the change', async () => {
      const conversation = await mk()
      const tag = await createTag(owner, { storeId: ctx.storeA.id })
      const writer = api(
        app,
        await createActor(owner, app, {
          prefix,
          name: 'writes-blind',
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          roleId: (
            await createRole(owner, {
              storeId: ctx.storeA.id,
              name: `${prefix}-writes-blind`,
              permissions: [Permissions.CONVERSATIONS_RESOLVE, Permissions.CONVERSATIONS_SNOOZE]
            })
          ).id
        }),
        ctx.storeA
      )
      const soon = new Date(Date.now() + 60_000).toISOString()

      const answers = await Promise.all([
        writer.post(ApiRoutes.conversations.read(conversation.id)),
        writer.post(ApiRoutes.conversations.snooze(conversation.id)).send({ until: soon }),
        writer.post(ApiRoutes.conversations.tags(conversation.id)).send({ tagId: tag.id }),
        writer.delete(ApiRoutes.conversations.tagById(conversation.id, tag.id))
      ])

      expect(answers.map(answer => answer.status)).toEqual(answers.map(() => FORBIDDEN))
    })
  })

  describe('the row lock of a conversation, with the lock held by the test', () => {
    // The owner locks the row of the conversation and writes it in an open transaction
    const holdingRow = (
      id: string,
      data: { status?: ConversationStatus; assignedTo?: string },
      request: () => Promise<{ status: number }>
    ) =>
      holding(async tx => {
        await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${id} FOR UPDATE`
        // The owner writes the row, as another request would
        await tx.conversation.update({ where: { id }, data })
      }, request)

    it('refuses to resolve what another request is resolving and has not committed', async () => {
      const conversation = await mk()

      const status = await holdingRow(
        conversation.id,
        { status: ConversationStatus.RESOLVED },
        () =>
          asAdmin()
            .patch(ApiRoutes.conversations.status(conversation.id))
            .send({ status: ConversationStatus.RESOLVED })
      )

      expect(status).toBe(CONFLICT)
    })

    it('tells the second agent who has the conversation when the first has not committed', async () => {
      const conversation = await mk()

      const status = await holdingRow(conversation.id, { assignedTo: ctx.agentA.id }, () =>
        asAgent2()
          .patch(ApiRoutes.conversations.assign(conversation.id))
          .send({ userId: agent2.id })
      )

      expect(status).toBe(CONFLICT)
      expect((await row(conversation.id)).assignedTo).toBe(ctx.agentA.id)
    })
  })

  describe('limits and writes, exactly', () => {
    it.each([ConversationStatus.ARCHIVED, ConversationStatus.SPAM])(
      'does not assign a %s conversation, and releases it',
      async hidden => {
        const conversation = await mk({ status: hidden, assignedTo: ctx.agentA.id })

        const assign = await asAdmin()
          .patch(ApiRoutes.conversations.assign(conversation.id))
          .send({ userId: agent2.id })
        const release = await asAdmin()
          .patch(ApiRoutes.conversations.assign(conversation.id))
          .send({ userId: null })

        expect(assign.status).toBe(CONFLICT)
        expect(release.status).toBe(OK)
      }
    )

    it('snoozes up to a year and not beyond it, to the minute', async () => {
      const yearMs = 365 * 24 * 60 * 60_000
      const conversation = await mk()
      const inside = new Date(Date.now() + yearMs - 5 * 60_000).toISOString()
      const outside = new Date(Date.now() + yearMs + 5 * 60_000).toISOString()

      const within = await asAgent()
        .post(ApiRoutes.conversations.snooze(conversation.id))
        .send({ until: inside })
      const beyond = await asAgent()
        .post(ApiRoutes.conversations.snooze(conversation.id))
        .send({ until: outside })

      expect(within.status).toBe(OK)
      expect(beyond.status).toBe(BAD_REQUEST)
    })

    it('reads a date with an offset as the instant it names', async () => {
      const conversation = await mk()
      const instant = new Date(Date.now() + 2 * 60 * 60_000)
      const local = new Date(instant.getTime() + 5 * 60 * 60_000)
      const withOffset = `${local.toISOString().slice(0, 19)}+05:00`

      const response = await asAgent()
        .post(ApiRoutes.conversations.snooze(conversation.id))
        .send({ until: withOffset })

      expect(response.status).toBe(OK)
      expect((await row(conversation.id)).snoozedUntil?.getTime()).toBe(
        Math.floor(instant.getTime() / 1000) * 1000
      )
    })

    it('keeps a snoozed conversation snoozed while it is tagged and read', async () => {
      const conversation = await mk({ status: ConversationStatus.SNOOZED })
      const until = new Date(Date.now() + 60 * 60_000)
      await owner.conversation.update({
        where: { id: conversation.id },
        data: { snoozedUntil: until }
      })
      const tag = await createTag(owner, { storeId: ctx.storeA.id })

      const read = await asAgent().post(ApiRoutes.conversations.read(conversation.id))
      const tagged = await asAgent()
        .post(ApiRoutes.conversations.tags(conversation.id))
        .send({ tagId: tag.id })

      expect([read.status, tagged.status]).toEqual([OK, OK])
      const stored = await row(conversation.id)
      expect([stored.status, stored.snoozedUntil?.getTime()]).toEqual([
        ConversationStatus.SNOOZED,
        until.getTime()
      ])
    })

    it('asks for the permission to see in the status and the assignment routes too', async () => {
      const writer = api(
        app,
        await actorWithPermissions(owner, app, {
          prefix,
          name: 'writes-status-blind',
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          permissions: [Permissions.CONVERSATIONS_RESOLVE, Permissions.CONVERSATIONS_ASSIGN]
        }),
        ctx.storeA
      )
      const conversation = await mk()

      const status = await writer
        .patch(ApiRoutes.conversations.status(conversation.id))
        .send({ status: ConversationStatus.PENDING })
      const assign = await writer
        .patch(ApiRoutes.conversations.assign(conversation.id))
        .send({ userId: null })

      expect([status.status, assign.status]).toEqual([FORBIDDEN, FORBIDDEN])
    })
  })
})
