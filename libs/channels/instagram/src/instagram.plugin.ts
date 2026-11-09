import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { MetaChannelPlugin, type MetaAccount } from '@platform/channels/meta'
import { InstagramMedia } from '@platform/core/channel-media'
import {
  ChannelConnectFieldKeys,
  ChannelIds,
  type ChannelLimits,
  InstagramApi,
  MetaGraph,
  MetaMessaging,
  type MetaWebhookApp,
  MetaWebhookApps
} from '@platform/core/domain'
import { ErrorCodes, PluginChecks, type PluginCheck } from '@platform/core/errors'
import { ChannelCapability, type ChannelContext, PluginError } from '@platform/plugins/sdk'

// A string: the id has 17 digits, more than a JSON number holds exactly, so a number would already
// be a different id by the time it is read
const pageSchema = z.object({
  id: z.string(),
  [InstagramApi.PAGE_ACCOUNT_KEY]: z.unknown().optional()
})
const accountSchema = z.object({ id: z.string(), username: z.string().min(1) })

// The refusal names the check, never the value: the log says why a token was not taken
function refused(failedCheck: PluginCheck): PluginError {
  return new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false, failedCheck })
}

// Instagram Direct through the Messenger Platform with Facebook Login: Facebook's host and the token of the
// Page linked to the account, which the owner pastes (there is no login flow). The token is the Page's:
// `me` is the Page and the account is the one it links, whose id is the one the webhooks carry in
// `entry.id`. The connection is the account; the Page is kept in its metadata, so that a token of
// another Page is not taken for the connection's own.
@Injectable()
export class InstagramPlugin extends MetaChannelPlugin {
  readonly id = ChannelIds.INSTAGRAM
  readonly name = 'Instagram Direct'
  readonly limits: ChannelLimits = { textMaxLength: 1000 }
  readonly connectFields = [
    {
      key: 'accessToken',
      labelKey: ChannelConnectFieldKeys.INSTAGRAM_ACCESS_TOKEN,
      secret: true,
      required: true,
      multiple: false
    }
  ] as const
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

  // Instagram can have an app of its own: its webhooks are then signed by that app's secret
  protected readonly webhookApp: MetaWebhookApp = MetaWebhookApps.INSTAGRAM
  protected readonly origin = MetaGraph.ORIGIN
  protected readonly webhookObject = InstagramApi.WEBHOOK_OBJECT
  protected readonly subscribedFields = InstagramApi.SUBSCRIBED_FIELDS
  // Meta takes png, jpeg and gif images, a few audio and video formats and only pdf as a file
  readonly media = InstagramMedia
  protected readonly userProfileFields = InstagramApi.USER_PROFILE_FIELDS

  protected override subscribeOwner(): string {
    return InstagramApi.SUBSCRIBE_OWNER
  }

  protected override sendOwner(): string {
    return InstagramApi.SEND_OWNER
  }

  // The Page the token is of and the one account it links; a Page with none is refused. A token that is
  // not a Page's (a user's) is refused by Meta itself: asking a User node for this field is error 100
  // ("nonexisting field"), which the log shows as `providerCode` 100. The expected id is not needed: a
  // Page links one account, and the health check compares it with the connection's own.
  protected async fetchAccount(token: string): Promise<MetaAccount> {
    const page = await this.meta.get({
      origin: this.origin,
      path: ['me'],
      token,
      query: { fields: InstagramApi.PAGE_ACCOUNT_FIELDS },
      schema: pageSchema
    })
    if (!MetaMessaging.RECIPIENT_ID_PATTERN.test(page.id)) {
      throw refused(PluginChecks.PAGE_ID_NOT_NUMERIC)
    }
    const linked = page[InstagramApi.PAGE_ACCOUNT_KEY]
    if (linked === undefined || linked === null) throw refused(PluginChecks.ACCOUNT_NOT_FOUND)
    const parsed = accountSchema.safeParse(linked)
    if (!parsed.success) throw refused(PluginChecks.ACCOUNT_SHAPE_INVALID)
    return {
      id: parsed.data.id,
      displayName: parsed.data.username,
      metadata: { [InstagramApi.METADATA_PAGE_ID]: page.id }
    }
  }

  protected override fetchHealthAccount(
    token: string
  ): Promise<Pick<MetaAccount, 'id' | 'metadata'>> {
    return this.fetchAccount(token)
  }

  // The token must still be of the Page recorded when the connection was made. `connect` writes the
  // credentials and the Page together, so this only fails when they have come apart (a credential
  // changed by another path, a row with no Page): it is a guard on that, not on a reconnect.
  protected override verifyBinding(
    account: Pick<MetaAccount, 'id' | 'metadata'>,
    ctx: ChannelContext
  ): void {
    const expected = ctx.metadata[InstagramApi.METADATA_PAGE_ID]
    if (
      typeof expected !== 'string' ||
      account.metadata?.[InstagramApi.METADATA_PAGE_ID] !== expected
    ) {
      throw refused(PluginChecks.PAGE_ID_MISMATCH)
    }
  }
}
