import type { Server, Socket } from 'socket.io'

import type { Permission } from '@platform/core/auth'
import type { ClientToServerEvents, ServerToClientEvents } from '@platform/core/realtime'

// What a socket knows about its user, set once the handshake is verified and refreshed by every
// heartbeat. `held` is what the user may do in `storeId` right now: it decides which events the
// socket receives.
export interface SocketData {
  userId: string
  userName: string
  storeId: string
  organizationId: string
  held: readonly Permission[]
  // When the access token the socket came in with expires (ms). The socket does not outlive it.
  tokenExpiresAt: number
}

export type PlatformServer = Server<ClientToServerEvents, ServerToClientEvents, never, SocketData>
export type PlatformSocket = Socket<ClientToServerEvents, ServerToClientEvents, never, SocketData>

// How often the gateway checks on its sockets by itself, and how long it lets one stay silent, in ms.
// A provider so that a test can make them short.
export interface RealtimeTiming {
  recheckMs: number
  silentMs: number
}
export const REALTIME_TIMING = Symbol('REALTIME_TIMING')
