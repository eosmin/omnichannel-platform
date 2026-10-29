'use client'

import { createContext, useContext } from 'react'

import type { RealtimeConnection } from './connection'
import type { ConnectionStatusStore } from './connection-status'
import type { OfflineQueue } from './offline-queue'

export interface RealtimeContextValue {
  connection: RealtimeConnection
  status: ConnectionStatusStore
  queue: OfflineQueue
}

export const RealtimeContext = createContext<RealtimeContextValue | null>(null)

// null outside a store: the org and account areas hold no socket
export function useRealtime(): RealtimeContextValue | null {
  return useContext(RealtimeContext)
}
