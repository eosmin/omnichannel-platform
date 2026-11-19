import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import {
  exactly,
  type ExportAuditLogsJob,
  type GenerateExportJob,
  type GenerateScheduledReportJob,
  JobNames,
  QueueNames
} from '@platform/core/queues'

import { ScheduledReportRunner } from '../exports/analytics/scheduled-report.runner'
import { ExportGenerator } from '../exports/export-generator.service'
import { AuditColdExporter } from '../retention/audit-cold-exporter.service'

import { BaseProcessor, isLastAttempt } from './base.processor'
import { ProcessorSupport } from './processor-support'

// The store is required: a job with none fails (and goes to the dead-letter queue), it is never looked up
const exportJobSchema = exactly<GenerateExportJob>()(
  z.object({ exportId: z.uuid(), storeId: z.uuid(), correlationId: z.string().optional() })
)
const reportJobSchema = exactly<GenerateScheduledReportJob>()(
  z.object({
    reportId: z.uuid(),
    day: z.iso.date(),
    storeId: z.uuid(),
    correlationId: z.string().optional()
  })
)
const auditExportJobSchema = exactly<ExportAuditLogsJob>()(
  z.object({ before: z.iso.datetime(), correlationId: z.string().optional() })
)

// One at a time: an export reads a whole table and the worker holds little memory
@Processor(QueueNames.EXPORTS, { concurrency: 1 })
export class ExportsProcessor extends BaseProcessor<
  GenerateExportJob | GenerateScheduledReportJob | ExportAuditLogsJob
> {
  constructor(
    support: ProcessorSupport,
    private readonly generator: ExportGenerator,
    private readonly reports: ScheduledReportRunner,
    private readonly auditExport: AuditColdExporter
  ) {
    super(QueueNames.EXPORTS, support)
  }

  protected async handle(
    job: Job<GenerateExportJob | GenerateScheduledReportJob | ExportAuditLogsJob>
  ): Promise<void> {
    if (job.name === JobNames.EXPORT_AUDIT_LOGS_TO_COLD_STORAGE) {
      const parsed = auditExportJobSchema.safeParse(job.data)
      if (!parsed.success)
        throw new UnrecoverableError('the audit export job does not fit its schema')
      await this.auditExport.run(new Date(parsed.data.before))
      return
    }
    if (job.name === JobNames.GENERATE_SCHEDULED_REPORT) {
      const parsed = reportJobSchema.safeParse(job.data)
      if (!parsed.success) throw new UnrecoverableError('the report job does not fit its schema')
      await this.skipIfGone(job, () =>
        this.reports.run(
          parsed.data.storeId,
          parsed.data.reportId,
          parsed.data.day,
          isLastAttempt(job)
        )
      )
      return
    }
    if (job.name !== JobNames.GENERATE_EXPORT) {
      throw new UnrecoverableError('the exports queue does not know this job')
    }
    const parsed = exportJobSchema.safeParse(job.data)
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    if (!parsed.success) throw new UnrecoverableError('the export job does not fit its schema')
    return this.skipIfGone(job, () =>
      this.generator.generate(parsed.data.storeId, parsed.data.exportId, isLastAttempt(job))
    )
  }
}
