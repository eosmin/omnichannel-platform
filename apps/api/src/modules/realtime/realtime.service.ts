import { Injectable, Logger } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'

import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import {
  RealtimeEvents,
  RoomNames,
  type RealtimeEvent,
  type RealtimeEventMap,
  type ServerToClientEvents
} from '@platform/core/realtime'

import type { PlatformServer, SocketData } from './realtime.types'

type ServerEvent = keyof ServerToClientEvents

// Anything that can emit to a room or a list of sockets, without the typing of the library (see send)
interface Emitter {
  emit: (event: string, payload: unknown) => boolean
}

// The one way the api talks to the browsers. Every method sends ids and plain values (the payloads
// of RealtimeEventMap): what is private is read through the REST api, which knows who may see it.
@Injectable()
export class RealtimeService {
  private server: PlatformServer | null = null
  private readonly logger = new Logger(RealtimeService.name)

  constructor(
    @InjectMetric(MetricNames.WEBSOCKET_EVENTS_EMITTED) private readonly emitted: Counter<string>
  ) {}

  // Called once by the gateway when it starts. Before that an emit has nobody to reach.
  attach(server: PlatformServer): void {
    this.server = server
  }

  // Every socket of the store: for what the whole team may know (who is online)
  toStore<E extends ServerEvent>(storeId: string, event: E, payload: RealtimeEventMap[E]): void {
    this.send(RoomNames.store(storeId), event, payload)
  }

  // Everyone in a conversation room (the sockets that joined it)
  toConversation<E extends ServerEvent>(
    conversationId: string,
    event: E,
    payload: RealtimeEventMap[E]
  ): void {
    this.send(RoomNames.conversation(conversationId), event, payload)
  }

  // The sockets of one user in one store, in any tab
  toStoreUser<E extends ServerEvent>(
    storeId: string,
    userId: string,
    event: E,
    payload: RealtimeEventMap[E]
  ): void {
    this.send(RoomNames.storeUser(storeId, userId), event, payload)
  }

  // The sockets of the store whose user passes `mayReceive`, whichever api instance holds them. This
  // is how an event about a conversation reaches only who may see that conversation.
  async toStoreWhere<E extends ServerEvent>(
    storeId: string,
    event: E,
    payload: RealtimeEventMap[E],
    mayReceive: (socket: SocketData) => boolean
  ): Promise<void> {
    const server = this.server
    if (server === null) {
      this.logger.warn(`${event} was not sent: the gateway has not started`)
      return
    }
    const sockets = await this.socketsOf(server, RoomNames.store(storeId))
    const ids = sockets.filter(socket => mayReceive(socket.data)).map(socket => socket.id)
    if (ids.length === 0) return
    this.send(ids, event, payload)
  }

  // Takes out of the room of a conversation the sockets whose user may no longer see it: what the
  // room carries (who is typing) is for who may see the conversation.
  async evictFromConversation(
    conversationId: string,
    mayStay: (socket: SocketData) => boolean | Promise<boolean>
  ): Promise<void> {
    const server = this.server
    if (server === null) return
    const room = RoomNames.conversation(conversationId)
    const sockets = await this.socketsOf(server, room)
    const verdicts = await Promise.all(
      sockets.map(async socket => ({ socket, stays: await mayStay(socket.data) }))
    )
    const leaving = verdicts.filter(verdict => !verdict.stays).map(verdict => verdict.socket)
    // Whoever was typing stops with the room: the others would see it forever
    for (const socket of leaving) {
      this.send(room, RealtimeEvents.TYPING_STOP, {
        conversationId,
        userId: socket.data.userId
      })
    }
    if (leaving.length > 0) server.in(leaving.map(socket => socket.id)).socketsLeave(room)
  }

  // The sockets in a room, on every instance. Public for the tests, which look at what the other
  // instances are told of a socket.
  socketsIn(room: string): ReturnType<PlatformServer['fetchSockets']> {
    return this.server === null ? Promise.resolve([]) : this.socketsOf(this.server, room)
  }

  // If the instances do not answer, the sockets of this one: an event that reaches some is better than
  // one that reaches none.
  private socketsOf(
    server: PlatformServer,
    room: string
  ): ReturnType<PlatformServer['fetchSockets']> {
    return server
      .in(room)
      .fetchSockets()
      .catch((error: unknown) => {
        this.logger.warn(`the instances did not answer, using the local sockets: ${String(error)}`)
        return server.local.in(room).fetchSockets()
      })
  }

  // The generic event of the library's typed emit cannot be proven to match its payload, so the
  // target is seen through the one signature it has: the types of this class are what keep the
  // payload and the event together.
  private send<E extends RealtimeEvent>(
    target: string | string[],
    event: E,
    payload: RealtimeEventMap[E]
  ): void {
    const server = this.server
    if (server === null) {
      this.logger.warn(`${event} was not sent: the gateway has not started`)
      return
    }
    ;(server.to(target) as unknown as Emitter).emit(event, payload)
    this.emitted.inc({ event })
  }
}
