import type { InfiniteData } from '@tanstack/react-query'

import type { NotificationPageView } from '@platform/api-client'
import { NotificationFilters } from '@platform/core/notifications'

type Pages = InfiniteData<NotificationPageView, string | null>

// What a "mark read" does to a list that is already loaded, so the tabs the person is not looking at
// are not fetched again page by page: the line gets its `readAt`, and on the Unread tab it leaves.
// `ids` null means every line (mark all). Lines already read keep their first `readAt`.
export function applyRead(
  data: Pages,
  filter: string,
  ids: ReadonlySet<string> | null,
  readAt: string
): Pages {
  const touched = (id: string): boolean => ids === null || ids.has(id)
  if (filter === NotificationFilters.UNREAD) {
    return {
      ...data,
      pages: data.pages.map(page => ({
        ...page,
        data: page.data.filter(item => !touched(item.id)),
        // Marking all leaves nothing to load behind this page
        ...(ids === null ? { nextCursor: null, hasMore: false } : {})
      }))
    }
  }
  return {
    ...data,
    pages: data.pages.map(page => ({
      ...page,
      data: page.data.map(item =>
        touched(item.id) && item.readAt === null ? { ...item, readAt } : item
      )
    }))
  }
}
