import { Injectable } from '@nestjs/common'

import { PrismaService } from '@platform/core/database'
import type { TrackAnalyticsJob } from '@platform/core/queues'

function startOfUtcDay(moment: Date): Date {
  const day = new Date(moment)
  day.setUTCHours(0, 0, 0, 0)
  return day
}

// The raw events of analytics_events (TDD_11 §7.1), written by TRACK_EVENT jobs. The store id is the
// one the producer put in the job, which read it from its own verified source (a tag the platform set
// on the email), never from a request body.
@Injectable()
export class AnalyticsEventWriter {
  constructor(private readonly prisma: PrismaService) {}

  // An event with a key is written once: the same job delivered again (a stalled worker's) conflicts with the row of the
  // first delivery and writes nothing. Returns whether a row was written.
  async write(job: TrackAnalyticsJob): Promise<boolean> {
    const timestamp = new Date(job.timestamp)
    const { count } = await this.prisma.client.analyticsEvent.createMany({
      data: [
        {
          storeId: job.storeId,
          event: job.event,
          data: job.data as object,
          // The day the event belongs to, in UTC: the rollups group by it
          date: startOfUtcDay(timestamp),
          timestamp,
          eventKey: job.eventKey ?? null
        }
      ],
      skipDuplicates: true
    })
    return count === 1
  }
}
