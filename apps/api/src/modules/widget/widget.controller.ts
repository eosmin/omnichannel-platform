import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import type { Response } from 'express'

import { type WidgetMessage, widgetMessageSchema } from '@platform/channels/web-widget'
import { ApiRoutes } from '@platform/core/api'
import { Public } from '@platform/core/auth-module'
import { ChannelIds, WidgetThrottle } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { RateLimit, ZodValidationPipe } from '@platform/core/http'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import { PluginRegistry } from '@platform/plugins/runtime'

import { InboundEventQueue } from '../channels/inbound-event-queue.service'

import { WidgetAway } from './widget-away.service'
import { WidgetHistory } from './widget-history.service'
import type { WidgetMessageView } from './widget-message-view'
import { allowOrigin } from './widget-origin'
import { WidgetSites } from './widget-sites.service'
import { WidgetTokens } from './widget-tokens.service'
import { type WidgetBootstrapBody, widgetBootstrapSchema } from './widget.schemas'

export interface WidgetBootstrapView {
  visitorToken: string
  expiresInSeconds: number
  store: { name: string; locale: string }
  away: boolean
  messages: WidgetMessageView[]
}

// The public doors of the widget (TDD_10 §5.4), called by a script on the store's site. The site key
// names the store; the token the bootstrap gives is what every other call carries.
@Public()
@Controller()
export class WidgetController {
  constructor(
    private readonly sites: WidgetSites,
    private readonly tokens: WidgetTokens,
    private readonly history: WidgetHistory,
    private readonly away: WidgetAway,
    private readonly registry: PluginRegistry,
    private readonly queue: InboundEventQueue,
    @InjectMetric(MetricNames.CHANNEL_WEBHOOK_RECEIVED) private readonly received: Counter<string>,
    @InjectMetric(MetricNames.CHANNEL_WEBHOOK_REJECTED) private readonly rejected: Counter<string>
  ) {}

  @RateLimit(WidgetThrottle.BOOTSTRAP)
  @Post(ApiRoutes.widget.bootstrap)
  @HttpCode(HttpStatusCodes.OK)
  async bootstrap(
    @Body(new ZodValidationPipe(widgetBootstrapSchema)) body: WidgetBootstrapBody,
    @Headers('origin') origin: string | undefined,
    @Res({ passthrough: true }) res: Response
  ): Promise<WidgetBootstrapView> {
    const site = await this.sites.find(body.siteKey)
    if (site === null) throw resourceNotFound('widget')
    allowOrigin(site, origin, res)
    const [messages, away] = await Promise.all([
      this.history.of(site, body.visitorId),
      this.away.isAway(site)
    ])
    const { token, expiresInSeconds } = this.tokens.issue({
      siteKey: site.siteKey,
      visitorId: body.visitorId
    })
    return {
      visitorToken: token,
      expiresInSeconds,
      store: { name: site.storeName, locale: site.storeLocale },
      away,
      messages
    }
  }

  // A message goes where a provider's webhook goes: the plugin reads it as an event and the inbound
  // queue takes it, so that the worker stores it, routes it and tells the team like any other.
  @RateLimit(WidgetThrottle.MESSAGES)
  @Post(ApiRoutes.widget.messages)
  @HttpCode(HttpStatusCodes.OK)
  async send(
    @Body(new ZodValidationPipe(widgetMessageSchema)) body: WidgetMessage,
    @Headers('origin') origin: string | undefined,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ received: true }> {
    const claims = this.tokens.verify(body.visitorToken)
    if (claims === null) {
      this.rejected.inc({ channel_type: ChannelIds.WEB_WIDGET })
      // Nothing is revealed by saying so, and the widget has to tell an expired session from a
      // network that is down to start again
      if (origin !== undefined) res.setHeader('Access-Control-Allow-Origin', origin)
      throw new PlatformException(
        ErrorCodes.WIDGET_TOKEN_INVALID,
        'the widget session is not valid',
        HttpStatusCodes.UNAUTHORIZED
      )
    }
    const site = await this.sites.find(claims.siteKey)
    if (site === null) throw resourceNotFound('widget')
    allowOrigin(site, origin, res)
    const events = await this.registry.get(ChannelIds.WEB_WIDGET).handleWebhook(body)
    this.received.inc({ channel_type: ChannelIds.WEB_WIDGET })
    await this.queue.enqueue(ChannelIds.WEB_WIDGET, events)
    return { received: true }
  }
}
