import type { MessageWhereInput } from '@platform/core/database'

// The messages that a provider id can name. A message the platform sent with several files has one id for each file:
// the message keeps the first file's, the other files carry their own on their row, and a provider that cannot
// carry the text under a file sends it as a message of its own whose id is kept apart. A reaction or a quote that
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

type FileIds = readonly { id: string; channelMessageId: string | null }[]

// Whether the provider has an id for this file that no other file of the message shares, in a message of several
// files: it can be named alone (one message for each picture, the first one too). Files that share one id and files
// with no id yet cannot.
export function isDistinctFile(
  files: FileIds,
  file: { id: string; channelMessageId: string | null }
): boolean {
  if (files.length < 2 || file.channelMessageId === null) return false
  return files.filter(item => item.channelMessageId === file.channelMessageId).length === 1
}

// Whether a file is a target of its own for a REACTION, which is one row for each person and target: the distinct
// files, except the first one, whose id IS the message's (its reaction is the message's, so the two never make two
// rows for one target).
export function isTargetOfItsOwn(
  message: { channelMessageId: string | null },
  files: FileIds,
  file: { id: string; channelMessageId: string | null }
): boolean {
  return isDistinctFile(files, file) && file.channelMessageId !== message.channelMessageId
}
