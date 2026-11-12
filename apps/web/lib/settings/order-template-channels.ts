import type { ChannelDirectoryEntryView } from '@platform/api-client'
import { ChannelCapability, ChannelConnectionStatus } from '@platform/core/domain'

// The channels a message template may be linked to (TDD_17 §4.7): the ones whose plugin declares both that it takes
// approved templates and that it has a messaging window (which is what asks for one). Decided by what the plugin
// declares in the channel directory, never by its name.
export interface LinkableChannel {
  pluginId: string
  pluginName: string
  // The accounts that are working, whose approved templates can be read
  connections: { id: string; displayName: string }[]
}

export function linkableChannels(entries: readonly ChannelDirectoryEntryView[]): LinkableChannel[] {
  const byPlugin = new Map<string, LinkableChannel>()
  for (const entry of entries) {
    if (
      !entry.capabilities.includes(ChannelCapability.TEMPLATES) ||
      !entry.capabilities.includes(ChannelCapability.MESSAGING_WINDOW)
    ) {
      continue
    }
    const channel = byPlugin.get(entry.pluginId) ?? {
      pluginId: entry.pluginId,
      pluginName: entry.pluginName,
      connections: []
    }
    if (entry.status === String(ChannelConnectionStatus.ACTIVE)) {
      channel.connections.push({ id: entry.id, displayName: entry.displayName })
    }
    byPlugin.set(entry.pluginId, channel)
  }
  return [...byPlugin.values()]
}
