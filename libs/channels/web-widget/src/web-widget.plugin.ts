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
import { AllowedContentTypes, GENERIC_CONTENT_TYPE, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'
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
  type FetchedMedia,
  PluginError,
  PluginTypes,
  type SendMediaParams,
  type SendMessageParams
} from '@platform/plugins/sdk'

import { WidgetConfig } from './widget-config'
import { type WidgetProfile, widgetInboundSchema } from './widget-message'
import { newSiteKey, originsLabel, siteOriginsSchema } from './widget-site'
import { verifyVisitorToken } from './widget-token'

// What the visitor typed, as the profile of the event; nothing when they typed nothing
function profileOf(profile: WidgetProfile | undefined): Pick<ChannelEvent, 'channelProfile'> {
  if (profile === undefined) return {}
  const channelProfile = {
    ...(profile.name === undefined ? {} : { displayName: profile.name }),
    ...(profile.email === undefined ? {} : { email: profile.email }),
    ...(profile.phone === undefined ? {} : { phone: profile.phone })
  }
  return Object.keys(channelProfile).length === 0 ? {} : { channelProfile }
}

// The kind of message a file makes: the first file of the message names it
function messageTypeOf(contentType: string): MessageType {
  if ((AllowedContentTypes.IMAGE as readonly string[]).includes(contentType))
    return MessageType.IMAGE
  if ((AllowedContentTypes.VIDEO as readonly string[]).includes(contentType))
    return MessageType.VIDEO
  if ((AllowedContentTypes.AUDIO as readonly string[]).includes(contentType))
    return MessageType.AUDIO
  return MessageType.DOCUMENT
}

// The id of an upload, the only reference the worker is given of a file
const uploadIdSchema = z.uuid()

const connectSchema = z.object({ siteOrigins: siteOriginsSchema })

// The channel every store gets (TDD_10 §5.4): a script on the store's site that a visitor chats from.
// The site key is the connection; the visitor is whoever the bootstrap gave a token to, and that token
// is what authenticates a message, where a provider's webhook has a signature. The plugin has no
// provider to call: a reply is delivered to the visitor's socket by the api when it is sent.
//
// Files from the visitor arrive as uploads the api checked (`attachments`) and are read from the
// bucket by the worker (`fetchMedia`) like any customer file; files to the visitor wait for PR F2.
// Typing is declared in both directions, and the read receipts too: the api tells the visitor's socket
// when an agent reads. There is no messaging window.
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

  constructor(
    private readonly config: WidgetConfig,
    private readonly storage: StorageService
  ) {}

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

  // The file of an upload: the api signed the url and checked the message that carries it, this only
  // reads what is under that upload id in the store of the connection. The key holds the name only the
  // api knew, so it is looked up by the id.
  async fetchMedia(ctx: ChannelContext, uploadId: string): Promise<FetchedMedia> {
    // The upload was never made, or the cleanup took it: the same answer every time
    const gone = (): PluginError =>
      new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false })
    if (!uploadIdSchema.safeParse(uploadId).success) throw gone()
    const page = await this.storage.list(StorageKeys.messageUploadPrefix(ctx.storeId, uploadId))
    const key = page.objects[0]?.key
    if (key === undefined) throw gone()
    // Head first: a stream opened for an object that is gone would be left open
    const stored = await this.storage.head(key)
    if (stored === null) throw gone()
    const stream = await this.storage.stream(key)
    if (stream === null) throw gone()
    // A type the bucket does not know is the generic one, which the worker replaces with the type the
    // message declared
    return {
      stream,
      contentType: stored.contentType ?? GENERIC_CONTENT_TYPE,
      contentLength: stored.contentLength
    }
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
    const message = widgetInboundSchema.safeParse(payload)
    if (!message.success) return Promise.resolve([])
    const claims = verifyVisitorToken(this.config.tokenKey, message.data.visitorToken)
    if (claims === null) return Promise.resolve([])
    const now = new Date().toISOString()
    const attachments = message.data.attachments ?? []
    const first = attachments[0]
    // Nothing to show: a message of the api with neither text nor files
    if (message.data.content === undefined && first === undefined) return Promise.resolve([])
    return Promise.resolve([
      {
        type: ChannelEventTypes.MESSAGE_RECEIVED,
        connectionId: claims.siteKey,
        channelIdentity: claims.visitorId,
        ...profileOf(message.data.profile),
        message: {
          // The visitor is part of it: ids are the browser's own, and two visitors may repeat one
          externalId: `${claims.visitorId}:${message.data.clientMessageId}`,
          type: first === undefined ? MessageType.TEXT : messageTypeOf(first.contentType),
          content: message.data.content ?? null,
          ...(attachments.length === 0
            ? {}
            : {
                media: attachments.map(file => ({
                  ref: file.id,
                  contentType: file.contentType,
                  filename: file.filename
                }))
              }),
          timestamp: now
        },
        timestamp: now
      }
    ])
  }
}
