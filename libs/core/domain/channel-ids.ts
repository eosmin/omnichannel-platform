import { z } from 'zod'

import {
  type ChannelConnectFailureReason,
  ChannelConnectFailureReasons
} from './errors/channel-connect-failures'
import { MessageType } from './status-enums'
import { WhatsAppLimits } from './whatsapp-constants'
import { WidgetLimits } from './widget-constants'

// The ids of the official channel plugins. A channel is the id of a registered plugin (TDD_10 §6.7),
// so this list is not the set of all channels: a plugin the owner adds brings an id of its own.
export const ChannelIds = {
  WHATSAPP: 'whatsapp',
  INSTAGRAM: 'instagram',
  MESSENGER: 'messenger',
  WEB_WIDGET: 'web_widget'
} as const
export type OfficialChannelId = (typeof ChannelIds)[keyof typeof ChannelIds]

const OFFICIAL_IDS: ReadonlySet<string> = new Set(Object.values(ChannelIds))

// The one place that says whether an id belongs to an official plugin
export function isOfficialChannelId(id: unknown): id is OfficialChannelId {
  return typeof id === 'string' && OFFICIAL_IDS.has(id)
}

// What the id of any channel plugin must look like, official or not
export const CHANNEL_ID_PATTERN = /^[a-z][a-z0-9_-]{2,31}$/

// For the routes that exist only for official plugins (the public webhook of TDD_10 §4)
export const officialChannelSchema = z.enum(ChannelIds)

// The id of any channel: the id of a registered plugin. The registry says whether it is registered;
// this is only its shape, for a schema that cannot reach the registry (the service checks it).
export type ChannelId = string
export const channelIdSchema = z.string().regex(CHANNEL_ID_PATTERN)

// The official ids under their old name, for the code that is about official channels only
export const ChannelType = ChannelIds
export type ChannelType = OfficialChannelId

// The health check of the connections (TDD_10 §10): one call to the provider each, so it is bounded
export const ChannelHealthLimits = {
  CHECK_TIMEOUT_MS: 10_000,
  // Connecting or disconnecting talks to the provider too, from a request that someone waits for
  PROVIDER_TIMEOUT_MS: 15_000,
  CONCURRENCY: 5,
  // A round starts no new check after this, so that it ends before its lock does and before the next
  // round; what it did not reach goes first in the next one
  ROUND_BUDGET_MS: 200_000,
  ERROR_MAX_LENGTH: 300
} as const

// What a connection may hold: the credentials and the metadata of a plugin are bounded in bytes, and
// the ids it names in characters
export const ChannelConnectionLimits = {
  MAX_JSON_BYTES: 8192,
  DISPLAY_NAME_MAX_LENGTH: 200,
  // The name the owner gives to a connection: a short one, to be read in a list and in the inbox
  LABEL_MAX_LENGTH: 80,
  // The name of a plugin in the inbox: a third-party plugin chose it and nothing bounds it at registration
  PLUGIN_NAME_MAX_LENGTH: 60
} as const

// The two lists of Settings → Channels: the connections in use, and the ones that were disconnected
export const ChannelConnectionListStates = { LIVE: 'live', PAST: 'past' } as const
export type ChannelConnectionListState =
  (typeof ChannelConnectionListStates)[keyof typeof ChannelConnectionListStates]

// What `ChannelConnection.lastError` holds when the platform, and not the provider, is the one that
// says what went wrong. The settings page turns each into text in the language of the reader.
export const ChannelHealthErrors = {
  CHECK_FAILED: 'check_failed',
  // The credentials saved for the connection cannot be opened (another key, a damaged row): the
  // provider is never asked, and only connecting the channel again fixes it
  CREDENTIALS_UNREADABLE: 'credentials_unreadable',
  INVALID_REPORT: 'invalid_report',
  UNSPECIFIED: 'unspecified',
  // What the plugin says the owner has to fix (see ChannelConnectFailureReasons, same names): the token
  // no longer works, a permission or task is missing, the token is of another account than the
  // connected one, or the account is no longer linked
  TOKEN_REJECTED: 'token_rejected',
  PERMISSION_MISSING: 'permission_missing',
  OTHER_ACCOUNT: 'other_account',
  ACCOUNT_NOT_LINKED: 'account_not_linked',
  // The provider refuses what it accepted before (often a permission or the link of the Page was taken away)
  REQUEST_REJECTED: 'request_rejected'
} as const

// The most text one message may hold on each official channel (TDD_10 §5). `POST /messages` caps at
// MessageLimits; the outbound processor checks the channel's own, which is the smaller. A channel
// that is not here (a plugin of the owner's) is held only by MessageLimits.
export const ChannelTextLimits: Readonly<Record<string, number>> = {
  [ChannelIds.WHATSAPP]: WhatsAppLimits.TEXT_MAX_LENGTH,
  [ChannelIds.MESSENGER]: 2000,
  [ChannelIds.INSTAGRAM]: 1000,
  [ChannelIds.WEB_WIDGET]: WidgetLimits.CONTENT_MAX_LENGTH
}

// What a channel holds for the text under a file (its caption), when that is not the limit of its text:
// `maxLength`, and the kinds of file that carry no caption at all. A channel that is not here takes the
// limit of its text. `POST /messages` checks it so that the agent hears of it before the reply is queued.
export const ChannelCaptionRules: Readonly<
  Record<string, { maxLength: number; withoutCaption: readonly MessageType[] }>
> = {
  [ChannelIds.WHATSAPP]: {
    maxLength: WhatsAppLimits.CAPTION_MAX_LENGTH,
    withoutCaption: [MessageType.AUDIO]
  }
}

// The send of a reply is one call to the provider, from a job: bounded like the other calls to it
export const OutboundLimits = {
  SEND_TIMEOUT_MS: 20_000,
  // A send that uploads its file first (up to 100 MB) and then posts the message: the budget of the
  // upload (`MetaLimits.UPLOAD_TIMEOUT_MS`, 180 s) and the post. Shorter, a slow upload times out here
  // while it goes on in the background and the retry would send the message twice.
  MEDIA_SEND_TIMEOUT_MS: 200_000,
  // The sweep queues again a reply that has been `queued` this long: its job was never added, or it
  // failed for good without the message being marked. Past the 75 seconds of the five attempts.
  REQUEUE_AFTER_MS: 120_000,
  REQUEUE_BATCH: 100,
  // An echo settles an `unconfirmed` caption only this long after the reply was written: the provider
  // echoes within seconds, and a later identical text is the owner typing it again, not that caption
  UNCONFIRMED_CAPTION_MS: 3_600_000,
  // Past this a reply is not sent any more: the customer would get it hours late, out of its time and
  // probably out of the messaging window. It is marked failed so that the agent sees it and decides.
  GIVE_UP_AFTER_MS: 3_600_000,
  // Once the provider has taken a reply, writing that down is tried this many times before the job
  // is allowed to fail: a failure there would send the reply again
  WRITE_ATTEMPTS: 3,
  WRITE_RETRY_DELAY_MS: 100,
  // A receipt that finds no message waits for the write of one that was queued this recently: as long
  // as the five attempts of a send (20 s each) and their backoff (75 s) can take
  RECEIPT_WAIT_MS: 300_000,
  // The typing indicator of an agent reaches the channel at most once in a slot (Meta shows `typing_on`
  // for about twenty seconds)
  TYPING_ON_SLOT_MS: 5_000,
  // The least time between a stop and the next start that reaches the channel, so that a client that
  // alternates the two cannot flicker the indicator of a customer
  TYPING_MIN_GAP_MS: 1_000,
  // How long the api remembers that it told a channel an agent is typing: a little more than Meta keeps
  // the indicator on, so a stop always finds what it has to take away
  TYPING_ACTIVE_MS: 30_000,
  // A typing job that waited longer than this in the queue is dropped: it would show the wrong thing
  TYPING_STALE_MS: 10_000
} as const

// What `lastError` says for a failure of a plugin that has a reason: only the ones the owner can fix.
// A busy or unavailable provider, or an answer that was not expected, stays the plain `check_failed`:
// it is not a verdict about the connection. One case for each reason, so a new one must be placed.
export function healthErrorOfReason(reason: ChannelConnectFailureReason | undefined): string {
  switch (reason) {
    case ChannelConnectFailureReasons.TOKEN_REJECTED:
      return ChannelHealthErrors.TOKEN_REJECTED
    case ChannelConnectFailureReasons.PERMISSION_MISSING:
      return ChannelHealthErrors.PERMISSION_MISSING
    case ChannelConnectFailureReasons.OTHER_ACCOUNT:
      return ChannelHealthErrors.OTHER_ACCOUNT
    case ChannelConnectFailureReasons.ACCOUNT_NOT_LINKED:
      return ChannelHealthErrors.ACCOUNT_NOT_LINKED
    case ChannelConnectFailureReasons.REQUEST_REJECTED:
      return ChannelHealthErrors.REQUEST_REJECTED
    // A saved credential that no longer reads as a token: only connecting again fixes it
    case ChannelConnectFailureReasons.TOKEN_MALFORMED:
      return ChannelHealthErrors.CREDENTIALS_UNREADABLE
    case undefined:
    case ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED:
    case ChannelConnectFailureReasons.SUBSCRIPTION_NOT_CONFIRMED:
    case ChannelConnectFailureReasons.ACCOUNT_UNREADABLE:
    case ChannelConnectFailureReasons.SUBSCRIPTION_FAILED:
    case ChannelConnectFailureReasons.SUBSCRIPTION_UNREADABLE:
    case ChannelConnectFailureReasons.PROVIDER_BUSY:
    case ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE:
      return ChannelHealthErrors.CHECK_FAILED
    default: {
      // The compiler makes a new reason name its case; at run time (a core older than the plugin) it is the
      // plain failure and never a throw, because the caller is the `catch` of the health check
      const unhandled: never = reason
      void unhandled
      return ChannelHealthErrors.CHECK_FAILED
    }
  }
}
