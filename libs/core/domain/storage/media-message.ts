import { ChannelCapability, type ChannelCapabilityType } from '../channel-capability'
import { MessageType } from '../status-enums'

import { AllowedContentTypes } from './upload-constants'

// The message types an agent can send with a file, with the capability the channel must declare for
// each. One file per message in the MVP (`MediaMessageLimits.MAX_FILES`).
export const OutboundMediaTypes = [
  MessageType.IMAGE,
  MessageType.VIDEO,
  MessageType.AUDIO,
  MessageType.DOCUMENT
] as const
export type OutboundMediaType = (typeof OutboundMediaTypes)[number]

export const MediaMessageLimits = {
  // Several files in one request are Phase 2 (`IMPLEMENTATION_PLAN.md`, Step 3.4)
  MAX_FILES: 1
} as const

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
