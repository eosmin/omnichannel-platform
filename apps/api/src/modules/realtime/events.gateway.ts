import { Inject } from '@nestjs/common'
import { SkipThrottle } from '@nestjs/throttler'
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway
} from '@nestjs/websockets'
import type { Gauge } from '@prometheus-io/client'
import { PinoLogger } from 'nestjs-pino'
import type { Server } from 'socket.io'
import { z } from 'zod'

import { Permissions } from '@platform/core/auth'
import { Public } from '@platform/core/auth-module'
import { ErrorCodes, type ErrorCode } from '@platform/core/errors'
import { clientAddress, TRUST_PROXY_HOPS } from '@platform/core/http'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import {
  type JoinConversationResult,
  RealtimeEvents,
  RealtimeNamespaces,
  RoomNames,
  SocketLimits
} from '@platform/core/realtime'

import { PresenceService } from './presence.service'
import { RealtimeService } from './realtime.service'
import {
  type PlatformServer,
  type PlatformSocket,
  REALTIME_TIMING,
  type RealtimeTiming
} from './realtime.types'
import { SocketAccessService, SocketRefused } from './socket-access.service'

// What the client is told when its connection is refused; the reason is in `data.code`
const REFUSED_MESSAGE = 'refused'
const WINDOW_MS = SocketLimits.WINDOW_SECONDS * 1000
const CONVERSATION_ROOM_PREFIX = RoomNames.conversation('')

// Ids are compared in lower case everywhere (the database treats 'ABC' and 'abc' as one id), and so
// is the name of the room
const conversationSchema = z.object({
  conversationId: z.uuid().transform(id => id.toLowerCase())
})
interface RateWindow {
  startedAt: number
  count: number
}

const heartbeatSchema = z.object({ active: z.boolean().optional() })

// The sockets of the agents. A socket is accepted when its access token is good and its user is an
// active member of the store it names (the same checks as a request), and from then on it is in the
// room of its store. A conversation room is joined on demand, and only for
// a conversation the user may see; it carries nothing but typing.
//
// The global guards of the api (token, store, permission, rate limit) are written for an HTTP request
// and run on a gateway too, where they cannot work: it is @Public and @SkipThrottle for them, and
// does the same checks itself, in the handshake and again as the socket lives (SocketAccessService).
@Public()
@SkipThrottle()
@WebSocketGateway({
  namespace: RealtimeNamespaces.AGENTS,
  transports: ['websocket'], // No long polling, so no sticky sessions
  maxHttpBufferSize: SocketLimits.MAX_MESSAGE_BYTES,
  connectTimeout: SocketLimits.CONNECT_TIMEOUT_MS
})
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  // What each socket has asked of the database in the current window, and what it has sent of anything
  private readonly dbEvents = new WeakMap<PlatformSocket, RateWindow>()
  private readonly allEvents = new WeakMap<PlatformSocket, RateWindow>()
  // Whether the socket was the first of its user when it was let in, for the announcement
  private readonly firstOfUser = new WeakMap<PlatformSocket, boolean>()
  // The refresh of a socket that is running, so that two do not write over each other
  private readonly refreshing = new WeakMap<
    PlatformSocket,
    Promise<PlatformSocket['data'] | null>
  >()
  // The sockets that got past the handshake and are handled by handleDisconnect from then on
  private readonly entered = new WeakSet<PlatformSocket>()
  // The conversations a socket has started typing in and not stopped
  private readonly typing = new WeakMap<PlatformSocket, Set<string>>()
  // The last time the socket showed it is alive (a heartbeat, typing), to close the ones that never do
  private readonly lastAlive = new WeakMap<PlatformSocket, number>()
  // The sockets in the gauge, so that one that never got in is not taken out of it
  private readonly counted = new WeakSet<PlatformSocket>()
  // The last time typing counted as a sign of life, for the same minimum gap
  private readonly lastTypingBeat = new WeakMap<PlatformSocket, number>()
  // The last heartbeat taken, for the minimum gap between two
  private readonly heartbeats = new WeakMap<PlatformSocket, number>()
  private readonly watches = new WeakMap<PlatformSocket, NodeJS.Timeout>()

  constructor(
    private readonly access: SocketAccessService,
    private readonly presence: PresenceService,
    private readonly realtime: RealtimeService,
    @InjectMetric(MetricNames.WEBSOCKET_CONNECTIONS) private readonly connections: Gauge<string>,
    private readonly logger: PinoLogger,
    @Inject(REALTIME_TIMING) private readonly timing: RealtimeTiming,
    @Inject(TRUST_PROXY_HOPS) private readonly hops: number
  ) {
    this.logger.setContext(EventsGateway.name)
  }

  afterInit(server: PlatformServer): void {
    this.realtime.attach(server)
    // The main namespace has nothing and nobody to serve: without this a client that never
    // authenticates could stay in it as long as it likes
    // (Nest hands over the namespace, typed as the server; the server is its `server`)
    const io = (server as unknown as { server: Server }).server
    io.use((_socket, next) => next(new Error(REFUSED_MESSAGE)))
    // The handshake is checked before the socket exists: a client that is refused never connects,
    // so no message of it can arrive before its identity is known
    server.use((socket, next) => {
      // Taken before the headers are emptied below; as Express would, with the proxies in front
      const address = clientAddress(socket.handshake.headers, socket.handshake.address, this.hops)
      this.access
        .authenticate(socket.handshake.auth, address)
        .then(async data => {
          // A user has a few devices: past that, one more is a loop. Counted and added in one step,
          // across the instances.
          const admission = await this.presence.admit(data.storeId, data.userId, socket.id)
          if (!admission.admitted) {
            throw new SocketRefused(ErrorCodes.RATE_LIMIT_EXCEEDED, { userId: data.userId })
          }
          // The token is checked and has no further use: it must not travel in what fetchSockets()
          // sends across the instances (the handshake of every socket goes with it)
          socket.handshake.auth = {}
          socket.handshake.headers = {}
          socket.handshake.query = {}
          this.firstOfUser.set(socket, !admission.wasOnline)
          // The client may have closed during the awaits above, before anything could listen
          if (socket.conn.readyState !== 'open') {
            await this.presence.socketDisconnected(data.storeId, data.userId, socket.id)
            throw new SocketRefused(ErrorCodes.AUTH_TOKEN_INVALID)
          }
          // A client that closes before the socket exists is never told to disconnect: the place it
          // was given is given back here
          socket.conn.once('close', () => {
            if (this.entered.has(socket)) return
            this.presence
              .socketDisconnected(data.storeId, data.userId, socket.id)
              .catch(() => undefined)
          })
          socket.data = data
          next()
        })
        .catch((error: unknown) => {
          const code = error instanceof SocketRefused ? error.code : null
          if (code === null) this.logger.error({ err: error }, 'a websocket handshake failed')
          else {
            this.logger.warn(
              {
                code,
                ...(error instanceof SocketRefused ? error.context : {}),
                address
              },
              'a websocket was refused'
            )
          }
          // connect_error on the client, with the code in `data`
          next(Object.assign(new Error(REFUSED_MESSAGE), { data: { code } }))
        })
    })
  }

  async handleConnection(client: PlatformSocket): Promise<void> {
    const { storeId, userId } = client.data
    this.entered.add(client)
    // Everything the socket sends counts, the names nobody listens to included
    client.use((_packet, next) => {
      if (this.tally(client)) next()
    })
    await client.join([RoomNames.store(storeId), RoomNames.storeUser(storeId, userId)])
    // The client may have gone while it joined: handleDisconnect takes it out of the presence, and
    // nothing is announced for a socket that is not there
    if (!client.connected) return
    this.counted.add(client)
    this.lastAlive.set(client, Date.now())
    this.connections.inc({ store_id: storeId })
    this.watch(client)
    if (this.firstOfUser.get(client) === true) this.presence.announceOnline(storeId, userId)
    this.logger.info({ userId, storeId }, 'websocket connected')
  }

  async handleDisconnect(client: PlatformSocket): Promise<void> {
    const timer = this.watches.get(client)
    if (timer !== undefined) clearTimeout(timer)
    // Whoever was typing stops with the socket: the others would see it forever
    for (const conversationId of [...(this.typing.get(client) ?? [])]) {
      this.stopTyping(client, conversationId)
    }
    // A socket that never got past the handshake has no data
    const data = client.data as Partial<typeof client.data>
    if (data.userId === undefined || data.storeId === undefined) return
    const { storeId, userId } = data
    if (this.counted.has(client)) this.connections.dec({ store_id: storeId })
    await this.tolerate('presence', () =>
      this.presence.socketDisconnected(storeId, userId, client.id)
    )
    this.logger.info({ userId, storeId }, 'websocket disconnected')
  }

  @SubscribeMessage(RealtimeEvents.JOIN_CONVERSATION)
  async handleJoin(
    @ConnectedSocket() client: PlatformSocket,
    @MessageBody() body: unknown
  ): Promise<JoinConversationResult> {
    const parsed = conversationSchema.safeParse(body)
    if (!parsed.success || !this.allow(client)) return { joined: false }
    const { conversationId } = parsed.data
    const room = RoomNames.conversation(conversationId)
    if (
      !client.rooms.has(room) &&
      this.conversationRoomsOf(client).length >= SocketLimits.MAX_CONVERSATION_ROOMS
    ) {
      return { joined: false }
    }
    const refreshed = await this.refresh(client)
    if (refreshed === null) return { joined: false }
    const joined = await this.access.mayJoin(refreshed, conversationId)
    // The socket may have gone while the database answered: joining then would leave a room for a
    // socket that no longer exists
    // The cap is looked at again here, with nothing awaited between it and the join: messages that
    // arrived together all passed the first look
    const hasRoom =
      client.rooms.has(room) ||
      this.conversationRoomsOf(client).length < SocketLimits.MAX_CONVERSATION_ROOMS
    if (!joined || !client.connected || !hasRoom) return { joined: false }
    await client.join(room)
    // A reassignment may have taken the conversation from the user between the check and the join,
    // when there was no room to take them out of: look once more now that they are in it. If the
    // look fails they are not left in.
    const still = await this.access.mayJoin(refreshed, conversationId).catch(() => false)
    if (!still) {
      await client.leave(room)
      return { joined: false }
    }
    return { joined: true }
  }

  @SubscribeMessage(RealtimeEvents.LEAVE_CONVERSATION)
  async handleLeave(
    @ConnectedSocket() client: PlatformSocket,
    @MessageBody() body: unknown
  ): Promise<void> {
    const parsed = conversationSchema.safeParse(body)
    if (!parsed.success) return
    this.stopTyping(client, parsed.data.conversationId)
    await client.leave(RoomNames.conversation(parsed.data.conversationId))
  }

  // Typing is relayed to the others in the conversation room, and only from a socket that is in it:
  // being in the room is what proves the user was allowed to join
  @SubscribeMessage(RealtimeEvents.TYPING_START)
  async handleTypingStart(
    @ConnectedSocket() client: PlatformSocket,
    @MessageBody() body: unknown
  ): Promise<void> {
    const room = this.roomOf(client, body)
    if (room === null || !this.allow(client)) return
    // Relayed at once, from what the socket held at its last look (30 s at most): a start and the stop
    // that follows it must not swap places because one of them waited for the database. Only who may
    // write in a conversation shows that they are writing in it.
    if (!client.data.held.includes(Permissions.MESSAGES_SEND)) return
    const started = this.typing.get(client) ?? new Set<string>()
    started.add(room.conversationId)
    this.typing.set(client, started)
    client.to(room.name).emit(RealtimeEvents.TYPING_START, {
      conversationId: room.conversationId,
      userId: client.data.userId,
      userName: client.data.userName
    })
    // Typing is the clearest sign that someone is there. Repeats within the gap of a heartbeat only
    // relay: they cost nothing else.
    const now = Date.now()
    if (
      now - (this.lastTypingBeat.get(client) ?? 0) >=
      SocketLimits.MIN_HEARTBEAT_GAP_SECONDS * 1000
    ) {
      this.lastTypingBeat.set(client, now)
      await this.beat(client, true)
    }
  }

  // Not counted against the budget: dropping the stop would leave "is typing" on the others' screens,
  // and relaying it costs nothing
  @SubscribeMessage(RealtimeEvents.TYPING_STOP)
  handleTypingStop(@ConnectedSocket() client: PlatformSocket, @MessageBody() body: unknown): void {
    const room = this.roomOf(client, body)
    // Only a stop that follows a start: nothing else has anything to stop
    if (room === null || !this.typing.get(client)?.delete(room.conversationId)) return
    client.to(room.name).emit(RealtimeEvents.TYPING_STOP, {
      conversationId: room.conversationId,
      userId: client.data.userId
    })
  }

  @SubscribeMessage(RealtimeEvents.HEARTBEAT)
  async handleHeartbeat(
    @ConnectedSocket() client: PlatformSocket,
    @MessageBody() body: unknown
  ): Promise<void> {
    const now = Date.now()
    const last = this.heartbeats.get(client)
    if (last !== undefined && now - last < SocketLimits.MIN_HEARTBEAT_GAP_SECONDS * 1000) return
    this.heartbeats.set(client, now)
    const parsed = heartbeatSchema.safeParse(body ?? {})
    await this.beat(client, parsed.success && parsed.data.active === true)
  }

  // A heartbeat is presence plus a check that the socket still has the right to be here
  private async beat(client: PlatformSocket, active: boolean): Promise<void> {
    this.lastAlive.set(client, Date.now())
    const refreshed = await this.refresh(client)
    // Not for a socket that went while the check ran: it would be counted as online again
    if (refreshed === null || !client.connected) return
    await this.tolerate('presence', async () => {
      const known = await this.presence.heartbeat(
        refreshed.storeId,
        refreshed.userId,
        client.id,
        active
      )
      // Not registered: a write lost at connect time. Let in again, if it is still there to be let in.
      if (!known && client.connected) {
        const again = await this.presence.admit(
          refreshed.storeId,
          refreshed.userId,
          client.id,
          false
        )
        // Past the cap: a socket that is not counted is not allowed to stay
        if (!again.admitted) client.disconnect(true)
      }
    })
  }

  // Tells the room the user stopped typing, if the socket had started and not stopped
  private stopTyping(client: PlatformSocket, conversationId: string): void {
    if (!this.typing.get(client)?.delete(conversationId)) return
    const stop = { conversationId, userId: client.data.userId }
    const room = RoomNames.conversation(conversationId)
    // As an explicit stop: the others, not the sender. A socket that has gone is in no room any more.
    if (client.rooms.has(room)) client.to(room).emit(RealtimeEvents.TYPING_STOP, stop)
    else this.realtime.toConversation(conversationId, RealtimeEvents.TYPING_STOP, stop)
  }

  // Checks the socket still has the right to be here and takes what it may do now. One that does not
  // is told why and disconnected: if its session is still good, the client reconnects with a fresh
  // token and comes back in.
  private refresh(client: PlatformSocket): Promise<PlatformSocket['data'] | null> {
    // One at a time per socket: an older answer must not be written over a newer one
    const running = this.refreshing.get(client)
    if (running !== undefined) return running
    const next = this.refreshNow(client).finally(() => this.refreshing.delete(client))
    this.refreshing.set(client, next)
    return next
  }

  private async refreshNow(client: PlatformSocket): Promise<PlatformSocket['data'] | null> {
    try {
      client.data = await this.access.refresh(client.data)
      return client.data
    } catch (error) {
      if (!(error instanceof SocketRefused)) throw error
      this.refuse(client, error.code)
      return null
    }
  }

  private refuse(client: PlatformSocket, code: ErrorCode): void {
    client.emit(RealtimeEvents.AUTH_ERROR, { code })
    client.disconnect(true)
  }

  // The server does not wait for the client to ask: a socket that says nothing still loses its place
  // when its token expires, when its user leaves the store, and when it can no longer see a
  // conversation it joined. The next look is at the expiry of the token if that comes first.
  private watch(client: PlatformSocket): void {
    const untilExpiry = client.data.tokenExpiresAt - Date.now()
    const delay = Math.max(Math.min(this.timing.recheckMs, untilExpiry + 1), 1)
    const timer = setTimeout(() => {
      this.recheck(client)
        .catch((error: unknown) => this.logger.error({ err: error }, 'a websocket recheck failed'))
        .finally(() => {
          if (client.connected) this.watch(client)
        })
    }, delay)
    timer.unref()
    this.watches.set(client, timer)
  }

  private async recheck(client: PlatformSocket): Promise<void> {
    // A client that sends no heartbeat is not counted by the presence either, so it would slip past the
    // cap of sockets per user: it is closed, and the client that is real reconnects
    const silentFor = Date.now() - (this.lastAlive.get(client) ?? Date.now())
    if (silentFor > this.timing.silentMs) {
      client.disconnect(true)
      return
    }
    const refreshed = await this.refresh(client)
    if (refreshed === null) return
    const rooms = this.conversationRoomsOf(client)
    // One query for all of them. If it fails, the rooms stay until the next look (a failure of the
    // database is not an answer, and emptying every room would leave the client without typing and
    // without a way to know).
    const visible = await this.access
      .visibleAmong(
        refreshed,
        rooms.map(room => room.slice(CONVERSATION_ROOM_PREFIX.length))
      )
      .catch((error: unknown) => {
        this.logger.error({ err: error }, 'the conversation rooms could not be checked')
        return null
      })
    if (visible === null) return
    for (const room of rooms) {
      const conversationId = room.slice(CONVERSATION_ROOM_PREFIX.length)
      if (visible.has(conversationId)) continue
      this.stopTyping(client, conversationId)
      await client.leave(room)
    }
  }

  private conversationRoomsOf(client: PlatformSocket): string[] {
    return [...client.rooms].filter(room => room.startsWith(CONVERSATION_ROOM_PREFIX))
  }

  private roomOf(
    client: PlatformSocket,
    body: unknown
  ): { name: string; conversationId: string } | null {
    const parsed = conversationSchema.safeParse(body)
    if (!parsed.success) return null
    const name = RoomNames.conversation(parsed.data.conversationId)
    return client.rooms.has(name) ? { name, conversationId: parsed.data.conversationId } : null
  }

  // Everything a socket sends counts, the typing stops too (which are never dropped): a socket that
  // sends more than any client does is cut off
  private tally(client: PlatformSocket): boolean {
    if (this.bump(this.allEvents, client) <= SocketLimits.MAX_EVENTS_PER_WINDOW) return true
    this.logger.warn({ userId: client.data.userId }, 'a websocket was cut off for flooding')
    client.disconnect(true)
    return false
  }

  // What a socket may ask of the database per window: above it, the event is dropped
  private allow(client: PlatformSocket): boolean {
    return this.bump(this.dbEvents, client) <= SocketLimits.MAX_DB_EVENTS_PER_WINDOW
  }

  private bump(windows: WeakMap<PlatformSocket, RateWindow>, client: PlatformSocket): number {
    const now = Date.now()
    const window = windows.get(client)
    if (window === undefined || now - window.startedAt >= WINDOW_MS) {
      windows.set(client, { startedAt: now, count: 1 })
      return 1
    }
    window.count += 1
    return window.count
  }

  // Presence is best effort: Redis being down must not turn people away or break an event
  private async tolerate(what: string, work: () => Promise<void>): Promise<void> {
    try {
      await work()
    } catch (error) {
      this.logger.error({ err: error }, `${what} failed`)
    }
  }
}
