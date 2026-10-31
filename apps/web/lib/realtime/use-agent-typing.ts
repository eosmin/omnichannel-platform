'use client'

import { useEffect, useRef } from 'react'

import { RealtimeEvents } from '@platform/core/realtime'

import { useRealtime } from './realtime-context'
import { TypingAnnouncer } from './typing-announcer'

// Announces that the agent is typing a reply in this conversation. `draft` is what is in the box and
// `isReply` is false for a note, a command or a box the agent may not send from: those are never
// announced, because the customer would see "typing" for something that is not going to reach them.
export function useAgentTyping(conversationId: string, draft: string, isReply: boolean): void {
  const realtime = useRealtime()
  const announcer = useRef<TypingAnnouncer | null>(null)
  // A box of spaces holds nothing that could be sent
  const isTyping = isReply && draft.trim() !== ''

  useEffect(() => {
    if (realtime === null) return
    const { socket } = realtime.connection
    const next = new TypingAnnouncer({
      // A signal queued by a socket that is down would arrive late and show "typing" for nothing
      sendStart: () => {
        if (!socket.connected) return false
        socket.emit(RealtimeEvents.TYPING_START, { conversationId })
        return true
      },
      sendStop: () => {
        if (socket.connected) socket.emit(RealtimeEvents.TYPING_STOP, { conversationId })
      }
    })
    announcer.current = next
    return () => {
      next.stop()
      announcer.current = null
    }
  }, [realtime, conversationId])

  useEffect(() => {
    if (isTyping) announcer.current?.type()
    else announcer.current?.stop()
  }, [realtime, conversationId, isTyping, draft])
}
