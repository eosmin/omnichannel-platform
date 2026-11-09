import type { ChannelDescriptorSnapshot } from '@platform/plugins/runtime'

// What the browser is told of how a channel is named and drawn. The image hosts are not here: the CSP is built
// from them when the web app is built, and a browser has no use for them.
export type PublicChannelDescriptor = Omit<ChannelDescriptorSnapshot, 'imageHosts'>

export function publicDescriptorOf(
  declared: ChannelDescriptorSnapshot | null
): PublicChannelDescriptor | null {
  if (declared === null) return null
  return {
    displayName: declared.displayName,
    iconKey: declared.iconKey,
    anonymousCustomers: declared.anonymousCustomers,
    managementSurface: declared.managementSurface,
    helpSteps: declared.helpSteps
  }
}
