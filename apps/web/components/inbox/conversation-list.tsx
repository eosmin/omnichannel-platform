'use client'

import { useVirtualizer } from '@tanstack/react-virtual'
import { Inbox, Lock, SearchX, TriangleAlert } from 'lucide-react'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ChannelDirectoryEntryView, ConversationFilters } from '@platform/api-client'
import { ApiError } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'
import {
  BulkActions,
  BulkLimits,
  ConversationStatus,
  ListKeyAliases,
  Shortcuts
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'

import { errorCodeOf } from '../../lib/error-message'
import { canChangeState } from '../../lib/inbox/conversation-status'
import { hasFilters } from '../../lib/inbox/inbox-filters'
import {
  type Direction,
  neighborIndex,
  ROW_ID_ATTRIBUTE,
  rowIdOf
} from '../../lib/inbox/list-navigation'
import {
  EMPTY_SELECTION,
  retainLoaded,
  type Selection,
  selectIds,
  toggleId
} from '../../lib/inbox/selection'
import { useBulkRunner } from '../../lib/inbox/use-bulk-actions'
import { useCustomerNamer } from '../../lib/inbox/use-customer-name'
import { useConversationPages } from '../../lib/inbox/use-inbox-data'
import { ShortcutPriority } from '../../lib/shortcuts/priorities'
import { useStore } from '../providers/store-context'
import { useShortcut } from '../shortcuts/shortcuts-provider'
import { Button } from '../ui/button'

import { BulkBar } from './bulk-bar'
import { CONVERSATION_ROW_HEIGHT_PX, ConversationItem } from './conversation-item'
import { InboxState } from './inbox-state'
import { RowCheckbox } from './row-checkbox'
import { RowSnooze } from './row-snooze'
import { SnoozeDialog } from './snooze-dialog'

const OVERSCAN_ROWS = 6
// A row far down is not drawn yet: the focus waits for the list to scroll to it
const FOCUS_ATTEMPTS = 8
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

  // The ticked rows belong to the filters they were ticked under: other filters, other list
  const filterKey = JSON.stringify(filters)
  const [ticked, setTicked] = useState<{ filterKey: string; selection: Selection }>({
    filterKey,
    selection: EMPTY_SELECTION
  })
  // Other filters, other list: what was ticked is dropped for good, not hidden until the filters return
  if (ticked.filterKey !== filterKey) setTicked({ filterKey, selection: EMPTY_SELECTION })
  const loadedIds = useMemo(() => new Set(items.map(item => item.id)), [items])
  const selection = useMemo(
    () =>
      ticked.filterKey === filterKey ? retainLoaded(ticked.selection, loadedIds) : EMPTY_SELECTION,
    [ticked, filterKey, loadedIds]
  )
  const setSelection = (next: Selection): void => setTicked({ filterKey, selection: next })
  const isSelecting = selection.ids.size > 0 || selection.isAllMatching

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

  const { can } = useStore()
  const runner = useBulkRunner()
  const nameOf = useCustomerNamer()
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null)

  const focusRow = useCallback((id: string, attemptsLeft = FOCUS_ATTEMPTS): void => {
    const link = scrollRef.current?.querySelector<HTMLElement>(`[${ROW_ID_ATTRIBUTE}="${id}"] a`)
    if (link !== null && link !== undefined) link.focus()
    else if (attemptsLeft > 0) requestAnimationFrame(() => focusRow(id, attemptsLeft - 1))
  }, [])

  const move = (direction: Direction, event: KeyboardEvent): boolean => {
    // The arrows scroll the page and move through menus: they are the list's only while it has the focus
    const isArrow =
      event.key === ListKeyAliases.NEXT_CONVERSATION ||
      event.key === ListKeyAliases.PREVIOUS_CONVERSATION
    if (isArrow && !(event.target instanceof Node && scrollRef.current?.contains(event.target))) {
      return false
    }
    const ids = items.map(item => item.id)
    const at = neighborIndex(ids, rowIdOf(document.activeElement) ?? conversationId, direction)
    const id = at === null ? undefined : ids[at]
    if (at === null || id === undefined) return false
    virtualizer.scrollToIndex(at)
    focusRow(id)
    return true
  }
  useShortcut([Shortcuts.list.NEXT_CONVERSATION, ListKeyAliases.NEXT_CONVERSATION], event =>
    move(1, event)
  )
  useShortcut([Shortcuts.list.PREVIOUS_CONVERSATION, ListKeyAliases.PREVIOUS_CONVERSATION], event =>
    move(-1, event)
  )
  useShortcut(Shortcuts.list.TOGGLE_SELECTION, () => {
    const id = rowIdOf(document.activeElement) ?? conversationId
    if (id === undefined || !loadedIds.has(id)) return false
    setSelection(toggleId(selection, id))
  })
  useShortcut(Shortcuts.list.SELECT_ALL_VISIBLE, () => {
    if (items.length === 0) return false
    setSelection(selectIds(items.slice(0, BulkLimits.MAX_ITEMS).map(item => item.id)))
  })

  // On the row that has the focus. With rows ticked the bar's handlers come first, and with none the
  // open conversation's come after these
  const nameOfRow = (item: (typeof items)[number]): string =>
    nameOf(item.customer, channelNames.get(item.channelType) ?? item.channelType)
  const focusedItem = (): (typeof items)[number] | undefined => {
    const id = rowIdOf(document.activeElement)
    return id === undefined ? undefined : items.find(item => item.id === id)
  }
  const mayAssign = can(Permissions.CONVERSATIONS_RESOLVE) || can(Permissions.CONVERSATIONS_ASSIGN)
  const mayResolve = can(Permissions.CONVERSATIONS_RESOLVE)
  const maySnooze = can(Permissions.CONVERSATIONS_SNOOZE)
  useShortcut(
    Shortcuts.list.ASSIGN_TO_ME,
    () => {
      const item = focusedItem()
      if (item === undefined) return false
      if (runner.isBusy()) return
      void runner.run(
        { action: BulkActions.ASSIGN_TO_ME },
        { conversationIds: [item.id] },
        [item],
        nameOfRow(item)
      )
    },
    { enabled: mayAssign, priority: ShortcutPriority.FOCUSED_ROW }
  )
  useShortcut(
    Shortcuts.list.MARK_RESOLVED,
    () => {
      const item = focusedItem()
      if (item === undefined || !canChangeState(item.status)) return false
      if (runner.isBusy()) return
      void runner.run(
        { action: BulkActions.SET_STATUS, params: { status: ConversationStatus.RESOLVED } },
        { conversationIds: [item.id] },
        [item],
        nameOfRow(item)
      )
    },
    { enabled: mayResolve, priority: ShortcutPriority.FOCUSED_ROW }
  )
  useShortcut(
    Shortcuts.conversation.SNOOZE,
    () => {
      const item = focusedItem()
      if (item === undefined || !canChangeState(item.status)) return false
      setSnoozeFor(item.id)
    },
    { enabled: maySnooze, priority: ShortcutPriority.FOCUSED_ROW }
  )

  // Leaving a conversation (the back button of a phone, Escape) puts the focus back on its row; the
  // composer that had it is gone
  const openedBefore = useRef<string | undefined>(undefined)
  useEffect(() => {
    const before = openedBefore.current
    openedBefore.current = conversationId
    if (conversationId === undefined && before !== undefined) {
      // The row may be out of the drawn window: scroll to it first, as moving with j does
      const at = items.findIndex(item => item.id === before)
      if (at !== -1) virtualizer.scrollToIndex(at)
      focusRow(before)
    }
    // Only a change of the open conversation moves the focus, not a new page of the list
  }, [conversationId])

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
    <>
      {isSelecting ? (
        <BulkBar
          selection={selection}
          onSelectionChange={setSelection}
          items={items}
          filters={filters}
          hasMore={hasNextPage}
        />
      ) : null}
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
                <div className="group relative" {...{ [ROW_ID_ATTRIBUTE]: item.id }}>
                  <ConversationItem
                    storeId={storeId}
                    item={item}
                    channelName={channelNames.get(item.channelType) ?? item.channelType}
                    isSelected={item.id === conversationId}
                    search={search}
                    now={now}
                  />
                  <RowCheckbox
                    customer={item.customer}
                    channelName={channelNames.get(item.channelType) ?? item.channelType}
                    isChecked={selection.ids.has(item.id)}
                    isSelecting={isSelecting}
                    onToggle={() => setSelection(toggleId(selection, item.id))}
                  />
                  {maySnooze && canChangeState(item.status) ? (
                    <RowSnooze
                      customer={item.customer}
                      channelName={channelNames.get(item.channelType) ?? item.channelType}
                      onSnooze={() => setSnoozeFor(item.id)}
                    />
                  ) : null}
                </div>
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
          <div
            role="alert"
            className="flex items-center justify-between gap-2 border-t p-3 text-sm"
          >
            <span>{tAll(`errors.${errorCodeOf(pages.error)}`)}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void pages.refetch()}>
              {tAll('common.tryAgain')}
            </Button>
          </div>
        ) : null}
      </div>
      <SnoozeDialog
        open={snoozeFor !== null}
        onOpenChange={open => (open ? undefined : setSnoozeFor(null))}
        conversationId={snoozeFor ?? ''}
      />
    </>
  )
}
