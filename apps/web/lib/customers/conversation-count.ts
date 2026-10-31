import type { ConversationPageView } from '@platform/api-client'

// The count the profile shows. The page is the biggest the server gives: a customer with more
// conversations than that shows "100+", never a wrong exact number.
export function conversationCount(page: ConversationPageView): { count: number; isExact: boolean } {
  return { count: page.data.length, isExact: !page.hasMore }
}
