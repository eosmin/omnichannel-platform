import type { QueryClient } from '@tanstack/react-query'

import type { NotificationRealtimePayload } from '@platform/core/notifications'
import { RealtimeEvents } from '@platform/core/realtime'

import type { RealtimeConnection } from './connection'
import {
  createInvalidationBatcher,
  invalidationFilterOf,
  queryKeysAfterReconnect,
  queryKeysForEvent
} from './invalidation'
import { RealtimeClientTiming } from './realtime-config'

// The tone is its own chunk, fetched the first time a notification asks for sound
function playToneLater(): void {
  import('../notifications/notification-tone')
    .then(tone => tone.playNotificationTone())
    .catch(() => undefined)
}

function asksForSound(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const { sound }: Partial<Pick<NotificationRealtimePayload, 'sound'>> = payload
  return sound === true
}

// Keeps the cache of the store in step with what the server tells: an event makes the queries it
// touches stale (one refetch for a burst), and a connection that may have missed events makes
// everything stale, because those events are not replayed. A `notification` event whose payload says
// `sound: true` plays one tone, once per event. It attaches before the first connection
// can happen (the provider calls it in the same effect that opens the socket), so none is missed.
// Returns the way to detach.
export function attachRealtimeSync(
  connection: RealtimeConnection,
  queryClient: QueryClient,
  storeId: string,
  playTone: () => void = playToneLater
): () => void {
  const { socket } = connection
  const batcher = createInvalidationBatcher(
    key => void queryClient.invalidateQueries(invalidationFilterOf(key, storeId)),
    RealtimeClientTiming.INVALIDATION_BATCH_MS
  )

  const onEvent = (event: string, payload: unknown): void => {
    batcher.add(queryKeysForEvent(event, payload, storeId))
    if (event === RealtimeEvents.NOTIFICATION && asksForSound(payload)) playTone()
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
