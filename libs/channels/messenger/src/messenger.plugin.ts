import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { MetaChannelPlugin, type MetaAccount } from '@platform/channels/meta'
import { ChannelIds, MessengerApi, MetaGraph, MetaMessaging } from '@platform/core/domain'
import { ChannelCapability } from '@platform/plugins/sdk'

const pageSchema = z.object({ id: z.string(), name: z.string().min(1) })

// Facebook Messenger with the access token of the Page: it names the Page it belongs to
@Injectable()
export class MessengerPlugin extends MetaChannelPlugin {
  readonly id = ChannelIds.MESSENGER
  readonly name = 'Facebook Messenger'
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
    ChannelCapability.MESSAGING_WINDOW
  ] as const

  protected readonly origin = MetaGraph.ORIGIN
  protected readonly webhookObject = MessengerApi.WEBHOOK_OBJECT
  protected readonly subscribedFields = MessengerApi.SUBSCRIBED_FIELDS
  protected readonly attachmentKey = MetaMessaging.ATTACHMENT_KEY
  protected readonly userProfileFields = MessengerApi.USER_PROFILE_FIELDS

  protected override sendFields(): Record<string, unknown> {
    return { messaging_type: MessengerApi.MESSAGING_TYPE_RESPONSE }
  }

  protected async fetchAccount(token: string): Promise<MetaAccount> {
    const page = await this.meta.get({
      origin: this.origin,
      path: ['me'],
      token,
      query: { fields: MessengerApi.PROFILE_FIELDS },
      schema: pageSchema
    })
    return { id: page.id, displayName: page.name }
  }
}
