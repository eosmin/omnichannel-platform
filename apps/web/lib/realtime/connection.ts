import { io, type Socket } from 'socket.io-client'
import { z } from 'zod'

import { ApiError } from '@platform/api-client'
import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'
import {
  type ClientToServerEvents,
  RealtimeEvents,
  RealtimeNamespaces,
  type ServerToClientEvents
} from '@platform/core/realtime'

import { type ConnectionStatusStore, ConnectionStatuses } from './connection-status'
import { RealtimeClientTiming, type ReconnectTiming } from './realtime-config'

export type RealtimeSocket = Socket<ServerToClientEvents, ClientToServerEvents>

export interface TokenRequest {
  // true after the api said the token expired: the one in memory is not worth sending again
  refresh: boolean
}

export interface RealtimeConnectionOptions {
  // The origin of the api; the namespace is added here
  url: string
  storeId: string
  getAccessToken: (request: TokenRequest) => Promise<string>
  status: ConnectionStatusStore
  timing?: Partial<ReconnectTiming>
}

export interface RealtimeConnection {
  socket: RealtimeSocket
  // Called on every connection. `mayHaveMissedEvents` is true after a loss and after a first connection
  // that took failed attempts: what happened meanwhile is not replayed (events are not durable), so
  // the listener reads it again.
  onConnect: (listener: (mayHaveMissedEvents: boolean) => void) => () => void
  // Joins the room of a conversation, and again after each reconnection (a new socket has no rooms).
  // Returns the way to leave it.
  joinConversation: (conversationId: string) => () => void
  close: () => void
}

// A refused handshake carries the reason in error.data.code (the gateway sets it in its middleware)
const handshakeErrorDataSchema = z.object({ code: z.string() })

function handshakeErrorCode(error: Error): string | null {
  const data: unknown = Reflect.get(error, 'data')
  const parsed = handshakeErrorDataSchema.safeParse(data)
  return parsed.success ? parsed.data.code : null
}

// Socket.io reconnects by itself only after a failure of the transport. A refusal of the gateway
// (a connect_error with a code) and a disconnect that the server asked for leave the socket idle, so
// the retry is ours: with the same backoff, and with a token asked for again each time.
export function openRealtimeConnection(options: RealtimeConnectionOptions): RealtimeConnection {
  const timing = {
    RECONNECT_DELAY_MS: RealtimeClientTiming.RECONNECT_DELAY_MS,
    RECONNECT_DELAY_MAX_MS: RealtimeClientTiming.RECONNECT_DELAY_MAX_MS,
    RED_BANNER_AFTER_FAILURES: RealtimeClientTiming.RED_BANNER_AFTER_FAILURES,
    STABLE_AFTER_MS: RealtimeClientTiming.STABLE_AFTER_MS,
    ...options.timing
  }
  const { status, storeId } = options

  let closed = false
  let sessionOver = false
  let everConnected = false
  let refreshNext = false
  let lastTokenWasFresh = false
  let failures = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let stableTimer: ReturnType<typeof setTimeout> | null = null

  const listeners = new Set<(mayHaveMissedEvents: boolean) => void>()
  const rooms = new Map<string, number>()

  const stopRetry = (): void => {
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
  }

  const stopStableTimer = (): void => {
    if (stableTimer !== null) clearTimeout(stableTimer)
    stableTimer = null
  }

  // One more failed attempt: the next retry waits longer and, after enough of them, the banner is red
  const noteFailure = (): void => {
    failures += 1
    status.set(
      failures >= timing.RED_BANNER_AFTER_FAILURES
        ? ConnectionStatuses.DISCONNECTED
        : ConnectionStatuses.RECONNECTING
    )
  }

  const sessionEnded = (): void => {
    sessionOver = true
    stopRetry()
    stopStableTimer()
    status.set(ConnectionStatuses.UNAUTHENTICATED)
    socket.disconnect()
  }

  const retryDelay = (): number => {
    const base = Math.min(
      timing.RECONNECT_DELAY_MS * 2 ** Math.max(failures - 1, 0),
      timing.RECONNECT_DELAY_MAX_MS
    )
    const jitter = 1 + (Math.random() * 2 - 1) * RealtimeClientTiming.RANDOMIZATION_FACTOR
    return Math.min(base * jitter, timing.RECONNECT_DELAY_MAX_MS)
  }

  const retryLater = (): void => {
    if (closed || sessionOver || retryTimer !== null) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!closed && !sessionOver) socket.connect()
    }, retryDelay())
  }

  const authenticate = async (callback: (data: object) => void): Promise<void> => {
    const refresh = refreshNext
    try {
      const token = await options.getAccessToken({ refresh })
      lastTokenWasFresh = refresh
      refreshNext = false
      if (!closed && !sessionOver) callback({ token, storeId })
    } catch (error) {
      if (error instanceof ApiError && error.status === HttpStatusCodes.UNAUTHORIZED) {
        sessionEnded()
        return
      }
      // The api cannot be reached to get a token: the attempt is lost like any other
      noteFailure()
      retryLater()
    }
  }

  const socket: RealtimeSocket = io(`${options.url}${RealtimeNamespaces.AGENTS}`, {
    autoConnect: false,
    // No long-polling handshake, so no sticky sessions are needed behind the load balancer
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: timing.RECONNECT_DELAY_MS,
    reconnectionDelayMax: timing.RECONNECT_DELAY_MAX_MS,
    randomizationFactor: RealtimeClientTiming.RANDOMIZATION_FACTOR,
    timeout: RealtimeClientTiming.CONNECT_TIMEOUT_MS,
    // Runs on every (re)connection, so each one carries a token that is still good
    auth: callback => {
      void authenticate(callback)
    }
  })

  const emitJoin = (conversationId: string): void => {
    // A conversation the person cannot see is answered {joined: false} and is not an error
    socket.emit(RealtimeEvents.JOIN_CONVERSATION, { conversationId }, () => undefined)
  }

  socket.on('connect', () => {
    const mayHaveMissedEvents = everConnected || failures > 0
    everConnected = true
    refreshNext = false
    stopRetry()
    // The failures are forgotten only once the connection has held: a gateway that accepts the
    // handshake and hangs up at once would otherwise be retried at the base delay forever
    stopStableTimer()
    stableTimer = setTimeout(() => {
      failures = 0
    }, timing.STABLE_AFTER_MS)
    status.set(ConnectionStatuses.CONNECTED)
    rooms.forEach((_count, conversationId) => emitJoin(conversationId))
    listeners.forEach(listener => listener(mayHaveMissedEvents))
  })

  socket.on('disconnect', reason => {
    // Our own close, or the end of the session: the status is already what it should be
    if (reason === 'io client disconnect') return
    stopStableTimer()
    // A connection that is accepted and dropped again and again (a proxy that cuts the websocket)
    // counts as failed attempts too, whether the transport or the server closed it
    noteFailure()
    // Socket.io does not reconnect after the server hung up (it did so on purpose, usually after
    // auth.error): this is the reconnection with a fresh token
    if (reason === 'io server disconnect') retryLater()
  })

  socket.on('connect_error', error => {
    const code = handshakeErrorCode(error)
    if (code === ErrorCodes.TENANT_ACCESS_DENIED) {
      sessionEnded()
      return
    }
    if (code === ErrorCodes.AUTH_TOKEN_EXPIRED) refreshNext = true
    if (code === ErrorCodes.AUTH_TOKEN_INVALID) {
      // A token that came from the refresh and is still invalid is not going to get better
      if (lastTokenWasFresh) {
        sessionEnded()
        return
      }
      refreshNext = true
    }
    noteFailure()
    if (!socket.active) retryLater()
  })

  // The gateway looks at a socket every 30 s: it sends this and hangs up when the token or the
  // membership no longer holds, and the 'disconnect' above does the reconnecting
  socket.on(RealtimeEvents.AUTH_ERROR, () => {
    refreshNext = true
  })

  status.set(ConnectionStatuses.CONNECTING)
  socket.connect()

  return {
    socket,
    onConnect: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    joinConversation: conversationId => {
      rooms.set(conversationId, (rooms.get(conversationId) ?? 0) + 1)
      if (socket.connected) emitJoin(conversationId)
      return () => {
        const remaining = (rooms.get(conversationId) ?? 0) - 1
        if (remaining > 0) {
          rooms.set(conversationId, remaining)
          return
        }
        rooms.delete(conversationId)
        if (socket.connected) socket.emit(RealtimeEvents.LEAVE_CONVERSATION, { conversationId })
      }
    },
    close: () => {
      closed = true
      stopRetry()
      stopStableTimer()
      socket.disconnect()
    }
  }
}
