'use client'

import { MessageSquare, TriangleAlert } from 'lucide-react'
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

import { errorCodeOf } from '../../lib/error-message'
import { messageActionsOf } from '../../lib/inbox/message-actions'
import { buildThreadItems, memberIdsOf } from '../../lib/inbox/thread-items'
import { useAuthorLabel } from '../../lib/inbox/use-author-label'
import { useComposerQueue } from '../../lib/inbox/use-composer-queue'
import { useCustomerName } from '../../lib/inbox/use-customer-name'
import {
  useChannelName,
  useConversation,
  useMemberDirectory,
  useOrigins,
  useThread
} from '../../lib/inbox/use-inbox-data'
import { useMarkRead } from '../../lib/inbox/use-mark-read'
import { useActionViewer } from '../../lib/inbox/use-message-actions'
import { useConversationRoom } from '../../lib/realtime/use-conversation-room'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { InboxState } from './inbox-state'
import { MessageBubble, messageDomId } from './message-bubble'
import { OriginCard } from './origin-card'
import { PendingBubble } from './pending-bubble'

// Closer to the end than this, a message that arrives keeps the thread at the end; farther, the
// reader is left where they are
const NEAR_END_PX = 80

// The messages of the open conversation, oldest first, with the origin of the conversation on top.
// Older pages load when the top comes into view (and from a button, for who cannot scroll). A
// message that arrives moves the thread only if the reader was at its end. The frame gives it a key
// per conversation, so every conversation starts at its end with nothing carried over.
export function MessageThread({ conversationId }: { conversationId: string }): ReactElement | null {
  const t = useTranslations('inbox.thread')
  const tAll = useTranslations()
  const format = useFormatter()
  const { storeId } = useStore()
  const conversation = useConversation(storeId, conversationId)
  const thread = useThread(storeId, conversationId)
  const origins = useOrigins(storeId, conversationId)
  const channelName = useChannelName(storeId, conversation.data?.channelType ?? '')
  const { name: customerName } = useCustomerName(
    conversation.data?.customer ?? {
      id: '',
      name: null,
      displayIdentity: '',
      username: null,
      avatarUrl: null
    },
    channelName
  )
  useMarkRead(conversationId, conversation.data?.unreadCount)
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
  const loadedIds = useMemo(
    () => new Set(items.flatMap(item => (item.kind === 'message' ? [item.message.id] : []))),
    [items]
  )

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

  const firstItem = items.find(item => item.kind === 'message')
  const lastItem = items.findLast(item => item.kind === 'message')
  const firstId = firstItem?.kind === 'message' ? firstItem.message.id : null
  const lastId = lastItem?.kind === 'message' ? lastItem.message.id : null

  useLayoutEffect(() => {
    const element = scroller
    if (element === null) return
    const before = position.current
    if (before.lastId === null) {
      element.scrollTop = element.scrollHeight
    } else if (lastId !== before.lastId && wasAtEnd(element)) {
      element.scrollTop = element.scrollHeight
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
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [scroller, content, wasAtEnd])

  const jumpTo = useCallback((messageId: string): void => {
    const target = document.getElementById(messageDomId(messageId))
    target?.scrollIntoView({ block: 'center' })
    target?.focus({ preventScroll: true })
  }, [])

  // The header says why a conversation cannot be read; the thread waits for it
  if (conversation.data === undefined) return null

  if (thread.isError && thread.data === undefined) {
    return (
      <InboxState
        icon={TriangleAlert}
        title={t('error.title')}
        body={tAll(`errors.${errorCodeOf(thread.error)}`)}
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
    <div
      ref={setScroller}
      // The browser keeps what is in view when something goes in above; the thread does it itself
      onScroll={keepAnchorCurrent}
      className="min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]"
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
          <ol aria-label={t('label')} className="flex flex-col p-3">
            {items.map(item =>
              item.kind === 'day' ? (
                <li
                  key={`day-${item.key}`}
                  className="text-muted-foreground mt-3 flex justify-center text-xs"
                >
                  <time dateTime={item.key} className="bg-muted rounded-full px-3 py-0.5">
                    {format.dateTime(item.at, { dateStyle: 'full' })}
                  </time>
                </li>
              ) : (
                <li key={item.message.id} className={item.showAuthor ? 'mt-3' : 'mt-1'}>
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
  )
}
