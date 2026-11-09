// Whether the reply the agent has chosen now is the one a send took: the same message and the same file of it (a
// newer quote of another image of the same album must survive the send of the older one)
export function isSameReplyTarget(
  current: { messageId: string; mediaId?: string } | null,
  messageId: string,
  mediaId: string | undefined
): boolean {
  return current !== null && current.messageId === messageId && current.mediaId === mediaId
}
