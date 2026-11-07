import type { INestApplication } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { PinoLogger } from 'nestjs-pino'

import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import {
  ConversationStatus,
  ConversationStatusReasons,
  MessageType,
  SystemMessageEvents
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { Events } from '@platform/core/events'
import { ConversationsService } from '@platform/core/messaging'

import { AutoArchiveScheduler } from '../../apps/worker/src/schedulers/auto-archive.scheduler'
import { SnoozeWakeScheduler } from '../../apps/worker/src/schedulers/snooze-wake.scheduler'
import { createConversationOf } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000
const ARCHIVE_AFTER_DAYS = 7
const OTHER_STORE_ARCHIVE_DAYS = 30

// The two sweeps of the worker (Step 3.2 / TDD_09 §3): a snoozed conversation comes back when its
// moment passes, and a resolved one is archived after the days the store chose
describe('Conversation sweeps', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let wake: SnoozeWakeScheduler
  let archive: AutoArchiveScheduler
  const heard: { event: string; payload: unknown }[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    for (const [storeId, autoArchiveAfterDays] of [
      [ctx.storeA.id, ARCHIVE_AFTER_DAYS],
      [ctx.storeA2.id, OTHER_STORE_ARCHIVE_DAYS]
    ] as const) {
      await owner.storeSettings.upsert({
        where: { storeId },
        create: { storeId, autoArchiveAfterDays },
        update: { autoArchiveAfterDays }
      })
    }
    const prisma = app.get(PrismaService, { strict: false })
    const conversations = app.get(ConversationsService, { strict: false })
    const locks = {
      withLock: async (_name: string, _seconds: number, work: () => Promise<void>) => {
        await work()
        return true
      }
    } as never // the lock is not what is tested
    wake = new SnoozeWakeScheduler(locks, prisma, conversations, await app.resolve(PinoLogger))
    archive = new AutoArchiveScheduler(locks, prisma, conversations, await app.resolve(PinoLogger))
    const emitter = app.get(EventEmitter2)
    emitter.onAny((event, payload) => {
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

  const snoozed = async (storeId: string, until: Date, assignedTo: string | null = null) => {
    const { id } = await createConversationOf(owner, {
      storeId,
      status: ConversationStatus.SNOOZED,
      assignedTo
    })
    await owner.conversation.update({ where: { id }, data: { snoozedUntil: until } })
    return id
  }
  const resolved = async (storeId: string, resolvedAt: Date) =>
    (
      await createConversationOf(owner, {
        storeId,
        status: ConversationStatus.RESOLVED,
        resolvedAt
      })
    ).id
  const row = (id: string) =>
    owner.conversation.findUniqueOrThrow({
      where: { id },
      select: { status: true, snoozedUntil: true, archivedAt: true }
    })
  const linesOf = async (id: string) =>
    (
      await owner.message.findMany({
        where: { conversationId: id, type: MessageType.SYSTEM },
        orderBy: { createdAt: 'asc' }
      })
    ).map(line => line.metadata as { event: string; reason: string | null })

  describe('snoozed conversations', () => {
    it('reopens one whose moment has passed, with the line that it woke up', async () => {
      const id = await snoozed(ctx.storeA.id, new Date(Date.now() - MINUTE_MS), ctx.agentA.id)

      await wake.wake()

      expect(await row(id)).toMatchObject({ status: ConversationStatus.OPEN, snoozedUntil: null })
      const lines = await linesOf(id)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        event: SystemMessageEvents.WOKEN,
        reason: ConversationStatusReasons.SNOOZE_EXPIRED
      })
    })

    it('announces the expired snooze with the assignee, the change of status and the mark', async () => {
      const id = await snoozed(ctx.storeA.id, new Date(Date.now() - MINUTE_MS), ctx.agentA.id)

      await wake.wake()

      const events = heard.filter(
        entry => (entry.payload as { conversationId?: string } | undefined)?.conversationId === id
      )
      expect(events.map(entry => entry.event).sort()).toEqual(
        [
          Events.CONVERSATION_ATTENTION_CHANGED,
          Events.CONVERSATION_SNOOZE_EXPIRED,
          Events.CONVERSATION_STATUS_CHANGED
        ].sort()
      )
      expect(events.find(e => e.event === Events.CONVERSATION_SNOOZE_EXPIRED)?.payload).toEqual({
        storeId: ctx.storeA.id,
        conversationId: id,
        assignedTo: ctx.agentA.id
      })
    })

    it('leaves alone one whose moment has not come', async () => {
      const id = await snoozed(ctx.storeA.id, new Date(Date.now() + HOUR_MS))

      await wake.wake()

      expect(await row(id)).toMatchObject({ status: ConversationStatus.SNOOZED })
      expect(await linesOf(id)).toHaveLength(0)
    })

    it('wakes the conversations of every store in one run', async () => {
      const a = await snoozed(ctx.storeA.id, new Date(Date.now() - HOUR_MS))
      const b = await snoozed(ctx.storeB.id, new Date(Date.now() - HOUR_MS))

      await wake.wake()

      expect((await row(a)).status).toBe(ConversationStatus.OPEN)
      expect((await row(b)).status).toBe(ConversationStatus.OPEN)
    })

    it('leaves out the ids it is told to skip', async () => {
      const id = await snoozed(ctx.storeA.id, new Date(Date.now() - MINUTE_MS))

      await wake.wake(new Date(), new Set([id]))

      expect((await row(id)).status).toBe(ConversationStatus.SNOOZED)
      await wake.wake()
      expect((await row(id)).status).toBe(ConversationStatus.OPEN)
    })

    it('does not wake the same conversation twice', async () => {
      const id = await snoozed(ctx.storeA.id, new Date(Date.now() - MINUTE_MS))

      await wake.wake()
      await wake.wake()

      expect(await linesOf(id)).toHaveLength(1)
    })

    it('does the same when the cron runs it', async () => {
      const id = await snoozed(ctx.storeA.id, new Date(Date.now() - MINUTE_MS))

      await wake.run()

      expect((await row(id)).status).toBe(ConversationStatus.OPEN)
    })

    it('refuses one that was snoozed again after the sweep chose it', async () => {
      const id = await snoozed(ctx.storeA.id, new Date(Date.now() + DAY_MS))
      const chosenAt = new Date()

      await expect(
        app.get(PrismaService, { strict: false }).transaction(tx =>
          app
            .get(ConversationsService, { strict: false })
            .applyStatus(tx, ctx.storeA.id, id, ConversationStatus.OPEN, {
              actor: 'system',
              reason: ConversationStatusReasons.SNOOZE_EXPIRED,
              onlyIfDue: { status: ConversationStatus.SNOOZED, by: chosenAt }
            })
        )
      ).rejects.toMatchObject({ code: ErrorCodes.RESOURCE_CONFLICT })

      expect((await row(id)).status).toBe(ConversationStatus.SNOOZED)
      expect(await linesOf(id)).toHaveLength(0)
    })

    it('refuses one that is no longer snoozed, whatever its old dates say', async () => {
      const id = (
        await createConversationOf(owner, {
          storeId: ctx.storeA.id,
          status: ConversationStatus.ARCHIVED,
          resolvedAt: new Date(Date.now() - 40 * DAY_MS)
        })
      ).id

      await expect(
        app.get(PrismaService, { strict: false }).transaction(tx =>
          app
            .get(ConversationsService, { strict: false })
            .applyStatus(tx, ctx.storeA.id, id, ConversationStatus.OPEN, {
              actor: 'system',
              reason: ConversationStatusReasons.SNOOZE_EXPIRED,
              onlyIfDue: { status: ConversationStatus.SNOOZED, by: new Date() }
            })
        )
      ).rejects.toMatchObject({ code: ErrorCodes.RESOURCE_CONFLICT })

      expect((await row(id)).status).toBe(ConversationStatus.ARCHIVED)
    })

    it('keeps going when one conversation changed under the sweep', async () => {
      const first = await snoozed(ctx.storeA.id, new Date(Date.now() - 2 * HOUR_MS))
      const second = await snoozed(ctx.storeA.id, new Date(Date.now() - HOUR_MS))
      const conversations = app.get(ConversationsService, { strict: false })
      const original = conversations.applyStatus.bind(conversations)
      const spy = jest
        .spyOn(conversations, 'applyStatus')
        .mockImplementationOnce(() => Promise.reject(new Error('lost the race')))
        .mockImplementation(original)

      await wake.wake()
      spy.mockRestore()

      expect((await row(first)).status).toBe(ConversationStatus.SNOOZED)
      expect((await row(second)).status).toBe(ConversationStatus.OPEN)
    })
  })

  describe('resolved conversations', () => {
    it('archives one resolved longer ago than the store chose, with its line', async () => {
      const id = await resolved(
        ctx.storeA.id,
        new Date(Date.now() - (ARCHIVE_AFTER_DAYS + 1) * DAY_MS)
      )

      await archive.archive()

      const after = await row(id)
      expect(after.status).toBe(ConversationStatus.ARCHIVED)
      expect(after.archivedAt).not.toBeNull()
      const lines = await linesOf(id)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        event: SystemMessageEvents.ARCHIVED,
        reason: ConversationStatusReasons.AUTO_ARCHIVED
      })
    })

    it('leaves alone one resolved more recently than that', async () => {
      const id = await resolved(
        ctx.storeA.id,
        new Date(Date.now() - (ARCHIVE_AFTER_DAYS - 1) * DAY_MS)
      )

      await archive.archive()

      expect((await row(id)).status).toBe(ConversationStatus.RESOLVED)
    })

    it('reads the days of each store: the same age is archived in one and kept in the other', async () => {
      const age = new Date(Date.now() - (ARCHIVE_AFTER_DAYS + 3) * DAY_MS)
      const short = await resolved(ctx.storeA.id, age)
      const long = await resolved(ctx.storeA2.id, age)

      await archive.archive()

      expect((await row(short)).status).toBe(ConversationStatus.ARCHIVED)
      expect((await row(long)).status).toBe(ConversationStatus.RESOLVED)
    })

    it('refuses one that was resolved again after the sweep chose it', async () => {
      const id = await resolved(ctx.storeA.id, new Date())
      const cutoff = new Date(Date.now() - ARCHIVE_AFTER_DAYS * DAY_MS)

      await expect(
        app.get(PrismaService, { strict: false }).transaction(tx =>
          app
            .get(ConversationsService, { strict: false })
            .applyStatus(tx, ctx.storeA.id, id, ConversationStatus.ARCHIVED, {
              actor: 'system',
              reason: ConversationStatusReasons.AUTO_ARCHIVED,
              onlyIfDue: { status: ConversationStatus.RESOLVED, by: cutoff }
            })
        )
      ).rejects.toMatchObject({ code: ErrorCodes.RESOURCE_CONFLICT })

      expect((await row(id)).status).toBe(ConversationStatus.RESOLVED)
    })

    it('does the same when the cron runs it', async () => {
      const id = await resolved(
        ctx.storeA.id,
        new Date(Date.now() - (ARCHIVE_AFTER_DAYS + 2) * DAY_MS)
      )

      await archive.run()

      expect((await row(id)).status).toBe(ConversationStatus.ARCHIVED)
    })

    it('leaves out the ids it is told to skip', async () => {
      const id = await resolved(
        ctx.storeA.id,
        new Date(Date.now() - (ARCHIVE_AFTER_DAYS + 5) * DAY_MS)
      )

      const skipped = await archive.archive(new Date(), new Set([id]))

      expect((await row(id)).status).toBe(ConversationStatus.RESOLVED)
      expect(skipped.changed).toBeGreaterThanOrEqual(0)
      await archive.archive()
      expect((await row(id)).status).toBe(ConversationStatus.ARCHIVED)
    })

    it('does not touch conversations that are not resolved', async () => {
      const old = new Date(Date.now() - 400 * DAY_MS)
      const open = (await createConversationOf(owner, { storeId: ctx.storeA.id })).id
      const pending = (
        await createConversationOf(owner, {
          storeId: ctx.storeA.id,
          status: ConversationStatus.PENDING
        })
      ).id
      await owner.conversation.updateMany({
        where: { id: { in: [open, pending] } },
        data: { lastMessageAt: old, updatedAt: old }
      })

      await archive.archive()

      expect((await row(open)).status).toBe(ConversationStatus.OPEN)
      expect((await row(pending)).status).toBe(ConversationStatus.PENDING)
    })
  })
})
