'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useSyncExternalStore } from 'react'

import { markConversationRead, QueryKeys } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'

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
export function useMarkRead(conversationId: string, unreadCount: number | undefined): void {
  const { storeId, can } = useStore()
  const queryClient = useQueryClient()
  const isVisible = useIsTabVisible()
  const isInFlight = useRef(false)
  const mayMark = can(Permissions.CONVERSATIONS_RESOLVE)

  useEffect(() => {
    if (!mayMark || !isVisible || unreadCount === undefined || unreadCount === 0) return
    if (isInFlight.current) return
    isInFlight.current = true
    markConversationRead(apiClient, storeId, conversationId)
      // The event of the api updates the list; this covers a socket that is down. A failure leaves
      // the count as it is: the next message tries again.
      .then(() => queryClient.invalidateQueries({ queryKey: QueryKeys.conversations.all(storeId) }))
      .catch(() => undefined)
      .finally(() => {
        isInFlight.current = false
      })
  }, [mayMark, isVisible, unreadCount, storeId, conversationId, queryClient])
}
