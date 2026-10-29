import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { InboundLimits } from '@platform/core/domain'
import { JobNames, QueueNames } from '@platform/core/queues'
import {
  channelEventSchema,
  inboundJobId,
  type ProcessChannelEventJob
} from '@platform/plugins/runtime'

// Where what a plugin read from a request goes next: the inbound queue, one job per event. The public
// webhook of the providers and the door of the web widget both end here.
@Injectable()
export class InboundEventQueue {
  constructor(
    @InjectQueue(QueueNames.INBOUND) private readonly inboundQueue: Queue<ProcessChannelEventJob>,
    private readonly logger: PinoLogger
  ) {
    // Not @InjectPinoLogger(name): see ProcessorSupport
    this.logger.setContext(InboundEventQueue.name)
  }

  async enqueue(pluginId: string, candidates: readonly unknown[]): Promise<void> {
    const receivedAt = new Date().toISOString()
    const jobs: { name: string; data: ProcessChannelEventJob; opts: { jobId: string } }[] = []
    for (const candidate of candidates) {
      // What the plugin returns is not trusted: the signature said who sent the request, not that the
      // plugin read it well. An event that does not fit is left out and said; the rest goes on, because
      // refusing the request would make the provider send the good ones again for ever.
      const parsed = channelEventSchema.safeParse(candidate)
      if (!parsed.success) {
        this.logger.warn(
          { pluginId, issues: parsed.error.issues.map(issue => issue.path.join('.')) },
          'event of a plugin left out: it does not fit its schema'
        )
        continue
      }
      jobs.push({
        name: JobNames.PROCESS_CHANNEL_EVENT,
        data: { pluginId, event: parsed.data, receivedAt },
        opts: { jobId: inboundJobId(pluginId, parsed.data) }
      })
    }
    for (let i = 0; i < jobs.length; i += InboundLimits.MAX_EVENTS_PER_REQUEST) {
      await this.inboundQueue.addBulk(jobs.slice(i, i + InboundLimits.MAX_EVENTS_PER_REQUEST))
    }
  }
}
