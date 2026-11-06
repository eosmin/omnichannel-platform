import type { QueryClient } from '@tanstack/react-query'

import { QueryKeys } from '@platform/api-client'
import { RealtimeEvents } from '@platform/core/realtime'

import type { RealtimeConnection } from './connection'
import { RealtimeClientTiming } from './realtime-config'
import { attachRealtimeSync } from './realtime-sync'

// The socket and the cache, as far as the sync reads them
function setup(playTone = jest.fn()) {
  let onAny: (event: string, payload: unknown) => void = () => undefined
  let onConnect: (mayHaveMissedEvents: boolean) => void = () => undefined
  const invalidateQueries = jest.fn()
  const connection = {
    socket: {
      onAny: (listener: typeof onAny) => {
        onAny = listener
      },
      offAny: jest.fn()
    },
    onConnect: (listener: typeof onConnect) => {
      onConnect = listener
      return jest.fn()
    }
  } as unknown as RealtimeConnection
  const detach = attachRealtimeSync(
    connection,
    { invalidateQueries } as unknown as QueryClient,
    's1',
    playTone
  )
  return {
    detach,
    invalidateQueries,
    emit: (event: string, payload: unknown) => onAny(event, payload),
    connect: (missed: boolean) => onConnect(missed)
  }
}

describe('attachRealtimeSync', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const flush = () => jest.advanceTimersByTime(RealtimeClientTiming.INVALIDATION_BATCH_MS)

  it('refreshes the thread, and the links only of the pictures that wait, when a file is processed', () => {
    const { emit, invalidateQueries } = setup()

    emit(RealtimeEvents.MEDIA_PROCESSED, { conversationId: 'c1', messageId: 'm1' })
    flush()

    const filters = invalidateQueries.mock.calls.map(([filter]) => filter as { queryKey: unknown })
    expect(filters.map(filter => filter.queryKey)).toEqual([
      QueryKeys.messages.thread('s1', 'c1'),
      QueryKeys.media.all('s1')
    ])
    // The links carry a predicate; the thread does not
    expect(filters[0]).not.toHaveProperty('predicate')
    expect(filters[1]).toHaveProperty('predicate', expect.any(Function))
  })

  it('reads the links of waiting pictures again after a connection that may have lost events', () => {
    const { connect, invalidateQueries } = setup()

    connect(true)
    flush()

    const keys = invalidateQueries.mock.calls.map(
      ([filter]) => (filter as { queryKey: unknown }).queryKey
    )
    expect(keys).toContainEqual(QueryKeys.media.all('s1'))
  })

  it('leaves the cache alone after a connection that lost nothing', () => {
    const { connect, invalidateQueries } = setup()

    connect(false)
    flush()

    expect(invalidateQueries).not.toHaveBeenCalled()
  })

  it('plays the tone once for a notification that asks for sound', () => {
    const playTone = jest.fn()
    const { emit } = setup(playTone)

    emit(RealtimeEvents.NOTIFICATION, { id: 'n1', sound: true })

    expect(playTone).toHaveBeenCalledTimes(1)
  })

  it('stays quiet for a notification without sound, for a malformed one and for other events', () => {
    const playTone = jest.fn()
    const { emit } = setup(playTone)

    emit(RealtimeEvents.NOTIFICATION, { id: 'n1', sound: false })
    emit(RealtimeEvents.NOTIFICATION, { id: 'n2', sound: 'true' })
    emit(RealtimeEvents.NOTIFICATION, null)
    emit(RealtimeEvents.NOTIFICATION, 'sound')
    emit(RealtimeEvents.MEDIA_PROCESSED, { conversationId: 'c1', messageId: 'm1', sound: true })

    expect(playTone).not.toHaveBeenCalled()
  })
})
