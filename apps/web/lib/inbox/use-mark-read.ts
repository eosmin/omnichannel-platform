'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { markConversationRead, QueryKeys } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'

import { useStore } from '../../components/providers/store-context'
import { apiClient } from '../api'

function subscribeToVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

// The server has no tab: it draws the thread as if it were in view, and the browser corrects it
function useIsTabVisible(): boolean {
  return useSyncExternalStore(
    subscribeToVisibility,
    () => document.visibilityState === 'visible',
    () => true
  )
}

// A conversation that is open and in view is a conversation that is being read: it is marked read
// when it opens and each time a message arrives in it. Marking writes what the whole team sees (the
// unread count), so it needs the permission to work the conversation; without it the count stays.
export function useMarkRead(
  conversationId: string,
  unreadCount: number | undefined,
  // False while the reader is above the end of the thread: what arrived is not read until they reach it
  isReading = true
): void {
  const { storeId, can } = useStore()
  const queryClient = useQueryClient()
  const isVisible = useIsTabVisible()
  const isInFlight = useRef(false)
  // Bumped when a mark ends well, so that a message that arrived while it was in flight is looked at again
  const [settled, setSettled] = useState(0)
  const mayMark = can(ClientPermissions.CONVERSATIONS_RESOLVE)

  useEffect(() => {
    if (!mayMark || !isVisible || !isReading || unreadCount === undefined || unreadCount === 0)
      return
    if (isInFlight.current) return
    isInFlight.current = true
    markConversationRead(apiClient, storeId, conversationId)
      // The event of the api updates the list; this covers a socket that is down. A failure leaves
      // the count as it is: the next message tries again.
      .then(() => queryClient.invalidateQueries({ queryKey: QueryKeys.conversations.all(storeId) }))
      .then(() => setSettled(count => count + 1))
      .catch(() => undefined)
      .finally(() => {
        isInFlight.current = false
      })
  }, [mayMark, isVisible, isReading, unreadCount, storeId, conversationId, queryClient, settled])
}
