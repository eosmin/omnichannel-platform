import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { MetaChannelPlugin, type MetaAccount } from '@platform/channels/meta'
import { MessengerMedia } from '@platform/core/channel-media'
import {
  ChannelConnectFieldKeys,
  ChannelIds,
  type ChannelLimits,
  ChannelSetupStepKeys,
  MessengerApi,
  MetaErrorCodes,
  MetaGraph,
  type MetaWebhookApp,
  MetaWebhookApps
} from '@platform/core/domain'
import { ChannelCapability, PluginError } from '@platform/plugins/sdk'

const pageIdSchema = z.object({ id: z.string() })
// `name` is optional: a token without pages_read_engagement may be answered with the id alone
const pageSchema = z.object({ id: z.string(), name: z.string().optional() })

function isNameNotReadable(error: unknown): boolean {
  if (!(error instanceof PluginError) || error.retryable === true || error.outcomeUnknown) {
    return false
  }
  const code = error.providerCode
  return (
    code !== undefined &&
    (code === MetaErrorCodes.INVALID_PARAMETER ||
      code === MetaErrorCodes.PERMISSION_DENIED ||
      (code >= MetaErrorCodes.PERMISSION_RANGE_START &&
        code <= MetaErrorCodes.PERMISSION_RANGE_END))
  )
}

// Facebook Messenger with the access token of the Page: it names the Page it belongs to
@Injectable()
export class MessengerPlugin extends MetaChannelPlugin {
  readonly id = ChannelIds.MESSENGER
  readonly name = 'Facebook Messenger'
  readonly limits: ChannelLimits = { textMaxLength: 2000 }
  readonly connectFields = [
    {
      key: 'accessToken',
      labelKey: ChannelConnectFieldKeys.MESSENGER_ACCESS_TOKEN,
      secret: true,
      required: true,
      multiple: false
    }
  ] as const
  // Reading a customer's name and photo needs "Business Asset User Profile Access", requested by the
  // owner in the settings of the Page
  readonly profileSetupKey = ChannelSetupStepKeys.MESSENGER_PROFILE_ACCESS
  // No buttons: Phase 2
  readonly capabilities = [
    ChannelCapability.TEXT,
    ChannelCapability.IMAGE,
    ChannelCapability.VIDEO,
    ChannelCapability.AUDIO,
    ChannelCapability.DOCUMENT,
    ChannelCapability.REACTIONS,
    ChannelCapability.REPLY_TO,
    ChannelCapability.CUSTOMER_PROFILE,
    ChannelCapability.TYPING_INDICATOR,
    ChannelCapability.READ_RECEIPTS,
    ChannelCapability.MESSAGING_WINDOW
  ] as const

  // Messenger belongs to the main app, always
  protected readonly webhookApp: MetaWebhookApp = MetaWebhookApps.MAIN
  protected readonly origin = MetaGraph.ORIGIN
  protected readonly webhookObject = MessengerApi.WEBHOOK_OBJECT
  protected readonly subscribedFields = MessengerApi.SUBSCRIBED_FIELDS
  readonly media = MessengerMedia
  protected readonly userProfileFields = MessengerApi.USER_PROFILE_FIELDS

  protected override sendFields(): Record<string, unknown> {
    return { messaging_type: MessengerApi.MESSAGING_TYPE_RESPONSE }
  }

  // The id first, alone: it needs no permission. The name needs `pages_read_engagement` (error 100
  // without it), and a name is a label, not a reason to refuse a token that can receive and send; so a
  // name that cannot be read is replaced, not required (least privilege).
  protected override async fetchAccountId(token: string): Promise<string> {
    const { id } = await this.meta.get({
      origin: this.origin,
      path: ['me'],
      token,
      query: { fields: MessengerApi.PROFILE_ID_FIELD },
      schema: pageIdSchema
    })
    return id
  }

  protected async fetchAccount(token: string): Promise<MetaAccount> {
    const id = await this.fetchAccountId(token)
    const fallback = `${MessengerApi.FALLBACK_NAME_PREFIX} ${id}`
    try {
      const page = await this.meta.get({
        origin: this.origin,
        path: ['me'],
        token,
        query: { fields: MessengerApi.PROFILE_NAME_FIELDS },
        schema: pageSchema
      })
      const name = page.name?.trim()
      const named = page.id === id && name !== undefined && name !== ''
      return named
        ? { id, displayName: name }
        : { id, displayName: fallback, displayNameIsPlaceholder: true }
    } catch (error) {
      // Only the refusal of the field: a token revoked between the two reads, a throttle or an outage
      // is not "no permission" and must not be stored as a name
      if (isNameNotReadable(error))
        return { id, displayName: fallback, displayNameIsPlaceholder: true }
      throw error
    }
  }
}
