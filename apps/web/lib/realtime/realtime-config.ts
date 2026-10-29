// How the browser behaves around its socket. The limits the server enforces live in SocketLimits.
export const RealtimeClientTiming = {
  RECONNECT_DELAY_MS: 1000,
  RECONNECT_DELAY_MAX_MS: 30_000,
  // Jitter, so that a team that lost the connection together does not come back together
  RANDOMIZATION_FACTOR: 0.5,
  CONNECT_TIMEOUT_MS: 20_000,
  // Failed attempts in a row after which the amber dot becomes the red banner
  RED_BANNER_AFTER_FAILURES: 5,
  // A connection that holds this long has recovered: only then are the failed attempts forgotten
  STABLE_AFTER_MS: 10_000,
  // How long a message written with no connection is still sent on its own once the connection is
  // back. Later than this the conversation may have moved on (a teammate answered, the customer no
  // longer needs it) and a reply to a customer cannot be taken back: the agent decides
  QUEUE_AUTO_SEND_WINDOW_MS: 10 * 60_000,
  // When what is queued could not be sent although the socket is up: the wait before trying again
  // doubles up to the maximum
  QUEUE_RETRY_MS: 5000,
  QUEUE_RETRY_MAX_MS: 60_000,
  // Events that arrive within this window are answered with one refetch
  INVALIDATION_BATCH_MS: 150
} as const

export interface ReconnectTiming {
  RECONNECT_DELAY_MS: number
  RECONNECT_DELAY_MAX_MS: number
  RED_BANNER_AFTER_FAILURES: number
  STABLE_AFTER_MS: number
}
