'use client'

import { useVirtualizer } from '@tanstack/react-virtual'
import { Inbox, Lock, SearchX, TriangleAlert } from 'lucide-react'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'

import type { ChannelDirectoryEntryView, ConversationFilters } from '@platform/api-client'
import { ApiError } from '@platform/api-client'
import { HttpStatusCodes } from '@platform/core/errors'

import { errorCodeOf } from '../../lib/error-message'
import { hasFilters } from '../../lib/inbox/inbox-filters'
import { useConversationPages } from '../../lib/inbox/use-inbox-data'
import { Button } from '../ui/button'

import { CONVERSATION_ROW_HEIGHT_PX, ConversationItem } from './conversation-item'
import { InboxState } from './inbox-state'

const OVERSCAN_ROWS = 6
const NOW_REFRESH_MS = 60_000

// The clock of the relative times ("5 min"): one tick a minute for the whole list
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), NOW_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])
  return now
}

export function ConversationList({
  storeId,
  filters,
  search,
  channels,
  areChannelsReady
}: {
  storeId: string
  filters: ConversationFilters
  search: string
  channels: readonly ChannelDirectoryEntryView[]
  // The names of the channels are known (or could not be read): until then the rows would show an id
  areChannelsReady: boolean
}): ReactElement {
  const t = useTranslations('inbox')
  const tAll = useTranslations()
  const { conversationId } = useParams<{ conversationId?: string }>()
  const now = useNow()
  const pages = useConversationPages(storeId, filters)
  const items = useMemo(() => pages.data?.pages.flatMap(page => page.data) ?? [], [pages.data])
  const channelNames = useMemo(
    () => new Map(channels.map(channel => [channel.pluginId, channel.pluginName])),
    [channels]
  )

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => CONVERSATION_ROW_HEIGHT_PX, // Until the row is measured
    overscan: OVERSCAN_ROWS,
    getItemKey: index => items[index]?.id ?? index
  })
  const virtualRows = virtualizer.getVirtualItems()
  const lastRow = virtualRows[virtualRows.length - 1]
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = pages

  // The next page is asked for when the last loaded row comes into view
  useEffect(() => {
    if (lastRow !== undefined && lastRow.index >= items.length - 1 && hasNextPage) {
      // After a failure the "Try again" button asks again: an effect that did would loop
      if (!isFetchingNextPage && !isError) void fetchNextPage()
    }
  }, [lastRow, items.length, hasNextPage, isFetchingNextPage, isError, fetchNextPage])

  // A failed refetch or next page keeps what is loaded (below); only a list with nothing to show is
  // replaced by the error
  if (pages.isError && pages.data === undefined) {
    if (pages.error instanceof ApiError && pages.error.status === HttpStatusCodes.FORBIDDEN) {
      return (
        <InboxState
          icon={Lock}
          title={t('permissionDenied.title')}
          body={t('permissionDenied.body')}
          isAlert
        />
      )
    }
    return (
      <InboxState
        icon={TriangleAlert}
        title={t('error.title')}
        body={tAll(`errors.${errorCodeOf(pages.error)}`)}
        isAlert
      >
        <Button type="button" variant="outline" size="sm" onClick={() => void pages.refetch()}>
          {tAll('common.tryAgain')}
        </Button>
      </InboxState>
    )
  }
  if (pages.isPending || !areChannelsReady) {
    return (
      <p role="status" className="text-muted-foreground p-6 text-center text-sm">
        {t('loadingList')}
      </p>
    )
  }
  if (items.length === 0) {
    return hasFilters(filters) ? (
      <InboxState icon={SearchX} title={t('noResults.title')} body={t('noResults.body')} />
    ) : (
      <InboxState icon={Inbox} title={t('empty.title')} body={t('empty.body')} />
    )
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <ul
        aria-label={t('listLabel')}
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualRows.map(row => {
          const item = items[row.index]
          if (item === undefined) return null
          return (
            // Measured, not fixed: a larger font or a wrapped badge makes a taller row
            <li
              key={row.key}
              ref={virtualizer.measureElement}
              data-index={row.index}
              aria-setsize={hasNextPage ? -1 : items.length}
              aria-posinset={row.index + 1}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              <ConversationItem
                storeId={storeId}
                item={item}
                channelName={channelNames.get(item.channelType) ?? item.channelType}
                isSelected={item.id === conversationId}
                search={search}
                now={now}
              />
            </li>
          )
        })}
      </ul>
      {isFetchingNextPage ? (
        <p role="status" className="text-muted-foreground p-3 text-center text-xs">
          {t('loadingMore')}
        </p>
      ) : null}
      {pages.isError ? (
        <div role="alert" className="flex items-center justify-between gap-2 border-t p-3 text-sm">
          <span>{tAll(`errors.${errorCodeOf(pages.error)}`)}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void pages.refetch()}>
            {tAll('common.tryAgain')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
