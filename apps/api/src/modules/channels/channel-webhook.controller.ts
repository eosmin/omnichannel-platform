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
import type { Request } from 'express'
import { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { ChannelWebhookThrottle } from '@platform/core/auth'
import { Public } from '@platform/core/auth-module'
import { CHANNEL_ID_PATTERN, ChannelIds } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { RateLimit } from '@platform/core/http'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import { PluginRegistry } from '@platform/plugins/runtime'

import { InboundEventQueue } from './inbound-event-queue.service'

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
    private readonly queue: InboundEventQueue,
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

    await this.queue.enqueue(pluginId, await this.normalize(pluginId, plugin, req.body))
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
    // The widget has doors of its own, which check the site, its origins and the limits of a visitor;
    // this one would let a token past all three
    const plugin =
      CHANNEL_ID_PATTERN.test(pluginId) && pluginId !== ChannelIds.WEB_WIDGET
        ? this.registry.find(pluginId)
        : undefined
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
