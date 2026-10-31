import {
  SocketLifecycle,
  WIDGET_TOKEN_AUTH_KEY,
  WidgetAuthors,
  WidgetClientEvents,
  WidgetDeliveryStates,
  WidgetLimits,
  WidgetSocketEvents
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { RealtimeNamespaces } from '@platform/core/realtime'

import { isServerMessage, type WidgetApi, WidgetApiError } from './api'
import type { ChatLog } from './chat-log'
import type { Bootstrap } from './types'

// The part of a socket the session uses, so that a test does not need a network
export interface VisitorSocket {
  readonly connected: boolean
  on(event: string, listener: (...args: unknown[]) => void): void
  emit(event: string): void
  connect(): void
  disconnect(): void
}
export type SocketFactory = (
  url: string,
  namespace: string,
  auth: (deliver: (data: Record<string, string>) => void) => void
) => VisitorSocket

const MS_PER_SECOND = 1000
// The token is renewed this long before it ends, so that a send never meets an expired one
const RENEW_BEFORE_EXPIRY_MS = 60 * MS_PER_SECOND
const MIN_RENEW_DELAY_MS = 10 * MS_PER_SECOND
const RETRY_DELAYS_MS = [1, 2, 4, 8, 16].map(seconds => seconds * MS_PER_SECOND)

export interface SessionDeps {
  siteKey: string
  visitorId: string
  api: WidgetApi
  log: ChatLog
  socketUrl: string
  createSocket: SocketFactory
  newMessageId: () => string
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// One visit of one visitor: the token and its renewal, the socket where replies arrive, and the sending
// of messages. The token lasts an hour; the session asks for another before it ends, reads the history
// again (anything said while the socket was down is in it) and reconnects the socket with it.
export class Session {
  private token = ''
  private renewTimer: ReturnType<typeof setTimeout> | undefined
  private socket: VisitorSocket | undefined
  private stopped = false
  private renewing: Promise<Bootstrap> | undefined
  private lastTypingAt = 0
  private typingListener: ((active: boolean) => void) | undefined
  private typingLapse: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly deps: SessionDeps) {}

  // Null when the widget cannot work here (a key that does not exist, a site that is not listed) or
  // the api never answered: the page then gets no widget at all
  async start(): Promise<Bootstrap | null> {
    let boot: Bootstrap | undefined
    for (let attempt = 0; boot === undefined; attempt += 1) {
      try {
        boot = await this.renew()
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt]
        const permanent = error instanceof WidgetApiError && error.permanent
        if (permanent || delay === undefined || this.stopped) return null
        await wait(delay)
      }
    }
    // Stopped while the api was answering: nothing may be left open
    if (this.stopped) return null
    this.openSocket()
    return boot
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.renewTimer)
    clearTimeout(this.typingLapse)
    this.socket?.disconnect()
  }

  // The visitor is typing: the server is told at most once in the gap it takes from a visitor (it drops
  // the rest), and only on a socket that is up, so that nothing waits in a buffer to arrive late
  typing(): void {
    const now = Date.now()
    if (this.socket?.connected !== true) return
    if (now - this.lastTypingAt < WidgetLimits.CUSTOMER_TYPING_GAP_MS) return
    this.lastTypingAt = now
    this.socket.emit(WidgetClientEvents.TYPING)
  }

  // Told whether the team is typing. A start that is not followed by a stop lapses by itself, because
  // the stop can be lost with the socket.
  onAgentTyping(listener: (active: boolean) => void): void {
    this.typingListener = listener
  }

  private setAgentTyping(active: boolean): void {
    clearTimeout(this.typingLapse)
    // A late start after stop() would have no lapse to end it
    if (active && this.stopped) return
    if (active) {
      this.typingLapse = setTimeout(
        () => this.typingListener?.(false),
        WidgetLimits.AGENT_TYPING_LAPSE_MS
      )
    }
    this.typingListener?.(active)
  }

  // Writes the message at once and sends it; the same key can be sent again, and the api stores it once
  async send(content: string): Promise<void> {
    const key = this.deps.newMessageId()
    this.deps.log.addOutgoing(key, content)
    await this.deliver(key)
  }

  async retry(key: string): Promise<void> {
    if (this.deps.log.find(key)?.state !== WidgetDeliveryStates.FAILED) return
    this.deps.log.setState(key, WidgetDeliveryStates.SENDING)
    await this.deliver(key)
  }

  private async deliver(key: string): Promise<void> {
    const message = this.deps.log.find(key)
    if (message === undefined) return
    try {
      try {
        await this.deps.api.send(this.token, key, message.content)
      } catch (error) {
        if (!(error instanceof WidgetApiError && error.tokenInvalid)) throw error
        // The session ended while the page stayed open: begin another and send once more
        await this.renew()
        await this.deps.api.send(this.token, key, message.content)
      }
      this.deps.log.setState(key, WidgetDeliveryStates.SENT)
    } catch {
      this.deps.log.setState(key, WidgetDeliveryStates.FAILED)
    }
  }

  // Concurrent callers share one request
  private renew(): Promise<Bootstrap> {
    this.renewing ??= this.requestToken().finally(() => {
      this.renewing = undefined
    })
    return this.renewing
  }

  private async requestToken(): Promise<Bootstrap> {
    const boot = await this.deps.api.bootstrap(this.deps.siteKey, this.deps.visitorId)
    this.token = boot.visitorToken
    this.deps.log.loadHistory(boot.messages)
    // An id outside the loaded window is older than all of it, so nothing loaded was read
    const readUpTo = boot.readUpToMessageId
    if (readUpTo !== null && boot.messages.some(message => message.id === readUpTo)) {
      this.deps.log.markSeenUpTo(readUpTo)
    }
    clearTimeout(this.renewTimer)
    if (this.stopped) return boot
    const delay = Math.max(
      MIN_RENEW_DELAY_MS,
      boot.expiresInSeconds * MS_PER_SECOND - RENEW_BEFORE_EXPIRY_MS
    )
    this.renewTimer = setTimeout(() => void this.renewAndReconnect(), delay)
    return boot
  }

  private async renewAndReconnect(): Promise<void> {
    if (this.stopped) return
    try {
      await this.renew()
    } catch (error) {
      // A site that was taken off the list, or a key that was disconnected, will not come back by
      // asking: the visitor is left with what they have, and the page with no more requests
      if (error instanceof WidgetApiError && error.permanent) {
        this.stop()
        return
      }
      // The api could not be reached: try again soon, the old token is still good for a minute
      this.renewTimer = setTimeout(() => void this.renewAndReconnect(), MIN_RENEW_DELAY_MS)
      return
    }
    // The server ends a socket when the token it came with does; a new one has a new end
    this.socket?.disconnect()
    this.socket?.connect()
  }

  private reconnectWithNewToken(socket: VisitorSocket): void {
    if (this.stopped) return
    this.renew().then(
      () => {
        if (!this.stopped) socket.connect()
      },
      () => undefined
    )
  }

  private openSocket(): void {
    const socket = this.deps.createSocket(
      this.deps.socketUrl,
      RealtimeNamespaces.WIDGET,
      // Asked on every connect, so that a reconnect carries the token of now
      deliver => deliver({ [WIDGET_TOKEN_AUTH_KEY]: this.token })
    )
    socket.on(WidgetSocketEvents.MESSAGE, (payload: unknown) => {
      if (!isServerMessage(payload)) return
      this.deps.log.addIncoming(payload)
      // A reply ends the typing that announced it
      if (payload.from === WidgetAuthors.TEAM) this.setAgentTyping(false)
    })
    socket.on(WidgetSocketEvents.AGENT_TYPING, (payload: unknown) => {
      const active = (payload as { active?: unknown } | null)?.active
      if (typeof active === 'boolean') this.setAgentTyping(active)
    })
    socket.on(WidgetSocketEvents.READ, (payload: unknown) => {
      const messageId = (payload as { messageId?: unknown } | null)?.messageId
      if (typeof messageId === 'string') this.deps.log.markSeenUpTo(messageId)
    })
    // A server that closes the socket on purpose (the token ended) is not retried by the library, and
    // neither is a handshake it refused: both are asked for a new token and connected again here
    socket.on(SocketLifecycle.DISCONNECT, (reason: unknown) => {
      this.setAgentTyping(false)
      if (reason === SocketLifecycle.SERVER_DISCONNECT) this.reconnectWithNewToken(socket)
    })
    socket.on(SocketLifecycle.CONNECT_ERROR, (error: unknown) => {
      const code = (error as { data?: { code?: unknown } } | null)?.data?.code
      if (code === ErrorCodes.WIDGET_TOKEN_INVALID) this.reconnectWithNewToken(socket)
    })
    this.socket = socket
  }
}
