import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { MetaChannelPlugin, type MetaAccount } from '@platform/channels/meta'
import { ChannelIds, InstagramApi, MetaGraph, MetaMessaging } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { ChannelCapability, PluginError } from '@platform/plugins/sdk'

const idSchema = z.union([z.string(), z.number()]).transform(String)
const profileSchema = z.object({ user_id: idSchema, username: z.string().min(1) })
// Meta's reference shows the profile alone and, in its sample answer, inside a list
const answerSchema = z.union([
  profileSchema,
  z.object({ data: z.tuple([profileSchema], z.unknown()) })
])

// Instagram Direct through Instagram API with Instagram Login: its own host, and the token of the
// Instagram professional account. The account id of the webhooks is the `user_id` of the profile.
@Injectable()
export class InstagramPlugin extends MetaChannelPlugin {
  readonly id = ChannelIds.INSTAGRAM
  readonly name = 'Instagram Direct'
  readonly capabilities = [
    ChannelCapability.TEXT,
    ChannelCapability.IMAGE,
    ChannelCapability.VIDEO,
    ChannelCapability.REACTIONS,
    ChannelCapability.REPLY_TO,
    ChannelCapability.MESSAGING_WINDOW
  ] as const

  protected readonly origin = MetaGraph.INSTAGRAM_ORIGIN
  protected readonly webhookObject = InstagramApi.WEBHOOK_OBJECT
  protected readonly subscribedFields = InstagramApi.SUBSCRIBED_FIELDS
  // Meta's reference sends a file under `attachments`
  protected readonly attachmentKey = MetaMessaging.ATTACHMENTS_KEY

  protected async readAccount(token: string): Promise<MetaAccount> {
    const answer = await this.meta.get({
      origin: this.origin,
      path: ['me'],
      token,
      query: { fields: InstagramApi.PROFILE_FIELDS },
      schema: answerSchema
    })
    const profile = 'data' in answer ? answer.data[0] : answer
    // The id goes into a path: digits only
    if (!MetaMessaging.RECIPIENT_ID_PATTERN.test(profile.user_id)) {
      throw new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
    }
    return { id: profile.user_id, displayName: profile.username }
  }
}
