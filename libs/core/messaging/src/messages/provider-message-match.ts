import type { MessageWhereInput } from '@platform/core/database'

// The messages that a provider id can name. A message the platform sent as an album has one id for each file:
// the message keeps the first file's, the other files carry their own on their row, and Instagram and Messenger
// send the text under a file as a message of their own whose id is kept apart. A reaction or a quote that
// points at any of them is about this one message, so all three places are looked in. The caller scopes it to
// the store and the thread, and puts this inside an `AND` so that it never replaces an `OR` of the caller's own;
// the files are tied to the same store here as well.
// (The echo of a message the platform sent finds it with a narrower rule, on purpose: only the files of a
// message of an agent. See `messageOfFile`.)
export const messageOfProviderId = (storeId: string, providerId: string): MessageWhereInput => ({
  OR: [
    { channelMessageId: providerId },
    { captionChannelMessageId: providerId },
    { media: { some: { storeId, channelMessageId: providerId } } }
  ]
})

// The same three places, for the ids that START with a prefix (the diagnostic of an id that matched nothing)
export const messageOfProviderIdPrefix = (storeId: string, prefix: string): MessageWhereInput => ({
  OR: [
    { channelMessageId: { startsWith: prefix } },
    { captionChannelMessageId: { startsWith: prefix } },
    { media: { some: { storeId, channelMessageId: { startsWith: prefix } } } }
  ]
})

// Whether a file of an album is a target of its own at the provider. It is when the album has several files and
// the file has an id that is not the message's (the first file IS the message: one id) and that no other file of
// the message shares (Instagram and Messenger send an album as ONE message, so every file carries that one id).
// When it is not, a reaction or a quote under the file is the message's: the provider cannot tell them apart.
export function isTargetOfItsOwn(
  message: { channelMessageId: string | null },
  files: readonly { id: string; channelMessageId: string | null }[],
  file: { id: string; channelMessageId: string | null }
): boolean {
  if (files.length < 2 || file.channelMessageId === null) return false
  if (file.channelMessageId === message.channelMessageId) return false
  return files.filter(item => item.channelMessageId === file.channelMessageId).length === 1
}
