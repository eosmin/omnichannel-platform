import type { ConversationListItemView } from '@platform/api-client'
import { AuthorType, MessageType } from '@platform/core/domain'

type LastMessage = NonNullable<ConversationListItemView['lastMessage']>

// What the second line of a row says. The server cut the text; a message with none (a photo with no
// caption, a location) is named by its type, and a type this page does not know by a generic word.
export type Preview =
  | { kind: 'empty' }
  | { kind: 'text'; text: string; byAgent: boolean; isNote: boolean }
  | { kind: 'type'; type: MessageType | 'unknown'; byAgent: boolean }

const isMessageType = (value: string): value is MessageType =>
  Object.values<string>(MessageType).includes(value)

export function previewOf(lastMessage: LastMessage | null): Preview {
  if (lastMessage === null) return { kind: 'empty' }
  const byAgent = lastMessage.authorType === String(AuthorType.AGENT)
  const text = lastMessage.contentPreview?.trim()
  if (text !== undefined && text !== '') {
    return {
      kind: 'text',
      text,
      byAgent,
      isNote: lastMessage.type === String(MessageType.INTERNAL_NOTE)
    }
  }
  return {
    kind: 'type',
    type: isMessageType(lastMessage.type) ? lastMessage.type : 'unknown',
    byAgent
  }
}
