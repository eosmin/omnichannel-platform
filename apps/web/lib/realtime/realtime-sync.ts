import type { QueryClient } from '@tanstack/react-query'

import { RealtimeEvents } from '@platform/core/realtime'

import { playChime, wantsSound } from '../notifications/chime'

import type { RealtimeConnection } from './connection'
import {
  createInvalidationBatcher,
  invalidationFilterOf,
  queryKeysAfterReconnect,
  queryKeysForEvent
} from './invalidation'
import { RealtimeClientTiming } from './realtime-config'

// Keeps the cache of the store in step with what the server tells: an event makes the queries it
// touches stale (one refetch for a burst), and a connection that may have missed events makes
// everything stale, because those events are not replayed. It attaches before the first connection
// can happen (the provider calls it in the same effect that opens the socket), so none is missed.
// Returns the way to detach.
export function attachRealtimeSync(
  connection: RealtimeConnection,
  queryClient: QueryClient,
  storeId: string,
  // Plays the sound of a notification that asks for one; a test passes its own
  onSound: () => void = playChime
): () => void {
  const { socket } = connection
  const batcher = createInvalidationBatcher(
    key => void queryClient.invalidateQueries(invalidationFilterOf(key, storeId)),
    RealtimeClientTiming.INVALIDATION_BATCH_MS
  )

  const onEvent = (event: string, payload: unknown): void => {
    batcher.add(queryKeysForEvent(event, payload, storeId))
    // Once for each notification the server sends with the sound on
    if (event === RealtimeEvents.NOTIFICATION && wantsSound(payload)) onSound()
  }
  socket.onAny(onEvent)
  const stopListening = connection.onConnect(mayHaveMissedEvents => {
    if (mayHaveMissedEvents) batcher.add(queryKeysAfterReconnect(storeId))
  })

  return () => {
    socket.offAny(onEvent)
    stopListening()
    batcher.cancel()
  }
}
