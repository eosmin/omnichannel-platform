'use client'

import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'

import { StorageKeys } from '@platform/api-client'
import { type MessageType } from '@platform/core/domain'

import type { PendingMessage } from '../realtime/offline-queue'
import { useRealtime } from '../realtime/realtime-context'
import { useProfile } from '../use-profile'

export interface ComposerQueue {
  // In the order they were written
  waiting: readonly PendingMessage[]
  // Refused by the api, or kept too long to go out on their own
  failed: readonly PendingMessage[]
  // False until the socket and the profile are there: the composer cannot queue before that
  isReady: boolean
  send: (input: {
    type: MessageType.TEXT | MessageType.INTERNAL_NOTE
    content: string
    mentions?: string[]
  }) => void
  discard: (id: string) => void
  // The agent confirms a message that waited too long
  resend: (id: string) => void
}

const NONE: readonly PendingMessage[] = []

// What the open conversation has in the offline queue, and how the composer writes to it. Every send
// goes through the queue, online or not: the queue is also what draws the message while it goes out.
export function useComposerQueue(storeId: string, conversationId: string): ComposerQueue {
  const realtime = useRealtime()
  const userId = useProfile().data?.id
  const queue = realtime?.queue
  const all = useSyncExternalStore(
    useCallback(listener => queue?.subscribe(listener) ?? (() => undefined), [queue]),
    () => queue?.all() ?? NONE,
    () => NONE
  )

  // Another tab writes to the same storage
  useEffect(() => {
    if (queue === undefined) return
    // A null key is the storage being cleared; any other key is not the queue's business
    const onStorage = (event: StorageEvent): void => {
      if (event.key === null || event.key === StorageKeys.PENDING_MESSAGES) queue.changedElsewhere()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [queue])

  const mine = useMemo(
    () =>
      all.filter(
        message =>
          message.userId === userId &&
          message.storeId === storeId &&
          message.conversationId === conversationId
      ),
    [all, userId, storeId, conversationId]
  )
  const waiting = useMemo(() => mine.filter(message => message.lastError === null), [mine])
  const failed = useMemo(() => mine.filter(message => message.lastError !== null), [mine])

  const flusher = realtime?.flusher
  const send = useCallback<ComposerQueue['send']>(
    input => {
      if (queue === undefined || flusher === undefined || userId === undefined) return
      queue.enqueue({ userId, storeId, conversationId, ...input })
      flusher.trigger()
    },
    [queue, flusher, userId, storeId, conversationId]
  )
  const discard = useCallback((id: string) => queue?.discard(id), [queue])
  const resend = useCallback(
    (id: string) => {
      if (queue === undefined || flusher === undefined || userId === undefined) return
      if (queue.resend(id, userId)) flusher.trigger()
    },
    [queue, flusher, userId]
  )

  return {
    waiting,
    failed,
    isReady: queue !== undefined && userId !== undefined,
    send,
    discard,
    resend
  }
}
