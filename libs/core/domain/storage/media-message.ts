import { ChannelCapability, type ChannelCapabilityType } from '../channel-capability'
import { MessageType } from '../status-enums'

import { AllowedContentTypes } from './upload-constants'

// The message types an agent can send with a file, with the capability the channel must declare for
// each. How many files one message may carry is `maxFilesFor`.
export const OutboundMediaTypes = [
  MessageType.IMAGE,
  MessageType.VIDEO,
  MessageType.AUDIO,
  MessageType.DOCUMENT
] as const
export type OutboundMediaType = (typeof OutboundMediaTypes)[number]

export const MediaMessageLimits = {
  // The most a request may carry, whatever the channel says: the channel and the flag below decide the real
  // number (`maxFilesFor`). Equal to the most any plugin may declare (`ChannelMediaLimits`).
  MAX_FILES: 30,
  // What a message carries while several files are not switched on (`OUTBOUND_MULTI_FILE_ENABLED`)
  SINGLE_FILE: 1
} as const

// How many files an agent may attach to a message of a channel: what the channel declares, and one while
// sending several is off. Never more than a request may carry, never less than one.
export function maxFilesFor(declared: number, multiFileEnabled: boolean): number {
  if (!multiFileEnabled) return MediaMessageLimits.SINGLE_FILE
  return Math.min(Math.max(Math.trunc(declared) || 1, 1), MediaMessageLimits.MAX_FILES)
}

export const CapabilityOfMediaType: Record<OutboundMediaType, ChannelCapabilityType> = {
  [MessageType.IMAGE]: ChannelCapability.IMAGE,
  [MessageType.VIDEO]: ChannelCapability.VIDEO,
  [MessageType.AUDIO]: ChannelCapability.AUDIO,
  [MessageType.DOCUMENT]: ChannelCapability.DOCUMENT
}

// The message type a stored file is sent as, by the type the upload declared (and the confirmation
// checked). null for a type that is not an allowed upload.
export function mediaMessageTypeOf(contentType: string): OutboundMediaType | null {
  const groups: [OutboundMediaType, readonly string[]][] = [
    [MessageType.IMAGE, AllowedContentTypes.IMAGE],
    [MessageType.VIDEO, AllowedContentTypes.VIDEO],
    [MessageType.AUDIO, AllowedContentTypes.AUDIO],
    [MessageType.DOCUMENT, AllowedContentTypes.DOCUMENT]
  ]
  return groups.find(([, types]) => types.includes(contentType))?.[0] ?? null
}

export function isOutboundMediaType(type: string): type is OutboundMediaType {
  return (OutboundMediaTypes as readonly string[]).includes(type)
}
