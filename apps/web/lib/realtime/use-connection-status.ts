'use client'

import { useCallback, useSyncExternalStore } from 'react'

import { type ConnectionStatus } from './connection-status'
import { useRealtime } from './realtime-context'

// null outside a store, where there is no socket
export function useConnectionStatus(): ConnectionStatus | null {
  const store = useRealtime()?.status
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? (() => undefined),
    [store]
  )
  return useSyncExternalStore(
    subscribe,
    () => store?.get() ?? null,
    () => null
  )
}
