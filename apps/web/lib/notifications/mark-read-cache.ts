import type { InfiniteData } from '@tanstack/react-query'

import { type NotificationPageView, QueryKeys } from '@platform/api-client'
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

// The filter a list query was made for, read from its key; null for a key that is not one of the
// tabs. `filtered()` builds the key, so the spec builds one with it and reads it back here.
export function filterOfListKey(storeId: string, key: readonly unknown[]): string | null {
  const probe = QueryKeys.notifications.filtered(storeId, '')
  const head = probe.slice(0, -1)
  const matches = key.length === probe.length && head.every((part, i) => key[i] === part)
  const filter = key[probe.length - 1]
  return matches && typeof filter === 'string' ? filter : null
}

// A tab whose loaded page ran out of lines while the api still has more behind it would show an
// empty state (or never ask for the next page): it has to be read again from the start.
export function hasEmptyPageWithMore(data: Pages): boolean {
  return data.pages.some(page => page.data.length === 0 && page.hasMore)
}
