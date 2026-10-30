import { z } from 'zod'

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
  DISPLAY_NAME_MAX_LENGTH: 200
} as const

// What `ChannelConnection.lastError` holds when the platform, and not the provider, is the one that
// says what went wrong. The settings page turns each into text in the language of the reader.
export const ChannelHealthErrors = {
  CHECK_FAILED: 'check_failed',
  INVALID_REPORT: 'invalid_report',
  UNSPECIFIED: 'unspecified'
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

// The send of a reply is one call to the provider, from a job: bounded like the other calls to it
export const OutboundLimits = {
  SEND_TIMEOUT_MS: 20_000,
  // The sweep queues again a reply that has been `queued` this long: its job was never added, or it
  // failed for good without the message being marked. Past the 75 seconds of the five attempts.
  REQUEUE_AFTER_MS: 120_000,
  REQUEUE_BATCH: 100,
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
