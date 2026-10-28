import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { MetaGraphClient } from '@platform/channels/meta'
import {
  ChannelIds,
  DeliveryStatus,
  WhatsAppApi,
  WhatsAppLimits,
  WhatsAppTemplateComponents,
  WhatsAppTemplateStatuses
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  ChannelCapability,
  type ChannelContext,
  type ChannelEvent,
  type ChannelHealth,
  type ChannelMessageResult,
  type ChannelPlugin,
  type ConnectInput,
  type ConnectResult,
  type FetchedMedia,
  type MarkReadParams,
  type MessageTemplate,
  PluginError,
  PluginTypes,
  type SendButtonsParams,
  type SendLocationParams,
  type SendMediaParams,
  type SendMessageParams,
  type SendTemplateParams
} from '@platform/plugins/sdk'

import { parseWhatsAppCredentials, type WhatsAppCredentials } from './whatsapp-credentials'
import { webhookToEvents } from './whatsapp-events'
import {
  buttonsPayload,
  locationPayload,
  mediaPayload,
  readReceiptPayload,
  templatePayload,
  textPayload
} from './whatsapp-payloads'

const MESSAGING_WINDOW_HOURS = 24

const phoneSchema = z.object({
  display_phone_number: z.string().min(1),
  verified_name: z.string().optional()
})

// Meta answers a send with the id of the message; it may list more than one, the first is ours
const sentSchema = z.object({
  messages: z.tuple([z.object({ id: z.string().min(1) })], z.unknown())
})

const successSchema = z.object({ success: z.boolean() })

const templateComponentSchema = z.object({
  type: z.string(),
  format: z.string().optional(),
  text: z.string().optional(),
  buttons: z.array(z.object({ type: z.string(), url: z.string().optional() })).optional()
})

const templateSchema = z.object({
  name: z.string(),
  language: z.string(),
  status: z.string(),
  components: z.array(templateComponentSchema).optional()
})

type TemplateComponent = z.infer<typeof templateComponentSchema>

const hasVariable = (text: string | undefined): boolean => text?.includes('{{') === true

// Variables are sent by position ({{1}}, {{2}}); a named one ({{first_name}}) needs its name in the send
const POSITIONAL_VARIABLES_ONLY = /^(?:(?!\{\{).|\{\{\d+\}\})*$/s

// What `templatePayload` can fill is the variables of the body. A template that needs more (an image
// or video header, a variable in the header or in a button url, a carousel) would be rejected by Meta
// for a missing parameter, so it is not offered to the agent.
function isFillable(component: TemplateComponent): boolean {
  switch (component.type) {
    case WhatsAppTemplateComponents.BODY:
      return POSITIONAL_VARIABLES_ONLY.test(component.text ?? '')
    case WhatsAppTemplateComponents.FOOTER:
      return true
    case WhatsAppTemplateComponents.HEADER:
      return (
        component.format === WhatsAppTemplateComponents.TEXT_FORMAT && !hasVariable(component.text)
      )
    case WhatsAppTemplateComponents.BUTTONS:
      return (component.buttons ?? []).every(
        button =>
          WhatsAppTemplateComponents.FILLABLE_BUTTONS.some(type => type === button.type) &&
          !hasVariable(button.url)
      )
    default:
      return false
  }
}

const phoneIdSchema = z.object({ id: z.string() })

const pagingSchema = z
  .object({
    cursors: z.object({ after: z.string().optional() }).optional(),
    next: z.string().optional()
  })
  .optional()

function templateStatus(status: string): MessageTemplate['status'] {
  if (status === WhatsAppTemplateStatuses.APPROVED) return 'approved'
  if (
    status === WhatsAppTemplateStatuses.PENDING ||
    status === WhatsAppTemplateStatuses.IN_APPEAL
  ) {
    return 'pending'
  }
  // REJECTED, PAUSED, DISABLED: none of them can be sent
  return 'rejected'
}

// WhatsApp Business through the Cloud API (TDD_10 §5.1). It holds no state and reads no environment:
// the connection's credentials arrive with every call, and the platform's Meta app (signature and
// handshake) is behind MetaGraphClient.
//
// Meta has no idempotency key, so `idempotencyKey` is not used; the client never repeats a send that
// may already have gone out.
@Injectable()
export class WhatsAppPlugin implements ChannelPlugin {
  readonly id = ChannelIds.WHATSAPP
  readonly name = 'WhatsApp Business'
  readonly version = '1.0.0'
  readonly author = 'Platform Team'
  readonly type = PluginTypes.CHANNEL
  readonly messagingWindow = { hours: MESSAGING_WINDOW_HOURS, requiresTemplateWhenClosed: true }

  // No list picker: the SDK has no method to send one
  readonly capabilities = [
    ChannelCapability.TEXT,
    ChannelCapability.IMAGE,
    ChannelCapability.VIDEO,
    ChannelCapability.AUDIO,
    ChannelCapability.DOCUMENT,
    ChannelCapability.LOCATION,
    ChannelCapability.BUTTONS,
    ChannelCapability.TEMPLATES,
    ChannelCapability.READ_RECEIPTS,
    ChannelCapability.DELIVERY_RECEIPTS,
    ChannelCapability.REPLY_TO,
    ChannelCapability.REACTIONS,
    ChannelCapability.MESSAGING_WINDOW
  ] as const

  constructor(private readonly meta: MetaGraphClient) {}

  async connect(input: ConnectInput): Promise<ConnectResult> {
    const credentials = parseWhatsAppCredentials(input.credentials)
    const profile = await this.getPhoneNumber(credentials)
    // Both ids come from the caller and the token may reach several assets: the number must be under
    // the account it is saved with, or its webhooks, templates and sends would come from two places
    const numbers = await this.listEdge(
      credentials,
      [credentials.businessAccountId, WhatsAppApi.EDGE_PHONE_NUMBERS],
      'id',
      phoneIdSchema
    )
    if (!numbers.some(number => number.id === credentials.phoneNumberId)) {
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
    }
    // Webhooks only reach the app for a business account that subscribed it. This also proves that the
    // token can act on the account it names.
    const subscribed = await this.meta.post({
      path: [credentials.businessAccountId, WhatsAppApi.EDGE_SUBSCRIBED_APPS],
      token: credentials.accessToken,
      idempotent: true,
      schema: successSchema
    })
    if (!subscribed.success) {
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
    }
    return {
      connectionId: credentials.phoneNumberId,
      displayName: profile.display_phone_number,
      credentials,
      metadata: {
        businessAccountId: credentials.businessAccountId,
        ...(profile.verified_name ? { verifiedName: profile.verified_name } : {})
      }
    }
  }

  // The subscription belongs to the account, not to the number: deleting it would cut off the other
  // numbers of the same account. A disconnected number needs nothing from Meta, because the core
  // drops the webhooks of a connection it does not have.
  async disconnect(): Promise<void> {
    return Promise.resolve()
  }

  // A failure is thrown, not reported: the health service reads a PluginError as the state of the
  // connection (a revoked token is not a Meta outage)
  async healthCheck(ctx: ChannelContext): Promise<ChannelHealth> {
    await this.getPhoneNumber(parseWhatsAppCredentials(ctx.credentials))
    return { healthy: true, checkedAt: new Date().toISOString() }
  }

  async sendMessage(ctx: ChannelContext, params: SendMessageParams): Promise<ChannelMessageResult> {
    return this.send(ctx, textPayload(params))
  }

  async sendMedia(ctx: ChannelContext, params: SendMediaParams): Promise<ChannelMessageResult> {
    return this.send(ctx, mediaPayload(params))
  }

  async sendTemplate(
    ctx: ChannelContext,
    params: SendTemplateParams
  ): Promise<ChannelMessageResult> {
    return this.send(ctx, templatePayload(params))
  }

  async sendButtons(ctx: ChannelContext, params: SendButtonsParams): Promise<ChannelMessageResult> {
    return this.send(ctx, buttonsPayload(params))
  }

  async sendLocation(
    ctx: ChannelContext,
    params: SendLocationParams
  ): Promise<ChannelMessageResult> {
    return this.send(ctx, locationPayload(params))
  }

  async markAsRead(ctx: ChannelContext, params: MarkReadParams): Promise<void> {
    const credentials = parseWhatsAppCredentials(ctx.credentials)
    await this.meta.post({
      path: [credentials.phoneNumberId, WhatsAppApi.EDGE_MESSAGES],
      token: credentials.accessToken,
      body: readReceiptPayload(params.externalId),
      idempotent: true,
      schema: successSchema
    })
  }

  async listTemplates(ctx: ChannelContext): Promise<MessageTemplate[]> {
    const credentials = parseWhatsAppCredentials(ctx.credentials)
    const templates = await this.listEdge(
      credentials,
      [credentials.businessAccountId, WhatsAppApi.EDGE_TEMPLATES],
      WhatsAppApi.TEMPLATE_FIELDS,
      templateSchema
    )
    return templates
      .filter(template => (template.components ?? []).every(isFillable))
      .map(template => ({
        name: template.name,
        language: template.language,
        status: templateStatus(template.status),
        body:
          template.components?.find(component => component.type === WhatsAppTemplateComponents.BODY)
            ?.text ?? ''
      }))
  }

  verifyWebhook(query: Record<string, string>): string | null {
    return this.meta.verifyHubChallenge(query)
  }

  validateWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
    return this.meta.isValidSignature(rawBody, headers)
  }

  async handleWebhook(payload: unknown): Promise<ChannelEvent[]> {
    return Promise.resolve(webhookToEvents(payload))
  }

  async fetchMedia(ctx: ChannelContext, mediaRef: string): Promise<FetchedMedia> {
    const credentials = parseWhatsAppCredentials(ctx.credentials)
    return this.meta.downloadMedia(credentials.accessToken, mediaRef)
  }

  // The items of an edge, page after page up to a bound
  private async listEdge<T>(
    credentials: WhatsAppCredentials,
    path: readonly string[],
    fields: string,
    item: z.ZodType<T>
  ): Promise<T[]> {
    const pageSchema = z.object({ data: z.array(item), paging: pagingSchema })
    const items: T[] = []
    let after: string | undefined
    for (let page = 0; page < WhatsAppLimits.MAX_PAGES; page++) {
      const result = await this.meta.get({
        path,
        token: credentials.accessToken,
        query: { fields, limit: String(WhatsAppLimits.PAGE_SIZE), ...(after ? { after } : {}) },
        schema: pageSchema
      })
      items.push(...result.data)
      after = result.paging?.next ? result.paging.cursors?.after : undefined
      if (!after) break
    }
    return items
  }

  private async getPhoneNumber(
    credentials: WhatsAppCredentials
  ): Promise<z.infer<typeof phoneSchema>> {
    return this.meta.get({
      path: [credentials.phoneNumberId],
      token: credentials.accessToken,
      query: { fields: WhatsAppApi.PHONE_FIELDS },
      schema: phoneSchema
    })
  }

  private async send(ctx: ChannelContext, body: object): Promise<ChannelMessageResult> {
    const credentials = parseWhatsAppCredentials(ctx.credentials)
    const response = await this.meta.post({
      path: [credentials.phoneNumberId, WhatsAppApi.EDGE_MESSAGES],
      token: credentials.accessToken,
      body,
      schema: sentSchema
    })
    return {
      externalId: response.messages[0].id,
      status: DeliveryStatus.SENT,
      sentAt: new Date().toISOString()
    }
  }
}
