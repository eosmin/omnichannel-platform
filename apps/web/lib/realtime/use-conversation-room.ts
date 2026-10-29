'use client'

import { useEffect } from 'react'

import { useRealtime } from './realtime-context'

// Joins the room of the conversation that is open, so that its typing and read events arrive, and
// leaves it when another one is opened or the page closes
export function useConversationRoom(conversationId: string | null): void {
  const realtime = useRealtime()

  useEffect(() => {
    if (realtime === null || conversationId === null) return
    return realtime.connection.joinConversation(conversationId)
  }, [realtime, conversationId])
}
