import { ChannelMediaKinds, type ChannelMediaKind } from '@platform/core/channel-media'
import { MessageType } from '@platform/core/domain'
import type { ChannelFileLimits } from '@platform/core/messaging'
import { maxFilesFor, type OutboundMediaType } from '@platform/core/storage'
import type { PluginRegistry } from '@platform/plugins/runtime'

const KIND_OF_TYPE: Readonly<Record<OutboundMediaType, ChannelMediaKind>> = {
  [MessageType.IMAGE]: ChannelMediaKinds.IMAGE,
  [MessageType.VIDEO]: ChannelMediaKinds.VIDEO,
  [MessageType.AUDIO]: ChannelMediaKinds.AUDIO,
  [MessageType.DOCUMENT]: ChannelMediaKinds.DOCUMENT
}

// What the channel of a conversation takes in one message of a kind of file, from what the plugin declared when
// it registered (a frozen copy) and the switch for several files. null when the plugin declares no rule for the
// kind: the route then lets one file through and the plugin has the last word.
export function channelFileLimits(
  registry: Pick<PluginRegistry, 'mediaOf'>,
  multiFileEnabled: boolean,
  captionPerFileEnabled = false
): (channelType: string, messageType: OutboundMediaType) => ChannelFileLimits | null {
  return (channelType, messageType) => {
    const media = registry.mediaOf(channelType)
    const rule = media?.kinds[KIND_OF_TYPE[messageType]]
    if (media === null || media === undefined || rule === undefined) return null
    return {
      maxFiles: maxFilesFor(media.maxFilesPerMessage, multiFileEnabled),
      types: rule.types,
      maxBytes: rule.maxBytes,
      captionsPerFile: captionPerFileEnabled
    }
  }
}
