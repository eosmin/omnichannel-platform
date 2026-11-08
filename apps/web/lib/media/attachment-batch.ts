import { ClientErrorCodes } from '@platform/core/errors'
import type { OutboundMediaType } from '@platform/core/storage'

import {
  acceptFor,
  attachmentMessageType,
  channelTakesFile,
  refusalCode,
  refuseAttachment
} from './attachment-rules'

// What a channel takes in one message of a kind of file, as the directory of channels says it
export interface ChannelMediaLimit {
  type: string
  maxFiles: number
  types: readonly string[] | null
  maxBytes: number
  // Whether a text goes under EACH file of a message of this kind (false: only under the first)
  captionsPerFile?: boolean
}

// Why a file does not join the message: a code the person reads as any error, the mix of kinds (a message
// carries images, or videos, or audio, or documents, never two of them), or a message that is full
export type BatchRefusal =
  { kind: 'code'; code: string } | { kind: 'mixed' } | { kind: 'full'; max: number }

interface FileFacts {
  type: string
  size: number
}

export function limitOfKind(
  media: readonly ChannelMediaLimit[] | undefined,
  type: OutboundMediaType | null
): ChannelMediaLimit | undefined {
  return media?.find(limit => limit.type === String(type))
}

// How many files a message of this kind takes. One when the directory does not say (it has not loaded, or the
// channel declares no rule for the kind): the behavior of the composer before several files were allowed.
export function maxFilesOf(
  media: readonly ChannelMediaLimit[] | undefined,
  type: OutboundMediaType | null
): number {
  return limitOfKind(media, type)?.maxFiles ?? 1
}

// The largest number any kind takes, for the picker (which cannot know the kind before a file is chosen)
export function pickerMaxFiles(media: readonly ChannelMediaLimit[] | undefined): number {
  return Math.max(1, ...(media ?? []).map(limit => limit.maxFiles))
}

// What the channel itself refuses of one file, before any byte leaves the browser: the kind it does not
// take, a type outside its list and a file larger than it takes. The api asks the same again.
function channelCode(
  file: FileFacts,
  capabilities: readonly string[] | undefined,
  media: readonly ChannelMediaLimit[] | undefined
): string | null {
  if (capabilities !== undefined && !channelTakesFile(capabilities, file.type)) {
    return ClientErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED
  }
  const limit = limitOfKind(media, attachmentMessageType(file.type))
  if (limit === undefined) return null
  if (limit.types !== null && !limit.types.includes(file.type)) {
    return ClientErrorCodes.CHANNEL_FILE_TYPE_UNSUPPORTED
  }
  return file.size > limit.maxBytes ? ClientErrorCodes.CHANNEL_FILE_TOO_LARGE : null
}

export interface BatchRules {
  capabilities?: readonly string[] | undefined
  media?: readonly ChannelMediaLimit[] | undefined
}

// Which of the files the person just chose join the message, in the order they came. `held` is the kind of
// each file already in the message that has not failed. The first file sets the kind of the message.
export function planAdd(
  held: readonly (OutboundMediaType | null)[],
  incoming: readonly FileFacts[],
  rules: BatchRules
): (BatchRefusal | null)[] {
  let kind = held[0] ?? null
  let count = held.length
  return incoming.map(file => {
    const refusal = refuseAttachment(file)
    if (refusal !== null) return { kind: 'code', code: refusalCode(refusal) }
    const code = channelCode(file, rules.capabilities, rules.media)
    if (code !== null) return { kind: 'code', code }
    const type = attachmentMessageType(file.type)
    if (kind !== null && type !== kind) return { kind: 'mixed' }
    const max = maxFilesOf(rules.media, type)
    if (count >= max) return { kind: 'full', max }
    kind = type
    count += 1
    return null
  })
}

// The picker offers the types the channel takes (its kinds, and inside a kind its list of formats) and
// nothing else. A kind with no list takes every type the platform allows for it. The api checks again.
export function acceptWith(
  capabilities: readonly string[],
  media: readonly ChannelMediaLimit[] | undefined
): string {
  return acceptFor(capabilities)
    .split(',')
    .filter(type => {
      if (type === '') return false
      const limit = limitOfKind(media, attachmentMessageType(type))
      return limit?.types == null || limit.types.includes(type)
    })
    .join(',')
}
