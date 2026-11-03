import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import { AnalyticsEventNames } from '@platform/core/analytics'
import { JobNames, QueueNames, type TrackAnalyticsJob } from '@platform/core/queues'

import { AnalyticsEventWriter } from '../analytics/analytics-event.writer'

import { BaseProcessor } from './base.processor'
import { ProcessorSupport } from './processor-support'

// Checked against the job type of the queue: a field added there and not here fails to compile
const trackEventSchema: z.ZodType<TrackAnalyticsJob, unknown> = z.object({
  event: z.enum(AnalyticsEventNames),
  storeId: z.uuid(),
  data: z.record(z.string(), z.unknown()),
  // An offset is read and written back in UTC, so a producer need not format its date our way
  timestamp: z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  correlationId: z.string().optional()
})

// The raw events of analytics (TDD_11 §7.1). The rollups and the search event are Phase 2: nothing
// queues them in the MVP, and the queue refuses a job it does not know instead of keeping it.
@Processor(QueueNames.ANALYTICS, { concurrency: 5 })
export class AnalyticsProcessor extends BaseProcessor<TrackAnalyticsJob> {
  constructor(
    support: ProcessorSupport,
    private readonly events: AnalyticsEventWriter
  ) {
    super(QueueNames.ANALYTICS, support)
  }

  protected async handle(job: Job<TrackAnalyticsJob>): Promise<void> {
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    if (job.name !== JobNames.TRACK_EVENT) {
      throw new UnrecoverableError('the analytics queue does not know this job')
    }
    const parsed = trackEventSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError('the track-event job does not fit its schema')
    await this.events.write(parsed.data)
  }
}
