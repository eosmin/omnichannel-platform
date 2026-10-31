import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import {
  ChannelIds,
  DeliveryStatus,
  MessageType,
  WIDGET_TOKEN_HEADER,
  WidgetMetadataKeys
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  ChannelCapability,
  type ChannelContext,
  type ChannelEvent,
  ChannelEventTypes,
  type ChannelHealth,
  type ChannelMessageResult,
  type ChannelPlugin,
  type ConnectInput,
  type ConnectResult,
  PluginError,
  PluginTypes,
  type SendMediaParams,
  type SendMessageParams
} from '@platform/plugins/sdk'

import { WidgetConfig } from './widget-config'
import { widgetMessageSchema } from './widget-message'
import { newSiteKey, originsLabel, siteOriginsSchema } from './widget-site'
import { verifyVisitorToken } from './widget-token'

const connectSchema = z.object({ siteOrigins: siteOriginsSchema })

// The channel every store gets (TDD_10 §5.4): a script on the store's site that a visitor chats from.
// The site key is the connection; the visitor is whoever the bootstrap gave a token to, and that token
// is what authenticates a message, where a provider's webhook has a signature. The plugin has no
// provider to call: a reply is delivered to the visitor's socket by the api when it is sent.
//
// Text only for now: files wait for the storage of Step 3.4. Typing is declared in both directions,
// and the read receipts too: the api tells the visitor's socket when an agent reads. There is no
// messaging window.
@Injectable()
export class WebWidgetPlugin implements ChannelPlugin {
  readonly id = ChannelIds.WEB_WIDGET
  readonly name = 'Web widget'
  readonly version = '1.0.0'
  readonly author = 'Platform Team'
  readonly type = PluginTypes.CHANNEL
  readonly messagingWindow = null
  readonly capabilities = [
    ChannelCapability.TEXT,
    ChannelCapability.TYPING_INDICATOR,
    ChannelCapability.CUSTOMER_TYPING,
    ChannelCapability.READ_RECEIPTS
  ] as const

  constructor(private readonly config: WidgetConfig) {}

  // Nothing to prove to a provider: a new site key for the sites the owner lists
  connect(input: ConnectInput): Promise<ConnectResult> {
    const parsed = connectSchema.safeParse(input.credentials)
    if (!parsed.success) {
      return Promise.reject(
        new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
      )
    }
    const origins = parsed.data.siteOrigins
    return Promise.resolve({
      connectionId: newSiteKey(),
      displayName: originsLabel(origins),
      credentials: {},
      metadata: { [WidgetMetadataKeys.ALLOWED_ORIGINS]: origins }
    })
  }

  disconnect(): Promise<void> {
    return Promise.resolve()
  }

  healthCheck(): Promise<ChannelHealth> {
    return Promise.resolve({ healthy: true, checkedAt: new Date().toISOString() })
  }

  // The reply is stored by the core and pushed to the visitor's socket by the api; this only says it
  // is accepted. The id is ours: there is no provider to give one.
  sendMessage(_ctx: ChannelContext, params: SendMessageParams): Promise<ChannelMessageResult> {
    return Promise.resolve({
      externalId: params.idempotencyKey,
      status: DeliveryStatus.SENT,
      sentAt: new Date().toISOString()
    })
  }

  // Shown to the visitor by the api through their socket, where the plugin has no reach: the capability
  // is declared so that the inbox knows the channel shows it, and the worker has nothing to send
  sendTypingIndicator(): Promise<void> {
    return Promise.resolve()
  }

  // Same: the visitor is told through their socket by the api when the read route runs
  markAsRead(): Promise<void> {
    return Promise.resolve()
  }

  sendMedia(_ctx: ChannelContext, _params: SendMediaParams): Promise<ChannelMessageResult> {
    return Promise.reject(
      new PluginError(ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED, { retryable: false })
    )
  }

  // The token is the signature: the request is genuine when it carries one this platform gave a
  // visitor. The api puts it in the header from the body of the visitor's request.
  validateWebhookSignature(_rawBody: string, headers: Record<string, string>): boolean {
    return verifyVisitorToken(this.config.tokenKey, headers[WIDGET_TOKEN_HEADER]) !== null
  }

  handleWebhook(payload: unknown): Promise<ChannelEvent[]> {
    const message = widgetMessageSchema.safeParse(payload)
    if (!message.success) return Promise.resolve([])
    const claims = verifyVisitorToken(this.config.tokenKey, message.data.visitorToken)
    if (claims === null) return Promise.resolve([])
    const now = new Date().toISOString()
    return Promise.resolve([
      {
        type: ChannelEventTypes.MESSAGE_RECEIVED,
        connectionId: claims.siteKey,
        channelIdentity: claims.visitorId,
        message: {
          // The visitor is part of it: ids are the browser's own, and two visitors may repeat one
          externalId: `${claims.visitorId}:${message.data.clientMessageId}`,
          type: MessageType.TEXT,
          content: message.data.content,
          timestamp: now
        },
        timestamp: now
      }
    ])
  }
}
