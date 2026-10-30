import { ConversationStatus } from '@platform/core/domain'

// A status this page does not know (a server newer than the page) is null, not an error
export function conversationStatusOf(value: string): ConversationStatus | null {
  return Object.values(ConversationStatus).find(status => String(status) === value) ?? null
}
