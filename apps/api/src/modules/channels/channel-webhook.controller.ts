import { InjectQueue } from '@nestjs/bullmq'
import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  type RawBodyRequest,
  Query,
  Req
} from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import type { Queue } from 'bullmq'
import type { Request } from 'express'
import { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { ChannelWebhookThrottle } from '@platform/core/auth'
import { Public } from '@platform/core/auth-module'
import { CHANNEL_ID_PATTERN, InboundLimits } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { RateLimit } from '@platform/core/http'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import { JobNames, QueueNames } from '@platform/core/queues'
import {
  channelEventSchema,
  inboundJobId,
  PluginRegistry,
  type ProcessChannelEventJob
} from '@platform/plugins/runtime'

// Only the strings of the headers: the plugin verifies a signature, not a list
function stringHeaders(headers: Request['headers']): Record<string, string> {
  const strings: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') strings[name] = value
  }
  return strings
}

// Public: the signature of the body, which the plugin of the channel checks, authenticates it
// (TDD_10 §4). The controller verifies, normalizes and queues, and answers at once, because a
// provider retries what it does not hear back about quickly; the worker does the rest.
@Public()
@RateLimit(ChannelWebhookThrottle)
@Controller()
export class ChannelWebhookController {
  constructor(
    private readonly registry: PluginRegistry,
    @InjectQueue(QueueNames.INBOUND) private readonly inboundQueue: Queue<ProcessChannelEventJob>,
    @InjectMetric(MetricNames.CHANNEL_WEBHOOK_RECEIVED) private readonly received: Counter<string>,
    @InjectMetric(MetricNames.CHANNEL_WEBHOOK_REJECTED) private readonly rejected: Counter<string>,
    private readonly logger: PinoLogger
  ) {
    // Not @InjectPinoLogger(name): see ProcessorSupport
    this.logger.setContext(ChannelWebhookController.name)
  }

  // Meta asks first with a GET and a challenge; a channel that has no handshake answers 404
  @Get(ApiRoutes.webhooks.channel(':pluginId'))
  verifyWebhook(
    @Param('pluginId') pluginId: string,
    @Query() query: Record<string, string>
  ): string {
    const plugin = this.pluginOf(pluginId)
    const challenge = plugin.verifyWebhook?.(stringQuery(query)) ?? null
    if (challenge === null) {
      throw new PlatformException(
        ErrorCodes.CHANNEL_WEBHOOK_SIGNATURE_INVALID,
        'invalid verify token',
        HttpStatusCodes.FORBIDDEN
      )
    }
    return challenge
  }

  @Post(ApiRoutes.webhooks.channel(':pluginId'))
  @HttpCode(HttpStatusCodes.OK)
  async handleWebhook(
    @Param('pluginId') pluginId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Request['headers']
  ): Promise<{ received: true }> {
    const plugin = this.pluginOf(pluginId)
    const rawBody = req.rawBody?.toString() ?? ''
    if (!plugin.validateWebhookSignature(rawBody, stringHeaders(headers))) {
      this.rejected.inc({ channel_type: pluginId })
      this.logger.warn({ pluginId }, 'invalid webhook signature')
      throw new PlatformException(
        ErrorCodes.CHANNEL_WEBHOOK_SIGNATURE_INVALID,
        'invalid signature',
        HttpStatusCodes.UNAUTHORIZED
      )
    }
    this.received.inc({ channel_type: pluginId })

    const receivedAt = new Date().toISOString()
    const jobs: { name: string; data: ProcessChannelEventJob; opts: { jobId: string } }[] = []
    for (const candidate of await this.normalize(pluginId, plugin, req.body)) {
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
    return { received: true }
  }

  // A body that the plugin cannot read is acknowledged and said, not failed: the signature is good, so
  // it is the provider's real request, and a 500 would have it sent again for ever
  private async normalize(
    pluginId: string,
    plugin: ReturnType<PluginRegistry['get']>,
    body: unknown
  ): Promise<unknown[]> {
    try {
      const events: unknown = await plugin.handleWebhook(body)
      if (Array.isArray(events)) return events as unknown[] // Each one is checked below
      this.logger.error({ pluginId }, 'a plugin returned something that is not a list of events')
    } catch (error) {
      this.logger.error({ err: error, pluginId }, 'a plugin could not read a webhook body')
    }
    return []
  }

  // The same answer for a channel that is not registered and for one that is malformed: nothing to learn
  private pluginOf(pluginId: string): ReturnType<PluginRegistry['get']> {
    const plugin = CHANNEL_ID_PATTERN.test(pluginId) ? this.registry.find(pluginId) : undefined
    if (plugin === undefined) throw resourceNotFound('channel')
    return plugin
  }
}

function stringQuery(query: Record<string, unknown>): Record<string, string> {
  const strings: Record<string, string> = {}
  for (const [name, value] of Object.entries(query)) {
    if (typeof value === 'string') strings[name] = value
  }
  return strings
}
