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
