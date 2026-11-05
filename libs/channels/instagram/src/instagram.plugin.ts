import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { MetaChannelPlugin, type MetaAccount } from '@platform/channels/meta'
import {
  ChannelConnectFieldKeys,
  ChannelIds,
  InstagramApi,
  MetaGraph,
  MetaMessaging,
  type MetaWebhookApp,
  MetaWebhookApps
} from '@platform/core/domain'
import { ErrorCodes, PluginChecks, type PluginCheck } from '@platform/core/errors'
import { ChannelCapability, PluginError } from '@platform/plugins/sdk'

// A string: the id has 17 digits, more than a JSON number holds exactly, so a number would already
// be a different id by the time it is read
const accountSchema = z.object({ id: z.string(), username: z.string().min(1) })
// Only the account that is picked is read in full: the others belong to the business, and a badly
// shaped one must not break the connection of another
const accountsSchema = z.object({ data: z.array(z.unknown()) })
const idOnlySchema = z.object({ id: z.unknown() })

// The refusal names the check, never the value: the log says why a token was not taken
function refused(failedCheck: PluginCheck): PluginError {
  return new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false, failedCheck })
}

// Instagram Direct through the Instagram API with Unified Login: Facebook's host and the token of a
// system user of the owner's business, which the owner pastes (there is no login flow). The token
// belongs to the business, not to an account: the account is read from the ones it was shared with,
// and its id is the one the webhooks carry in `entry.id`.
@Injectable()
export class InstagramPlugin extends MetaChannelPlugin {
  readonly id = ChannelIds.INSTAGRAM
  readonly name = 'Instagram Direct'
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
  // Meta's reference sends a file under `attachments`
  protected readonly attachmentKey = MetaMessaging.ATTACHMENTS_KEY
  protected readonly userProfileFields = InstagramApi.USER_PROFILE_FIELDS

  // A new connection is one account: a token that reaches none, or several (well shaped or not), is
  // refused, because the owner would otherwise connect an account by the order Meta lists them in. A
  // connection that exists asks for its own account among the ones the token reaches, and the others
  // are not read, so a badly shaped one cannot break it.
  protected async fetchAccount(token: string, expectedId?: string): Promise<MetaAccount> {
    const answer = await this.meta.get({
      origin: this.origin,
      path: ['me', InstagramApi.ACCOUNTS_EDGE],
      token,
      query: { fields: InstagramApi.PROFILE_FIELDS, limit: InstagramApi.ACCOUNTS_PAGE_LIMIT },
      schema: accountsSchema
    })
    const candidates = answer.data.filter(entry => {
      if (expectedId === undefined) return true
      const named = idOnlySchema.safeParse(entry)
      return named.success && named.data.id === expectedId
    })
    if (candidates.length === 0) throw refused(PluginChecks.ACCOUNT_NOT_FOUND)
    if (candidates.length > 1) throw refused(PluginChecks.ACCOUNT_AMBIGUOUS)
    const parsed = accountSchema.safeParse(candidates[0])
    if (!parsed.success) throw refused(PluginChecks.ACCOUNT_SHAPE_INVALID)
    const account = parsed.data
    return { id: account.id, displayName: account.username }
  }
}
