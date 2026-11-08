import { ChannelCaptionRules, ChannelTextLimits, type MessageType } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import { invalidInput } from '../conversations/conversations.support'

// The text under a file has the limits of its channel (WhatsApp: 1024, and none under an audio). The
// plugin refuses the same at send time, which the agent would only see as a failed bubble: here it is
// an answer to the request, before anything is queued.
export function requireCaptionFits(
  channelType: string,
  type: MessageType,
  caption: string | undefined
): void {
  if (caption === undefined) return
  const rule = ChannelCaptionRules[channelType]
  if (rule?.withoutCaption.includes(type) === true) {
    throw new PlatformException(
      ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED,
      'the channel does not carry text under this kind of file',
      HttpStatusCodes.CONFLICT
    )
  }
  const limit = rule?.maxLength ?? ChannelTextLimits[channelType]
  if (limit !== undefined && Array.from(caption).length > limit) {
    throw invalidInput(`the text under the file is longer than the channel holds (${limit})`)
  }
}

// The text under each file of a media message, by its place: `captions` when it comes (it wins), else the
// one `content` that is the text under the first file. A blank one is none. Always as many as files.
export function captionsOf(body: {
  mediaIds: readonly string[]
  content?: string | undefined
  captions?: readonly (string | null)[] | undefined
}): (string | null)[] {
  // `captions` wins for the places it names; the text under the first file is `content` when `captions` does
  // not reach it, so that a request with both never loses the one text it carried
  return body.mediaIds.map((_, place) => {
    const named = body.captions?.[place]
    if (named !== undefined) return named
    return place === 0 ? (body.content ?? null) : null
  })
}

// More texts than files, or a text under a file other than the first when the switch is off: the request
// says what the worker would not do, so it is refused before anything is queued
export function requireCaptionsPlaced(
  body: { mediaIds: readonly string[]; captions?: readonly (string | null)[] | undefined },
  captionsPerFile: boolean
): void {
  const captions = body.captions ?? []
  if (captions.length > body.mediaIds.length) {
    throw invalidInput('there is more text than files: each file has one text at most')
  }
  if (!captionsPerFile && captions.slice(1).some(caption => caption !== null)) {
    throw new PlatformException(
      ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED,
      'a text under each file is not switched on: only the first file takes one',
      HttpStatusCodes.CONFLICT
    )
  }
}
