import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import { UnrecoverableError } from 'bullmq'
import { strFromU8, unzipSync } from 'fflate'
import type { PinoLogger } from 'nestjs-pino'

import {
  AnalyticsMetrics,
  ReportDisableReasons,
  ReportFrequency,
  ReportLimits
} from '@platform/core/analytics'
import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { JobContext, WorkerLists } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'
import { ExportStatus, ExportTypes, JobNames, QueueNames } from '@platform/core/queues'
import { StorageService } from '@platform/core/storage-module'

import { AnalyticsRollupService } from '../../apps/worker/src/analytics/analytics-rollup.service'
import { RollupGranularities } from '../../apps/worker/src/analytics/rollup-periods'
import { AnalyticsExportWriter } from '../../apps/worker/src/exports/analytics/analytics-export.writer'
import { ScheduledReportRunner } from '../../apps/worker/src/exports/analytics/scheduled-report.runner'
import { CsvExportWriter } from '../../apps/worker/src/exports/csv-export-writer'
import { ExportGenerator } from '../../apps/worker/src/exports/export-generator.service'
import { ZipExportWriter } from '../../apps/worker/src/exports/zip-export-writer'
import { ReportDispatchScheduler } from '../../apps/worker/src/schedulers/report-dispatch.scheduler'
import { createOrder, createRole } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type CapturedEmails, emailsOf } from '../helpers/email'
import { api } from '../helpers/http'
import { type CapturedQueue, queueOf } from '../helpers/queue'
import { createWorkerPrisma, createGuardedWorkerPrisma } from '../helpers/worker-db'
import { workerServices } from '../helpers/worker-services'

interface ErrorBody {
  error: { code: string }
}
interface ReportBody {
  id: string
  name: string
  enabled: boolean
  recipients: string[]
  lastSentAt: string | null
}
interface ExportBody {
  id: string
  type: string
  status: string
}

const OK = 200
const CREATED = 201
const ACCEPTED = 202
const NO_CONTENT = 204
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409
const MAX_FILE = 5_000_000
const HOUR = 3_600_000

// Scheduled reports and the export of the analytics (Step 5.2 PR C): the routes, the file that the worker makes from the rollup
// tables, and the run of one report (the file, an email for each address, the person who may still send it).
describe('Analytics reports and export', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let storage: StorageService
  let generator: ExportGenerator
  let runner: ScheduledReportRunner
  let emails: CapturedEmails
  const keys: string[] = []

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    const prisma = createWorkerPrisma()
    storage = app.get(StorageService, { strict: false })
    const logger = {
      setContext: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn()
    } as unknown as PinoLogger
    const csv = new CsvExportWriter(storage)
    const { events, audit } = await workerServices(app, prisma)
    const subjectMissing = { inc: jest.fn() } as unknown as Counter<string>
    generator = new ExportGenerator(
      prisma,
      csv,
      new ZipExportWriter(storage, logger),
      new AnalyticsExportWriter(prisma, storage, csv, new JobContext(prisma)),
      storage,
      audit,
      events,
      logger,
      new JobContext(prisma),
      subjectMissing
    )
    emails = emailsOf(app)
    runner = new ScheduledReportRunner(
      prisma,
      generator,
      storage,
      audit,
      emails as never,
      logger,
      new JobContext(prisma),
      subjectMissing
    )
  })
  afterAll(async () => {
    for (const key of keys) await storage.delete(key)
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  afterEach(async () => {
    await owner.scheduledReport.deleteMany({
      where: { storeId: { in: [ctx.storeA.id, ctx.storeB.id] } }
    })
    await owner.export.updateMany({
      where: { storeId: { in: [ctx.storeA.id, ctx.storeB.id] }, status: ExportStatus.PENDING },
      data: { status: ExportStatus.FAILED }
    })
    emails.clear()
    await owner.metricDaily.deleteMany({
      where: { storeId: { in: [ctx.storeA.id, ctx.storeB.id] } }
    })
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)

  const body = (overrides: Record<string, unknown> = {}) => ({
    name: 'Weekly summary',
    metrics: [AnalyticsMetrics.ORDERS_CREATED, AnalyticsMetrics.ORDERS_REVENUE],
    frequency: ReportFrequency.WEEKLY,
    format: 'csv',
    recipients: ['owner@example.com'],
    timezone: 'America/El_Salvador',
    ...overrides
  })

  async function createReport(overrides: Record<string, unknown> = {}): Promise<ReportBody> {
    const response = await asAdmin().post(ApiRoutes.analytics.reports).send(body(overrides))
    expect(response.status).toBe(CREATED)
    return response.body as ReportBody
  }

  // A row of the rollup of a store for a calendar day
  const day = (storeId: string, date: string, metric: string, value: number, count = 1) =>
    owner.metricDaily.create({
      data: { storeId, date: new Date(`${date}T00:00:00.000Z`), metric, value, count }
    })

  async function fileOf(exportId: string): Promise<{ text: string; bytes: Buffer }> {
    await generator.generate(ctx.storeA.id, exportId, false)
    const row = await owner.export.findUniqueOrThrow({ where: { id: exportId } })
    expect(row.status).toBe(ExportStatus.READY)
    keys.push(row.key ?? '')
    const bytes = (await storage.read(row.key ?? '', MAX_FILE)) ?? Buffer.alloc(0)
    return { text: bytes.toString('utf8'), bytes }
  }

  describe('the routes of the reports', () => {
    it('needs the three permissions to make one, and the right to manage to list or delete', async () => {
      const viewOnly = await createRole(owner, {
        storeId: ctx.storeA.id,
        permissions: [Permissions.ANALYTICS_VIEW]
      })
      const noExport = await createRole(owner, {
        storeId: ctx.storeA.id,
        permissions: [Permissions.ANALYTICS_VIEW, Permissions.ANALYTICS_MANAGE_REPORTS]
      })
      const asViewer = await createActor(owner, app, {
        prefix,
        name: `viewer-${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: viewOnly.id
      })
      const asManager = await createActor(owner, app, {
        prefix,
        name: `manager-${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: noExport.id
      })
      const viewer = api(app, asViewer, ctx.storeA)
      expect((await viewer.get(ApiRoutes.analytics.reports)).status).toBe(FORBIDDEN)
      expect((await viewer.post(ApiRoutes.analytics.reports).send(body())).status).toBe(FORBIDDEN)
      const manager = api(app, asManager, ctx.storeA)
      expect((await manager.get(ApiRoutes.analytics.reports)).status).toBe(OK)
      // A report sends the figures out: whoever saves one holds the right to take them out
      expect((await manager.post(ApiRoutes.analytics.reports).send(body())).status).toBe(FORBIDDEN)
      expect((await api(app, ctx.agentA, ctx.storeA).get(ApiRoutes.analytics.reports)).status).toBe(
        FORBIDDEN
      )
    })

    it('makes a report in the store of the request, as the person who asked, and lists it', async () => {
      const created = await createReport()
      const row = await owner.scheduledReport.findUniqueOrThrow({ where: { id: created.id } })
      expect(row.storeId).toBe(ctx.storeA.id)
      expect(row.createdBy).toBe(ctx.adminA.id)
      expect(row.sendAtHour).toBe(ReportLimits.DEFAULT_SEND_AT_HOUR)
      const list = await asAdmin().get(ApiRoutes.analytics.reports)
      expect((list.body as ReportBody[]).map(report => report.id)).toEqual([created.id])
      // The other store sees none
      const other = await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.analytics.reports)
      expect(other.body).toEqual([])
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.REPORT_CREATED,
        resourceId: created.id
      })
      expect(entries).toHaveLength(1)
      // The addresses are not in the log: how many there are is
      expect(JSON.stringify(entries[0]?.metadata)).not.toContain('owner@example.com')
    })

    it.each([
      ['a store in the body', { storeId: randomUUID() }],
      ['the person in the body', { createdBy: randomUUID() }],
      ['no metrics', { metrics: [] }],
      ['a metric that has a breakdown', { metrics: [AnalyticsMetrics.CHANNEL_VOLUME] }],
      ['an address that is not one', { recipients: ['nope'] }],
      ['eleven addresses', { recipients: Array.from({ length: 11 }, (_, i) => `a${i}@b.co`) }],
      ['a time zone that does not exist', { timezone: 'Mars/Olympus' }],
      ['a name with a line break', { name: 'a\r\nBcc: x@y.z' }]
    ])('refuses %s', async (_label, overrides) => {
      const response = await asAdmin().post(ApiRoutes.analytics.reports).send(body(overrides))
      expect(response.status).toBe(BAD_REQUEST)
      expect(await owner.scheduledReport.count({ where: { storeId: ctx.storeA.id } })).toBe(0)
    })

    it('stops at the most reports a store may have, counted under the store lock', async () => {
      await owner.scheduledReport.createMany({
        data: Array.from({ length: ReportLimits.MAX_PER_STORE }, (_, i) => ({
          storeId: ctx.storeA.id,
          name: `r${i}`,
          metrics: [AnalyticsMetrics.ORDERS_CREATED],
          frequency: ReportFrequency.DAILY,
          format: 'csv',
          recipients: ['a@b.co'],
          createdBy: ctx.adminA.id
        }))
      })
      const response = await asAdmin().post(ApiRoutes.analytics.reports).send(body())
      expect(response.status).toBe(CONFLICT)
      expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.REPORT_LIMIT_REACHED)
    })

    it('changes only what the change names, makes the report the one of whoever saved it, and 404s on another store', async () => {
      const created = await createReport({ sendAtHour: 17 })
      const renamed = await asAdmin()
        .patch(ApiRoutes.analytics.reportById(created.id))
        .send({ name: 'Renamed' })
      expect(renamed.status).toBe(OK)
      const row = await owner.scheduledReport.findUniqueOrThrow({ where: { id: created.id } })
      expect(row.name).toBe('Renamed')
      // The hour was 17 and stays so: a change does not put the defaults back
      expect(row.sendAtHour).toBe(17)
      expect(
        (await asAdmin().patch(ApiRoutes.analytics.reportById(created.id)).send({})).status
      ).toBe(BAD_REQUEST)
      const stranger = api(app, ctx.adminB, ctx.storeB)
      expect(
        (await stranger.patch(ApiRoutes.analytics.reportById(created.id)).send({ name: 'x' }))
          .status
      ).toBe(NOT_FOUND)
      expect((await stranger.delete(ApiRoutes.analytics.reportById(created.id))).status).toBe(
        NOT_FOUND
      )
      expect(
        (await owner.scheduledReport.findUniqueOrThrow({ where: { id: created.id } })).name
      ).toBe('Renamed')
    })

    it('deletes a report', async () => {
      const created = await createReport()
      expect((await asAdmin().delete(ApiRoutes.analytics.reportById(created.id))).status).toBe(
        NO_CONTENT
      )
      expect(await owner.scheduledReport.count({ where: { id: created.id } })).toBe(0)
    })
  })

  describe('the export of the analytics', () => {
    const query = (extra = '') =>
      `${ApiRoutes.analytics.export}?metrics=${AnalyticsMetrics.ORDERS_CREATED},${AnalyticsMetrics.ORDERS_REVENUE}&from=2026-11-01&to=2026-11-04&format=csv${extra}`

    it('needs analytics:view and analytics:export together', async () => {
      const exportOnly = await createRole(owner, {
        storeId: ctx.storeA.id,
        permissions: [Permissions.ANALYTICS_EXPORT]
      })
      const member = await createActor(owner, app, {
        prefix,
        name: `export-${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: exportOnly.id
      })
      expect((await api(app, member, ctx.storeA).get(query())).status).toBe(FORBIDDEN)
      expect((await api(app, ctx.agentA, ctx.storeA).get(query())).status).toBe(FORBIDDEN)
    })

    it('queues the file in the store of the request, and the exports center lists it', async () => {
      const response = await asAdmin().get(query())
      expect(response.status).toBe(ACCEPTED)
      const made = response.body as ExportBody
      expect(made.type).toBe(ExportTypes.ANALYTICS)
      const row = await owner.export.findUniqueOrThrow({ where: { id: made.id } })
      expect(row.storeId).toBe(ctx.storeA.id)
      expect(row.requestedBy).toBe(ctx.adminA.id)
      const list = await asAdmin().get(ApiRoutes.exports.list)
      expect((list.body as { data: ExportBody[] }).data.map(entry => entry.id)).toContain(made.id)
    })

    it.each([
      ['a period that ends before it starts', '&to=2026-10-01'],
      ['a day that is not a day', '&from=2026-02-30'],
      ['a metric of a breakdown', `&metrics=${AnalyticsMetrics.CHANNEL_VOLUME}`],
      ['a field it does not know', '&storeId=x'],
      ['a format it does not make', '&format=zip']
    ])('refuses %s', async (_label, extra) => {
      // The later value of a repeated parameter is the one the server reads
      const url = `${ApiRoutes.analytics.export}?metrics=${AnalyticsMetrics.ORDERS_CREATED}&from=2026-11-01&to=2026-11-04&format=csv${extra}`
      const response = await asAdmin().get(url)
      expect(response.status).toBe(BAD_REQUEST)
    })

    it('writes the days of the period with their totals, from the rollup of its own store only', async () => {
      await day(ctx.storeA.id, '2026-11-01', AnalyticsMetrics.ORDERS_CREATED, 3)
      await day(ctx.storeA.id, '2026-11-03', AnalyticsMetrics.ORDERS_CREATED, 2)
      // The rollup keeps money in whole units of the currency (dollars), as the dashboard reads it
      await day(ctx.storeA.id, '2026-11-03', AnalyticsMetrics.ORDERS_REVENUE, 123.45)
      // Another store's figures, and a day outside the period, never enter the file
      await day(ctx.storeB.id, '2026-11-01', AnalyticsMetrics.ORDERS_CREATED, 999)
      await day(ctx.storeA.id, '2026-11-04', AnalyticsMetrics.ORDERS_CREATED, 777)
      const made = (await asAdmin().get(query())).body as ExportBody
      const { text } = await fileOf(made.id)
      const lines = text.replace('﻿', '').split('\r\n').filter(Boolean)
      expect(lines).toHaveLength(1 + 3 + 1)
      // Money always has its two decimals (R2-ANA-006), a day with no sales included
      expect(lines[1]).toBe('2026-11-01,3,0.00')
      expect(lines[2]).toBe('2026-11-02,0,0.00')
      expect(lines[3]).toBe('2026-11-03,2,123.45')
      expect(lines[4]).toMatch(/,5,123\.45$/)
      expect(text).not.toContain('999')
      expect(text).not.toContain('777')
    })

    it('makes a spreadsheet and a document that open, and never a formula from a name', async () => {
      await day(ctx.storeA.id, '2026-11-01', AnalyticsMetrics.ORDERS_CREATED, 3)
      const filters = {
        metrics: [AnalyticsMetrics.ORDERS_CREATED],
        from: '2026-11-01',
        to: '2026-11-04',
        reportName: '=HYPERLINK("http://evil.example","click")'
      }
      for (const format of ['excel', 'pdf'] as const) {
        const row = await owner.export.create({
          data: {
            storeId: ctx.storeA.id,
            requestedBy: ctx.adminA.id,
            type: ExportTypes.ANALYTICS,
            format,
            filters,
            status: ExportStatus.PENDING,
            expiresAt: new Date(Date.now() + 24 * HOUR)
          }
        })
        const { bytes } = await fileOf(row.id)
        if (format === 'pdf') {
          expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
        } else {
          // A zip: the signature of its first entry
          expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
          expect(bytes.includes('<f>')).toBe(false)
        }
      }
    })

    it('fails a row whose filters do not fit, and makes nothing', async () => {
      const row = await owner.export.create({
        data: {
          storeId: ctx.storeA.id,
          requestedBy: ctx.adminA.id,
          type: ExportTypes.ANALYTICS,
          format: 'csv',
          filters: { metrics: ['not.a.metric'], from: '2026-11-01', to: '2026-11-04' },
          status: ExportStatus.PENDING,
          expiresAt: new Date(Date.now() + 24 * HOUR)
        }
      })
      await expect(generator.generate(ctx.storeA.id, row.id, false)).rejects.toBeInstanceOf(
        UnrecoverableError
      )
      expect((await owner.export.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
        ExportStatus.FAILED
      )
    })
  })

  describe('the dispatch', () => {
    function scheduler(queue: CapturedQueue): ReportDispatchScheduler {
      return new ReportDispatchScheduler(
        {} as never,
        queue as never,
        createGuardedWorkerPrisma(),
        {
          setContext: jest.fn(),
          info: jest.fn(),
          error: jest.fn()
        } as unknown as PinoLogger,
        new JobContext(createGuardedWorkerPrisma()),
        new WorkerLists(createGuardedWorkerPrisma())
      )
    }

    async function make(data: Record<string, unknown>) {
      return owner.scheduledReport.create({
        data: {
          storeId: ctx.storeA.id,
          name: 'r',
          metrics: [AnalyticsMetrics.ORDERS_CREATED],
          frequency: ReportFrequency.DAILY,
          format: 'csv',
          recipients: ['a@b.co'],
          createdBy: ctx.adminA.id,
          timezone: 'UTC',
          sendAtHour: 8,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...data
        }
      })
    }

    it('queues the reports whose own clock reads their hour, one job for each report and day', async () => {
      const due = await make({})
      await make({ sendAtHour: 9 }) // not yet its hour
      await make({ enabled: false })
      await make({
        frequency: ReportFrequency.WEEKLY,
        lastSentAt: new Date('2026-11-09T09:00:00.000Z')
      }) // 2026-11-10 is a Tuesday: Monday was made
      await make({ timezone: 'America/El_Salvador' }) // 08:00 UTC is 02:00 there
      const queue = new (queueOf(app, QueueNames.EXPORTS).constructor as new () => CapturedQueue)()
      const queued = await scheduler(queue).dispatch(new Date('2026-11-10T08:00:00.000Z'))
      expect(queued).toBe(1)
      expect(queue.jobs).toEqual([
        {
          name: JobNames.GENERATE_SCHEDULED_REPORT,
          data: { reportId: due.id, day: '2026-11-10', storeId: ctx.storeA.id },
          opts: { jobId: `${JobNames.GENERATE_SCHEDULED_REPORT}-${due.id}-2026-11-10` }
        }
      ])
    })

    it('makes up for a missed tick, once, and one bad zone does not stop the others', async () => {
      const late = await make({ sendAtHour: 6 }) // its hour passed two hours ago
      await make({ sendAtHour: 6, lastSentAt: new Date('2026-11-10T06:30:00.000Z') }) // already made today
      await make({ timezone: 'Mars/Olympus', sendAtHour: 0 })
      const queue = new (queueOf(app, QueueNames.EXPORTS).constructor as new () => CapturedQueue)()
      const queued = await scheduler(queue).dispatch(new Date('2026-11-10T08:00:00.000Z'))
      expect(queued).toBe(1)
      expect((queue.jobs[0]?.data as { reportId: string }).reportId).toBe(late.id)
    })

    it('queues a weekly report on Monday and a monthly one on the first, in their own zone', async () => {
      const weekly = await make({
        frequency: ReportFrequency.WEEKLY,
        timezone: 'America/El_Salvador',
        sendAtHour: 2
      })
      const monthly = await make({
        frequency: ReportFrequency.MONTHLY,
        timezone: 'UTC',
        lastSentAt: new Date('2026-11-01T08:00:00.000Z')
      })
      const queue = new (queueOf(app, QueueNames.EXPORTS).constructor as new () => CapturedQueue)()
      // Monday 2026-11-09 08:00 UTC is 02:00 in El Salvador
      await scheduler(queue).dispatch(new Date('2026-11-09T08:00:00.000Z'))
      expect(queue.jobs.map(job => (job.data as { reportId: string }).reportId)).toEqual([
        weekly.id
      ])
      const queue2 = new (queueOf(app, QueueNames.EXPORTS).constructor as new () => CapturedQueue)()
      await scheduler(queue2).dispatch(new Date('2026-12-01T08:00:00.000Z'))
      expect(queue2.jobs.map(job => (job.data as { reportId: string }).reportId)).toContain(
        monthly.id
      )
    })
  })

  describe('the dispatch of a day that is not whole yet, or that was missed', () => {
    function scheduler(queue: CapturedQueue): ReportDispatchScheduler {
      return new ReportDispatchScheduler(
        {} as never,
        queue as never,
        createGuardedWorkerPrisma(),
        {
          setContext: jest.fn(),
          info: jest.fn(),
          error: jest.fn()
        } as unknown as PinoLogger,
        new JobContext(createGuardedWorkerPrisma()),
        new WorkerLists(createGuardedWorkerPrisma())
      )
    }
    const freshQueue = () =>
      new (queueOf(app, QueueNames.EXPORTS).constructor as new () => CapturedQueue)()

    async function make(data: Record<string, unknown>) {
      return owner.scheduledReport.create({
        data: {
          storeId: ctx.storeA.id,
          name: 'r',
          metrics: [AnalyticsMetrics.ORDERS_CREATED],
          frequency: ReportFrequency.DAILY,
          format: 'csv',
          recipients: ['a@b.co'],
          createdBy: ctx.adminA.id,
          timezone: 'UTC',
          sendAtHour: 8,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...data
        }
      })
    }
    const daysOf = (queue: CapturedQueue) =>
      queue.jobs.map(job => (job.data as { reportId: string; day: string }).day)

    it('does not send a day that is still running in UTC: Auckland at hour 0 waits for the rollup of the day it reports', async () => {
      const report = await make({ timezone: 'Pacific/Auckland', sendAtHour: 0 })
      // 2026-11-15T11:00Z is 2026-11-16 00:00 in Auckland, but the UTC day of the 15th ends 13 hours later
      const early = freshQueue()
      expect(await scheduler(early).dispatch(new Date('2026-11-15T11:00:00.000Z'))).toBe(0)
      const justClosed = freshQueue()
      expect(await scheduler(justClosed).dispatch(new Date('2026-11-16T00:05:00.000Z'))).toBe(0)
      const ready = freshQueue()
      expect(await scheduler(ready).dispatch(new Date('2026-11-16T01:00:00.000Z'))).toBe(1)
      expect(ready.jobs[0]?.data).toEqual({
        reportId: report.id,
        day: '2026-11-16',
        storeId: ctx.storeA.id
      })
    })

    it('does not send at 00:05 UTC, before the rollup of 00:15, and sends from the hour after', async () => {
      await make({ sendAtHour: 0 })
      const early = freshQueue()
      expect(await scheduler(early).dispatch(new Date('2026-11-16T00:05:00.000Z'))).toBe(0)
      const ready = freshQueue()
      expect(await scheduler(ready).dispatch(new Date('2026-11-16T01:00:00.000Z'))).toBe(1)
    })

    it('makes up a weekly report when the worker was down all Monday, and only once', async () => {
      const report = await make({ frequency: ReportFrequency.WEEKLY })
      // Tuesday 2026-11-10: Monday the 9th was lost
      const tuesday = freshQueue()
      expect(await scheduler(tuesday).dispatch(new Date('2026-11-10T08:00:00.000Z'))).toBe(1)
      // the week it covers is the one of Monday the 9th, not the one of Tuesday
      expect(tuesday.jobs[0]?.data).toEqual({
        reportId: report.id,
        day: '2026-11-09',
        storeId: ctx.storeA.id
      })
      await owner.scheduledReport.update({
        where: { id: report.id },
        data: { lastSentAt: new Date('2026-11-10T08:05:00.000Z') }
      })
      const wednesday = freshQueue()
      expect(await scheduler(wednesday).dispatch(new Date('2026-11-11T09:00:00.000Z'))).toBe(0)
      // and the next Monday is its own report
      const nextMonday = freshQueue()
      await scheduler(nextMonday).dispatch(new Date('2026-11-16T08:00:00.000Z'))
      expect(daysOf(nextMonday)).toEqual(['2026-11-16'])
    })

    it('makes up a monthly report on the second of the month', async () => {
      const report = await make({ frequency: ReportFrequency.MONTHLY })
      const queue = freshQueue()
      expect(await scheduler(queue).dispatch(new Date('2026-12-02T08:00:00.000Z'))).toBe(1)
      expect(queue.jobs[0]?.data).toEqual({
        reportId: report.id,
        day: '2026-12-01',
        storeId: ctx.storeA.id
      })
    })

    it('does not make up a period that ended before the report existed', async () => {
      // made on Wednesday the 11th: last Monday is not owed
      await make({
        frequency: ReportFrequency.WEEKLY,
        createdAt: new Date('2026-11-11T10:00:00.000Z')
      })
      const queue = freshQueue()
      expect(await scheduler(queue).dispatch(new Date('2026-11-12T08:00:00.000Z'))).toBe(0)
      // one made on the Monday itself, after its hour, is still sent that day (as before)
      await make({
        frequency: ReportFrequency.WEEKLY,
        createdAt: new Date('2026-11-09T09:00:00.000Z')
      })
      const monday = freshQueue()
      expect(await scheduler(monday).dispatch(new Date('2026-11-09T10:00:00.000Z'))).toBe(1)
    })
  })

  describe('one report', () => {
    const now = new Date('2026-11-10T08:00:00.000Z')
    const DAY = '2026-11-10'

    async function make(data: Record<string, unknown> = {}) {
      return owner.scheduledReport.create({
        data: {
          storeId: ctx.storeA.id,
          name: 'Daily figures',
          metrics: [AnalyticsMetrics.ORDERS_CREATED],
          frequency: ReportFrequency.DAILY,
          format: 'csv',
          recipients: ['one@example.com', 'two@example.com'],
          createdBy: ctx.adminA.id,
          timezone: 'UTC',
          sendAtHour: 8,
          ...data
        }
      })
    }

    it('makes the file as an export of the person, and sends one email for each address with the file attached', async () => {
      await day(ctx.storeA.id, '2026-11-09', AnalyticsMetrics.ORDERS_CREATED, 4)
      const report = await make()
      expect(await runner.run(ctx.storeA.id, report.id, DAY, false, now)).toBe('sent')
      const made = await owner.export.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, type: ExportTypes.ANALYTICS },
        orderBy: { createdAt: 'desc' }
      })
      keys.push(made.key ?? '')
      expect(made.requestedBy).toBe(ctx.adminA.id)
      expect(made.status).toBe(ExportStatus.READY)
      expect(emails.jobs).toHaveLength(2)
      // Each address gets its own email: they do not see each other
      expect(emails.jobs.map(job => job.to).sort()).toEqual(['one@example.com', 'two@example.com'])
      const first = emails.jobs[0] as unknown as {
        template: string
        attachments: { filename: string; contentBase64: string }[]
        data: { from: string; to: string; totals: { value: string }[] }
      }
      expect(first.template).toBe('scheduled-report')
      expect(first.data).toMatchObject({ from: '2026-11-09', to: '2026-11-10' })
      expect(first.data.totals[0]?.value).toBe('4')
      expect(first.attachments[0]?.filename).toMatch(/\.csv$/)
      expect(Buffer.from(first.attachments[0]?.contentBase64 ?? '', 'base64').toString()).toContain(
        '2026-11-09,4'
      )
      const after = await owner.scheduledReport.findUniqueOrThrow({ where: { id: report.id } })
      expect(after.lastSentAt).toEqual(now)
      const entries = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.REPORT_SENT,
        resourceId: report.id
      })
      expect(entries).toHaveLength(1)
      expect(JSON.stringify(entries[0]?.metadata)).not.toContain('example.com')
    })

    it('reports the period of the day it was queued for, however late it runs', async () => {
      await day(ctx.storeA.id, '2026-11-07', AnalyticsMetrics.ORDERS_CREATED, 6)
      const report = await make()
      // Queued for the 8th (so it reports the 7th) and run on the 10th
      expect(await runner.run(ctx.storeA.id, report.id, '2026-11-08', false, now)).toBe('sent')
      const first = emails.jobs[0] as unknown as { data: { from: string; to: string } }
      expect(first.data).toMatchObject({ from: '2026-11-07', to: '2026-11-08' })
    })

    it('does not send the same report twice in a day', async () => {
      const report = await make({ lastSentAt: new Date(now.getTime() - HOUR) })
      expect(await runner.run(ctx.storeA.id, report.id, DAY, false, now)).toBe('skipped')
      expect(emails.jobs).toHaveLength(0)
    })

    it('skips a report that is off or gone', async () => {
      const off = await make({ enabled: false })
      expect(await runner.run(ctx.storeA.id, off.id, DAY, false, now)).toBe('skipped')
      expect(await runner.run(ctx.storeA.id, randomUUID(), DAY, false, now)).toBe('skipped')
      expect(emails.jobs).toHaveLength(0)
    })

    it('turns the report off, and sends nothing, when the person lost the right to take the figures out', async () => {
      const viewOnly = await createRole(owner, {
        storeId: ctx.storeA.id,
        permissions: [Permissions.ANALYTICS_VIEW, Permissions.ANALYTICS_MANAGE_REPORTS]
      })
      const member = await createActor(owner, app, {
        prefix,
        name: `lost-${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: viewOnly.id
      })
      const report = await make({ createdBy: member.id })
      expect(await runner.run(ctx.storeA.id, report.id, DAY, false, now)).toBe('disabled')
      expect(emails.jobs).toHaveLength(0)
      expect(
        (await owner.scheduledReport.findUniqueOrThrow({ where: { id: report.id } })).enabled
      ).toBe(false)
      expect(await owner.export.count({ where: { requestedBy: member.id } })).toBe(0)
      // The runner turned it off by itself, so the trail says so and why (N-A7-06): the system did it, the person is in the metadata
      const [entry] = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.REPORT_DISABLED,
        resourceId: report.id
      })
      expect(entry?.userId).toBeNull()
      expect(entry?.metadata).toMatchObject({
        reason: ReportDisableReasons.OWNER_LOST_RIGHT,
        createdBy: member.id
      })
      // Off now: a later run skips it and says nothing more
      expect(await runner.run(ctx.storeA.id, report.id, DAY, false, now)).toBe('skipped')
      expect(
        await owner.auditLog.count({
          where: {
            storeId: ctx.storeA.id,
            action: AuditAction.REPORT_DISABLED,
            resourceId: report.id
          }
        })
      ).toBe(1)
    })

    it('turns the report off when the person was suspended in the store', async () => {
      const report = await make()
      await owner.membership.updateMany({
        where: { userId: ctx.adminA.id, storeId: ctx.storeA.id },
        data: { status: 'SUSPENDED' }
      })
      try {
        expect(await runner.run(ctx.storeA.id, report.id, DAY, false, now)).toBe('disabled')
      } finally {
        await owner.membership.updateMany({
          where: { userId: ctx.adminA.id, storeId: ctx.storeA.id },
          data: { status: 'ACTIVE' }
        })
      }
      expect(emails.jobs).toHaveLength(0)
      const [entry] = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.REPORT_DISABLED,
        resourceId: report.id
      })
      expect(entry?.metadata).toMatchObject({ reason: ReportDisableReasons.OWNER_LOST_RIGHT })
    })

    it('refuses to run a report whose stored metrics do not fit any more', async () => {
      const report = await make({ metrics: ['no.longer.a.metric'] })
      await expect(runner.run(ctx.storeA.id, report.id, DAY, false, now)).rejects.toBeInstanceOf(
        UnrecoverableError
      )
      expect(emails.jobs).toHaveLength(0)
    })

    it('reads only the store of the report', async () => {
      await day(ctx.storeB.id, '2026-11-09', AnalyticsMetrics.ORDERS_CREATED, 888)
      const report = await make()
      await runner.run(ctx.storeA.id, report.id, DAY, false, now)
      const first = emails.jobs[0] as unknown as { data: { totals: { value: string }[] } }
      expect(first.data.totals[0]?.value).toBe('0')
      const made = await owner.export.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, type: ExportTypes.ANALYTICS },
        orderBy: { createdAt: 'desc' }
      })
      keys.push(made.key ?? '')
    })
  })
  // One revenue, one unit (HC-010): the rollup keeps `orders.revenue` in dollars, the dashboard reads it as dollars, and every file
  // the worker makes from it must say the same figure. Before, the files divided it by 100 again and rounded first: 19.99 came out as
  // 0.2 and one cent as 0. The two specs that held each half (the rollup said dollars, this one seeded cents) never met.
  describe('the revenue of one order, on every surface', () => {
    const REVENUE_FROM = '2026-11-02'
    const REVENUE_TO = '2026-11-04'
    async function seedRevenue(): Promise<void> {
      const rollups = new AnalyticsRollupService(createWorkerPrisma())
      // 1999 cents on the first day and one single cent on the second
      const first = await createOrder(owner, { storeId: ctx.storeA.id })
      const second = await createOrder(owner, { storeId: ctx.storeA.id })
      await owner.order.update({
        where: { id: first.id },
        data: { createdAt: new Date('2026-11-02T10:00:00.000Z') }
      })
      await owner.order.update({
        where: { id: second.id },
        data: { createdAt: new Date('2026-11-03T10:00:00.000Z'), totalCents: 1 }
      })
      for (const date of [REVENUE_FROM, '2026-11-03']) {
        const start = new Date(`${date}T00:00:00.000Z`)
        await rollups.rollup(RollupGranularities.DAILY, ctx.storeA.id, {
          start,
          end: new Date(start.getTime() + 24 * HOUR)
        })
      }
    }

    const exportOf = async (format: 'csv' | 'excel' | 'pdf'): Promise<Buffer> => {
      const row = await owner.export.create({
        data: {
          storeId: ctx.storeA.id,
          requestedBy: ctx.adminA.id,
          type: ExportTypes.ANALYTICS,
          format,
          filters: {
            metrics: [AnalyticsMetrics.ORDERS_REVENUE],
            from: REVENUE_FROM,
            to: REVENUE_TO
          },
          status: ExportStatus.PENDING,
          expiresAt: new Date(Date.now() + 24 * HOUR)
        }
      })
      return (await fileOf(row.id)).bytes
    }

    it('says 19.99 and 0.01 in the metrics of the api, the csv, the spreadsheet and the pdf', async () => {
      await seedRevenue()

      // The api: what the dashboard draws
      const metrics = await asAdmin()
        .get(ApiRoutes.analytics.metrics)
        .query({
          metric: AnalyticsMetrics.ORDERS_REVENUE,
          from: `${REVENUE_FROM}T00:00:00.000Z`,
          to: `${REVENUE_TO}T00:00:00.000Z`,
          granularity: 'day'
        })
      expect(metrics.status).toBe(OK)
      const points = (metrics.body as { series: { points: { value: number }[] }[] }).series[0]
        ?.points
      expect(points?.map(point => point.value)).toEqual([19.99, 0.01])

      // The csv: a day for each row, then the total of the period
      const csv = (await exportOf('csv')).toString('utf8').replace('﻿', '')
      const lines = csv.split('\r\n').filter(Boolean)
      expect(lines[1]).toBe('2026-11-02,19.99')
      expect(lines[2]).toBe('2026-11-03,0.01')
      expect(Number(lines[3]?.split(',')[1])).toBeCloseTo(20, 2)

      // The spreadsheet: numbers, in the same unit
      const xml = strFromU8(
        unzipSync(new Uint8Array(await exportOf('excel')))['xl/worksheets/sheet1.xml'] ??
          new Uint8Array()
      )
      expect(xml).toContain('<v>19.99</v>')
      expect(xml).toContain('<v>0.01</v>')
      expect(xml).not.toContain('<v>0.2</v>')

      // The document: text a person reads, with two decimals
      const pdf = (await exportOf('pdf')).toString('latin1')
      expect(pdf).toContain('(19.99)')
      expect(pdf).toContain('(0.01)')
    })
  })
})
