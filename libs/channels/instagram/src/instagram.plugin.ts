import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { MetaChannelPlugin, type MetaAccount } from '@platform/channels/meta'
import { ChannelIds, InstagramApi, MetaGraph, MetaMessaging } from '@platform/core/domain'
import { ChannelCapability } from '@platform/plugins/sdk'

// A string: the id has 17 digits, more than a JSON number holds exactly, so a number would already
// be a different id by the time it is read
const profileSchema = z.object({ user_id: z.string(), username: z.string().min(1) })
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

  protected async fetchAccount(token: string): Promise<MetaAccount> {
    const answer = await this.meta.get({
      origin: this.origin,
      path: ['me'],
      token,
      query: { fields: InstagramApi.PROFILE_FIELDS },
      schema: answerSchema
    })
    // The flat profile is the one with the id; a `data` key beside it must not take its place
    const profile = 'user_id' in answer ? answer : answer.data[0]
    return { id: profile.user_id, displayName: profile.username }
  }
}
