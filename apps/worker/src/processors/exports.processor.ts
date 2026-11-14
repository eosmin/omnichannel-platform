import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import {
  type GenerateExportJob,
  type GenerateScheduledReportJob,
  JobNames,
  QueueNames
} from '@platform/core/queues'

import { ScheduledReportRunner } from '../exports/analytics/scheduled-report.runner'
import { ExportGenerator } from '../exports/export-generator.service'

import { BaseProcessor, isLastAttempt } from './base.processor'
import { ProcessorSupport } from './processor-support'

const exportJobSchema = z.object({ exportId: z.uuid() })
const reportJobSchema = z.object({ reportId: z.uuid(), day: z.iso.date() })

// One at a time: an export reads a whole table and the worker holds little memory
@Processor(QueueNames.EXPORTS, { concurrency: 1 })
export class ExportsProcessor extends BaseProcessor<
  GenerateExportJob | GenerateScheduledReportJob
> {
  constructor(
    support: ProcessorSupport,
    private readonly generator: ExportGenerator,
    private readonly reports: ScheduledReportRunner
  ) {
    super(QueueNames.EXPORTS, support)
  }

  protected async handle(job: Job<GenerateExportJob | GenerateScheduledReportJob>): Promise<void> {
    if (job.name === JobNames.GENERATE_SCHEDULED_REPORT) {
      const parsed = reportJobSchema.safeParse(job.data)
      if (!parsed.success) throw new UnrecoverableError('the report job does not fit its schema')
      await this.reports.run(parsed.data.reportId, parsed.data.day, isLastAttempt(job))
      return
    }
    if (job.name !== JobNames.GENERATE_EXPORT) {
      throw new UnrecoverableError('the exports queue does not know this job')
    }
    const parsed = exportJobSchema.safeParse(job.data)
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    if (!parsed.success) throw new UnrecoverableError('the export job does not fit its schema')
    return this.generator.generate(parsed.data.exportId, isLastAttempt(job))
  }
}
