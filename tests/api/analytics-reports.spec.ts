import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { UnrecoverableError } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'

import { AnalyticsMetrics, ReportFrequency, ReportLimits } from '@platform/core/analytics'
import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { Permissions } from '@platform/core/auth'
import { PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'
import { DomainEvents } from '@platform/core/event-bus'
import { ExportStatus, ExportTypes, JobNames, QueueNames } from '@platform/core/queues'
import { StorageService } from '@platform/core/storage-module'

import { AnalyticsExportWriter } from '../../apps/worker/src/exports/analytics/analytics-export.writer'
import { ScheduledReportRunner } from '../../apps/worker/src/exports/analytics/scheduled-report.runner'
import { CsvExportWriter } from '../../apps/worker/src/exports/csv-export-writer'
import { ExportGenerator } from '../../apps/worker/src/exports/export-generator.service'
import { ZipExportWriter } from '../../apps/worker/src/exports/zip-export-writer'
import { ReportDispatchScheduler } from '../../apps/worker/src/schedulers/report-dispatch.scheduler'
import { createRole } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type CapturedEmails, emailsOf } from '../helpers/email'
import { api } from '../helpers/http'
import { type CapturedQueue, queueOf } from '../helpers/queue'

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
    const prisma = app.get(PrismaService, { strict: false })
    storage = app.get(StorageService, { strict: false })
    const logger = {
      setContext: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn()
    } as unknown as PinoLogger
    const csv = new CsvExportWriter(storage)
    const audit = app.get(AuditService, { strict: false })
    generator = new ExportGenerator(
      prisma,
      csv,
      new ZipExportWriter(storage, logger),
      new AnalyticsExportWriter(prisma, storage, csv),
      storage,
      audit,
      app.get(DomainEvents, { strict: false }),
      logger
    )
    emails = emailsOf(app)
    runner = new ScheduledReportRunner(prisma, generator, storage, audit, emails as never, logger)
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
    await generator.generate(exportId, false)
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
      await day(ctx.storeA.id, '2026-11-03', AnalyticsMetrics.ORDERS_REVENUE, 12_345)
      // Another store's figures, and a day outside the period, never enter the file
      await day(ctx.storeB.id, '2026-11-01', AnalyticsMetrics.ORDERS_CREATED, 999)
      await day(ctx.storeA.id, '2026-11-04', AnalyticsMetrics.ORDERS_CREATED, 777)
      const made = (await asAdmin().get(query())).body as ExportBody
      const { text } = await fileOf(made.id)
      const lines = text.replace('﻿', '').split('\r\n').filter(Boolean)
      expect(lines).toHaveLength(1 + 3 + 1)
      expect(lines[1]).toBe('2026-11-01,3,0')
      expect(lines[2]).toBe('2026-11-02,0,0')
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
      await expect(generator.generate(row.id, false)).rejects.toBeInstanceOf(UnrecoverableError)
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
        app.get(PrismaService, { strict: false }),
        { setContext: jest.fn(), info: jest.fn(), error: jest.fn() } as unknown as PinoLogger
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
          ...data
        }
      })
    }

    it('queues the reports whose own clock reads their hour, one job for each report and day', async () => {
      const due = await make({})
      await make({ sendAtHour: 9 }) // not yet its hour
      await make({ enabled: false })
      await make({ frequency: ReportFrequency.WEEKLY }) // 2026-11-10 is a Tuesday
      await make({ timezone: 'America/El_Salvador' }) // 08:00 UTC is 02:00 there
      const queue = new (queueOf(app, QueueNames.EXPORTS).constructor as new () => CapturedQueue)()
      const queued = await scheduler(queue).dispatch(new Date('2026-11-10T08:00:00.000Z'))
      expect(queued).toBe(1)
      expect(queue.jobs).toEqual([
        {
          name: JobNames.GENERATE_SCHEDULED_REPORT,
          data: { reportId: due.id, day: '2026-11-10' },
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
      const monthly = await make({ frequency: ReportFrequency.MONTHLY, timezone: 'UTC' })
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
      expect(await runner.run(report.id, DAY, false, now)).toBe('sent')
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
      expect(await runner.run(report.id, '2026-11-08', false, now)).toBe('sent')
      const first = emails.jobs[0] as unknown as { data: { from: string; to: string } }
      expect(first.data).toMatchObject({ from: '2026-11-07', to: '2026-11-08' })
    })

    it('does not send the same report twice in a day', async () => {
      const report = await make({ lastSentAt: new Date(now.getTime() - HOUR) })
      expect(await runner.run(report.id, DAY, false, now)).toBe('skipped')
      expect(emails.jobs).toHaveLength(0)
    })

    it('skips a report that is off or gone', async () => {
      const off = await make({ enabled: false })
      expect(await runner.run(off.id, DAY, false, now)).toBe('skipped')
      expect(await runner.run(randomUUID(), DAY, false, now)).toBe('skipped')
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
      expect(await runner.run(report.id, DAY, false, now)).toBe('disabled')
      expect(emails.jobs).toHaveLength(0)
      expect(
        (await owner.scheduledReport.findUniqueOrThrow({ where: { id: report.id } })).enabled
      ).toBe(false)
      expect(await owner.export.count({ where: { requestedBy: member.id } })).toBe(0)
    })

    it('turns the report off when the person was suspended in the store', async () => {
      const report = await make()
      await owner.membership.updateMany({
        where: { userId: ctx.adminA.id, storeId: ctx.storeA.id },
        data: { status: 'SUSPENDED' }
      })
      try {
        expect(await runner.run(report.id, DAY, false, now)).toBe('disabled')
      } finally {
        await owner.membership.updateMany({
          where: { userId: ctx.adminA.id, storeId: ctx.storeA.id },
          data: { status: 'ACTIVE' }
        })
      }
      expect(emails.jobs).toHaveLength(0)
    })

    it('refuses to run a report whose stored metrics do not fit any more', async () => {
      const report = await make({ metrics: ['no.longer.a.metric'] })
      await expect(runner.run(report.id, DAY, false, now)).rejects.toBeInstanceOf(
        UnrecoverableError
      )
      expect(emails.jobs).toHaveLength(0)
    })

    it('reads only the store of the report', async () => {
      await day(ctx.storeB.id, '2026-11-09', AnalyticsMetrics.ORDERS_CREATED, 888)
      const report = await make()
      await runner.run(report.id, DAY, false, now)
      const first = emails.jobs[0] as unknown as { data: { totals: { value: string }[] } }
      expect(first.data.totals[0]?.value).toBe('0')
      const made = await owner.export.findFirstOrThrow({
        where: { storeId: ctx.storeA.id, type: ExportTypes.ANALYTICS },
        orderBy: { createdAt: 'desc' }
      })
      keys.push(made.key ?? '')
    })
  })
})
