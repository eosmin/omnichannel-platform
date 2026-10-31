import type { ConversationPageView } from '@platform/api-client'

import { conversationCount } from './conversation-count'

const page = (size: number, hasMore: boolean): ConversationPageView => ({
  data: Array.from({ length: size }, () => ({}) as ConversationPageView['data'][number]),
  nextCursor: hasMore ? 'n' : null,
  hasMore
})

describe('conversationCount', () => {
  it('is exact when the page is the whole list', () => {
    expect(conversationCount(page(3, false))).toEqual({ count: 3, isExact: true })
  })

  it('is a lower bound when there is more', () => {
    expect(conversationCount(page(100, true))).toEqual({ count: 100, isExact: false })
  })
})
