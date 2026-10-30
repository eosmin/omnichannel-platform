'use client'

import { useEffect } from 'react'

import { MessageType } from '@platform/core/domain'
import { RealtimeEvents } from '@platform/core/realtime'

import { useStore } from '../../components/providers/store-context'
import { type HeardEvent } from '../../lib/realtime/e2e-harness'
import { useRealtime } from '../../lib/realtime/realtime-context'
import { useProfile } from '../../lib/use-profile'

const HEARD_EVENTS = [RealtimeEvents.MESSAGE_QUEUED, RealtimeEvents.USER_ONLINE] as const

// Draws nothing: publishes the connection and the queue of the store on window.e2eRealtime
export function E2eRealtimeHarness(): null {
  const realtime = useRealtime()
  const userId = useProfile().data?.id
  const { storeId } = useStore()

  useEffect(() => {
    if (realtime === null || userId === undefined) return
    const { connection, queue, status } = realtime
    const heard: HeardEvent[] = []
    const stops = HEARD_EVENTS.map(event => {
      const listener = (payload: unknown): void => void heard.push({ event, payload })
      connection.socket.on(event, listener)
      return () => connection.socket.off(event, listener)
    })

    window.e2eRealtime = {
      status: status.get,
      heard,
      // The transport closes and socket.io tries again, as it does when the network goes away
      dropConnection: () => connection.socket.io.engine.close(),
      enqueue: (conversationId, content) => {
        const pending = queue.enqueue({
          userId,
          storeId,
          conversationId,
          type: MessageType.TEXT,
          content
        })
        void queue.flush(userId)
        return pending.id
      },
      waiting: () => queue.waiting(userId).length
    }
    return () => {
      stops.forEach(stop => stop())
      delete window.e2eRealtime
    }
  }, [realtime, userId, storeId])

  return null
}
