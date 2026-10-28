import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { DeliveryStatus, type MetaGraphOrigin, MetaMessaging } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  type ChannelCapabilityType,
  type ChannelContext,
  type ChannelEvent,
  type ChannelHealth,
  type ChannelMessageResult,
  type ChannelPlugin,
  type ConnectInput,
  type ConnectResult,
  type FetchedMedia,
  PluginError,
  PluginTypes,
  type SendMediaParams,
  type SendMessageParams,
  type SendReactionParams
} from '@platform/plugins/sdk'

import { MetaGraphClient } from './meta-graph.client'
import { messagingToEvents } from './meta-messaging-events'
import { parseMetaTokenCredentials } from './meta-token-credentials'

const MESSAGING_WINDOW_HOURS = 24
// Meta: up to 7 days from the first message after a Click-to-Message ad (changelog of 2026-09-28)
const AD_WINDOW_HOURS = 168

const successSchema = z.object({ success: z.boolean() })
// The Send API answers with the ids of the recipient and the message
const sentSchema = z.object({ message_id: z.string().min(1) })
// A reaction is answered with the recipient only, and nobody reads it again
const acknowledgedSchema = z.record(z.string(), z.unknown())

export interface MetaAccount {
  // The Page or the Instagram account that receives the webhooks: `entry.id`
  id: string
  displayName: string
}

// The Graph API messaging that Instagram and Messenger share: one webhook shape and one Send API on
// two hosts. A subclass says its host, its webhook object, how to read its own account and the few
// places where the two differ. It holds no state and reads no environment: the connection's token
// arrives with every call, and the platform's Meta app (signature and handshake) is behind
// MetaGraphClient.
//
// Meta has no idempotency key, so `idempotencyKey` is not used; the client never repeats a send that
// may already have gone out.
@Injectable()
export abstract class MetaChannelPlugin implements ChannelPlugin {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly capabilities: readonly ChannelCapabilityType[]
  readonly version = '1.0.0'
  readonly author = 'Platform Team'
  readonly type = PluginTypes.CHANNEL
  // Meta policy: reply within 24 h of the last customer message, 7 days after an ad; no templates
  readonly messagingWindow = {
    hours: MESSAGING_WINDOW_HOURS,
    requiresTemplateWhenClosed: false,
    extendedHoursAfterAd: AD_WINDOW_HOURS
  }

  protected abstract readonly origin: MetaGraphOrigin
  protected abstract readonly webhookObject: string
  protected abstract readonly subscribedFields: string
  // The key that holds the file of a media message in the Send API
  protected abstract readonly attachmentKey: string

  constructor(protected readonly meta: MetaGraphClient) {}

  // Who the token belongs to, read from Meta with that token
  protected abstract readAccount(token: string): Promise<MetaAccount>

  // Fields of every send that only one of the two APIs wants
  protected sendFields(): Record<string, unknown> {
    return {}
  }

  // Where a reply to a message goes in the Send API
  protected replyFields(replyToExternalId: string | undefined): Record<string, unknown> {
    return replyToExternalId === undefined ? {} : { reply_to: { mid: replyToExternalId } }
  }

  async connect(input: ConnectInput): Promise<ConnectResult> {
    const { accessToken } = parseMetaTokenCredentials(input.credentials)
    const account = await this.readAccount(accessToken)
    // Webhooks only reach the app for an account that subscribed it. This also proves that the token
    // can act on the account it names.
    const subscribed = await this.meta.post({
      origin: this.origin,
      path: [account.id, MetaMessaging.EDGE_SUBSCRIBED_APPS],
      token: accessToken,
      query: { subscribed_fields: this.subscribedFields },
      idempotent: true,
      schema: successSchema
    })
    if (!subscribed.success) {
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
    }
    return {
      connectionId: account.id,
      displayName: account.displayName,
      credentials: { accessToken },
      metadata: {}
    }
  }

  // The subscription belongs to the account and a disconnected connection needs nothing from Meta:
  // the core drops the webhooks of a connection it does not have
  async disconnect(): Promise<void> {
    return Promise.resolve()
  }

  // A failure is thrown, not reported: the health service reads a PluginError as the state of the
  // connection (a revoked token is not a Meta outage)
  async healthCheck(ctx: ChannelContext): Promise<ChannelHealth> {
    await this.readAccount(parseMetaTokenCredentials(ctx.credentials).accessToken)
    return { healthy: true, checkedAt: new Date().toISOString() }
  }

  async sendMessage(ctx: ChannelContext, params: SendMessageParams): Promise<ChannelMessageResult> {
    return this.send(ctx, params.channelIdentity, {
      message: { text: params.content },
      ...this.replyFields(params.replyToExternalId)
    })
  }

  // Meta takes a file and no caption, so the caption is a message of its own after the file. Meta echoes
  // that second message too, so its id travels in `metadata.captionExternalId`: whoever deduplicates
  // the echoes has to know it. If the second call fails the file is already with the customer: it is
  // reported as failed for good, never as a retry that would send the file twice.
  async sendMedia(ctx: ChannelContext, params: SendMediaParams): Promise<ChannelMessageResult> {
    const sent = await this.send(ctx, params.channelIdentity, {
      message: {
        [this.attachmentKey]: {
          type: attachmentType(params.contentType),
          payload: { url: params.mediaUrl }
        }
      },
      ...this.replyFields(params.replyToExternalId)
    })
    if (!params.caption) return sent
    try {
      const caption = await this.send(ctx, params.channelIdentity, {
        message: { text: params.caption }
      })
      return { ...sent, metadata: { captionExternalId: caption.externalId } }
    } catch {
      throw new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false })
    }
  }

  async sendReaction(ctx: ChannelContext, params: SendReactionParams): Promise<void> {
    const { accessToken } = parseMetaTokenCredentials(ctx.credentials)
    // The same reaction twice is the same reaction: the call is safe to repeat
    await this.meta.post({
      origin: this.origin,
      path: [ctx.connectionId, MetaMessaging.EDGE_MESSAGES],
      token: accessToken,
      body: {
        recipient: { id: params.channelIdentity },
        sender_action:
          params.emoji === null ? MetaMessaging.ACTION_UNREACT : MetaMessaging.ACTION_REACT,
        payload: {
          message_id: params.targetExternalId,
          ...(params.emoji === null ? {} : { reaction: params.emoji })
        }
      },
      idempotent: true,
      schema: acknowledgedSchema
    })
  }

  verifyWebhook(query: Record<string, string>): string | null {
    return this.meta.verifyHubChallenge(query)
  }

  validateWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
    return this.meta.isValidSignature(rawBody, headers)
  }

  async handleWebhook(payload: unknown): Promise<ChannelEvent[]> {
    return Promise.resolve(messagingToEvents(payload, this.webhookObject))
  }

  // The reference of a file is the url Meta put in the webhook, a link of its CDN
  async fetchMedia(_ctx: ChannelContext, mediaRef: string): Promise<FetchedMedia> {
    return this.meta.downloadMediaUrl(mediaRef)
  }

  private async send(
    ctx: ChannelContext,
    recipientId: string,
    body: Record<string, unknown>
  ): Promise<ChannelMessageResult> {
    const { accessToken } = parseMetaTokenCredentials(ctx.credentials)
    const response = await this.meta.post({
      origin: this.origin,
      path: [ctx.connectionId, MetaMessaging.EDGE_MESSAGES],
      token: accessToken,
      body: { recipient: { id: recipientId }, ...this.sendFields(), ...body },
      schema: sentSchema
    })
    return {
      externalId: response.message_id,
      status: DeliveryStatus.SENT,
      sentAt: new Date().toISOString()
    }
  }
}

// The kind of file the Send API wants, from its content type; anything else goes as a file
function attachmentType(contentType: string): string {
  if (contentType.startsWith('image/')) return MetaMessaging.ATTACHMENT_IMAGE
  if (contentType.startsWith('video/')) return MetaMessaging.ATTACHMENT_VIDEO
  if (contentType.startsWith('audio/')) return MetaMessaging.ATTACHMENT_AUDIO
  return MetaMessaging.ATTACHMENT_FILE
}
