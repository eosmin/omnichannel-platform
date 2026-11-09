'use client'

import { ArrowDown, MessageSquare, TriangleAlert } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { quotedFileOf } from '../../lib/inbox/file-targets'
import { groupImageRuns } from '../../lib/inbox/image-runs'
import { messageActionsOf } from '../../lib/inbox/message-actions'
import { groupNoticeRuns } from '../../lib/inbox/notice-runs'
import { buildThreadItems, isFromCustomer, memberIdsOf } from '../../lib/inbox/thread-items'
import { stickyDayOf, unseenAfter } from '../../lib/inbox/thread-reading'
import { useAuthorLabel } from '../../lib/inbox/use-author-label'
import { useComposerQueue } from '../../lib/inbox/use-composer-queue'
import { useCustomerName } from '../../lib/inbox/use-customer-name'
import {
  useConversation,
  useMemberDirectory,
  useOrigins,
  useThread
} from '../../lib/inbox/use-inbox-data'
import { useMarkRead } from '../../lib/inbox/use-mark-read'
import { useActionViewer } from '../../lib/inbox/use-message-actions'
import { useConversationRoom } from '../../lib/realtime/use-conversation-room'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { ImageRun } from './image-run'
import { InboxState } from './inbox-state'
import { MessageBubble, messageDomId } from './message-bubble'
import { OriginCard } from './origin-card'
import { PendingBubble } from './pending-bubble'

// Closer to the end than this, a message that arrives keeps the thread at the end; farther, the
// reader is left where they are
const NEAR_END_PX = 80
// The floating day stays this long after the last scroll
const STICKY_DAY_VISIBLE_MS = 1500

const dayDomId = (key: string): string => `day-${key}`

// The messages of the open conversation, oldest first, with the origin of the conversation on top.
// Older pages load when the top comes into view (and from a button, for who cannot scroll). A
// message that arrives moves the thread only if the reader was at its end. The frame gives it a key
// per conversation, so every conversation starts at its end with nothing carried over.
export function MessageThread({ conversationId }: { conversationId: string }): ReactElement | null {
  const t = useTranslations('inbox.thread')
  const errorText = useErrorText()
  const tAll = useTranslations()
  const format = useFormatter()
  const { storeId } = useStore()
  const conversation = useConversation(storeId, conversationId)
  const thread = useThread(storeId, conversationId)
  const origins = useOrigins(storeId, conversationId)
  const { name: customerName } = useCustomerName(
    conversation.data?.customer ?? {
      id: '',
      name: null,
      displayIdentity: '',
      username: null,
      avatarUrl: null
    },
    conversation.data?.channelType ?? ''
  )
  // Typing and the read marks of the open conversation come through its room
  useConversationRoom(conversationId)
  const { waiting } = useComposerQueue(storeId, conversationId)
  const viewer = useActionViewer(conversationId)
  const members = useMemberDirectory(storeId)
  const memberNames = useMemo(
    () => new Map((members.data ?? []).map(member => [member.id, member.name])),
    [members.data]
  )

  const items = useMemo(
    () => buildThreadItems(thread.data?.pages.map(page => page.data) ?? []),
    [thread.data]
  )
  const memberIds = useMemo(() => memberIdsOf(items), [items])
  const authorLabel = useAuthorLabel(customerName, memberIds)
  // The messages of the loaded part of the thread by id: a reply to one file of an album says which one
  const loadedById = useMemo(
    () =>
      new Map(
        items.flatMap(item =>
          item.kind === 'message' ? [[item.message.id, item.message] as const] : []
        )
      ),
    [items]
  )
  const loadedIds = useMemo(
    () => new Set(items.flatMap(item => (item.kind === 'message' ? [item.message.id] : []))),
    [items]
  )

  // What the reader has reached: reading the end of the thread is what marks it read, and what arrives
  // while they read above waits behind a button (W3c). `seenId` is the last message they were at the end for.
  const [isAtEnd, setAtEnd] = useState(true)
  const [seenId, setSeenId] = useState<string | null>(null)
  const [stickyKey, setStickyKey] = useState<string | null>(null)
  const [isScrolling, setScrolling] = useState(false)
  const scrollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const frame = useRef<number | undefined>(undefined)
  useMarkRead(
    conversationId,
    conversation.data?.unreadCount,
    isAtEnd,
    (conversation.data?.attention ?? null) !== null
  )
  const messageIds = useMemo(
    () => items.flatMap(item => (item.kind === 'message' ? [item.message.id] : [])),
    [items]
  )
  const fromCustomer = useMemo(
    () =>
      new Set(
        items.flatMap(item =>
          item.kind === 'message' && isFromCustomer(item.message) ? [item.message.id] : []
        )
      ),
    [items]
  )
  // Pictures a customer sent one after the other are drawn as one block; the logic of the thread keeps its items
  const entries = useMemo(() => groupNoticeRuns(groupImageRuns(items)), [items])
  const stickyDay = items.find(item => item.kind === 'day' && item.key === stickyKey)
  const unseen = unseenAfter(messageIds, seenId, fromCustomer)

  // The elements are state, not refs: the thread draws nothing until the conversation is read, so
  // they can appear after the data does, and the effects have to run again when they do
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [top, setTop] = useState<HTMLDivElement | null>(null)
  const [content, setContent] = useState<HTMLDivElement | null>(null)
  // `height` is the scroll height the last time the thread was adjusted. Whether the reader is at the
  // end is worked out from it and the scroll as it is now, never from an event: a scroll event can
  // come after the thread has changed size, and the thread would pull the reader back to the end.
  const position = useRef({
    firstId: null as string | null,
    lastId: null as string | null,
    height: 0,
    // Where the first loaded message sits in the view when older ones are asked for
    anchorTop: null as number | null
  })
  const wasAtEnd = useCallback(
    (element: HTMLElement): boolean =>
      position.current.height - element.scrollTop - element.clientHeight < NEAR_END_PX,
    []
  )

  const lastIdRef = useRef<string | null>(null)
  const firstItem = items.find(item => item.kind === 'message')
  const lastItem = items.findLast(item => item.kind === 'message')
  const firstId = firstItem?.kind === 'message' ? firstItem.message.id : null
  const lastId = lastItem?.kind === 'message' ? lastItem.message.id : null
  lastIdRef.current = lastId

  useLayoutEffect(() => {
    const element = scroller
    if (element === null) return
    const before = position.current
    if (before.lastId === null) {
      element.scrollTop = element.scrollHeight
      setSeenId(lastId)
    } else if (lastId !== before.lastId && wasAtEnd(element)) {
      element.scrollTop = element.scrollHeight
      setSeenId(lastId)
    } else if (firstId !== before.firstId && lastId === before.lastId) {
      // Older messages went in above: the message that was first is put back where it was in the
      // view. Its place is measured, not the height that was added: the "load earlier" block goes
      // away with the last page, and that is not part of what the reader was looking at.
      const anchor =
        before.firstId === null ? null : document.getElementById(messageDomId(before.firstId))
      if (anchor !== null && before.anchorTop !== null) {
        element.scrollTop +=
          anchor.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          before.anchorTop
      }
    }
    position.current = { firstId, lastId, height: element.scrollHeight, anchorTop: null }
  }, [scroller, firstId, lastId, wasAtEnd])

  // What the agent just wrote is what they look at next, wherever the thread was scrolled to
  const waitingCount = waiting.length
  const previousWaiting = useRef(waitingCount)
  useLayoutEffect(() => {
    const grew = waitingCount > previousWaiting.current
    previousWaiting.current = waitingCount
    if (grew && scroller !== null) scroller.scrollTop = scroller.scrollHeight
  }, [scroller, waitingCount])

  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = thread
  const loadEarlier = useCallback((): void => {
    const { firstId: first } = position.current
    const anchor = first === null ? null : document.getElementById(messageDomId(first))
    if (scroller !== null && anchor !== null) {
      position.current.anchorTop =
        anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    }
    void fetchNextPage()
  }, [scroller, fetchNextPage])

  // While an older page is on its way the reader may keep scrolling: the place to go back to is the
  // one of the moment the page arrives, so it follows the scroll
  const keepAnchorCurrent = useCallback((): void => {
    const { firstId: first, anchorTop } = position.current
    if (scroller === null || first === null || anchorTop === null) return
    const anchor = document.getElementById(messageDomId(first))
    if (anchor !== null) {
      position.current.anchorTop =
        anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    }
  }, [scroller])

  // The origin card sits above every message: when it grows (its earlier origins unfold) while the
  // reader is below it, the messages move down and the reader is moved with them. Anything else that
  // changes size above the view is not followed (no message draws a picture yet; Step 3.4 does).
  const keepPlaceBelow = useCallback(
    (growth: number, card: HTMLElement): void => {
      if (scroller === null || wasAtEnd(scroller)) return
      const bottomBefore = card.getBoundingClientRect().bottom - growth
      if (bottomBefore <= scroller.getBoundingClientRect().top) {
        scroller.scrollTop += growth
        // The height the scroll position matches now, so the next check does not read it as a move
        position.current.height += growth
      }
    },
    [scroller, wasAtEnd]
  )

  useEffect(() => {
    const root = scroller
    // After a failure the reader asks again with the button: an observer would ask on its own, for as
    // long as the top is in view
    if (top === null || root === null || !hasNextPage || isFetchNextPageError) return
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting) && !isFetchingNextPage) loadEarlier()
      },
      { root }
    )
    observer.observe(top)
    return () => observer.disconnect()
  }, [scroller, top, hasNextPage, isFetchingNextPage, isFetchNextPageError, loadEarlier])

  // What grows after the first draw (the origin card, a picture) keeps a reader who is at the end
  // at the end
  useEffect(() => {
    const element = scroller
    if (content === null || element === null) return
    const observer = new ResizeObserver(() => {
      if (wasAtEnd(element)) element.scrollTop = element.scrollHeight
      position.current.height = element.scrollHeight
      // The size of the thread or of its window changed without a scroll: the end may be in view now
      const near = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_END_PX
      setAtEnd(near)
      if (near) setSeenId(lastIdRef.current)
    })
    observer.observe(content)
    observer.observe(element)
    return () => observer.disconnect()
  }, [scroller, content, wasAtEnd])

  const onScroll = useCallback((): void => {
    keepAnchorCurrent()
    const element = scroller
    if (element === null) return
    const near = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_END_PX
    setAtEnd(near)
    if (near) setSeenId(lastId)
    // The day of the top of the view floats while the reader scrolls, once its own separator is above it.
    // Looking for the separators costs a pass over the thread, so it is done once for each frame.
    // At the end the thread follows itself (when it opens, when a message arrives): nothing floats there
    if (near) {
      setScrolling(false)
      return
    }
    setScrolling(true)
    clearTimeout(scrollTimer.current)
    scrollTimer.current = setTimeout(() => setScrolling(false), STICKY_DAY_VISIBLE_MS)
    if (frame.current !== undefined) return
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined
      const days = items.flatMap(item => {
        if (item.kind !== 'day') return []
        const separator = document.getElementById(dayDomId(item.key))
        return separator === null ? [] : [{ key: item.key, at: item.at, top: separator.offsetTop }]
      })
      const key = stickyDayOf(days, element.scrollTop)
      const current = days.find(day => day.key === key)
      setStickyKey(current === undefined ? null : current.key)
    })
  }, [scroller, items, lastId, keepAnchorCurrent])
  useEffect(
    () => () => {
      clearTimeout(scrollTimer.current)
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
      frame.current = undefined
    },
    []
  )

  const showNewMessages = useCallback((): void => {
    if (scroller === null) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
    // The button goes away with the new messages: the focus goes to the last message, not to the page
    if (lastId !== null)
      document.getElementById(messageDomId(lastId))?.focus({ preventScroll: true })
  }, [scroller, lastId])

  const jumpTo = useCallback(
    (messageId: string): void => {
      const target = document.getElementById(messageDomId(messageId))
      if (target === null) return
      // The thread is moved, and only the thread: `scrollIntoView` moves every scrollable ancestor,
      // the page included, which left the header out of sight and a white gap under the thread
      if (scroller !== null) {
        const box = scroller.getBoundingClientRect()
        const at = target.getBoundingClientRect()
        // Centred, or by its top when it is taller than the thread (its beginning is what is looked for)
        const offset = Math.max(0, (box.height - at.height) / 2)
        scroller.scrollTo({ top: scroller.scrollTop + at.top - box.top - offset })
      }
      target.focus({ preventScroll: true })
    },
    [scroller]
  )

  // The header says why a conversation cannot be read; the thread waits for it
  if (conversation.data === undefined) return null

  if (thread.isError && thread.data === undefined) {
    return (
      <InboxState
        icon={TriangleAlert}
        title={t('error.title')}
        body={errorText(thread.error)}
        isAlert
      >
        <Button type="button" variant="outline" size="sm" onClick={() => void thread.refetch()}>
          {tAll('common.tryAgain')}
        </Button>
      </InboxState>
    )
  }
  if (thread.isPending) {
    return (
      <p role="status" className="text-muted-foreground p-6 text-sm">
        {t('loading')}
      </p>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={setScroller}
        // The browser keeps what is in view when something goes in above; the thread does it itself
        onScroll={onScroll}
        // `relative`: the hidden texts inside (`sr-only` is absolute) take the thread as their container and are clipped
        // by it; without it they escape and make the whole page taller. `overscroll-contain`: the wheel at the
        // end of the thread does not go on to scroll the page
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
      >
        <div ref={setTop} />
        <div ref={setContent}>
          {origins.data === undefined ? null : (
            <OriginCard storeId={storeId} origins={origins.data} onGrow={keepPlaceBelow} />
          )}
          {hasNextPage ? (
            <div className="flex justify-center p-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isFetchingNextPage}
                onClick={loadEarlier}
              >
                {isFetchingNextPage ? t('loadingEarlier') : t('loadEarlier')}
              </Button>
              {isFetchNextPageError ? (
                <p role="alert" className="text-destructive ml-3 self-center text-xs">
                  {t('loadEarlierFailed')}
                </p>
              ) : null}
            </div>
          ) : null}
          {items.length === 0 && waiting.length === 0 ? (
            <InboxState icon={MessageSquare} title={t('empty.title')} body={t('empty.body')} />
          ) : (
            <ol aria-label={t('label')} className="compact:p-2 flex flex-col p-3">
              {entries.map(item =>
                item.kind === 'day' ? (
                  <li
                    id={dayDomId(item.key)}
                    key={`day-${item.key}`}
                    className="text-muted-foreground mt-3 flex justify-center text-xs"
                  >
                    <time dateTime={item.key} className="bg-muted rounded-full px-3 py-0.5">
                      {format.dateTime(item.at, { dateStyle: 'full' })}
                    </time>
                  </li>
                ) : item.kind === 'imageRun' ? (
                  <li
                    // The key of the first picture, as a lone picture has: the entry keeps its place when a second joins
                    key={item.messages[0]?.id ?? 'run'}
                    className={item.showAuthor ? 'compact:mt-1.5 mt-3' : 'compact:mt-0.5 mt-1'}
                  >
                    <ImageRun
                      messages={item.messages}
                      showAuthor={item.showAuthor}
                      authorLabel={authorLabel}
                      actionsOf={message => messageActionsOf(message, viewer)}
                      conversationId={conversationId}
                      userId={viewer.userId}
                    />
                  </li>
                ) : item.kind === 'noticeRun' ? (
                  <li
                    // The key of the first notice, as a lone one has: the entry keeps its place when another joins
                    key={item.messages[0]?.id ?? 'notices'}
                    className={item.showAuthor ? 'compact:mt-1.5 mt-3' : 'compact:mt-0.5 mt-1'}
                  >
                    <MessageBubble
                      // The bubble is the last notice's (its hour and its menu); the others keep their place for a quote
                      message={item.last}
                      showAuthor={item.showAuthor}
                      authorLabel={authorLabel}
                      loadedIds={loadedIds}
                      onJumpTo={jumpTo}
                      actions={messageActionsOf(item.last, viewer)}
                      conversationId={conversationId}
                      userId={viewer.userId}
                      mentionNames={[]}
                      notice={{
                        count: item.messages.length,
                        otherIds: item.messages.slice(0, -1).map(message => message.id)
                      }}
                    />
                  </li>
                ) : (
                  <li
                    key={item.message.id}
                    className={item.showAuthor ? 'compact:mt-1.5 mt-3' : 'compact:mt-0.5 mt-1'}
                  >
                    <MessageBubble
                      message={item.message}
                      showAuthor={item.showAuthor}
                      authorLabel={authorLabel}
                      loadedIds={loadedIds}
                      onJumpTo={jumpTo}
                      actions={messageActionsOf(item.message, viewer)}
                      conversationId={conversationId}
                      userId={viewer.userId}
                      mentionNames={item.message.mentions.flatMap(id => memberNames.get(id) ?? [])}
                      quotedFile={quotedFileOf(
                        loadedById.get(item.message.replyToMessageId ?? ''),
                        item.message.replyToMediaId
                      )}
                    />
                  </li>
                )
              )}
              {waiting.map(message => (
                <li key={message.id} className="mt-1">
                  <PendingBubble message={message} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
      {stickyDay !== undefined && isScrolling ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-2 flex justify-center"
        >
          <time
            dateTime={stickyDay.kind === 'day' ? stickyDay.key : undefined}
            className="bg-muted/95 text-muted-foreground rounded-full px-3 py-0.5 text-xs shadow-sm"
          >
            {stickyDay.kind === 'day' ? format.dateTime(stickyDay.at, { dateStyle: 'full' }) : null}
          </time>
        </div>
      ) : null}
      {/* Said to a screen reader when the count changes; the button itself is for who sees */}
      <p role="status" className="sr-only">
        {unseen > 0 && !isAtEnd ? t('newMessages', { count: unseen }) : ''}
      </p>
      {unseen > 0 && !isAtEnd ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            type="button"
            size="sm"
            className="pointer-events-auto shadow-md"
            onClick={showNewMessages}
          >
            <ArrowDown aria-hidden />
            {t('newMessages', { count: unseen })}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
