import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  AttentionReasons,
  ConversationLimits,
  ConversationStatus,
  MessageType,
  SystemMessageEvents
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Events } from '@platform/core/events'
import { ConversationsService } from '@platform/core/messaging'
import { NotificationTypes } from '@platform/core/notifications'

import { SnoozeWakeScheduler } from '../../apps/worker/src/schedulers/snooze-wake.scheduler'
import { createConversationOf } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const BAD_REQUEST = 400
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const POLL_MS = 100
const ATTEMPTS = 50
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

interface ItemBody {
  id: string
  attention: { reason: string; at: string; note: string | null } | null
}
interface PageBody {
  data: ItemBody[]
  nextCursor: string | null
  hasMore: boolean
}

// The mark that raises a conversation in the list when a snoozed one wakes up, and the reminder left
// with the snooze (owner, 2026-11-08)
describe('Conversation attention', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let wake: SnoozeWakeScheduler
  const heard: { event: string; payload: unknown }[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const locks = {
      withLock: async (_name: string, _seconds: number, work: () => Promise<void>) => {
        await work()
        return true
      }
    } as never // the lock is not what is tested
    wake = new SnoozeWakeScheduler(
      locks,
      app.get(PrismaService, { strict: false }),
      app.get(ConversationsService, { strict: false }),
      await app.resolve(PinoLogger)
    )
    app.get(EventEmitter2).onAny((event, payload) => {
      heard.push({ event: String(event), payload })
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(() => {
    heard.length = 0
  })
  afterEach(async () => {
    await owner.notification.deleteMany({ where: { storeId: ctx.storeA.id } })
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const future = () => new Date(Date.now() + HOUR_MS).toISOString()

  const open = async (
    extra: { lastMessageAt?: Date; assignedTo?: string | null; status?: ConversationStatus } = {}
  ) => (await createConversationOf(owner, { storeId: ctx.storeA.id, ...extra })).id
  // A snoozed conversation whose moment already passed, with the reminder it was given
  const overdue = async (note: string | null, assignedTo: string | null = ctx.agentA.id) => {
    const id = await open({ assignedTo, status: ConversationStatus.SNOOZED })
    await owner.conversation.update({
      where: { id },
      data: { snoozedUntil: new Date(Date.now() - MINUTE_MS), snoozeNote: note }
    })
    return id
  }
  const row = (id: string) =>
    owner.conversation.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        snoozeNote: true,
        attentionReason: true,
        attentionAt: true,
        attentionNote: true
      }
    })
  const attentionEvents = (id: string) =>
    heard.filter(
      entry =>
        entry.event === Events.CONVERSATION_ATTENTION_CHANGED &&
        (entry.payload as { conversationId: string }).conversationId === id
    )
  const pageOf = async (query: object = {}): Promise<PageBody> => {
    const response = await asAdmin().get(ApiRoutes.conversations.list).query(query)
    expect(response.status).toBe(OK)
    return response.body as PageBody
  }

  describe('the reminder of a snooze', () => {
    it('is kept trimmed, and an empty one is none', async () => {
      const kept = await open()
      const empty = await open()

      const first = await asAdmin()
        .post(ApiRoutes.conversations.snooze(kept))
        .send({ until: future(), note: '  call back after the delivery  ' })
      const second = await asAdmin()
        .post(ApiRoutes.conversations.snooze(empty))
        .send({ until: future(), note: '   ' })

      expect(first.status).toBe(OK)
      expect(second.status).toBe(OK)
      expect((await row(kept)).snoozeNote).toBe('call back after the delivery')
      expect((await row(empty)).snoozeNote).toBeNull()
    })

    it('takes the longest the limit allows and refuses one character more', async () => {
      const id = await open()
      const longest = 'a'.repeat(ConversationLimits.SNOOZE_NOTE_MAX_LENGTH)

      const refused = await asAdmin()
        .post(ApiRoutes.conversations.snooze(id))
        .send({ until: future(), note: `${longest}a` })
      expect(refused.status).toBe(BAD_REQUEST)
      expect((refused.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.VALIDATION_FAILED
      )
      expect((await row(id)).status).toBe(ConversationStatus.OPEN)

      const accepted = await asAdmin()
        .post(ApiRoutes.conversations.snooze(id))
        .send({ until: future(), note: longest })
      expect(accepted.status).toBe(OK)
      expect((await row(id)).snoozeNote).toBe(longest)
    })
  })

  describe('a snoozed conversation that wakes up', () => {
    it('is marked with the reason, the moment and the reminder, and the reminder is not kept twice', async () => {
      const id = await overdue('ask for the invoice')

      await wake.wake()

      const woken = await row(id)
      expect(woken).toMatchObject({
        status: ConversationStatus.OPEN,
        snoozeNote: null,
        attentionReason: AttentionReasons.SNOOZE_WOKE,
        attentionNote: 'ask for the invoice'
      })
      expect(woken.attentionAt).toBeInstanceOf(Date)
      const item = (await pageOf()).data.find(entry => entry.id === id)
      expect(item?.attention).toMatchObject({
        reason: AttentionReasons.SNOOZE_WOKE,
        note: 'ask for the invoice'
      })
      expect(attentionEvents(id)).toHaveLength(1)
      expect(attentionEvents(id)[0]?.payload).toMatchObject({
        reason: AttentionReasons.SNOOZE_WOKE
      })
      // The note stays out of the event: no text of an agent crosses the bridge
      expect(JSON.stringify(attentionEvents(id)[0]?.payload)).not.toContain('invoice')
    })

    it('carries the reminder on the line of the thread that says it woke up', async () => {
      const id = await overdue('ask for the invoice')

      await wake.wake()

      const lines = await owner.message.findMany({
        where: { conversationId: id, type: MessageType.SYSTEM }
      })
      expect(lines.map(line => line.metadata)).toEqual([
        expect.objectContaining({ event: SystemMessageEvents.WOKEN, note: 'ask for the invoice' })
      ])
    })

    it('has no note when none was left', async () => {
      const id = await overdue(null)

      await wake.wake()

      expect(await row(id)).toMatchObject({
        attentionReason: AttentionReasons.SNOOZE_WOKE,
        attentionNote: null
      })
    })

    it('is not marked when a person wakes it, and loses the reminder', async () => {
      const id = await overdue('ask for the invoice')
      await owner.conversation.update({
        where: { id },
        data: { snoozedUntil: new Date(Date.now() + HOUR_MS) }
      })

      const response = await asAdmin()
        .patch(ApiRoutes.conversations.status(id))
        .send({ status: ConversationStatus.OPEN })

      expect(response.status).toBe(OK)
      expect(await row(id)).toMatchObject({
        status: ConversationStatus.OPEN,
        snoozeNote: null,
        attentionReason: null,
        attentionAt: null,
        attentionNote: null
      })
      expect(attentionEvents(id)).toHaveLength(0)
    })

    it('tells the team when nobody owns it, and keeps the notice of the owner as it was', async () => {
      const mine = await overdue(null, ctx.agentA.id)
      const nobodys = await overdue(null, null)

      await wake.wake()

      const rowsOf = async (type: string, resourceId: string) => {
        for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
          const rows = await owner.notification.findMany({
            where: { storeId: ctx.storeA.id, type, resourceId }
          })
          if (rows.length > 0) return rows
          await wait(POLL_MS)
        }
        return []
      }
      const queue = await rowsOf(NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE, nobodys)
      expect(queue.map(entry => entry.userId).sort()).toEqual([ctx.adminA.id, ctx.agentA.id].sort())
      const owners = await rowsOf(NotificationTypes.CONVERSATION_SNOOZE_EXPIRED, mine)
      expect(owners.map(entry => entry.userId)).toEqual([ctx.agentA.id])
    })
  })

  describe('the order of the list', () => {
    it('raises a marked conversation above newer ones, and drops it back when it is opened', async () => {
      const base = Date.now() - 10 * HOUR_MS
      const oldest = await open({
        lastMessageAt: new Date(base),
        assignedTo: ctx.agentA.id,
        status: ConversationStatus.SNOOZED
      })
      const newer = await open({ lastMessageAt: new Date(base + HOUR_MS) })
      const newest = await open({ lastMessageAt: new Date(base + 2 * HOUR_MS) })
      await owner.conversation.update({
        where: { id: oldest },
        data: { snoozedUntil: new Date(Date.now() - MINUTE_MS) }
      })

      await wake.wake()
      const ids = () =>
        pageOf().then(page =>
          page.data.map(entry => entry.id).filter(id => [oldest, newer, newest].includes(id))
        )
      expect(await ids()).toEqual([oldest, newest, newer])

      const opened = await asAdmin().post(ApiRoutes.conversations.read(oldest))
      expect(opened.status).toBe(OK)
      expect(await ids()).toEqual([newest, newer, oldest])
      expect(await row(oldest)).toMatchObject({
        attentionReason: null,
        attentionAt: null,
        attentionNote: null
      })
      expect(
        attentionEvents(oldest).map(entry => (entry.payload as { reason: unknown }).reason)
      ).toEqual([AttentionReasons.SNOOZE_WOKE, null])
    })

    it('pages without repeating or skipping a row, even when opening one moves it between pages', async () => {
      const base = Date.now() - 20 * HOUR_MS
      const plain = []
      for (let i = 0; i < 5; i += 1) {
        plain.push(await open({ lastMessageAt: new Date(base + i * HOUR_MS) }))
      }
      const markedIds = []
      for (let i = 0; i < 3; i += 1) {
        const id = await overdue(null)
        await owner.conversation.update({
          where: { id },
          data: { lastMessageAt: new Date(base - (i + 1) * HOUR_MS) }
        })
        markedIds.push(id)
        await wake.wake()
        await wait(POLL_MS) // each mark has its own moment
      }
      const mine = new Set([...plain, ...markedIds])
      const only = (page: PageBody) => page.data.map(entry => entry.id).filter(id => mine.has(id))

      const whole = only(await pageOf({ limit: 100 }))
      expect(whole).toHaveLength(8)
      // The newest mark first, then the older marks, then the rest by their last message
      expect(whole.slice(0, 3)).toEqual([...markedIds].reverse())

      // The same list in pages of two, taking off the mark of the first row after the first page
      const seen: string[] = []
      let cursor: string | undefined
      for (let step = 0; step < 20; step += 1) {
        const page = await pageOf({ limit: 2, ...(cursor === undefined ? {} : { cursor }) })
        seen.push(...page.data.map(entry => entry.id))
        if (step === 0) {
          const moved = whole[0]
          if (moved === undefined) throw new Error('no first row')
          await asAdmin().post(ApiRoutes.conversations.read(moved))
        }
        if (!page.hasMore || page.nextCursor === null) break
        cursor = page.nextCursor
      }
      const visits = seen.filter(id => mine.has(id))
      // Every row that did not move is seen exactly once. The one that lost its mark moved down into
      // the part not yet read, so it may be seen again there: once more at most.
      const moved = whole[0]
      for (const id of whole.slice(1)) expect(visits.filter(visit => visit === id)).toHaveLength(1)
      expect(visits.filter(visit => visit === moved).length).toBeLessThanOrEqual(2)
      expect(visits).toHaveLength(whole.length + visits.filter(v => v === moved).length - 1)
    })
  })

  describe('how the mark and the reminder go away', () => {
    it('goes away when the conversation leaves OPEN for another state', async () => {
      const id = await overdue('x')
      await wake.wake()
      expect((await row(id)).attentionReason).not.toBeNull()
      heard.length = 0

      const response = await asAdmin()
        .patch(ApiRoutes.conversations.status(id))
        .send({ status: ConversationStatus.RESOLVED })

      expect(response.status).toBe(OK)
      expect(await row(id)).toMatchObject({ attentionReason: null, attentionAt: null })
      expect(
        attentionEvents(id).map(entry => (entry.payload as { reason: unknown }).reason)
      ).toEqual([null])
    })

    it('says nothing when opening a conversation that had no mark', async () => {
      const id = await open()

      const response = await asAdmin().post(ApiRoutes.conversations.read(id))

      expect(response.status).toBe(OK)
      expect(attentionEvents(id)).toHaveLength(0)
    })

    it('loses the reminder when the customer writes to the snoozed conversation', async () => {
      const id = await overdue('x')
      await owner.conversation.update({
        where: { id },
        data: { snoozedUntil: new Date(Date.now() + HOUR_MS) }
      })
      const conversations = app.get(ConversationsService, { strict: false })
      const prisma = app.get(PrismaService, { strict: false })

      await prisma.transaction(tx =>
        conversations.applyStatus(tx, ctx.storeA.id, id, ConversationStatus.OPEN, {
          actor: 'system',
          reason: 'customer_replied'
        })
      )

      expect(await row(id)).toMatchObject({ snoozeNote: null, attentionReason: null })
    })
  })
})
