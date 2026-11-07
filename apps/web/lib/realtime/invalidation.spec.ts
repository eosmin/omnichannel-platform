import type { Query } from '@tanstack/react-query'

import { QueryKeys } from '@platform/api-client'
import { RealtimeEvents } from '@platform/core/realtime'

import {
  createInvalidationBatcher,
  invalidationFilterOf,
  queryKeysAfterReconnect,
  queryKeysForEvent
} from './invalidation'

// The part of a query the filter reads
const queryHolding = (data: unknown, queryKey: readonly unknown[] = LINKS): Query =>
  ({ queryKey, state: { data } }) as unknown as Query
const LINKS = QueryKeys.media.urls('s1', 'm1')

describe('invalidationFilterOf', () => {
  it('makes the links of the store stale only for the pictures that wait for their variants', () => {
    const filter = invalidationFilterOf(QueryKeys.media.all('s1'), 's1')

    expect(filter.queryKey).toEqual(QueryKeys.media.all('s1'))
    // A voice note that plays keeps the signed link it started with: a new one would restart it
    expect(filter.predicate?.(queryHolding({ processed: false }))).toBe(true)
    expect(filter.predicate?.(queryHolding({ processed: true }))).toBe(false)
    expect(filter.predicate?.(queryHolding('x'))).toBe(false)
  })

  it('also reads again the links whose first read has not come back, which may have gone out too early', () => {
    const filter = invalidationFilterOf(QueryKeys.media.all('s1'), 's1')

    expect(filter.predicate?.(queryHolding(undefined))).toBe(true)
  })

  it('only touches queries of signed links, not any other that sits under the media key', () => {
    const filter = invalidationFilterOf(QueryKeys.media.all('s1'), 's1')

    expect(filter.predicate?.(queryHolding(undefined, ['media', 's1', 'gallery']))).toBe(false)
    expect(filter.predicate?.(queryHolding({ processed: false }, ['media', 's1', 'm1']))).toBe(
      false
    )
  })

  it('leaves every other key as it is, with no predicate', () => {
    expect(invalidationFilterOf(QueryKeys.messages.thread('s1', 'c1'), 's1')).toEqual({
      queryKey: QueryKeys.messages.thread('s1', 'c1')
    })
    // The links of another store are not this store's links
    expect(invalidationFilterOf(QueryKeys.media.all('s2'), 's1').predicate).toBeUndefined()
  })
})

describe('queryKeysForEvent', () => {
  it('refreshes the list and the thread when a customer writes', () => {
    expect(
      queryKeysForEvent(RealtimeEvents.MESSAGE_RECEIVED, { conversationId: 'c1' }, 's1')
    ).toEqual([QueryKeys.conversations.all('s1'), QueryKeys.messages.thread('s1', 'c1')])
  })

  it('moves the conversation in the list when a reply or a note is written', () => {
    const expected = [QueryKeys.conversations.all('s1'), QueryKeys.messages.thread('s1', 'c1')]
    expect(
      queryKeysForEvent(RealtimeEvents.MESSAGE_QUEUED, { conversationId: 'c1' }, 's1')
    ).toEqual(expected)
    expect(
      queryKeysForEvent(RealtimeEvents.MESSAGE_NOTE_ADDED, { conversationId: 'c1' }, 's1')
    ).toEqual(expected)
  })

  it('moves the preview of the row when a message is edited or deleted, from this or another tab', () => {
    const expected = [QueryKeys.conversations.all('s1'), QueryKeys.messages.thread('s1', 'c1')]
    expect(
      queryKeysForEvent(RealtimeEvents.MESSAGE_EDITED, { conversationId: 'c1' }, 's1')
    ).toEqual(expected)
    expect(
      queryKeysForEvent(RealtimeEvents.MESSAGE_DELETED, { conversationId: 'c1' }, 's1')
    ).toEqual(expected)
  })

  it('answers a burst of deletions with one read of the list and one of the thread', () => {
    jest.useFakeTimers()
    try {
      const invalidate = jest.fn()
      const batcher = createInvalidationBatcher(invalidate, 150)
      for (let at = 0; at < 50; at++) {
        batcher.add(
          queryKeysForEvent(RealtimeEvents.MESSAGE_DELETED, { conversationId: 'c1' }, 's1')
        )
      }
      jest.advanceTimersByTime(150)
      expect(invalidate).toHaveBeenCalledTimes(2)
      expect(invalidate).toHaveBeenCalledWith(QueryKeys.conversations.all('s1'))
      expect(invalidate).toHaveBeenCalledWith(QueryKeys.messages.thread('s1', 'c1'))
    } finally {
      jest.useRealTimers()
    }
  })

  it('reaches the origins of the conversation through the key of its thread', () => {
    const thread = QueryKeys.messages.thread('s1', 'c1')

    expect(QueryKeys.messages.origins('s1', 'c1').slice(0, thread.length)).toEqual(thread)
  })

  it('refreshes only the thread for the state of a message', () => {
    expect(
      queryKeysForEvent(RealtimeEvents.MESSAGE_DELIVERED, { conversationId: 'c1' }, 's1')
    ).toEqual([QueryKeys.messages.thread('s1', 'c1')])
  })

  // The scan announces the file as soon as it is clean and the worker announces it again once the
  // variants exist. The signed links cached after the first one say "no variant yet": without this the
  // picture stays a download card until the page is reloaded.
  it('asks for the signed links of the files again when a file is processed', () => {
    const keys = queryKeysForEvent(RealtimeEvents.MEDIA_PROCESSED, { conversationId: 'c1' }, 's1')

    expect(keys).toEqual([QueryKeys.messages.thread('s1', 'c1'), QueryKeys.media.all('s1')])
    expect(QueryKeys.media.urls('s1', 'm1').slice(0, 2)).toEqual(QueryKeys.media.all('s1'))
  })

  it('leaves the signed links alone when a file is refused', () => {
    for (const event of [RealtimeEvents.MEDIA_INFECTED, RealtimeEvents.MEDIA_UNSCANNABLE]) {
      expect(queryKeysForEvent(event, { conversationId: 'c1' }, 's1')).toEqual([
        QueryKeys.messages.thread('s1', 'c1')
      ])
    }
  })

  it('refreshes the whole list when a conversation changes', () => {
    expect(
      queryKeysForEvent(RealtimeEvents.CONVERSATION_ASSIGNED, { conversationId: 'c1' }, 's1')
    ).toEqual([QueryKeys.conversations.all('s1')])
  })

  it('refreshes the customers too when a conversation opens or changes state', () => {
    for (const event of [
      RealtimeEvents.CONVERSATION_CREATED,
      RealtimeEvents.CONVERSATION_STATUS_CHANGED
    ]) {
      expect(queryKeysForEvent(event, { conversationId: 'c1' }, 's1')).toEqual([
        QueryKeys.conversations.all('s1'),
        QueryKeys.customers.all('s1')
      ])
    }
    // The activity of a customer sits under customers.all, so one invalidation reaches it
    expect(QueryKeys.customers.timeline('s1', 'u1', 'all').slice(0, 2)).toEqual(
      QueryKeys.customers.all('s1')
    )
  })

  it('refreshes the presence of the team on user.online and user.offline', () => {
    expect(queryKeysForEvent(RealtimeEvents.USER_ONLINE, { userId: 'u1' }, 's1')).toEqual([
      QueryKeys.presence.team('s1')
    ])
    expect(queryKeysForEvent(RealtimeEvents.USER_OFFLINE, { userId: 'u1' }, 's1')).toEqual([
      QueryKeys.presence.team('s1')
    ])
  })

  it('refreshes every thread when the payload does not say which one', () => {
    expect(queryKeysForEvent(RealtimeEvents.MESSAGE_SENT, { nothing: true }, 's1')).toEqual([
      QueryKeys.messages.all('s1')
    ])
    expect(queryKeysForEvent(RealtimeEvents.MESSAGE_SENT, null, 's1')).toEqual([
      QueryKeys.messages.all('s1')
    ])
  })

  it('ignores an event it does not know, typing included', () => {
    expect(queryKeysForEvent('made.up', { conversationId: 'c1' }, 's1')).toEqual([])
    expect(queryKeysForEvent(RealtimeEvents.TYPING_START, { conversationId: 'c1' }, 's1')).toEqual(
      []
    )
    expect(queryKeysForEvent('toString', { conversationId: 'c1' }, 's1')).toEqual([])
  })

  it('keeps every key under the store it was told about', () => {
    const keys = queryKeysForEvent(RealtimeEvents.MESSAGE_RECEIVED, { conversationId: 'c1' }, 's2')
    keys.forEach(key => expect(key).toContain('s2'))
  })
})

describe('queryKeysAfterReconnect', () => {
  it('refreshes the exports center when an export of the person settles', () => {
    expect(queryKeysForEvent(RealtimeEvents.EXPORT_UPDATED, { exportId: 'e1' }, 's1')).toEqual([
      QueryKeys.exports.all('s1')
    ])
  })

  it('covers the list, every thread, the presence, the notifications, the exports and the links of pictures', () => {
    const keys = queryKeysAfterReconnect('s1')
    expect(keys).toEqual(
      expect.arrayContaining([
        QueryKeys.conversations.all('s1'),
        QueryKeys.messages.all('s1'),
        QueryKeys.customers.all('s1'),
        QueryKeys.presence.team('s1'),
        QueryKeys.exports.all('s1'),
        // A picture that was waiting for its variants when the event was lost
        QueryKeys.media.all('s1')
      ])
    )
    // A thread key sits under messages.all, so one invalidation reaches every thread
    expect(QueryKeys.messages.thread('s1', 'c1').slice(0, 2)).toEqual(QueryKeys.messages.all('s1'))
  })
})

describe('createInvalidationBatcher', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('answers a burst with one invalidation per key', () => {
    const invalidate = jest.fn()
    const batcher = createInvalidationBatcher(invalidate, 150)

    batcher.add([QueryKeys.conversations.all('s1'), QueryKeys.messages.thread('s1', 'c1')])
    batcher.add([QueryKeys.conversations.all('s1'), QueryKeys.messages.thread('s1', 'c1')])
    expect(invalidate).not.toHaveBeenCalled()

    jest.advanceTimersByTime(150)
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('keeps the keys of every event of the window, not only the last one', () => {
    const invalidate = jest.fn()
    const batcher = createInvalidationBatcher(invalidate, 150)

    batcher.add([QueryKeys.messages.thread('s1', 'c1')])
    batcher.add([QueryKeys.messages.thread('s1', 'c2')])
    jest.advanceTimersByTime(150)

    expect(invalidate).toHaveBeenCalledWith(QueryKeys.messages.thread('s1', 'c1'))
    expect(invalidate).toHaveBeenCalledWith(QueryKeys.messages.thread('s1', 'c2'))
  })

  it('closes the window at the first event, so a steady stream is still answered', () => {
    const invalidate = jest.fn()
    const batcher = createInvalidationBatcher(invalidate, 150)

    batcher.add([QueryKeys.conversations.all('s1')])
    jest.advanceTimersByTime(100)
    batcher.add([QueryKeys.conversations.all('s1')])
    jest.advanceTimersByTime(50)

    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('starts a new window after the last one closed', () => {
    const invalidate = jest.fn()
    const batcher = createInvalidationBatcher(invalidate, 150)
    batcher.add([QueryKeys.conversations.all('s1')])
    jest.advanceTimersByTime(150)
    batcher.add([QueryKeys.conversations.all('s1')])
    jest.advanceTimersByTime(150)
    expect(invalidate).toHaveBeenCalledTimes(2)
  })

  it('drops what is waiting when it is cancelled', () => {
    const invalidate = jest.fn()
    const batcher = createInvalidationBatcher(invalidate, 150)
    batcher.add([QueryKeys.conversations.all('s1')])
    batcher.cancel()
    jest.advanceTimersByTime(500)
    expect(invalidate).not.toHaveBeenCalled()
  })
})
