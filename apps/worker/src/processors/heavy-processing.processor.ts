import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import { JobNames, QueueNames, type ProcessImageJob, type ScanFileJob } from '@platform/core/queues'

import { MediaPipeline } from '../media/media-pipeline.service'

import { BaseProcessor } from './base.processor'
import { ProcessorSupport } from './processor-support'

type HeavyJob = ScanFileJob | ProcessImageJob

const mediaJobSchema = z.object({ mediaId: z.uuid() })

// The worker half of a file: scan it, then make the variants of a clean image. One processor for the
// queue, told apart by the name of the job (the media of an inbound message joins them in PR B2).
@Processor(QueueNames.HEAVY_PROCESSING, { concurrency: 2 })
export class HeavyProcessingProcessor extends BaseProcessor<HeavyJob> {
  constructor(
    support: ProcessorSupport,
    private readonly pipeline: MediaPipeline
  ) {
    super(QueueNames.HEAVY_PROCESSING, support)
  }

  protected async handle(job: Job<HeavyJob>): Promise<void> {
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    const parsed = mediaJobSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError('the media job does not fit its schema')

    switch (job.name) {
      case JobNames.SCAN_FILE:
        return this.pipeline.scan(parsed.data.mediaId)
      case JobNames.PROCESS_IMAGE:
        return this.pipeline.processImage(parsed.data.mediaId)
      default:
        throw new UnrecoverableError('the heavy-processing queue does not know this job')
    }
  }
}
