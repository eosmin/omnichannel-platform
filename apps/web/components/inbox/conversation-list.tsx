'use client'

import { useVirtualizer } from '@tanstack/react-virtual'
import { Lock, PencilLine, SearchX, TriangleAlert } from 'lucide-react'
import { useParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { ChannelDirectoryEntryView, ConversationFilters } from '@platform/api-client'
import { ApiError } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { BulkActions, BulkLimits, ListKeyAliases, Shortcuts } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'

import { useConversationIdsWithDraft } from '../../lib/inbox/composer-draft-index'
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
import { useConversationPages, useInboxBehavior } from '../../lib/inbox/use-inbox-data'
import { ShortcutPriority } from '../../lib/shortcuts/priorities'
import { useErrorText } from '../../lib/use-error-text'
import { useMountedOnce } from '../../lib/use-mounted-once'
import { useProfile } from '../../lib/use-profile'
import { useStore } from '../providers/store-context'
import { useShortcut } from '../shortcuts/shortcuts-provider'
import { Button } from '../ui/button'

import { CONVERSATION_ROW_HEIGHT_PX, ConversationItem } from './conversation-item'
import { InboxState } from './inbox-state'
import { BulkBar, EmptyInbox, SnoozeDialog } from './lazy-dialogs'
import { resolveModeOf } from './resolve-flow'
import { RowCheckbox } from './row-checkbox'
import { RowResolve, type RowResolveWay } from './row-resolve'
import { RowResolveButton } from './row-resolve-button'
import { RowSnooze } from './row-snooze'

const OVERSCAN_ROWS = 6
// A row far down is not drawn yet: the focus waits for the list to scroll to it
const FOCUS_ATTEMPTS = 8
const NOW_REFRESH_MS = 60_000
// The view "With draft" asks for more pages until it has found the drafts it knows of, up to this many: a person
// does not have so many drafts in a tab, and a draft of a conversation that no filter lets in is never found
const DRAFT_VIEW_MAX_PAGES = 20

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
  onlyDrafts,
  search,
  channels,
  areChannelsReady
}: {
  storeId: string
  filters: ConversationFilters
  // Only the conversations that have an unsent draft of this person, in this tab
  onlyDrafts: boolean
  search: string
  channels: readonly ChannelDirectoryEntryView[]
  // The names of the channels are known (or could not be read): until then the rows would show an id
  areChannelsReady: boolean
}): ReactElement {
  const t = useTranslations('inbox')
  const errorText = useErrorText()
  const tAll = useTranslations()
  const { conversationId } = useParams<{ conversationId?: string }>()
  const now = useNow()
  const pages = useConversationPages(storeId, filters)
  const loaded = useMemo(() => pages.data?.pages.flatMap(page => page.data) ?? [], [pages.data])
  const userId = useProfile().data?.id
  const draftIds = useConversationIdsWithDraft(userId, storeId)
  const items = useMemo(() => {
    if (!onlyDrafts) return loaded
    const withDraft = new Set(draftIds)
    return loaded.filter(item => withDraft.has(item.id))
  }, [loaded, onlyDrafts, draftIds])
  // The drafts of conversations that have not come yet: the next pages are asked for until they do
  const missingDrafts = onlyDrafts && items.length < draftIds.length
  const pagesLoaded = pages.data?.pages.length ?? 0
  const isLookingForDrafts =
    missingDrafts && pages.hasNextPage && pagesLoaded < DRAFT_VIEW_MAX_PAGES
  const channelNames = useMemo(
    () => new Map(channels.map(channel => [channel.pluginId, channel.pluginName])),
    [channels]
  )

  // The ticked rows belong to the filters they were ticked under: other filters, other list
  // The draft view is part of what was ticked under: "all that match" in one is not the same list as in the other
  const filterKey = JSON.stringify({ filters, onlyDrafts })
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
  const isSnoozeMounted = useMountedOnce(snoozeFor !== null)
  // The row a resolve runs for, and whether it is the way the main button does not take (`Shift+E`)
  const [resolveFor, setResolveFor] = useState<{ id: string; way: RowResolveWay } | null>(null)

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
    nameOf(item.customer, item.anonymousCustomers)
  const focusedItem = (): (typeof items)[number] | undefined => {
    const id = rowIdOf(document.activeElement)
    return id === undefined ? undefined : items.find(item => item.id === id)
  }
  const mayAssign =
    can(ClientPermissions.CONVERSATIONS_RESOLVE) || can(ClientPermissions.CONVERSATIONS_ASSIGN)
  const mayResolve = can(ClientPermissions.CONVERSATIONS_RESOLVE)
  // The way the button of a row takes: the one the store chose, which the arrow marks
  const resolveSettings = useInboxBehavior(storeId).data
  const defaultResolveMode = resolveSettings === undefined ? null : resolveModeOf(resolveSettings)
  const maySnooze = can(ClientPermissions.CONVERSATIONS_SNOOZE)
  useShortcut(
    Shortcuts.list.ASSIGN_TO_ME,
    () => {
      const item = focusedItem()
      if (item === undefined) return false
      if (!runner.claim()) return
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
      if (!runner.claim()) return
      // The flow of the store (reason, closing message), as in the open conversation
      setResolveFor({ id: item.id, way: 'default' })
    },
    { enabled: mayResolve, priority: ShortcutPriority.FOCUSED_ROW }
  )
  useShortcut(
    Shortcuts.list.MARK_RESOLVED_OTHER_WAY,
    () => {
      const item = focusedItem()
      if (item === undefined || !canChangeState(item.status)) return false
      if (!runner.claim()) return
      setResolveFor({ id: item.id, way: 'other' })
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

  useEffect(() => {
    if (isLookingForDrafts && !isFetchingNextPage && !isError) void fetchNextPage()
  }, [isLookingForDrafts, isFetchingNextPage, isError, fetchNextPage, pagesLoaded])

  // The next page is asked for when the last loaded row comes into view
  useEffect(() => {
    // The draft view has its own rule (above), with a limit: the last row of a short list is always in view
    if (!onlyDrafts && lastRow !== undefined && lastRow.index >= items.length - 1 && hasNextPage) {
      // After a failure the "Try again" button asks again: an effect that did would loop
      if (!isFetchingNextPage && !isError) void fetchNextPage()
    }
  }, [lastRow, items.length, hasNextPage, isFetchingNextPage, isError, fetchNextPage, onlyDrafts])

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
        body={errorText(pages.error)}
        isAlert
      >
        <Button type="button" variant="outline" size="sm" onClick={() => void pages.refetch()}>
          {tAll('common.tryAgain')}
        </Button>
      </InboxState>
    )
  }
  // On a reload at the draft view the person is not known yet, so the drafts are not either: not "no drafts" yet
  const isDraftViewWaiting = onlyDrafts && userId === undefined
  if (
    pages.isPending ||
    !areChannelsReady ||
    isDraftViewWaiting ||
    (items.length === 0 && isLookingForDrafts)
  ) {
    return (
      <p role="status" className="text-muted-foreground p-6 text-center text-sm">
        {t('loadingList')}
      </p>
    )
  }
  if (items.length === 0) {
    if (onlyDrafts) {
      return <InboxState icon={PencilLine} title={t('noDrafts.title')} body={t('noDrafts.body')} />
    }
    return hasFilters(filters) ? (
      <InboxState icon={SearchX} title={t('noResults.title')} body={t('noResults.body')} />
    ) : (
      <EmptyInbox />
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
          // "All that match" is the api's list; the view of drafts is only in this tab, so it cannot be widened
          hasMore={hasNextPage && !onlyDrafts}
        />
      ) : null}
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain max-md:h-[70dvh] max-md:flex-none"
      >
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
                    anonymous={item.anonymousCustomers}
                    isChecked={selection.ids.has(item.id)}
                    isSelecting={isSelecting}
                    onToggle={() => setSelection(toggleId(selection, item.id))}
                  />
                  {mayResolve && canChangeState(item.status) ? (
                    <RowResolveButton
                      customer={item.customer}
                      anonymous={item.anonymousCustomers}
                      defaultMode={defaultResolveMode}
                      onResolve={way => {
                        if (!runner.claim()) return
                        setResolveFor({ id: item.id, way })
                      }}
                    />
                  ) : null}
                  {maySnooze && canChangeState(item.status) ? (
                    <RowSnooze
                      customer={item.customer}
                      anonymous={item.anonymousCustomers}
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
            <span>{errorText(pages.error)}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => void pages.refetch()}>
              {tAll('common.tryAgain')}
            </Button>
          </div>
        ) : null}
      </div>
      {isSnoozeMounted ? (
        <SnoozeDialog
          open={snoozeFor !== null}
          onOpenChange={open => (open ? undefined : setSnoozeFor(null))}
          conversationId={snoozeFor ?? ''}
        />
      ) : null}
      {resolveFor === null ? null : (
        <RowResolve
          key={`${resolveFor.id}-${resolveFor.way}`}
          conversationId={resolveFor.id}
          way={resolveFor.way}
          onFinished={() => setResolveFor(null)}
        />
      )}
    </>
  )
}
