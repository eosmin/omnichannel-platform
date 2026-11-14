import { Processor } from '@nestjs/bullmq'
import { type Job, UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import { AnalyticsEventNames } from '@platform/core/analytics'
import { searchEventDataSchema } from '@platform/core/domain'
import { JobNames, QueueNames, type RollupJob, type TrackAnalyticsJob } from '@platform/core/queues'

import { AnalyticsEventWriter } from '../analytics/analytics-event.writer'
import { AnalyticsRollupService } from '../analytics/analytics-rollup.service'
import { isAligned, RollupGranularities, type RollupGranularity } from '../analytics/rollup-periods'

import { BaseProcessor } from './base.processor'
import { ProcessorSupport } from './processor-support'

// Checked against the job type of the queue: a field added there and not here fails to compile
const rawEventSchema = z.object({
  event: z.enum(AnalyticsEventNames),
  storeId: z.uuid(),
  data: z.record(z.string(), z.unknown()),
  // An offset is read and written back in UTC, so a producer need not format its date our way
  timestamp: z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  correlationId: z.string().optional(),
  eventKey: z.string().min(1).max(255).optional()
})

const rollupSchema: z.ZodType<RollupJob, unknown> = z.object({
  storeId: z.uuid(),
  periodStart: z.iso.datetime(),
  periodEnd: z.iso.datetime(),
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

const RollupGranularityOf: Record<string, RollupGranularity | undefined> = {
  [JobNames.ROLLUP_HOURLY]: RollupGranularities.HOURLY,
  [JobNames.ROLLUP_DAILY]: RollupGranularities.DAILY
}

// The raw events of analytics (TDD_11 §7.1), the search event (TDD_08 §5.6) and the rollups of the metrics tables (§7.2):
// the queue refuses a job it does not know instead of keeping it.
@Processor(QueueNames.ANALYTICS, { concurrency: 5 })
export class AnalyticsProcessor extends BaseProcessor<TrackAnalyticsJob | RollupJob> {
  constructor(
    support: ProcessorSupport,
    private readonly events: AnalyticsEventWriter,
    private readonly rollups: AnalyticsRollupService
  ) {
    super(QueueNames.ANALYTICS, support)
  }

  protected async handle(job: Job<TrackAnalyticsJob | RollupJob>): Promise<void> {
    // The job crossed Redis: what does not fit now will not fit when it is tried again
    const trackSchema = this.trackSchemaOf(job.name)
    if (trackSchema !== undefined) {
      const parsed = trackSchema.safeParse(job.data)
      if (!parsed.success) {
        throw new UnrecoverableError(`the ${job.name} job does not fit its schema`)
      }
      await this.events.write(parsed.data)
      return
    }
    const granularity = RollupGranularityOf[job.name]
    if (granularity === undefined) {
      throw new UnrecoverableError('the analytics queue does not know this job')
    }
    const parsed = rollupSchema.safeParse(job.data)
    if (!parsed.success) throw new UnrecoverableError('the rollup job does not fit its schema')
    const start = new Date(parsed.data.periodStart)
    const end = new Date(parsed.data.periodEnd)
    // Only a whole hour or a whole UTC day: a job cannot write a period the schedulers never ask for
    if (!isAligned(granularity, start, end)) {
      throw new UnrecoverableError('the rollup period is not a whole hour or day')
    }
    // A period that is still running would be written with what it has so far, and the schedulers only come back to the two
    // latest closed ones
    if (end > new Date()) throw new UnrecoverableError('the rollup period has not closed')
    await this.rollups.rollup(granularity, parsed.data.storeId, { start, end })
  }

  private trackSchemaOf(name: string): z.ZodType<TrackAnalyticsJob, unknown> | undefined {
    if (name === JobNames.TRACK_EVENT) return trackEventSchema
    if (name === JobNames.TRACK_SEARCH) return trackSearchSchema
    return undefined
  }
}
