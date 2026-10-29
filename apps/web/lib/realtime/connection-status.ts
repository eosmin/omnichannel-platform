export const ConnectionStatuses = {
  // Before the first connection: nothing to show yet
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
  // The api refused the token or the store and a fresh token did not change that: the session is over
  UNAUTHENTICATED: 'unauthenticated'
} as const

export type ConnectionStatus = (typeof ConnectionStatuses)[keyof typeof ConnectionStatuses]

// A tiny store that React reads with useSyncExternalStore: the status is one value that a socket
// changes from outside the component tree.
export interface ConnectionStatusStore {
  get: () => ConnectionStatus
  set: (next: ConnectionStatus) => void
  subscribe: (listener: () => void) => () => void
}

export function createConnectionStatusStore(
  initial: ConnectionStatus = ConnectionStatuses.CONNECTING
): ConnectionStatusStore {
  let current = initial
  const listeners = new Set<() => void>()
  return {
    get: () => current,
    set: next => {
      if (next === current) return
      current = next
      listeners.forEach(listener => listener())
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
