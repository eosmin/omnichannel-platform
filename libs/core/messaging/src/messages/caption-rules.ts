import type { ChannelLimitsView, MessageType } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { invalidInput } from '../conversations/conversations.support'

// Where a kind of file carries no text of its own on the channel (an audio on WhatsApp), the text goes after
// the file as a message of its own (only for the text of the message: the first file)
export function carriesNoCaption(limits: ChannelLimitsView | null, type: MessageType): boolean {
  return limits?.caption?.withoutCaption.includes(type) === true
}

// Whether a text fits under a file of this kind on this channel: the limit of its caption, or of a plain
// text where it goes apart. One rule for the api (before anything is queued) and the worker (before the
// first file leaves, so that no album goes in part for a text that would be refused).
export type CaptionProblem = 'unsupported' | 'too-long'
export function captionProblemOf(
  limits: ChannelLimitsView | null,
  type: MessageType,
  caption: string,
  apartAllowed: boolean
): { problem: CaptionProblem; limit?: number } | null {
  const apart = carriesNoCaption(limits, type)
  if (apart && !apartAllowed) return { problem: 'unsupported' }
  const limit = apart
    ? limits?.textMaxLength
    : (limits?.caption?.maxLength ?? limits?.textMaxLength)
  if (limit !== undefined && Array.from(caption).length > limit)
    return { problem: 'too-long', limit }
  return null
}

// The text under a file has the limits of its channel (WhatsApp: 1024, and none under an audio unless it goes
// apart). The plugin refuses the same at send time, which the agent would only see as a failed bubble: here
// it is an answer to the request, before anything is queued.
export function requireCaptionFits(
  limits: ChannelLimitsView | null,
  type: MessageType,
  caption: string | undefined,
  apartAllowed = false
): void {
  if (caption === undefined) return
  const found = captionProblemOf(limits, type, caption, apartAllowed)
  if (found === null) return
  if (found.problem === 'unsupported') {
    throw new PlatformException(
      ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED,
      'the channel does not carry text under this kind of file',
      HttpStatusCodes.CONFLICT
    )
  }
  throw invalidInput(`the text under the file is longer than the channel holds (${found.limit})`)
}

// The text under each file of a media message, by its place. Where the text of the message goes apart (after
// every file: `textApart`) each file has only the text of `captions`, the first included, and `content` is not
// under any of them. Elsewhere `captions` wins for the places it names, and the text under the first file is
// `content` when `captions` does not reach it, so that a request with both never loses the one text it carried.
// A blank one is none. Always as many as files.
export function captionsOf(
  body: {
    mediaIds: readonly string[]
    content?: string | undefined
    captions?: readonly (string | null)[] | undefined
  },
  textApart: boolean
): (string | null)[] {
  return body.mediaIds.map((_, place) => {
    const named = body.captions?.[place]
    if (named !== undefined) return named
    return place === 0 && !textApart ? (body.content ?? null) : null
  })
}

// More texts than files, or a text under a file that has no place for one: the request says what the worker
// would not do, so it is refused before anything is queued. Where the text goes with the files, the first file
// is the only one that takes a text on a channel that has no text under each file; where it goes apart, no file
// does there.
export function requireCaptionsPlaced(
  body: { mediaIds: readonly string[]; captions?: readonly (string | null)[] | undefined },
  captionsPerFile: boolean,
  textApart = false
): void {
  const captions = body.captions ?? []
  if (captions.length > body.mediaIds.length) {
    throw invalidInput('there is more text than files: each file has one text at most')
  }
  const unplaced = textApart ? captions : captions.slice(1)
  if (!captionsPerFile && unplaced.some(caption => caption !== null)) {
    throw new PlatformException(
      ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED,
      textApart
        ? 'this kind of file takes no text under it'
        : 'this channel takes a text under the first file only',
      HttpStatusCodes.CONFLICT
    )
  }
}

// The text of a message that goes apart, as a message of its own after the files, has the limit of a plain text
// of its channel (the same the worker holds it to before anything leaves)
export function requireTextFits(limits: ChannelLimitsView | null, text: string | undefined): void {
  const limit = limits?.textMaxLength
  if (text !== undefined && limit !== undefined && Array.from(text).length > limit) {
    throw invalidInput(`the text of the message is longer than the channel holds (${limit})`)
  }
}
