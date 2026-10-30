export interface HeardEvent {
  event: string
  payload: unknown
}

// What the Playwright cases of Step 3.1 drive. The realtime client has no screen until the inbox of
// Step 3.2, so the cases reach the connection and the offline queue of the open store through this
// object on `window`. It exists only on the test page that the e2e build compiles.
export interface E2eRealtimeApi {
  status: () => string
  heard: HeardEvent[]
  dropConnection: () => void
  enqueue: (conversationId: string, content: string) => string
  waiting: () => number
}

declare global {
  interface Window {
    e2eRealtime?: E2eRealtimeApi
  }
}
