import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import { AnalyticsEventNames } from '@platform/core/analytics'
import { searchEventDataSchema } from '@platform/core/domain'
import { JobNames, QueueNames, type TrackAnalyticsJob } from '@platform/core/queues'

import { AnalyticsEventWriter } from '../analytics/analytics-event.writer'

import { BaseProcessor } from './base.processor'
import { ProcessorSupport } from './processor-support'

// Checked against the job type of the queue: a field added there and not here fails to compile
const rawEventSchema = z.object({
  event: z.enum(AnalyticsEventNames),
  storeId: z.uuid(),
  data: z.record(z.string(), z.unknown()),
  // An offset is read and written back in UTC, so a producer need not format its date our way
  timestamp: z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  correlationId: z.string().optional()
})

// The search event has its own job and its own data check: through this one it would be written with any data
const trackEventSchema: z.ZodType<TrackAnalyticsJob, unknown> = rawEventSchema.refine(
  job => job.event !== AnalyticsEventNames.SEARCH_PERFORMED,
  { message: 'a search event is queued as a search job' }
)

// The search event is a TRACK_SEARCH job: the same shape as a raw event, but only ever `search.performed`, with the
// data the search route queues (`searchEventDataSchema`)
const trackSearchSchema: z.ZodType<TrackAnalyticsJob, unknown> = rawEventSchema.extend({
  event: z.literal(AnalyticsEventNames.SEARCH_PERFORMED),
  // What is written is what this check returns, not what was queued
  data: searchEventDataSchema
})

// The raw events of analytics (TDD_11 §7.1) and the search event. The rollups are Step 5.2's, and the queue refuses a
// job it does not know instead of keeping it.
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
    const schema = this.schemaOf(job.name)
    const parsed = schema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError(`the ${job.name} job does not fit its schema`)
    await this.events.write(parsed.data)
  }

  private schemaOf(name: string): z.ZodType<TrackAnalyticsJob, unknown> {
    if (name === JobNames.TRACK_EVENT) return trackEventSchema
    if (name === JobNames.TRACK_SEARCH) return trackSearchSchema
    throw new UnrecoverableError('the analytics queue does not know this job')
  }
}
