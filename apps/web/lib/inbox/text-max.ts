import { MessageLimits } from '@platform/core/domain'

// The most characters the agent may write in the box: the limit of the text that the plugin of the channel
// declared (never above what the api takes for any message), so that the counter and the box say it before
// the send is refused. A note goes to no channel, and while the directory has not said the general limit
// holds (the api checks the channel's own anyway).
export function textMaxOf(
  limits: { textMaxLength: number } | null | undefined,
  isNote: boolean
): number {
  if (isNote || limits === null || limits === undefined) return MessageLimits.CONTENT_MAX_LENGTH
  return Math.min(limits.textMaxLength, MessageLimits.CONTENT_MAX_LENGTH)
}
