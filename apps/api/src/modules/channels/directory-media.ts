import type { ChannelFileLimits } from '@platform/core/messaging'
import { OutboundMediaTypes, type OutboundMediaType } from '@platform/core/storage'

// What a channel takes of one kind of file in a message, for the directory the inbox reads
export interface DirectoryMediaLimits extends ChannelFileLimits {
  type: OutboundMediaType
}

// The kinds of file a channel declares, each with its limits. A kind the channel does not declare is not
// listed: the composer treats it as a file the channel does not take.
export function directoryMedia(
  channelType: string,
  limitsOf: (channelType: string, type: OutboundMediaType) => ChannelFileLimits | null
): DirectoryMediaLimits[] {
  return OutboundMediaTypes.flatMap(type => {
    const limits = limitsOf(channelType, type)
    return limits === null ? [] : [{ type, ...limits }]
  })
}
