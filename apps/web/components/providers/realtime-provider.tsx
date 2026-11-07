'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react'

import { AppPaths, QueryKeys, sendMessage } from '@platform/api-client'
import { ClientErrorCodes } from '@platform/core/errors'

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
import { toast } from '../../lib/toast'

// The access token in memory first; a fresh one when the api said it expired or there is none
async function socketToken({ refresh }: { refresh: boolean }): Promise<string> {
  const current = browserSession.getAccessToken()
  return refresh || current === null ? browserSession.refresh() : current
}

// One socket for the store that is open. It is opened in an effect (never while rendering, where
// StrictMode would open it twice) and closed when the store or the person changes. A null store opens
// nothing, so a page can keep its tree whether or not there is a store to listen to.
// `leaveWhenRefused` is for the pages of a store: a refused handshake there means the person cannot
// stay. A page that belongs to no store (the account pages) passes false: the socket is only there
// for the bell, so a refusal makes the profile reload and the page stays where it is.
export function RealtimeProvider({
  storeId,
  userId,
  leaveWhenRefused = true,
  children
}: {
  storeId: string | null
  userId: string
  leaveWhenRefused?: boolean
  children: ReactNode
}): ReactElement {
  const router = useRouter()
  const t = useTranslations('noAccess')
  // Read by the effect when the session ends; a change of language must not reopen the socket
  const tRef = useRef(t)
  tRef.current = t
  const queryClient = useQueryClient()
  const [value, setValue] = useState<RealtimeContextValue | null>(null)

  useEffect(() => {
    if (storeId === null) return undefined
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
    let profileReloaded = false
    const leaveIfSessionOver = (): void => {
      if (status.get() !== ConnectionStatuses.UNAUTHENTICATED) return
      if (!leaveWhenRefused) {
        // The profile may no longer list the store: once it does not, the page stops asking for a socket
        if (!profileReloaded) {
          profileReloaded = true
          void queryClient.invalidateQueries({ queryKey: QueryKeys.session })
        }
        return
      }
      // Removed, not just marked stale: "/" would read the cached profile first, still listing the
      // store, and send the person straight back to it
      queryClient.removeQueries({ queryKey: QueryKeys.session })
      // A suspension is told to the person where they are; "/" then picks a store they can still
      // enter, or the screen that explains the suspension. Their sessions elsewhere are not touched.
      // The id keeps a second call (StrictMode runs the effect twice) from showing it twice.
      if (connection.endedBy() === ClientErrorCodes.TENANT_MEMBER_SUSPENDED) {
        toast.error(tRef.current('suspendedGeneric'), { id: `suspended-${storeId}` })
      }
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
  }, [storeId, userId, leaveWhenRefused, queryClient, router])

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}
