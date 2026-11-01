import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import { type GenerateExportJob, JobNames, QueueNames } from '@platform/core/queues'

import { ExportGenerator } from '../exports/export-generator.service'

import { BaseProcessor, isLastAttempt } from './base.processor'
import { ProcessorSupport } from './processor-support'

const exportJobSchema = z.object({ exportId: z.uuid() })

// One at a time: an export reads a whole table and the worker holds little memory
@Processor(QueueNames.EXPORTS, { concurrency: 1 })
export class ExportsProcessor extends BaseProcessor<GenerateExportJob> {
  constructor(
    support: ProcessorSupport,
    private readonly generator: ExportGenerator
  ) {
    super(QueueNames.EXPORTS, support)
  }

  protected async handle(job: Job<GenerateExportJob>): Promise<void> {
    if (job.name !== JobNames.GENERATE_EXPORT) {
      throw new UnrecoverableError('the exports queue does not know this job')
    }
    const parsed = exportJobSchema.safeParse(job.data)
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    if (!parsed.success) throw new UnrecoverableError('the export job does not fit its schema')
    return this.generator.generate(parsed.data.exportId, isLastAttempt(job))
  }
}
