import type { QueryKey } from '@tanstack/react-query'
import { z } from 'zod'

import { QueryKeys } from '@platform/api-client'
import { type RealtimeEvent, RealtimeEvents } from '@platform/core/realtime'

// What a realtime event makes stale. The events carry ids only, never text (the server cuts it), so
// the page reads the data again through the REST api.
const Scopes = {
  CONVERSATIONS: 'conversations',
  THREAD: 'thread',
  CUSTOMERS: 'customers',
  PRESENCE: 'presence',
  NOTIFICATIONS: 'notifications'
} as const
type Scope = (typeof Scopes)[keyof typeof Scopes]

// Orders and shipments join with the steps that build their pages (4.4 and 4.x)
const scopesByEvent: Readonly<Partial<Record<RealtimeEvent, readonly Scope[]>>> = {
  // The activity and the count of conversations of a customer open in the panel
  [RealtimeEvents.CONVERSATION_CREATED]: [Scopes.CONVERSATIONS, Scopes.CUSTOMERS],
  [RealtimeEvents.CONVERSATION_ASSIGNED]: [Scopes.CONVERSATIONS],
  [RealtimeEvents.CONVERSATION_STATUS_CHANGED]: [Scopes.CONVERSATIONS, Scopes.CUSTOMERS],
  [RealtimeEvents.CONVERSATION_READ]: [Scopes.CONVERSATIONS],
  [RealtimeEvents.CONVERSATION_UNREAD]: [Scopes.CONVERSATIONS],
  [RealtimeEvents.MESSAGE_RECEIVED]: [Scopes.CONVERSATIONS, Scopes.THREAD],
  // A reply from another tab or device moves the conversation in the list and changes its preview
  [RealtimeEvents.MESSAGE_QUEUED]: [Scopes.CONVERSATIONS, Scopes.THREAD],
  [RealtimeEvents.MESSAGE_SENT]: [Scopes.THREAD],
  [RealtimeEvents.MESSAGE_DELIVERED]: [Scopes.THREAD],
  [RealtimeEvents.MESSAGE_READ]: [Scopes.THREAD],
  [RealtimeEvents.MESSAGE_REACTION]: [Scopes.THREAD],
  [RealtimeEvents.MESSAGE_EDITED]: [Scopes.THREAD],
  [RealtimeEvents.MESSAGE_DELETED]: [Scopes.THREAD],
  [RealtimeEvents.MEDIA_PROCESSED]: [Scopes.THREAD],
  [RealtimeEvents.MEDIA_INFECTED]: [Scopes.THREAD],
  [RealtimeEvents.MESSAGE_FAILED]: [Scopes.THREAD],
  [RealtimeEvents.MESSAGE_NOTE_ADDED]: [Scopes.CONVERSATIONS, Scopes.THREAD],
  [RealtimeEvents.USER_ONLINE]: [Scopes.PRESENCE],
  [RealtimeEvents.USER_OFFLINE]: [Scopes.PRESENCE],
  [RealtimeEvents.NOTIFICATION]: [Scopes.NOTIFICATIONS]
}

const conversationIdSchema = z.object({ conversationId: z.string().min(1) })

function keysForScope(scope: Scope, storeId: string, conversationId: string | null): QueryKey[] {
  switch (scope) {
    case Scopes.CONVERSATIONS:
      return [QueryKeys.conversations.all(storeId)]
    case Scopes.THREAD:
      // An event that does not say which conversation (a payload that drifted) makes every thread
      // stale: a refetch too many is better than a thread that never moves
      return [
        conversationId === null
          ? QueryKeys.messages.all(storeId)
          : QueryKeys.messages.thread(storeId, conversationId)
      ]
    case Scopes.CUSTOMERS:
      return [QueryKeys.customers.all(storeId)]
    case Scopes.PRESENCE:
      return [QueryKeys.presence.team(storeId)]
    case Scopes.NOTIFICATIONS:
      return [QueryKeys.notifications.list(storeId), QueryKeys.notifications.unread(storeId)]
  }
}

export function queryKeysForEvent(event: string, payload: unknown, storeId: string): QueryKey[] {
  // Narrowed by the check: only the names of the table get past it
  const scopes = Object.hasOwn(scopesByEvent, event)
    ? (scopesByEvent[event as RealtimeEvent] ?? [])
    : []
  if (scopes.length === 0) return []
  const parsed = conversationIdSchema.safeParse(payload)
  const conversationId = parsed.success ? parsed.data.conversationId : null
  return scopes.flatMap(scope => keysForScope(scope, storeId, conversationId))
}

// The events of the time the socket was down are lost (they are not replayed), so everything the
// events would have touched is read again
export function queryKeysAfterReconnect(storeId: string): QueryKey[] {
  return [
    QueryKeys.conversations.all(storeId),
    QueryKeys.messages.all(storeId),
    QueryKeys.customers.all(storeId),
    QueryKeys.presence.team(storeId),
    QueryKeys.notifications.list(storeId),
    QueryKeys.notifications.unread(storeId)
  ]
}

export interface InvalidationBatcher {
  add: (keys: readonly QueryKey[]) => void
  cancel: () => void
}

// A burst of events is one refetch per key: the keys wait in a set for the window to close. The
// window starts at the first event (a debounce that restarts would starve under a steady stream),
// and every key that came in it is invalidated, not only those of the last event.
export function createInvalidationBatcher(
  invalidate: (key: QueryKey) => void,
  delayMs: number
): InvalidationBatcher {
  const pending = new Map<string, QueryKey>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const run = (): void => {
    timer = null
    const keys = [...pending.values()]
    pending.clear()
    // Not forEach(invalidate): it would hand the callback the index and the array as well
    keys.forEach(key => invalidate(key))
  }

  return {
    add: keys => {
      if (keys.length === 0) return
      keys.forEach(key => pending.set(JSON.stringify(key), key))
      timer ??= setTimeout(run, delayMs)
    },
    cancel: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      pending.clear()
    }
  }
}
