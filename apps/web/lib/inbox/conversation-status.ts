import { ConversationStatus } from '@platform/core/domain'

// A status this page does not know (a server newer than the page) is null, not an error
export function conversationStatusOf(value: string): ConversationStatus | null {
  return Object.values(ConversationStatus).find(status => String(status) === value) ?? null
}

// A resolved or snoozed conversation is reopened, not resolved or snoozed again; any other can be
export function canChangeState(value: string): boolean {
  const status = conversationStatusOf(value)
  return status !== ConversationStatus.RESOLVED && status !== ConversationStatus.SNOOZED
}
