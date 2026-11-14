import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'

import { AnalyticsEventNames, AnalyticsMetrics, MetricDimensions } from '@platform/core/analytics'
import { ApiRoutes } from '@platform/core/api'
import { RoleNames } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import { ensureMembership, ensureStore, type OwnerClient } from '@platform/core/database-testing'
import { AuthorType, ConversationStatus, MessageType, OrderStatus } from '@platform/core/domain'
import { ConversationsService } from '@platform/core/messaging'
import { JobNames, rollupJobId } from '@platform/core/queues'

import { AnalyticsEventWriter } from '../../apps/worker/src/analytics/analytics-event.writer'
import {
  AnalyticsRollupService,
  type MetricRow
} from '../../apps/worker/src/analytics/analytics-rollup.service'
import { RollupGranularities } from '../../apps/worker/src/analytics/rollup-periods'
import { AnalyticsRollupScheduler } from '../../apps/worker/src/schedulers/analytics-rollup.scheduler'
import { createConversationOf, createMessage, createOrder } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'
import { CapturedQueue } from '../helpers/queue'

// The rollups of the metrics (TDD_11 §7.2, TDD_08 §6, Step 5.2 PR A), the answer of a person apart from the one of an automation, the
// event key and the route that reads the rollup tables. Every case works in a store of its own.
const HOUR_START = new Date('2026-11-10T09:00:00.000Z')
const HOUR = { start: HOUR_START, end: new Date('2026-11-10T10:00:00.000Z') }
const DAY = {
  start: new Date('2026-11-10T00:00:00.000Z'),
  end: new Date('2026-11-11T00:00:00.000Z')
}
const at = (minutes: number): Date => new Date(HOUR_START.getTime() + minutes * 60_000)

describe('The rollups of analytics', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let prisma: PrismaService
  let rollups: AnalyticsRollupService

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    prisma = app.get(PrismaService, { strict: false })
    rollups = new AnalyticsRollupService(prisma)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  async function aStore() {
    return ensureStore(owner, ctx.orgA.id, `${prefix}-${randomUUID().slice(0, 8)}`)
  }
  // The builders of orders write them as a member of the store
  async function aStoreWithAMember() {
    const store = await aStore()
    await ensureMembership(owner, {
      userId: ctx.adminA.id,
      organizationId: ctx.orgA.id,
      storeId: store.id,
      roleId: ctx.roleIds[RoleNames.ADMIN]
    })
    return store
  }

  // A conversation of the store whose dates are the ones of the case
  async function conversation(
    storeId: string,
    dates: {
      createdAt: Date
      firstResponseAt?: Date
      firstAutomatedResponseAt?: Date
      resolvedAt?: Date
      assignedTo?: string
      status?: ConversationStatus
    }
  ) {
    const row = await createConversationOf(owner, {
      storeId,
      ...(dates.status === undefined ? {} : { status: dates.status }),
      ...(dates.assignedTo === undefined ? {} : { assignedTo: dates.assignedTo })
    })
    await owner.conversation.update({
      where: { id: row.id },
      data: {
        createdAt: dates.createdAt,
        firstResponseAt: dates.firstResponseAt ?? null,
        firstAutomatedResponseAt: dates.firstAutomatedResponseAt ?? null,
        resolvedAt: dates.resolvedAt ?? null
      }
    })
    return row
  }

  const hourlyValue = async (
    storeId: string,
    metric: string,
    dimension: string = MetricDimensions.NONE,
    dimensionId = ''
  ) => {
    const row = await owner.metricHourly.findFirst({
      where: { storeId, hour: HOUR.start, metric, dimension, dimensionId }
    })
    return row === null ? null : { value: Number(row.value), count: row.count }
  }

  describe('the hourly rollup', () => {
    it('counts what happened in the hour, dated by when it happened', async () => {
      const { id: storeId } = await aStore()
      const inside = await conversation(storeId, {
        createdAt: at(10),
        resolvedAt: at(50),
        assignedTo: ctx.adminA.id
      })
      await conversation(storeId, { createdAt: at(-30) }) // the hour before
      await conversation(storeId, { createdAt: at(60) }) // the next hour: the end is out
      await createMessage(owner, {
        storeId,
        conversationId: inside.id,
        authorType: AuthorType.CUSTOMER,
        createdAt: at(11)
      })
      await createMessage(owner, {
        storeId,
        conversationId: inside.id,
        authorType: AuthorType.AGENT,
        createdAt: at(12)
      })
      await createMessage(owner, {
        storeId,
        conversationId: inside.id,
        authorType: AuthorType.AGENT,
        type: MessageType.INTERNAL_NOTE,
        createdAt: at(13)
      })

      await rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR)

      expect(await hourlyValue(storeId, AnalyticsMetrics.CONVERSATIONS_CREATED)).toEqual({
        value: 1,
        count: 1
      })
      expect(await hourlyValue(storeId, AnalyticsMetrics.CONVERSATIONS_RESOLVED)).toEqual({
        value: 1,
        count: 1
      })
      expect(await hourlyValue(storeId, AnalyticsMetrics.MESSAGES_RECEIVED)).toEqual({
        value: 1,
        count: 1
      })
      // The note is not a message to anyone
      expect(await hourlyValue(storeId, AnalyticsMetrics.MESSAGES_SENT)).toEqual({
        value: 1,
        count: 1
      })
      const { channelType } = await owner.conversation.findUniqueOrThrow({
        where: { id: inside.id },
        select: { channelType: true }
      })
      // Of the two conversations of the channel, only the one of the hour
      expect(
        await hourlyValue(
          storeId,
          AnalyticsMetrics.CHANNEL_VOLUME,
          MetricDimensions.CHANNEL,
          channelType
        )
      ).toEqual({ value: 1, count: 1 })
      expect(
        await hourlyValue(
          storeId,
          AnalyticsMetrics.CONVERSATIONS_PER_AGENT,
          MetricDimensions.AGENT,
          ctx.adminA.id
        )
      ).toEqual({ value: 1, count: 1 })
      // 40 minutes from creation to resolution
      expect(await hourlyValue(storeId, AnalyticsMetrics.RESOLUTION_TIME)).toEqual({
        value: 40 * 60,
        count: 1
      })
    })

    it('counts the orders that are not cancelled, with their revenue in dollars', async () => {
      const { id: storeId } = await aStoreWithAMember()
      const kept = await createOrder(owner, { storeId })
      const cancelled = await createOrder(owner, { storeId, status: OrderStatus.CANCELLED })
      const outside = await createOrder(owner, { storeId })
      await owner.order.update({ where: { id: kept.id }, data: { createdAt: at(5) } })
      await owner.order.update({ where: { id: cancelled.id }, data: { createdAt: at(6) } })
      await owner.order.update({ where: { id: outside.id }, data: { createdAt: at(90) } })

      await rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR)

      expect(await hourlyValue(storeId, AnalyticsMetrics.ORDERS_CREATED)).toEqual({
        value: 1,
        count: 1
      })
      expect(await hourlyValue(storeId, AnalyticsMetrics.ORDERS_REVENUE)).toEqual({
        value: 19.99,
        count: 1
      })
    })

    it('writes no row at all for an hour with nothing in it, and clears what an earlier run wrote', async () => {
      const { id: storeId } = await aStore()
      const row = await conversation(storeId, { createdAt: at(10), resolvedAt: at(20) })
      await rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR)
      expect(await owner.metricHourly.count({ where: { storeId } })).toBeGreaterThan(0)

      await owner.conversation.delete({ where: { id: row.id } })
      await rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR)

      // A missing row is zero for the reads, and a median of nothing is not zero. The count of the moment keeps its zero: with no
      // row, a read would carry the last count that has one
      const rows = await owner.metricHourly.findMany({ where: { storeId } })
      expect(rows.map(r => [r.metric, Number(r.value), r.count])).toEqual([
        [AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON, 0, 0]
      ])
    })

    it('never reads or writes the rows of another store', async () => {
      const mine = await aStore()
      const theirs = await aStore()
      await conversation(theirs.id, { createdAt: at(10), firstResponseAt: at(12) })
      // A row of theirs for the same period: rolling mine up replaces mine and leaves theirs as it was
      await owner.metricHourly.create({
        data: {
          storeId: theirs.id,
          hour: HOUR.start,
          metric: AnalyticsMetrics.CONVERSATIONS_CREATED,
          value: 7,
          count: 7
        }
      })

      await rollups.rollup(RollupGranularities.HOURLY, mine.id, HOUR)

      const rows = await owner.metricHourly.findMany({ where: { storeId: mine.id } })
      expect(rows.map(r => r.metric)).toEqual([AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON])
      expect(rows.map(r => r.count)).toEqual([0])
      expect(await hourlyValue(theirs.id, AnalyticsMetrics.CONVERSATIONS_CREATED)).toEqual({
        value: 7,
        count: 7
      })
    })

    it('gives the same rows when it runs again, and drops a row the data no longer supports', async () => {
      const { id: storeId } = await aStore()
      const row = await conversation(storeId, {
        createdAt: at(10),
        resolvedAt: at(20),
        assignedTo: ctx.adminA.id
      })
      await rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR)
      const first = await owner.metricHourly.count({ where: { storeId } })

      await rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR)
      expect(await owner.metricHourly.count({ where: { storeId } })).toBe(first)

      // The conversation was handed to nobody, a late correction: the row of the agent has no support
      await owner.conversation.update({ where: { id: row.id }, data: { assignedTo: null } })
      await rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR)
      expect(
        await hourlyValue(
          storeId,
          AnalyticsMetrics.CONVERSATIONS_PER_AGENT,
          MetricDimensions.AGENT,
          ctx.adminA.id
        )
      ).toBeNull()
    })

    it('does not touch the rows of a metric that another step writes', async () => {
      const { id: storeId } = await aStore()
      await owner.metricHourly.create({
        data: {
          storeId,
          hour: HOUR.start,
          metric: AnalyticsMetrics.CSAT_SCORE,
          value: 4.5,
          count: 2
        }
      })

      await rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR)

      expect(await hourlyValue(storeId, AnalyticsMetrics.CSAT_SCORE)).toEqual({
        value: 4.5,
        count: 2
      })
    })

    it('runs twice at once without writing a row twice', async () => {
      const { id: storeId } = await aStore()
      await conversation(storeId, { createdAt: at(10) })

      await Promise.all([
        rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR),
        rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR)
      ])

      expect(
        await owner.metricHourly.count({
          where: { storeId, metric: AnalyticsMetrics.CHANNEL_VOLUME }
        })
      ).toBe(1)
    })
  })

  describe('the response of a person and of an automation', () => {
    it('reads the first response time from the answers of persons only, and reports automation apart', async () => {
      const { id: storeId } = await aStore()
      // Answered by a person after 10 minutes and by an automation after 1: the time of the team is the 10
      await conversation(storeId, {
        createdAt: at(0),
        firstAutomatedResponseAt: at(1),
        firstResponseAt: at(10)
      })
      // Answered by an automation only: no time for the team at all
      await conversation(storeId, { createdAt: at(5), firstAutomatedResponseAt: at(6) })

      await rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR)

      expect(await hourlyValue(storeId, AnalyticsMetrics.FIRST_RESPONSE_TIME)).toEqual({
        value: 600,
        count: 1
      })
      expect(await hourlyValue(storeId, AnalyticsMetrics.FIRST_AUTOMATED_RESPONSE_TIME)).toEqual({
        value: 60,
        count: 2
      })
    })

    it('dates an answer by when it came: a late one lands in its own hour, which the recompute reaches', async () => {
      const { id: storeId } = await aStore()
      await conversation(storeId, { createdAt: at(30), firstResponseAt: at(90) })

      await rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR)
      expect(await hourlyValue(storeId, AnalyticsMetrics.FIRST_RESPONSE_TIME)).toBeNull()

      await rollups.rollup(RollupGranularities.HOURLY, storeId, {
        start: HOUR.end,
        end: new Date(HOUR.end.getTime() + 3_600_000)
      })
      const next = await owner.metricHourly.findFirstOrThrow({
        where: { storeId, hour: HOUR.end, metric: AnalyticsMetrics.FIRST_RESPONSE_TIME }
      })
      expect(Number(next.value)).toBe(3600)
    })

    it('counts the three states of the conversation by who answered it', async () => {
      const { id: storeId } = await aStore()
      // Waiting for a person: nobody answered, even if an automation did
      await conversation(storeId, { createdAt: at(1) })
      await conversation(storeId, { createdAt: at(2), firstAutomatedResponseAt: at(3) })
      // Answered by a person: not waiting, not answered by automation (the person was first)
      await conversation(storeId, {
        createdAt: at(4),
        firstResponseAt: at(5),
        firstAutomatedResponseAt: at(6)
      })
      // Resolved by automation: answered by it, resolved with no reply of a person
      await conversation(storeId, {
        createdAt: at(7),
        firstAutomatedResponseAt: at(8),
        resolvedAt: at(9),
        status: ConversationStatus.RESOLVED
      })
      // Resolved by a person: answered by them, then resolved
      await conversation(storeId, {
        createdAt: at(10),
        firstResponseAt: at(11),
        resolvedAt: at(12),
        status: ConversationStatus.RESOLVED
      })
      // Spam is nobody's queue
      await conversation(storeId, { createdAt: at(13), status: ConversationStatus.SPAM })
      // Nor is what was archived
      await conversation(storeId, { createdAt: at(14), status: ConversationStatus.ARCHIVED })

      await rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR)

      // The first two, still waiting at the end of the hour; the automation-resolved one is no longer waiting
      expect(await hourlyValue(storeId, AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON)).toEqual({
        value: 2,
        count: 2
      })
      // The two whose first answer was automatic and no person had answered by then
      expect(
        await hourlyValue(storeId, AnalyticsMetrics.CONVERSATIONS_ANSWERED_AUTOMATION)
      ).toEqual({
        value: 2,
        count: 2
      })
      expect(
        await hourlyValue(storeId, AnalyticsMetrics.CONVERSATIONS_RESOLVED_AUTOMATION)
      ).toEqual({
        value: 1,
        count: 1
      })
    })

    it('does not count as waiting a conversation unattended for longer than the lookback', async () => {
      const { id: storeId } = await aStore()
      await conversation(storeId, { createdAt: at(-60 * 24 * 100) }) // 100 days before
      await conversation(storeId, { createdAt: at(-60 * 24 * 10) }) // 10 days before

      await rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR)

      expect(await hourlyValue(storeId, AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON)).toEqual({
        value: 1,
        count: 1
      })
    })

    it('counts as waiting a conversation that a person answered only after the period ended', async () => {
      const { id: storeId } = await aStore()
      await conversation(storeId, { createdAt: at(10), firstResponseAt: at(70) })

      await rollups.rollup(RollupGranularities.HOURLY, storeId, HOUR)

      // At the end of this hour nobody had answered yet: it was waiting then, whatever happens later
      expect(await hourlyValue(storeId, AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON)).toEqual({
        value: 1,
        count: 1
      })
    })
  })

  describe('recordReply', () => {
    let conversations: ConversationsService
    beforeAll(() => {
      conversations = app.get(ConversationsService, { strict: false })
    })

    const reply = (conversationId: string, storeId: string, when: Date, automated?: boolean) =>
      prisma.transaction(tx =>
        conversations.recordReply(
          tx,
          storeId,
          conversationId,
          when,
          automated === undefined ? {} : { automated }
        )
      )

    it('sets the first answer of a person once, and never the automated one', async () => {
      const { id: storeId } = await aStore()
      const { id } = await conversation(storeId, { createdAt: at(0) })

      await reply(id, storeId, at(5))
      await reply(id, storeId, at(9))

      const after = await owner.conversation.findUniqueOrThrow({ where: { id } })
      expect(after.firstResponseAt).toEqual(at(5))
      expect(after.firstAutomatedResponseAt).toBeNull()
    })

    it('sets the first answer of an automation once, and leaves the one of the team empty', async () => {
      const { id: storeId } = await aStore()
      const { id } = await conversation(storeId, { createdAt: at(0) })

      await reply(id, storeId, at(2), true)
      await reply(id, storeId, at(4), true)

      const after = await owner.conversation.findUniqueOrThrow({ where: { id } })
      expect(after.firstAutomatedResponseAt).toEqual(at(2))
      expect(after.firstResponseAt).toBeNull()
    })

    it('keeps the two apart when both answer', async () => {
      const { id: storeId } = await aStore()
      const { id } = await conversation(storeId, { createdAt: at(0) })

      await reply(id, storeId, at(2), true)
      await reply(id, storeId, at(7))

      const after = await owner.conversation.findUniqueOrThrow({ where: { id } })
      expect([after.firstAutomatedResponseAt, after.firstResponseAt]).toEqual([at(2), at(7)])
    })

    it('does not change a conversation of another store', async () => {
      const mine = await aStore()
      const theirs = await aStore()
      const { id } = await conversation(theirs.id, { createdAt: at(0) })

      await reply(id, mine.id, at(2), true)

      const after = await owner.conversation.findUniqueOrThrow({ where: { id } })
      expect(after.firstAutomatedResponseAt).toBeNull()
    })
  })

  describe('the daily rollup', () => {
    it('writes the metrics of a whole UTC day to metrics_daily', async () => {
      const { id: storeId } = await aStore()
      await conversation(storeId, { createdAt: at(10) })
      await conversation(storeId, { createdAt: new Date('2026-11-10T22:00:00.000Z') })
      await conversation(storeId, { createdAt: new Date('2026-11-11T00:00:00.000Z') }) // the next day

      await rollups.rollup(RollupGranularities.DAILY, storeId, DAY)

      const row = await owner.metricDaily.findFirstOrThrow({
        where: { storeId, date: DAY.start, metric: AnalyticsMetrics.CONVERSATIONS_CREATED }
      })
      expect([Number(row.value), row.count]).toEqual([2, 2])
      expect(await owner.metricHourly.count({ where: { storeId } })).toBe(0)
    })
  })

  describe('the event key', () => {
    const baseEvent = (storeId: string, eventKey?: string) => ({
      event: AnalyticsEventNames.EMAIL_ENGAGEMENT,
      storeId,
      data: { type: 'email.opened' },
      timestamp: '2026-11-10T09:15:00.000Z',
      ...(eventKey === undefined ? {} : { eventKey })
    })
    let writer: AnalyticsEventWriter
    beforeAll(() => {
      writer = new AnalyticsEventWriter(prisma)
    })

    it('writes one row for a job delivered twice with the same key', async () => {
      const { id: storeId } = await aStore()

      const first = await writer.write(baseEvent(storeId, 'svix_msg_1'))
      const again = await writer.write(baseEvent(storeId, 'svix_msg_1'))

      expect([first, again]).toEqual([true, false])
      expect(await owner.analyticsEvent.count({ where: { storeId } })).toBe(1)
    })

    it('takes the same key in another store as another event', async () => {
      const one = await aStore()
      const two = await aStore()

      await writer.write(baseEvent(one.id, 'svix_msg_2'))
      await writer.write(baseEvent(two.id, 'svix_msg_2'))

      expect(
        await owner.analyticsEvent.count({ where: { storeId: { in: [one.id, two.id] } } })
      ).toBe(2)
    })

    it('keeps every event that has no key', async () => {
      const { id: storeId } = await aStore()

      await writer.write(baseEvent(storeId))
      await writer.write(baseEvent(storeId))

      expect(await owner.analyticsEvent.count({ where: { storeId } })).toBe(2)
    })
  })

  describe('the schedule', () => {
    const NOW = new Date('2026-11-10T10:05:00.000Z')
    const queue = new CapturedQueue()
    const locks = {
      withLock: async (_name: string, _seconds: number, work: () => Promise<void>) => {
        await work()
        return true
      }
    } as never // the lock is not what is tested here
    const logger = { setContext: () => undefined, error: () => undefined } as unknown as PinoLogger
    let scheduler: AnalyticsRollupScheduler

    beforeAll(() => {
      scheduler = new AnalyticsRollupScheduler(locks, queue as never, prisma, logger)
    })
    beforeEach(() => {
      queue.jobs.length = 0
    })

    it('queues the two latest closed hours of a store, each with an id of its own for the run', async () => {
      const { id: storeId } = await aStore()

      await scheduler.enqueueAll(RollupGranularities.HOURLY, NOW)

      const mine = queue.jobs.filter(job => (job.data as { storeId: string }).storeId === storeId)
      const run = new Date('2026-11-10T10:00:00.000Z')
      expect(mine).toEqual([
        {
          name: JobNames.ROLLUP_HOURLY,
          data: {
            storeId,
            periodStart: '2026-11-10T09:00:00.000Z',
            periodEnd: '2026-11-10T10:00:00.000Z'
          },
          opts: {
            jobId: rollupJobId(
              JobNames.ROLLUP_HOURLY,
              storeId,
              new Date('2026-11-10T09:00:00.000Z'),
              run
            )
          }
        },
        {
          name: JobNames.ROLLUP_HOURLY,
          data: {
            storeId,
            periodStart: '2026-11-10T08:00:00.000Z',
            periodEnd: '2026-11-10T09:00:00.000Z'
          },
          opts: {
            jobId: rollupJobId(
              JobNames.ROLLUP_HOURLY,
              storeId,
              new Date('2026-11-10T08:00:00.000Z'),
              run
            )
          }
        }
      ])
    })

    it('gives the same hour another id in the next run, so that the late webhook is recomputed', async () => {
      const { id: storeId } = await aStore()

      await scheduler.enqueueAll(RollupGranularities.HOURLY, NOW)
      await scheduler.enqueueAll(RollupGranularities.HOURLY, new Date(NOW.getTime() + 3_600_000))

      const ids = queue.jobs
        .filter(job => (job.data as { storeId: string }).storeId === storeId)
        .filter(
          job => (job.data as { periodStart: string }).periodStart === '2026-11-10T09:00:00.000Z'
        )
        .map(job => job.opts?.jobId)
      expect(new Set(ids).size).toBe(2)
    })

    it('queues the two latest closed days under the daily name', async () => {
      const { id: storeId } = await aStore()

      await scheduler.enqueueAll(RollupGranularities.DAILY, new Date('2026-11-10T00:15:00.000Z'))

      const periods = queue.jobs
        .filter(job => (job.data as { storeId: string }).storeId === storeId)
        .map(job => [job.name, (job.data as { periodStart: string }).periodStart])
      expect(periods).toEqual([
        [JobNames.ROLLUP_DAILY, '2026-11-09T00:00:00.000Z'],
        [JobNames.ROLLUP_DAILY, '2026-11-08T00:00:00.000Z']
      ])
    })

    it('goes through every page of stores', async () => {
      const first = await aStore()
      const second = await aStore()

      await scheduler.enqueueAll(RollupGranularities.HOURLY, NOW, { pageSize: 1 })

      const stores = new Set(queue.jobs.map(job => (job.data as { storeId: string }).storeId))
      expect(stores.has(first.id) && stores.has(second.id)).toBe(true)
    })
  })

  describe('GET /analytics/metrics', () => {
    async function seededStore() {
      const store = await aStore()
      // Two days of a count, two of a time and one of a count of the moment, written the way the rollup writes them
      const rows: MetricRow[] = [
        row(AnalyticsMetrics.CONVERSATIONS_CREATED, 3, 3),
        row(AnalyticsMetrics.FIRST_RESPONSE_TIME, 60, 10),
        row(AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON, 7, 7),
        row(AnalyticsMetrics.CHANNEL_VOLUME, 2, 2, MetricDimensions.CHANNEL, 'channel-a')
      ]
      const later: MetricRow[] = [
        row(AnalyticsMetrics.CONVERSATIONS_CREATED, 5, 5),
        row(AnalyticsMetrics.FIRST_RESPONSE_TIME, 120, 30),
        row(AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON, 4, 4)
      ]
      await owner.metricDaily.createMany({
        data: [
          ...rows.map(r => ({ storeId: store.id, date: new Date('2026-11-09'), ...r })),
          ...later.map(r => ({ storeId: store.id, date: new Date('2026-11-10'), ...r }))
        ]
      })
      return store
    }
    const row = (
      metric: string,
      value: number,
      count: number,
      dimension: string = MetricDimensions.NONE,
      dimensionId = ''
    ): MetricRow => ({ metric, value, count, dimension, dimensionId }) as MetricRow
    const query = (metric: string, extra: Record<string, string> = {}) => ({
      metric,
      from: '2026-11-09T00:00:00.000Z',
      to: '2026-11-11T00:00:00.000Z',
      granularity: 'day',
      ...extra
    })

    // The store of the header must be one the user belongs to: the rows are written in store A, which the suite has
    it('puts a count together by adding, a time weighted by its conversations, and a count of the moment by its last point', async () => {
      await owner.metricDaily.deleteMany({ where: { storeId: ctx.storeA.id } })
      await owner.metricDaily.createMany({
        data: [
          {
            storeId: ctx.storeA.id,
            date: new Date('2026-11-09'),
            metric: AnalyticsMetrics.CONVERSATIONS_CREATED,
            value: 3,
            count: 3
          },
          {
            storeId: ctx.storeA.id,
            date: new Date('2026-11-10'),
            metric: AnalyticsMetrics.CONVERSATIONS_CREATED,
            value: 5,
            count: 5
          },
          {
            storeId: ctx.storeA.id,
            date: new Date('2026-11-09'),
            metric: AnalyticsMetrics.FIRST_RESPONSE_TIME,
            value: 60,
            count: 10
          },
          {
            storeId: ctx.storeA.id,
            date: new Date('2026-11-10'),
            metric: AnalyticsMetrics.FIRST_RESPONSE_TIME,
            value: 120,
            count: 30
          },
          {
            storeId: ctx.storeA.id,
            date: new Date('2026-11-09'),
            metric: AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON,
            value: 7,
            count: 7
          },
          {
            storeId: ctx.storeA.id,
            date: new Date('2026-11-10'),
            metric: AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON,
            value: 4,
            count: 4
          }
        ]
      })
      const agent = api(app, ctx.viewerA, ctx.storeA)

      const sum = await agent
        .get(ApiRoutes.analytics.metrics)
        .query(query(AnalyticsMetrics.CONVERSATIONS_CREATED, { granularity: 'week' }))
      const mean = await agent
        .get(ApiRoutes.analytics.metrics)
        .query(query(AnalyticsMetrics.FIRST_RESPONSE_TIME))
      const last = await agent
        .get(ApiRoutes.analytics.metrics)
        .query(query(AnalyticsMetrics.CONVERSATIONS_WAITING_PERSON, { granularity: 'week' }))

      type Body = {
        series: { points: { value: number }[]; summary: { value: number; count: number } }[]
      }
      expect(sum.status).toBe(200)
      expect((sum.body as Body).series[0]?.summary).toEqual({ value: 8, count: 8 })
      expect((mean.body as Body).series[0]?.points.map(point => point.value)).toEqual([60, 120])
      // (60 * 10 + 120 * 30) / 40
      expect((mean.body as Body).series[0]?.summary).toEqual({ value: 105, count: 40 })
      expect((last.body as Body).series[0]?.summary).toEqual({ value: 4, count: 4 })
    })

    it('returns the breakdown by dimension of a metric that has one', async () => {
      await owner.metricDaily.deleteMany({ where: { storeId: ctx.storeA.id } })
      await owner.metricDaily.createMany({
        data: ['a', 'b'].map((id, index) => ({
          storeId: ctx.storeA.id,
          date: new Date('2026-11-09'),
          metric: AnalyticsMetrics.CHANNEL_VOLUME,
          dimension: MetricDimensions.CHANNEL,
          dimensionId: id,
          value: index + 1,
          count: index + 1
        }))
      })

      const response = await api(app, ctx.viewerA, ctx.storeA)
        .get(ApiRoutes.analytics.metrics)
        .query(query(AnalyticsMetrics.CHANNEL_VOLUME, { dimension: MetricDimensions.CHANNEL }))

      expect(response.status).toBe(200)
      expect(
        (response.body as { series: { dimensionId: string }[] }).series.map(s => s.dimensionId)
      ).toEqual(['a', 'b'])
    })

    it('reads a week or a month from its first day, never a part of one under the label of the whole', async () => {
      await owner.metricDaily.deleteMany({ where: { storeId: ctx.storeA.id } })
      // 2026-11-09 is a Monday: the days of that week, one conversation each
      await owner.metricDaily.createMany({
        data: ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12'].map(day => ({
          storeId: ctx.storeA.id,
          date: new Date(day),
          metric: AnalyticsMetrics.CONVERSATIONS_CREATED,
          value: 1,
          count: 1
        }))
      })

      // From a Wednesday: the bucket is the Monday's and holds the four days of the week
      const response = await api(app, ctx.viewerA, ctx.storeA)
        .get(ApiRoutes.analytics.metrics)
        .query(
          query(AnalyticsMetrics.CONVERSATIONS_CREATED, {
            granularity: 'week',
            from: '2026-11-11T00:00:00.000Z',
            to: '2026-11-16T00:00:00.000Z'
          })
        )

      const body = response.body as {
        aggregation: string
        from: string
        series: { points: { timestamp: string; value: number }[] }[]
      }
      expect(response.status).toBe(200)
      expect(body.from).toBe('2026-11-09T00:00:00.000Z')
      expect(body.series[0]?.points).toEqual([
        { timestamp: '2026-11-09T00:00:00.000Z', value: 4, count: 4 }
      ])
      expect(body.aggregation).toBe('sum')
    })

    it('reads a range inside one day as that day', async () => {
      await owner.metricDaily.deleteMany({ where: { storeId: ctx.storeA.id } })
      await owner.metricDaily.create({
        data: {
          storeId: ctx.storeA.id,
          date: new Date('2026-11-12'),
          metric: AnalyticsMetrics.CONVERSATIONS_CREATED,
          value: 2,
          count: 2
        }
      })

      const response = await api(app, ctx.viewerA, ctx.storeA)
        .get(ApiRoutes.analytics.metrics)
        .query(
          query(AnalyticsMetrics.CONVERSATIONS_CREATED, {
            from: '2026-11-12T10:00:00.000Z',
            to: '2026-11-12T20:00:00.000Z'
          })
        )

      expect(response.status).toBe(200)
      expect(
        (response.body as { series: { summary: { value: number } }[] }).series[0]?.summary.value
      ).toBe(2)
    })

    it('reads from the hourly table for an hour', async () => {
      await owner.metricHourly.deleteMany({ where: { storeId: ctx.storeA.id } })
      await owner.metricHourly.create({
        data: {
          storeId: ctx.storeA.id,
          hour: HOUR.start,
          metric: AnalyticsMetrics.MESSAGES_SENT,
          value: 9,
          count: 9
        }
      })

      const response = await api(app, ctx.viewerA, ctx.storeA)
        .get(ApiRoutes.analytics.metrics)
        .query({
          metric: AnalyticsMetrics.MESSAGES_SENT,
          granularity: 'hour',
          from: '2026-11-10T00:00:00.000Z',
          to: '2026-11-11T00:00:00.000Z'
        })

      expect(response.status).toBe(200)
      expect(
        (response.body as { series: { points: { timestamp: string; value: number }[] }[] })
          .series[0]?.points
      ).toEqual([{ timestamp: '2026-11-10T09:00:00.000Z', value: 9, count: 9 }])
    })

    it('shows the rows of the store of the header and no other, even when the query names one', async () => {
      const other = await seededStore()
      await owner.metricDaily.deleteMany({ where: { storeId: ctx.storeA.id } })

      const own = await api(app, ctx.viewerA, ctx.storeA)
        .get(ApiRoutes.analytics.metrics)
        .query(query(AnalyticsMetrics.CONVERSATIONS_CREATED))
      const naming = await api(app, ctx.viewerA, ctx.storeA)
        .get(ApiRoutes.analytics.metrics)
        .query(query(AnalyticsMetrics.CONVERSATIONS_CREATED, { storeId: other.id }))

      expect((own.body as { series: unknown[] }).series).toEqual([])
      expect(naming.status).toBe(400)
    })

    it.each([
      ['a metric that no rollup writes', { metric: AnalyticsMetrics.CSAT_SCORE }],
      ['a made-up metric', { metric: 'made.up' }],
      [
        'a range that ends before it starts',
        { from: '2026-11-11T00:00:00.000Z', to: '2026-11-09T00:00:00.000Z' }
      ],
      [
        'a range of hours longer than the table keeps in a page',
        { granularity: 'hour', from: '2026-01-01T00:00:00.000Z', to: '2026-03-01T00:00:00.000Z' }
      ],
      ['a breakdown the metric does not have', { dimension: MetricDimensions.AGENT }],
      [
        'a metric that is read by its breakdown, without it',
        { metric: AnalyticsMetrics.CHANNEL_VOLUME }
      ],
      [
        'a date that SQL cannot read',
        { from: '9999-12-31T00:00:00.000Z', to: '9999-12-31T12:00:00.000Z' }
      ],
      ['a granularity that does not exist', { granularity: 'minute' }],
      ['a date with no time', { from: '2026-11-09' }]
    ])('refuses %s', async (_label, extra) => {
      const response = await api(app, ctx.viewerA, ctx.storeA)
        .get(ApiRoutes.analytics.metrics)
        .query(query(AnalyticsMetrics.CONVERSATIONS_CREATED, extra))

      expect(response.status).toBe(400)
    })

    it('is for who may view analytics: an agent has no such permission', async () => {
      const response = await api(app, ctx.agentA, ctx.storeA)
        .get(ApiRoutes.analytics.metrics)
        .query(query(AnalyticsMetrics.CONVERSATIONS_CREATED))

      expect(response.status).toBe(403)
    })
  })
})
