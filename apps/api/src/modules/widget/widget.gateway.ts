import { SkipThrottle } from '@nestjs/throttler'
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  ConnectedSocket,
  SubscribeMessage,
  WebSocketGateway
} from '@nestjs/websockets'
import { PinoLogger } from 'nestjs-pino'
import type { Namespace, Socket } from 'socket.io'

import { isAllowedOrigin } from '@platform/channels/web-widget'
import { Public } from '@platform/core/auth-module'
import { WIDGET_TOKEN_AUTH_KEY, WidgetClientEvents, WidgetLimits } from '@platform/core/domain'
import { ErrorCodes, type ErrorCode } from '@platform/core/errors'
import { RealtimeNamespaces, RoomNames, SocketLimits } from '@platform/core/realtime'

import { WidgetCustomerTyping } from './widget-customer-typing.service'
import { WidgetDelivery } from './widget-delivery.service'
import { WidgetSites } from './widget-sites.service'
import { WidgetTokens } from './widget-tokens.service'
import { WidgetTypingThrottle } from './widget-typing-throttle'

// What the client is told when it is refused; the reason is in `data.code`
const REFUSED_MESSAGE = 'refused'

interface VisitorSocketData {
  siteKey: string
  // What the handshake found of the site, so that a typing signal does not look it up again. A site
  // disconnected after the handshake is heard until the token ends (an hour at most).
  storeId: string
  connectionId: string
  visitorId: string
  expiresAt: number
}
type VisitorSocket = Socket<never, never, never, VisitorSocketData>

class Refused extends Error {
  constructor(readonly code: ErrorCode) {
    super(REFUSED_MESSAGE)
  }
}

// The sockets of the visitors, in their own namespace. A visitor gets in with the token of the
// bootstrap, from a site the store listed, and is put in the room of that visitor alone, where the
// replies of the store arrive. The socket sends nothing the server listens to, and it closes when the
// token does: the widget asks for a new one and connects again. The limit of tabs is looked at in the
// handshake and not after it, so a burst of connects at once can pass it by a few: it is there to stop a
// loop, not to count exactly.
//
// The global guards are written for an HTTP request and run on a gateway too, where they cannot work
// (as for the agents' gateway): it is @Public and @SkipThrottle and does its own checks.
@Public()
@SkipThrottle()
@WebSocketGateway({
  namespace: RealtimeNamespaces.WIDGET,
  transports: ['websocket'], // No long polling, so no sticky sessions
  maxHttpBufferSize: SocketLimits.MAX_MESSAGE_BYTES,
  connectTimeout: SocketLimits.CONNECT_TIMEOUT_MS
})
export class WidgetGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly expiries = new WeakMap<VisitorSocket, NodeJS.Timeout>()
  private readonly typingThrottle = new WidgetTypingThrottle()

  constructor(
    private readonly tokens: WidgetTokens,
    private readonly sites: WidgetSites,
    private readonly delivery: WidgetDelivery,
    private readonly typing: WidgetCustomerTyping,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(WidgetGateway.name)
  }

  afterInit(namespace: Namespace): void {
    this.delivery.attach(namespace)
    // Checked before the socket exists: a client that is refused never connects
    namespace.use((socket, next) => {
      this.admit(socket as VisitorSocket, namespace)
        .then(() => next())
        .catch((error: unknown) => {
          const code = error instanceof Refused ? error.code : null
          if (code === null) this.logger.error({ err: error }, 'a widget handshake failed')
          next(Object.assign(new Error(REFUSED_MESSAGE), { data: { code } }))
        })
    })
  }

  private async admit(socket: VisitorSocket, namespace: Namespace): Promise<void> {
    const auth: unknown = socket.handshake.auth
    const token =
      typeof auth === 'object' && auth !== null
        ? (auth as Record<string, unknown>)[WIDGET_TOKEN_AUTH_KEY]
        : undefined
    const claims = this.tokens.verify(token)
    if (claims === null) throw new Refused(ErrorCodes.WIDGET_TOKEN_INVALID)
    const site = await this.sites.find(claims.siteKey)
    if (site === null) throw new Refused(ErrorCodes.WIDGET_TOKEN_INVALID)
    if (!isAllowedOrigin(site.allowedOrigins, socket.handshake.headers.origin)) {
      throw new Refused(ErrorCodes.WIDGET_ORIGIN_NOT_ALLOWED)
    }
    // A visitor has a few tabs: past that, one more is a loop. Counted across the instances.
    const room = RoomNames.widgetVisitor(claims.siteKey, claims.visitorId)
    if ((await namespace.in(room).fetchSockets()).length >= WidgetLimits.MAX_SOCKETS_PER_VISITOR) {
      throw new Refused(ErrorCodes.RATE_LIMIT_EXCEEDED)
    }
    // The token is checked and has no further use: it must not travel in what fetchSockets() sends
    // across the instances (the handshake of every socket goes with it)
    socket.handshake.auth = {}
    socket.handshake.headers = {}
    socket.handshake.query = {}
    socket.data = {
      siteKey: claims.siteKey,
      storeId: site.storeId,
      connectionId: site.connectionId,
      visitorId: claims.visitorId,
      expiresAt: claims.expiresAt
    }
  }

  async handleConnection(client: VisitorSocket): Promise<void> {
    const { siteKey, visitorId, expiresAt } = client.data
    // Before the first await: a disconnect that comes during it must find the timer to clear
    this.expiries.set(
      client,
      setTimeout(() => client.disconnect(true), Math.max(0, expiresAt - Date.now()))
    )
    await client.join(RoomNames.widgetVisitor(siteKey, visitorId))
  }

  // The one thing a visitor's socket may send, and it carries nothing: who is typing is the visitor of
  // the socket. A signal past the limit of the visitor or of the site is dropped before the database.
  @SubscribeMessage(WidgetClientEvents.TYPING)
  async handleTyping(@ConnectedSocket() client: VisitorSocket): Promise<void> {
    const { siteKey, storeId, connectionId, visitorId } = client.data
    if (!this.typingThrottle.take(siteKey, visitorId)) return
    try {
      await this.typing.signal({ storeId, connectionId }, visitorId)
    } catch (error) {
      this.logger.warn({ err: error }, 'a visitor typing signal failed')
    }
  }

  handleDisconnect(client: VisitorSocket): void {
    const timer = this.expiries.get(client)
    if (timer !== undefined) clearTimeout(timer)
  }
}
