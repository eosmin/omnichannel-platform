import type { ChannelDescriptorView } from '@platform/api-client'

// The name a channel shows in the interface: the one its descriptor declares, in the language of the reader
// (English for any other), else the name the server sent. No channel id is read: a plugin of a third party is
// named the same way as an official one.
export function pluginNameOf(
  descriptor: Pick<ChannelDescriptorView, 'displayName'> | null | undefined,
  locale: string,
  serverName: string
): string {
  if (descriptor === null || descriptor === undefined) return serverName
  return locale.toLowerCase().startsWith('es')
    ? descriptor.displayName.es
    : descriptor.displayName.en
}
