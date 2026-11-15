import { z } from 'zod'

import { RemoteChannelApiLimits } from '@platform/core/domain'
import { isWellFormedPublicHttpsUrl } from '@platform/core/url-safety'

import { channelEventSchema } from './channel-event.schema'

const MS_PER_MINUTE = 60_000
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE

function bytesOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

// Whether a timestamp is inside what a remote plugin may report: no older than 30 days and no more than 5 minutes ahead
// (TDD_10 §6.7.5). `now` is read when the request is parsed, so the same schema serves every request.
function withinWindow(timestamp: string, now: number): boolean {
  const at = Date.parse(timestamp)
  return (
    Number.isFinite(at) &&
    at >= now - RemoteChannelApiLimits.TIMESTAMP_MAX_AGE_DAYS * MS_PER_DAY &&
    at <= now + RemoteChannelApiLimits.TIMESTAMP_MAX_AHEAD_MINUTES * MS_PER_MINUTE
  )
}

// The event of a REMOTE plugin: the `ChannelEvent` of §2 with the tighter caps of TDD_10 §6.7.5, because a remote plugin is a
// third party's service and what it says about a customer is not trusted. What is here is only shape and size: that the connection
// is the plugin's own, that a status event is about a message of the plugin's own, and that the capability exists are checked by
// the service, which has the installation.
export const remoteChannelEventSchema = channelEventSchema.superRefine((event, context) => {
  const limits = RemoteChannelApiLimits
  const issue = (path: (string | number)[], message: string): void => {
    context.addIssue({ code: 'custom', path, message })
  }
  if (event.channelIdentity.length > limits.CHANNEL_IDENTITY_MAX_LENGTH) {
    issue(['channelIdentity'], 'the identity of the customer is too long')
  }
  const name = event.channelProfile?.displayName
  if (name !== undefined && name.length > limits.PROFILE_NAME_MAX_LENGTH) {
    issue(['channelProfile', 'displayName'], 'the name of the customer is too long')
  }
  const now = Date.now()
  if (!withinWindow(event.timestamp, now)) {
    issue(['timestamp'], 'the timestamp is outside the window a plugin may report')
  }
  const sent = event.message
  if (sent !== undefined) {
    if (sent.content !== null && sent.content.length > limits.MESSAGE_CONTENT_MAX_LENGTH) {
      issue(['message', 'content'], 'the text of the message is too long')
    }
    if (sent.metadata !== undefined && bytesOf(sent.metadata) > limits.MESSAGE_METADATA_MAX_BYTES) {
      issue(['message', 'metadata'], 'the metadata of the message is too large')
    }
    if (!withinWindow(sent.timestamp, now)) {
      issue(['message', 'timestamp'], 'the timestamp is outside the window a plugin may report')
    }
    if (sent.media !== undefined && sent.media.length > 1) {
      issue(['message', 'media'], 'a message of a remote plugin carries one file')
    }
    sent.media?.forEach((file, index) => {
      // Only the shape is judged here: the API never opens the address, and the fetch resolves it, pins the answer and follows no
      // redirect (TDD_10 §6.7.6). What can already be told apart from the text (http, a port, credentials, a private name or an
      // address literal) is refused now, so a hostile plugin learns nothing from the fetch.
      if (!isWellFormedPublicHttpsUrl(file.ref)) {
        issue(['message', 'media', index, 'ref'], 'the file must be a public https address')
      }
      // The id of a stored file is the platform's to choose for a remote plugin (only the web widget names its files)
      if (file.id !== undefined) {
        issue(['message', 'media', index, 'id'], 'a remote plugin does not name its files')
      }
    })
  }
  // The origin of a message (an ad it came from) is read and fetched like a file: the same rules, and the same cap on what it carries
  const origin = sent?.origin
  if (origin !== undefined) {
    const links: [(string | number)[], string | undefined][] = [
      [['message', 'origin', 'sourceUrl'], origin.sourceUrl],
      [['message', 'origin', 'thumbnailUrl'], origin.thumbnailUrl],
      [['message', 'origin', 'media', 'url'], origin.media?.url],
      [['message', 'origin', 'media', 'ref'], origin.media?.ref]
    ]
    for (const [path, link] of links) {
      if (link !== undefined && !isWellFormedPublicHttpsUrl(link)) {
        issue(path, 'the address must be a public https one')
      }
    }
    if (
      origin.referral !== undefined &&
      bytesOf(origin.referral) > limits.MESSAGE_METADATA_MAX_BYTES
    ) {
      issue(['message', 'origin', 'referral'], 'the referral is too large')
    }
  }
  if (event.edit !== undefined && event.edit.content.length > limits.MESSAGE_CONTENT_MAX_LENGTH) {
    issue(['edit', 'content'], 'the text of the message is too long')
  }
})

// The body of `POST /plugin-api/channel/events`: one to 50 events (the 1 MB of the whole request is the limit of the body parser)
export const remoteChannelEventsBodySchema = z.strictObject({
  events: z
    .array(remoteChannelEventSchema)
    .min(1)
    .max(RemoteChannelApiLimits.MAX_EVENTS_PER_REQUEST)
})

export type RemoteChannelEventsBody = z.output<typeof remoteChannelEventsBodySchema>
export type ValidRemoteChannelEvent = z.output<typeof remoteChannelEventSchema>
