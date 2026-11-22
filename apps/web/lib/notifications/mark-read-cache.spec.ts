import type { InfiniteData } from '@tanstack/react-query'

import type { NotificationPageView, NotificationView } from '@platform/api-client'
import { NotificationFilters } from '@platform/core/notifications'

import { applyRead } from './mark-read-cache'

const AT = '2026-11-23T10:00:00.000Z'
const item = (id: string, readAt: string | null): NotificationView => ({
  id,
  type: 'x',
  severity: 'info',
  messageKey: 'k',
  params: {},
  resourceType: null,
  resourceId: null,
  actionPath: null,
  readAt,
  createdAt: '2026-11-23T09:00:00.000Z'
})
const pages = (): InfiniteData<NotificationPageView, string | null> => ({
  pageParams: [null],
  pages: [
    {
      data: [item('a', null), item('b', '2026-11-22T00:00:00.000Z'), item('c', null)],
      nextCursor: 'next',
      hasMore: true
    }
  ]
})

describe('applyRead', () => {
  it('marks only the named unread lines on the All tab and keeps an older readAt', () => {
    const result = applyRead(pages(), NotificationFilters.ALL, new Set(['a', 'b']), AT)
    expect(result.pages[0]?.data.map(i => i.readAt)).toEqual([AT, '2026-11-22T00:00:00.000Z', null])
  })

  it('marks every unread line when no ids are named', () => {
    const result = applyRead(pages(), NotificationFilters.MENTIONS, null, AT)
    expect(result.pages[0]?.data.map(i => i.readAt)).toEqual([AT, '2026-11-22T00:00:00.000Z', AT])
  })

  it('removes the named lines from the Unread tab and keeps its paging', () => {
    const result = applyRead(pages(), NotificationFilters.UNREAD, new Set(['a']), AT)
    expect(result.pages[0]?.data.map(i => i.id)).toEqual(['b', 'c'])
    expect(result.pages[0]?.hasMore).toBe(true)
  })

  it('empties the Unread tab and closes its paging on mark all', () => {
    const result = applyRead(pages(), NotificationFilters.UNREAD, null, AT)
    expect(result.pages[0]).toEqual({ data: [], nextCursor: null, hasMore: false })
  })

  it('does not change the cached object it was given', () => {
    const before = pages()
    applyRead(before, NotificationFilters.ALL, null, AT)
    expect(before.pages[0]?.data[0]?.readAt).toBeNull()
  })
})
