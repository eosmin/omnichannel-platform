/**
 * @jest-environment node
 */
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Server } from 'socket.io'

import { ApiError } from '@platform/api-client'
import { ErrorCodes } from '@platform/core/errors'
import { RealtimeEvents, RealtimeNamespaces } from '@platform/core/realtime'

import { openRealtimeConnection, type RealtimeConnection } from './connection'
import {
  type ConnectionStatus,
  ConnectionStatuses,
  createConnectionStatusStore
} from './connection-status'
import { startHeartbeat } from './heartbeat'

// A real socket.io server with the same kind of middleware as the gateway: it refuses a handshake
// with the code in error.data.code, which leaves the client socket idle (it must retry by hand).
interface Handshake {
  token: string
  storeId: string
}

interface TestServer {
  io: Server
  url: string
  handshakes: Handshake[]
  setAccept: (accepted: (token: string) => boolean) => void
  refuseWith: (code: string | null) => void
  close: () => Promise<void>
}

async function startServer(): Promise<TestServer> {
  const http: HttpServer = createServer()
  const io = new Server(http)
  const handshakes: Handshake[] = []
  const state: { accepted: (token: string) => boolean; refusal: string | null } = {
    accepted: () => true,
    refusal: null
  }
  io.of(RealtimeNamespaces.AGENTS).use((socket, next) => {
    const auth = socket.handshake.auth as Partial<Handshake>
    handshakes.push({ token: String(auth.token), storeId: String(auth.storeId) })
    if (state.refusal !== null) {
      const error = Object.assign(new Error('refused'), { data: { code: state.refusal } })
      next(error)
      return
    }
    if (!state.accepted(String(auth.token))) {
      next(Object.assign(new Error('expired'), { data: { code: ErrorCodes.AUTH_TOKEN_EXPIRED } }))
      return
    }
    next()
  })
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  const { port } = http.address() as AddressInfo
  return {
    io,
    url: `http://127.0.0.1:${port}`,
    handshakes,
    setAccept: accepted => {
      state.accepted = accepted
    },
    refuseWith: code => {
      state.refusal = code
    },
    close: async () => {
      await io.close()
    }
  }
}

const FAST = {
  RECONNECT_DELAY_MS: 10,
  RECONNECT_DELAY_MAX_MS: 40,
  RED_BANNER_AFTER_FAILURES: 3,
  STABLE_AFTER_MS: 10_000
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('openRealtimeConnection', () => {
  let server: TestServer
  const open: RealtimeConnection[] = []

  beforeEach(async () => {
    server = await startServer()
  })

  afterEach(async () => {
    open.splice(0).forEach(connection => connection.close())
    await server.close()
  })

  function connect(
    getAccessToken: Parameters<typeof openRealtimeConnection>[0]['getAccessToken'],
    timing: Partial<typeof FAST> = {}
  ) {
    const status = createConnectionStatusStore()
    const connection = openRealtimeConnection({
      url: server.url,
      storeId: 'store-1',
      getAccessToken,
      status,
      timing: { ...FAST, ...timing }
    })
    open.push(connection)
    return { status, connection }
  }

  it('sends the token and the store in the handshake and reports it connected', async () => {
    const { status } = connect(() => Promise.resolve('tok-1'))
    expect(status.get()).toBe(ConnectionStatuses.CONNECTING)
    await waitFor(() => status.get() === ConnectionStatuses.CONNECTED, 'connected')
    expect(server.handshakes).toEqual([{ token: 'tok-1', storeId: 'store-1' }])
  })

  it('asks for the token again on every reconnection', async () => {
    let issued = 0
    const { status } = connect(() => Promise.resolve(`tok-${++issued}`))
    await waitFor(() => status.get() === ConnectionStatuses.CONNECTED, 'connected')

    server.io.of(RealtimeNamespaces.AGENTS).sockets.forEach(socket => socket.disconnect(true))
    await waitFor(() => server.handshakes.length === 2, 'second handshake')
    await waitFor(() => status.get() === ConnectionStatuses.CONNECTED, 'reconnected')

    expect(server.handshakes.map(h => h.token)).toEqual(['tok-1', 'tok-2'])
  })

  it('tells the listeners whether it is a reconnection and joins the rooms again', async () => {
    const { status, connection } = connect(() => Promise.resolve('tok'))
    const joins: string[] = []
    server.io.of(RealtimeNamespaces.AGENTS).on('connection', socket => {
      socket.on(RealtimeEvents.JOIN_CONVERSATION, (body: { conversationId: string }) => {
        joins.push(body.conversationId)
      })
    })
    const connects: boolean[] = []
    connection.onConnect(reconnected => connects.push(reconnected))
    connection.joinConversation('c1')
    await waitFor(() => status.get() === ConnectionStatuses.CONNECTED, 'connected')
    await waitFor(() => joins.length === 1, 'first join')

    server.io.of(RealtimeNamespaces.AGENTS).sockets.forEach(socket => socket.disconnect(true))
    await waitFor(() => joins.length === 2, 'join after reconnection')

    expect(joins).toEqual(['c1', 'c1'])
    expect(connects).toEqual([false, true])
  })

  it('joins a room once for two components and leaves when the last one goes', async () => {
    const { status, connection } = connect(() => Promise.resolve('tok'))
    const events: string[] = []
    server.io.of(RealtimeNamespaces.AGENTS).on('connection', socket => {
      socket.on(RealtimeEvents.LEAVE_CONVERSATION, () => events.push('leave'))
    })
    await waitFor(() => status.get() === ConnectionStatuses.CONNECTED, 'connected')

    const leaveA = connection.joinConversation('c1')
    const leaveB = connection.joinConversation('c1')
    leaveA()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(events).toEqual([])
    leaveB()
    await waitFor(() => events.length === 1, 'leave')
  })

  it('takes a fresh token after the api says it expired and carries on', async () => {
    const requests: boolean[] = []
    server.setAccept(token => token === 'fresh')
    const { status } = connect(({ refresh }) => {
      requests.push(refresh)
      return Promise.resolve(refresh ? 'fresh' : 'stale')
    })
    await waitFor(() => status.get() === ConnectionStatuses.CONNECTED, 'connected')
    expect(requests).toEqual([false, true])
  })

  it('ends the session when a token that came from a refresh is still invalid', async () => {
    server.refuseWith(ErrorCodes.AUTH_TOKEN_INVALID)
    const { status } = connect(() => Promise.resolve('tok'))
    await waitFor(() => status.get() === ConnectionStatuses.UNAUTHENTICATED, 'unauthenticated')
    // One try with the token in memory, one with a fresh one, and no more
    expect(server.handshakes).toHaveLength(2)
  })

  it('ends the session at once when the person has no access to the store', async () => {
    server.refuseWith(ErrorCodes.TENANT_ACCESS_DENIED)
    const { status } = connect(() => Promise.resolve('tok'))
    await waitFor(() => status.get() === ConnectionStatuses.UNAUTHENTICATED, 'unauthenticated')
    expect(server.handshakes).toHaveLength(1)
  })

  it('ends the session when the refresh finds that it is gone', async () => {
    const { status } = connect(() =>
      Promise.reject(new ApiError(401, ErrorCodes.AUTH_TOKEN_INVALID, 'no session'))
    )
    await waitFor(() => status.get() === ConnectionStatuses.UNAUTHENTICATED, 'unauthenticated')
    expect(server.handshakes).toHaveLength(0)
  })

  it('goes amber and then red while the api cannot be reached for a token, and recovers', async () => {
    let reachable = false
    const { status } = connect(() =>
      reachable
        ? Promise.resolve('tok')
        : Promise.reject(new ApiError(0, ErrorCodes.INTERNAL_ERROR, 'offline'))
    )
    const seen: ConnectionStatus[] = []
    status.subscribe(() => seen.push(status.get()))

    await waitFor(() => status.get() === ConnectionStatuses.DISCONNECTED, 'red banner')
    reachable = true
    await waitFor(() => status.get() === ConnectionStatuses.CONNECTED, 'recovered')

    expect(seen).toEqual([
      ConnectionStatuses.RECONNECTING,
      ConnectionStatuses.DISCONNECTED,
      ConnectionStatuses.CONNECTED
    ])
  })

  it('reconnects with a fresh token after the gateway sends auth.error and hangs up', async () => {
    const requests: boolean[] = []
    const { status } = connect(({ refresh }) => {
      requests.push(refresh)
      return Promise.resolve('tok')
    })
    await waitFor(() => status.get() === ConnectionStatuses.CONNECTED, 'connected')

    server.io.of(RealtimeNamespaces.AGENTS).sockets.forEach(socket => {
      socket.emit(RealtimeEvents.AUTH_ERROR, { code: ErrorCodes.AUTH_TOKEN_EXPIRED })
      socket.disconnect(true)
    })
    await waitFor(() => requests.length === 2, 'second token request')
    await waitFor(() => status.get() === ConnectionStatuses.CONNECTED, 'reconnected')

    expect(requests).toEqual([false, true])
  })

  it('backs off when the gateway accepts the handshake and hangs up at once', async () => {
    server.io.of(RealtimeNamespaces.AGENTS).on('connection', socket => socket.disconnect(true))
    const { status } = connect(() => Promise.resolve('tok'), {
      RECONNECT_DELAY_MS: 20,
      RECONNECT_DELAY_MAX_MS: 200
    })
    const seen = new Set<ConnectionStatus>()
    status.subscribe(() => seen.add(status.get()))

    await new Promise(resolve => setTimeout(resolve, 500))

    // Without the backoff this is one attempt every 20 ms, about 25 in this time
    expect(server.handshakes.length).toBeLessThan(12)
    expect(seen.has(ConnectionStatuses.DISCONNECTED)).toBe(true)
  })

  it('goes red when a proxy accepts the connection and cuts the transport again and again', async () => {
    server.io.of(RealtimeNamespaces.AGENTS).on('connection', socket => socket.conn.close())
    const { status } = connect(() => Promise.resolve('tok'))
    const seen = new Set<ConnectionStatus>()
    status.subscribe(() => seen.add(status.get()))

    await waitFor(() => seen.has(ConnectionStatuses.DISCONNECTED), 'the red banner')
  })

  it('says a first connection that took failed attempts may have missed events', async () => {
    let calls = 0
    const { status, connection } = connect(() =>
      ++calls <= 2
        ? Promise.reject(new ApiError(0, ErrorCodes.INTERNAL_ERROR, 'offline'))
        : Promise.resolve('tok')
    )
    const flags: boolean[] = []
    connection.onConnect(flag => flags.push(flag))
    await waitFor(() => status.get() === ConnectionStatuses.CONNECTED, 'connected')
    expect(flags).toEqual([true])
  })

  it('does not report a close of its own as a loss', async () => {
    const { status, connection } = connect(() => Promise.resolve('tok'))
    await waitFor(() => status.get() === ConnectionStatuses.CONNECTED, 'connected')
    connection.close()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(status.get()).toBe(ConnectionStatuses.CONNECTED)
  })

  describe('heartbeat', () => {
    it('beats when it connects and then on the interval, with the activity of the person', async () => {
      const beats: Array<{ active?: boolean }> = []
      server.io.of(RealtimeNamespaces.AGENTS).on('connection', socket => {
        socket.on(RealtimeEvents.HEARTBEAT, (body: { active?: boolean }) => beats.push(body))
      })
      const { status, connection } = connect(() => Promise.resolve('tok'))
      const activity = [true, false, true]
      const stop = startHeartbeat(
        connection.socket,
        { consume: () => activity.shift() ?? false },
        40
      )
      await waitFor(() => status.get() === ConnectionStatuses.CONNECTED, 'connected')
      await waitFor(() => beats.length >= 3, 'three beats')
      stop()

      expect(beats.slice(0, 3)).toEqual([{ active: true }, { active: false }, { active: true }])
    })

    it('stops beating when it is stopped', async () => {
      const beats: unknown[] = []
      server.io.of(RealtimeNamespaces.AGENTS).on('connection', socket => {
        socket.on(RealtimeEvents.HEARTBEAT, body => beats.push(body))
      })
      const { status, connection } = connect(() => Promise.resolve('tok'))
      const stop = startHeartbeat(connection.socket, { consume: () => true }, 20)
      await waitFor(() => status.get() === ConnectionStatuses.CONNECTED, 'connected')
      await waitFor(() => beats.length >= 1, 'first beat')
      stop()
      const after = beats.length
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(beats.length).toBe(after)
    })
  })
})
