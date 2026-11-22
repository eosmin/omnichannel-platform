import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { InboundLimits } from '@platform/core/domain'
import { InboundEventDropReason, MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
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
    @InjectMetric(MetricNames.INBOUND_EVENTS_DROPPED) private readonly dropped: Counter<string>,
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
        const issues = parsed.error.issues
        // A text over the limit is told apart: no real provider reaches it (they cut texts far below), so it means a forged signed body
        const tooLong = issues.some(
          issue =>
            issue.code === 'too_big' &&
            (issue.path[0] === 'message' || issue.path[0] === 'edit') &&
            issue.path[issue.path.length - 1] === 'content'
        )
        this.dropped.inc({
          reason: tooLong ? InboundEventDropReason.CONTENT_TOO_LONG : InboundEventDropReason.SCHEMA
        })
        this.logger.warn(
          {
            pluginId,
            providerMessageId: providerIdOf(candidate),
            reason: tooLong
              ? InboundEventDropReason.CONTENT_TOO_LONG
              : InboundEventDropReason.SCHEMA,
            issues: issues.map(issue => issue.path.join('.'))
          },
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

// The id the provider gave the message of an event that did not fit, to find it in the provider's own tools. The event is not
// trusted: only a short string is taken, and nothing else of it is logged.
const PROVIDER_ID_LOG_LENGTH = 200
function providerIdOf(candidate: unknown): string | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined
  const event = candidate as Record<string, unknown>
  for (const part of ['message', 'edit', 'reaction', 'deletion']) {
    const body = event[part]
    if (typeof body !== 'object' || body === null) continue
    const fields = body as Record<string, unknown>
    for (const key of ['externalId', 'targetExternalId']) {
      const value = fields[key]
      if (typeof value === 'string' && value !== '') return value.slice(0, PROVIDER_ID_LOG_LENGTH)
    }
  }
  return undefined
}
