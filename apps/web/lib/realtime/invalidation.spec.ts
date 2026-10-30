import { QueryKeys } from '@platform/api-client'
import { RealtimeEvents } from '@platform/core/realtime'

import {
  createInvalidationBatcher,
  queryKeysAfterReconnect,
  queryKeysForEvent
} from './invalidation'

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

  it('reaches the origins of the conversation through the key of its thread', () => {
    const thread = QueryKeys.messages.thread('s1', 'c1')

    expect(QueryKeys.messages.origins('s1', 'c1').slice(0, thread.length)).toEqual(thread)
  })

  it('refreshes only the thread for the state of a message', () => {
    expect(
      queryKeysForEvent(RealtimeEvents.MESSAGE_DELIVERED, { conversationId: 'c1' }, 's1')
    ).toEqual([QueryKeys.messages.thread('s1', 'c1')])
  })

  it('refreshes the whole list when a conversation changes', () => {
    expect(
      queryKeysForEvent(RealtimeEvents.CONVERSATION_STATUS_CHANGED, { conversationId: 'c1' }, 's1')
    ).toEqual([QueryKeys.conversations.all('s1')])
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
  it('covers the list, every thread, the presence and the notifications', () => {
    const keys = queryKeysAfterReconnect('s1')
    expect(keys).toEqual(
      expect.arrayContaining([
        QueryKeys.conversations.all('s1'),
        QueryKeys.messages.all('s1'),
        QueryKeys.presence.team('s1')
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
