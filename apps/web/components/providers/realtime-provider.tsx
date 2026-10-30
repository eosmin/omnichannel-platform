'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { type ReactElement, type ReactNode, useEffect, useState } from 'react'

import { AppPaths, QueryKeys, sendMessage } from '@platform/api-client'

import { apiClient, browserSession } from '../../lib/api'
import { webEnv } from '../../lib/env'
import { safeLocalStorage } from '../../lib/realtime/browser-storage'
import { openRealtimeConnection } from '../../lib/realtime/connection'
import {
  ConnectionStatuses,
  createConnectionStatusStore
} from '../../lib/realtime/connection-status'
import { createFlushScheduler } from '../../lib/realtime/flush-scheduler'
import { startHeartbeat, trackActivity } from '../../lib/realtime/heartbeat'
import { OfflineQueue } from '../../lib/realtime/offline-queue'
import { RealtimeClientTiming } from '../../lib/realtime/realtime-config'
import { type RealtimeContextValue, RealtimeContext } from '../../lib/realtime/realtime-context'
import { attachRealtimeSync } from '../../lib/realtime/realtime-sync'
import { sendThenRefresh } from '../../lib/realtime/send-then-refresh'

// The access token in memory first; a fresh one when the api said it expired or there is none
async function socketToken({ refresh }: { refresh: boolean }): Promise<string> {
  const current = browserSession.getAccessToken()
  return refresh || current === null ? browserSession.refresh() : current
}

// One socket for the store that is open. It is opened in an effect (never while rendering, where
// StrictMode would open it twice) and closed when the store or the person changes.
export function RealtimeProvider({
  storeId,
  userId,
  children
}: {
  storeId: string
  userId: string
  children: ReactNode
}): ReactElement {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [value, setValue] = useState<RealtimeContextValue | null>(null)

  useEffect(() => {
    const status = createConnectionStatusStore()
    const connection = openRealtimeConnection({
      url: webEnv.NEXT_PUBLIC_WS_URL,
      storeId,
      getAccessToken: socketToken,
      status
    })
    const queue = new OfflineQueue({
      storage: safeLocalStorage(),
      send: (queuedStoreId, input) =>
        sendThenRefresh(
          () => sendMessage(apiClient, queuedStoreId, input),
          () =>
            queryClient.invalidateQueries({
              queryKey: QueryKeys.messages.thread(queuedStoreId, input.conversationId)
            }),
          RealtimeClientTiming.QUEUE_REFRESH_WAIT_MS
        ),
      newId: () => crypto.randomUUID(),
      now: () => new Date(),
      autoSendWindowMs: RealtimeClientTiming.QUEUE_AUTO_SEND_WINDOW_MS
    })
    const activity = trackActivity(window)

    const stopHeartbeat = startHeartbeat(connection.socket, activity)
    // What was queued while the connection was down goes out as soon as it is back
    const flusher = createFlushScheduler(queue, userId)
    const stopFlushing = connection.onConnect(() => flusher.trigger())
    const stopSync = attachRealtimeSync(connection, queryClient, storeId)
    // A refused handshake that a fresh token did not fix: what the page knows about the person is
    // out of date (they may have been removed from the store). "/" reads it again and sends them to
    // a store they still belong to, or to the login if the session is gone
    const leaveIfSessionOver = (): void => {
      if (status.get() !== ConnectionStatuses.UNAUTHENTICATED) return
      // Removed, not just marked stale: "/" would read the cached profile first, still listing the
      // store, and send the person straight back to it
      queryClient.removeQueries({ queryKey: QueryKeys.session })
      router.replace(AppPaths.home)
    }
    const stopWatching = status.subscribe(leaveIfSessionOver)
    // The refusal may have come before the subscription existed
    leaveIfSessionOver()

    setValue({ connection, status, queue, flusher })
    return () => {
      setValue(null)
      stopWatching()
      stopFlushing()
      flusher.stop()
      stopSync()
      stopHeartbeat()
      activity.stop()
      connection.close()
    }
  }, [storeId, userId, queryClient, router])

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}
