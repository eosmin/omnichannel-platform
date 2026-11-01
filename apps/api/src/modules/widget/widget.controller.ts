import { Body, Controller, Headers, HttpCode, Post, Res } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import type { Response } from 'express'

import {
  type VisitorClaims,
  type WidgetMessage,
  widgetMessageSchema
} from '@platform/channels/web-widget'
import { ApiRoutes } from '@platform/core/api'
import { Public } from '@platform/core/auth-module'
import { ChannelIds, WidgetFieldIssues, WidgetThrottle } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import { RateLimit, ZodValidationPipe } from '@platform/core/http'
import { normalizePhone } from '@platform/core/messaging'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import { PluginRegistry } from '@platform/plugins/runtime'

import { InboundEventQueue } from '../channels/inbound-event-queue.service'

import { WidgetAway } from './widget-away.service'
import { WidgetHistory } from './widget-history.service'
import type { WidgetMessageView } from './widget-message-view'
import { allowOrigin } from './widget-origin'
import { type WidgetSite, WidgetSites } from './widget-sites.service'
import { WidgetTokens } from './widget-tokens.service'
import { WidgetUploads } from './widget-uploads.service'
import {
  type WidgetBootstrapBody,
  widgetBootstrapSchema,
  type WidgetUploadBody,
  widgetUploadSchema
} from './widget.schemas'

// A phone the core cannot read would be dropped without a word, and the visitor would think the
// store has it. It is refused before anything else is done, naming the field, so the form can say so.
function refuseUnreadablePhone(profile: WidgetMessage['profile']): void {
  const phone = profile?.phone?.trim()
  if (phone === undefined || phone === '' || normalizePhone(phone) !== null) return
  throw new PlatformException(
    ErrorCodes.VALIDATION_FAILED,
    'the phone is not valid',
    HttpStatusCodes.BAD_REQUEST,
    {
      issues: [
        {
          path: WidgetFieldIssues.PHONE_PATH,
          code: WidgetFieldIssues.INVALID_PHONE,
          message: 'the phone is not valid'
        }
      ],
      truncated: false
    }
  )
}

export interface WidgetBootstrapView {
  visitorToken: string
  expiresInSeconds: number
  store: { name: string; locale: string }
  away: boolean
  // The widget asks for name, email and phone before the first message, when nothing was said yet
  preChat: boolean
  messages: WidgetMessageView[]
  // The latest message of the visitor that an agent read, so a page that opens late shows "Seen"
  readUpToMessageId: string | null
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
    private readonly uploads: WidgetUploads,
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
    const [messages, readUpToMessageId, away] = await Promise.all([
      this.history.of(site, body.visitorId),
      this.history.readUpTo(site, body.visitorId),
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
      preChat: site.preChatEnabled,
      messages,
      readUpToMessageId
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
    const { claims, site } = await this.authenticate(body.visitorToken, origin, res)
    // A store that did not turn the form on takes no profile, whatever a script sends
    const accepted = site.preChatEnabled ? body : { ...body, profile: undefined }
    refuseUnreadablePhone(accepted.profile)
    // The files are the ones this visitor signed, checked here; what a script sends beside the ids
    // is not read. A message may carry only files.
    const attachments = await this.uploads.attachmentsOf(
      site,
      claims.visitorId,
      body.clientMessageId,
      body.uploadIds ?? []
    )
    try {
      const events = await this.registry.get(ChannelIds.WEB_WIDGET).handleWebhook({
        visitorToken: accepted.visitorToken,
        clientMessageId: accepted.clientMessageId,
        content: accepted.content,
        profile: accepted.profile,
        attachments
      })
      this.received.inc({ channel_type: ChannelIds.WEB_WIDGET })
      await this.queue.enqueue(ChannelIds.WEB_WIDGET, events)
    } catch (error) {
      // The message was not taken: its files are free for the visitor's next try
      await this.uploads.release(
        site.storeId,
        attachments.map(file => file.id),
        body.clientMessageId
      )
      throw error
    }
    return { received: true }
  }

  // The signed url for one file of the visitor; the file is attached by the message that names it
  @RateLimit(WidgetThrottle.UPLOAD)
  @Post(ApiRoutes.widget.upload)
  @HttpCode(HttpStatusCodes.OK)
  async upload(
    @Body(new ZodValidationPipe(widgetUploadSchema)) body: WidgetUploadBody,
    @Headers('origin') origin: string | undefined,
    @Res({ passthrough: true }) res: Response
  ): Promise<{ uploadUrl: string; uploadId: string }> {
    const { claims, site } = await this.authenticate(body.visitorToken, origin, res)
    return this.uploads.requestUrl(site, claims.visitorId, body)
  }

  // The token of a request, the site it names and the origin that may read the answer. A bad token
  // says nothing about why, and the widget has to tell an expired session from a network that is down
  // to start again.
  private async authenticate(
    token: string,
    origin: string | undefined,
    res: Response
  ): Promise<{ claims: VisitorClaims; site: WidgetSite }> {
    const claims = this.tokens.verify(token)
    if (claims === null) {
      this.rejected.inc({ channel_type: ChannelIds.WEB_WIDGET })
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
    return { claims, site }
  }
}
