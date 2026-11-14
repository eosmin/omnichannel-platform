import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import { type Queue, UnrecoverableError } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import {
  analyticsExportFiltersSchema,
  madeOnDay,
  reportPeriod,
  type ReportFrequencyType,
  type ReportMetric,
  RolledUpMetricUnits
} from '@platform/core/analytics'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { Permissions } from '@platform/core/auth'
import { DataRetentionPolicies } from '@platform/core/compliance'
import { PrismaService } from '@platform/core/database'
import { MembershipStatus } from '@platform/core/domain'
import { ErrorCodes, errorName } from '@platform/core/errors'
import { ExportContentTypes } from '@platform/core/exports'
import {
  EmailTemplates,
  ExportStatus,
  ExportTypes,
  JobNames,
  QueueNames,
  type SendEmailJob
} from '@platform/core/queues'
import { StorageService } from '@platform/core/storage-module'

import { ExportGenerator } from '../export-generator.service'

import { formatCell } from './pdf-writer'
import { readReportTable } from './report-table'
import { localeOf, reportTexts } from './report-texts'

// A file attached to an email is held by the queue: a report is a table of days, far below this. Above it the email goes without
// the file, and the file stays in the exports center of whoever made the report.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

export const ReportRunOutcomes = {
  SENT: 'sent',
  SKIPPED: 'skipped',
  DISABLED: 'disabled'
} as const
export type ReportRunOutcome = (typeof ReportRunOutcomes)[keyof typeof ReportRunOutcomes]

// Makes one scheduled report (TDD_11 §7.4): the file, as an export of whoever made the report, and the email to its addresses. The
// job names only the report; the store, the person, the metrics and the addresses are read from its row.
@Injectable()
export class ScheduledReportRunner {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generator: ExportGenerator,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    @InjectQueue(QueueNames.EMAIL) private readonly email: Queue<SendEmailJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ScheduledReportRunner.name)
  }

  async run(
    reportId: string,
    day: string,
    lastAttempt: boolean,
    now: Date = new Date()
  ): Promise<ReportRunOutcome> {
    const report = await this.prisma.client.scheduledReport.findUnique({ where: { id: reportId } })
    if (report === null || !report.enabled) return ReportRunOutcomes.SKIPPED
    if (madeOnDay(report.lastSentAt, report.timezone, day)) return ReportRunOutcomes.SKIPPED

    // The report is made for a person: it is theirs while they still hold the right to take the figures out. When they lose it
    // (removed, suspended, a role without it) the report stops, and its row says so (it shows as off in the list).
    if (!(await this.stillAllowed(report.storeId, report.createdBy))) {
      await this.prisma.client.scheduledReport.updateMany({
        where: { id: report.id, storeId: report.storeId },
        data: { enabled: false }
      })
      this.logger.warn(
        { reportId: report.id },
        'a scheduled report was turned off: its person lost the right'
      )
      return ReportRunOutcomes.DISABLED
    }

    const period = reportPeriod(report.frequency as ReportFrequencyType, day)
    const filters = analyticsExportFiltersSchema.safeParse({
      metrics: report.metrics,
      ...period,
      reportName: report.name
    })
    // What is stored now and does not fit will not fit when it is tried again
    if (!filters.success)
      throw new UnrecoverableError('the scheduled report does not fit its schema')

    const made = await this.prisma.client.export.create({
      data: {
        storeId: report.storeId,
        requestedBy: report.createdBy,
        type: ExportTypes.ANALYTICS,
        format: report.format,
        filters: filters.data,
        status: ExportStatus.PENDING,
        expiresAt: new Date(now.getTime() + DataRetentionPolicies.EXPORTS.defaultDays * 86_400_000)
      },
      select: { id: true }
    })
    try {
      await this.generator.generate(made.id, lastAttempt)
    } catch (error) {
      // The retry makes a row of its own: this one would stay pending for good, and count as an export being made
      await this.prisma.client.export.updateMany({
        where: { id: made.id, storeId: report.storeId, status: ExportStatus.PENDING },
        data: {
          status: ExportStatus.FAILED,
          error: ErrorCodes.EXPORT_FAILED,
          completedAt: new Date()
        }
      })
      throw error
    }
    const row = await this.prisma.client.export.findFirst({
      where: { id: made.id, storeId: report.storeId },
      select: { status: true, key: true }
    })
    if (row === null || row.status !== ExportStatus.READY || row.key === null) {
      // The generator failed the row or threw; whichever it was, the report is not sent
      throw new Error('the file of a scheduled report was not made')
    }

    const attachment = await this.attachment(row.key)
    const store = await this.prisma.client.store.findUnique({
      where: { id: report.storeId },
      select: { name: true }
    })
    const user = await this.prisma.client.user.findUnique({
      where: { id: report.createdBy },
      select: { locale: true }
    })
    const locale = localeOf(user?.locale)
    const texts = reportTexts(locale, { name: report.name, ...period })
    const table = await readReportTable(this.prisma, report.storeId, filters.data)
    const totals = table.metrics.map((metric: ReportMetric, index) => ({
      label: texts.metricLabel(metric),
      value: formatCell(table.totals[index] ?? null, RolledUpMetricUnits[metric])
    }))
    // One email for each address: the people who receive a report do not see who else does
    for (const [index, to] of report.recipients.entries()) {
      await this.email.add(
        JobNames.SEND_EMAIL,
        {
          template: EmailTemplates.SCHEDULED_REPORT,
          to,
          locale,
          data: {
            name: report.name,
            storeName: store?.name ?? report.name,
            from: period.from,
            to: period.to,
            totals,
            attached: attachment !== null
          },
          ...(attachment === null ? {} : { attachments: [attachment] }),
          tags: { storeId: report.storeId, template: EmailTemplates.SCHEDULED_REPORT }
        } satisfies SendEmailJob,
        // A retry after some were queued does not send them again (dashes, no colon)
        { jobId: `${JobNames.GENERATE_SCHEDULED_REPORT}-email-${report.id}-${day}-${index}` }
      )
    }
    await this.prisma.client.scheduledReport.updateMany({
      where: { id: report.id, storeId: report.storeId },
      data: { lastSentAt: now }
    })
    this.audit.log({
      action: AuditAction.REPORT_SENT,
      actor: { userId: report.createdBy },
      storeId: report.storeId,
      resourceType: 'scheduled_report',
      resourceId: report.id,
      metadata: { recipients: report.recipients.length, format: report.format, ...period }
    })
    return ReportRunOutcomes.SENT
  }

  private async stillAllowed(storeId: string, userId: string): Promise<boolean> {
    const count = await this.prisma.client.membership.count({
      where: {
        storeId,
        userId,
        status: MembershipStatus.ACTIVE,
        AND: [Permissions.ANALYTICS_VIEW, Permissions.ANALYTICS_EXPORT].map(name => ({
          role: { permissions: { some: { name } } }
        }))
      }
    })
    return count > 0
  }

  private async attachment(
    key: string
  ): Promise<{ filename: string; contentBase64: string; contentType: string } | null> {
    try {
      const bytes = await this.storage.read(key, MAX_ATTACHMENT_BYTES)
      if (bytes === null) return null
      const filename = key.split('/').at(-1) ?? 'report'
      return {
        filename,
        contentBase64: bytes.toString('base64'),
        contentType: contentTypeOf(filename)
      }
    } catch (error) {
      this.logger.warn({ errorName: errorName(error) }, 'a report file could not be attached')
      return null
    }
  }
}

function contentTypeOf(filename: string): string {
  if (filename.endsWith('.xlsx')) return ExportContentTypes.EXCEL
  if (filename.endsWith('.pdf')) return ExportContentTypes.PDF
  return ExportContentTypes.CSV
}
