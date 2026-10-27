import { z } from 'zod'

// The ids of the official channel plugins. A channel is the id of a registered plugin (TDD_10 §6.7),
// so this list is not the set of all channels: a plugin the owner adds brings an id of its own.
export const ChannelIds = {
  WHATSAPP: 'whatsapp',
  INSTAGRAM: 'instagram',
  MESSENGER: 'messenger',
  WEB_WIDGET: 'web_widget',
  EMAIL: 'email'
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
