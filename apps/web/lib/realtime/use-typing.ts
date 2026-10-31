'use client'

import { useEffect, useRef, useState } from 'react'

import { RealtimeEvents } from '@platform/core/realtime'

import { useRealtime } from './realtime-context'
import { NOBODY_TYPING, TypingTracker, type TypingSnapshot } from './typing-tracker'

// Who is typing in the open conversation: the customer (the widget sends it; Meta does not) and the
// teammates, except the person themselves on another tab. The room is joined by the thread.
export function useTyping(conversationId: string, selfId: string | undefined): TypingSnapshot {
  const realtime = useRealtime()
  // Read when a signal arrives, so that the profile loading does not tear down the subscription and
  // blank a line that is showing
  const self = useRef(selfId)
  self.current = selfId
  const [snapshot, setSnapshot] = useState<TypingSnapshot>(NOBODY_TYPING)

  useEffect(() => {
    setSnapshot(NOBODY_TYPING)
    if (realtime === null) return
    const { socket } = realtime.connection
    const tracker = new TypingTracker(setSnapshot)

    const onCustomer = (body: { conversationId: string }): void => {
      if (body.conversationId === conversationId) tracker.customerTyping()
    }
    const onStart = (body: { conversationId: string; userId: string; userName: string }): void => {
      if (body.conversationId === conversationId && body.userId !== self.current) {
        tracker.teammateStart(body.userId, body.userName)
      }
    }
    const onStop = (body: { conversationId: string; userId: string }): void => {
      if (body.conversationId === conversationId) tracker.teammateStop(body.userId)
    }
    const onReceived = (body: { conversationId: string }): void => {
      if (body.conversationId === conversationId) tracker.clearCustomer()
    }

    socket.on(RealtimeEvents.CUSTOMER_TYPING, onCustomer)
    socket.on(RealtimeEvents.TYPING_START, onStart)
    socket.on(RealtimeEvents.TYPING_STOP, onStop)
    socket.on(RealtimeEvents.MESSAGE_RECEIVED, onReceived)
    return () => {
      socket.off(RealtimeEvents.CUSTOMER_TYPING, onCustomer)
      socket.off(RealtimeEvents.TYPING_START, onStart)
      socket.off(RealtimeEvents.TYPING_STOP, onStop)
      socket.off(RealtimeEvents.MESSAGE_RECEIVED, onReceived)
      tracker.dispose()
    }
  }, [realtime, conversationId])

  return snapshot
}
