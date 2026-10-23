# TDD 06 — Realtime & Notifications

> Part of the Omnichannel Commerce Platform TDD v1.1
> Covers: WebSocket scaling, presence, offline handling, in-app notifications, web push

---

## 1. WebSocket architecture

### 1.1 The scaling problem

Socket.io is stateful. With multiple `api-service` instances, a user connected to
instance 1 does not receive events emitted from instance 2.

**Solution: Redis Adapter.**

```
Agent A ──── Instance 1 ──┐
                          ├── Redis Pub/Sub ──> broadcast reaches all instances
Agent B ──── Instance 2 ──┘
```

Clients connect with `transports: ['websocket']` only (no long-polling), so no sticky
sessions are needed on Cloud Run or Kubernetes; the load balancer only has to keep the
upgraded TCP connection open (`TDD_03` §1 timeouts).

### 1.2 Setup

The adapter uses **ioredis** — the platform's only Redis client (`TDD_01` §2.4).

```typescript
// apps/api/src/realtime/redis-io.adapter.ts
import { IoAdapter } from '@nestjs/platform-socket.io'
import { createAdapter } from '@socket.io/redis-adapter'
import type { Redis } from 'ioredis'
import type { ServerOptions } from 'socket.io'

export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null

  constructor(app: INestApplication, private readonly redis: Redis) { super(app) }

  async connectToRedis(): Promise<void> {
    const pubClient = this.redis.duplicate()
    const subClient = this.redis.duplicate()
    await Promise.all([pubClient.connect(), subClient.connect()])
    this.adapterConstructor = createAdapter(pubClient, subClient)
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server
    if (this.adapterConstructor) server.adapter(this.adapterConstructor)
    return server
  }
}
```

```typescript
// apps/api/src/main.ts
const app = await NestFactory.create(AppModule, { rawBody: true })
const redisAdapter = new RedisIoAdapter(app, app.get<Redis>(REDIS_CLIENT))
await redisAdapter.connectToRedis()
app.useWebSocketAdapter(redisAdapter)
await app.listen(env.PORT)
```

### 1.3 Gateway

```typescript
// apps/api/src/modules/realtime/events.gateway.ts
interface SocketData {
  userId: string
  userName: string
  storeId: string
}

@WebSocketGateway({
  namespace: RealtimeNamespaces.AGENTS,        // '/realtime'
  cors: { origin: [env.FRONTEND_URL], credentials: true },
  transports: ['websocket'],
})
export class EventsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() private readonly server!: Server<RealtimeClientEvents, RealtimeServerEvents, never, SocketData>

  constructor(
    private readonly auth: AuthService,
    private readonly tenancy: TenancyService,
    private readonly presence: PresenceService,
    private readonly realtime: RealtimeService,
    @InjectMetric(MetricNames.WEBSOCKET_CONNECTIONS) private readonly wsConnections: Gauge,
    @InjectPinoLogger(EventsGateway.name) private readonly logger: PinoLogger,
  ) {}

  afterInit(server: Server): void {
    this.realtime.attach(server)                  // RealtimeService broadcasts through this server
  }

  async handleConnection(client: Socket<RealtimeClientEvents, RealtimeServerEvents, never, SocketData>): Promise<void> {
    const parsed = handshakeSchema.safeParse(client.handshake.auth)   // { token, storeId } — Zod
    if (!parsed.success) return this.reject(client, ErrorCodes.AUTH_TOKEN_INVALID)

    const user = await this.auth.validateAccessToken(parsed.data.token)
    if (!user) return this.reject(client, ErrorCodes.AUTH_TOKEN_INVALID)

    const hasAccess = await this.tenancy.hasStoreAccess(user.id, parsed.data.storeId)
    if (!hasAccess) return this.reject(client, ErrorCodes.TENANT_ACCESS_DENIED)

    client.data = { userId: user.id, userName: user.name, storeId: parsed.data.storeId }

    // Rooms: one per store (broadcasts), one per user (direct). Conversation rooms are
    // joined on demand (JOIN_CONVERSATION) so typing indicators stay scoped.
    await client.join(RoomNames.store(parsed.data.storeId))
    await client.join(RoomNames.user(user.id))

    await this.presence.socketConnected(parsed.data.storeId, user.id, client.id)
    this.wsConnections.inc({ store_id: parsed.data.storeId })
    this.logger.info({ userId: user.id, storeId: parsed.data.storeId }, 'websocket connected')
  }

  async handleDisconnect(client: Socket<RealtimeClientEvents, RealtimeServerEvents, never, SocketData>): Promise<void> {
    const { userId, storeId } = client.data
    if (!userId) return

    await this.presence.socketDisconnected(storeId, userId, client.id)
    this.wsConnections.dec({ store_id: storeId })
    this.logger.info({ userId, storeId }, 'websocket disconnected')
  }

  @SubscribeMessage(RealtimeEvents.JOIN_CONVERSATION)
  async handleJoin(@ConnectedSocket() client: Socket, @MessageBody() body: RealtimeEventMap[typeof RealtimeEvents.JOIN_CONVERSATION]): Promise<void> {
    // Membership in the store was verified at connect time; the conversation must belong to that store
    if (await this.tenancy.conversationBelongsToStore(body.conversationId, client.data.storeId)) {
      await client.join(RoomNames.conversation(body.conversationId))
    }
  }

  @SubscribeMessage(RealtimeEvents.LEAVE_CONVERSATION)
  async handleLeave(@ConnectedSocket() client: Socket, @MessageBody() body: RealtimeEventMap[typeof RealtimeEvents.LEAVE_CONVERSATION]): Promise<void> {
    await client.leave(RoomNames.conversation(body.conversationId))
  }

  @SubscribeMessage(RealtimeEvents.TYPING_START)
  handleTypingStart(@ConnectedSocket() client: Socket, @MessageBody() body: { conversationId: string }): void {
    client.to(RoomNames.conversation(body.conversationId)).emit(RealtimeEvents.TYPING_START, {
      conversationId: body.conversationId,
      userId: client.data.userId,
      userName: client.data.userName,
    })
  }

  @SubscribeMessage(RealtimeEvents.TYPING_STOP)
  handleTypingStop(@ConnectedSocket() client: Socket, @MessageBody() body: { conversationId: string }): void {
    client.to(RoomNames.conversation(body.conversationId)).emit(RealtimeEvents.TYPING_STOP, {
      conversationId: body.conversationId,
      userId: client.data.userId,
    })
  }

  @SubscribeMessage(RealtimeEvents.HEARTBEAT)
  async handleHeartbeat(@ConnectedSocket() client: Socket): Promise<void> {
    await this.presence.heartbeat(client.data.storeId, client.data.userId, client.id)
  }

  private reject(client: Socket, code: ErrorCode): void {
    client.emit(RealtimeEvents.AUTH_ERROR, { code })
    client.disconnect(true)
  }
}
```

`RealtimeClientEvents` / `RealtimeServerEvents` are derived from `RealtimeEventMap`
(`TDD_02` §2) so both directions are typed end to end.

### 1.4 Room naming (constants)

```typescript
// libs/core/realtime/room-names.ts
export const RealtimeNamespaces = {
  AGENTS: '/realtime',
  WIDGET: '/widget',          // Visitor sockets for the web-widget channel, TDD_10 §5.4
} as const

export const RoomNames = {
  store: (storeId: string) => `store:${storeId}`,
  user: (userId: string) => `user:${userId}`,
  organization: (organizationId: string) => `org:${organizationId}`,   // Impersonation banner
  conversation: (conversationId: string) => `conv:${conversationId}`,
  widgetVisitor: (connectionId: string, visitorId: string) => `widget:${connectionId}:${visitorId}`,
} as const
```

### 1.5 Broadcasting from services

```typescript
// libs/core/realtime/realtime.service.ts
@Injectable()
export class RealtimeService {
  private server: Server | null = null

  constructor(
    @InjectMetric(MetricNames.WEBSOCKET_EVENTS_EMITTED) private readonly eventsEmitted: Counter,
  ) {}

  // Called once by EventsGateway.afterInit. Before that, emits are dropped with a warning —
  // this only happens during boot.
  attach(server: Server): void { this.server = server }

  broadcastToStore<E extends RealtimeEvent>(storeId: string, event: E, payload: RealtimeEventMap[E]): void {
    this.emitTo(RoomNames.store(storeId), event, payload)
  }

  broadcastToConversation<E extends RealtimeEvent>(conversationId: string, event: E, payload: RealtimeEventMap[E]): void {
    this.emitTo(RoomNames.conversation(conversationId), event, payload)
  }

  notifyUser<E extends RealtimeEvent>(userId: string, event: E, payload: RealtimeEventMap[E]): void {
    this.emitTo(RoomNames.user(userId), event, payload)
  }

  notifyOrganization<E extends RealtimeEvent>(organizationId: string, event: E, payload: RealtimeEventMap[E]): void {
    this.emitTo(RoomNames.organization(organizationId), event, payload)
  }

  private emitTo<E extends RealtimeEvent>(room: string, event: E, payload: RealtimeEventMap[E]): void {
    this.server?.to(room).emit(event, payload)
    this.eventsEmitted.inc({ event })
  }
}
```

The worker never holds a socket server. When a worker needs to broadcast (snooze wake,
export ready) it emits the **domain event**; the API instances' listeners below translate
it into realtime traffic. Domain events cross process boundaries through the
`EVENTS_BRIDGE` Redis channel (`libs/core/events/events-bridge.ts`), which re-emits
worker-originated events on every API instance.

Wired to the domain event bus:

```typescript
@Injectable()
export class RealtimeEventsListener {
  constructor(private readonly realtime: RealtimeService) {}

  @OnEvent(Events.MESSAGE_RECEIVED)
  onMessageReceived(payload: MessageReceivedPayload): void {
    this.realtime.broadcastToStore(payload.storeId, RealtimeEvents.MESSAGE_RECEIVED, {
      conversationId: payload.conversationId,
      messageId: payload.messageId,
      authorType: payload.authorType,
      contentPreview: payload.contentPreview,
      createdAt: payload.receivedAt,
    })
  }

  @OnEvent(Events.CONVERSATION_STATUS_CHANGED)
  onStatusChanged(payload: ConversationStatusChangedPayload): void {
    this.realtime.broadcastToStore(payload.storeId, RealtimeEvents.CONVERSATION_STATUS_CHANGED, {
      conversationId: payload.conversationId,
      status: payload.status,
      previousStatus: payload.previousStatus,
    })
  }

  @OnEvent(Events.CONVERSATION_ASSIGNED)
  onAssigned(payload: ConversationAssignedPayload): void {
    this.realtime.broadcastToStore(payload.storeId, RealtimeEvents.CONVERSATION_ASSIGNED, {
      conversationId: payload.conversationId,
      assignedTo: payload.assignedTo,
      assignedBy: payload.assignedBy.id,
    })
  }
}
```

---

## 2. Load balancer configuration for WebSockets

No sticky sessions (§1.1). What the ingress must do is keep upgraded connections open:

```yaml
# Kubernetes / Nginx Ingress (Phase 2)
metadata:
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
```

Cloud Run (Phase 1): `--timeout=3600` on `api-service` (`TDD_03` §1). Cloudflare proxies
WebSockets by default.

---

## 3. Client connection management

```typescript
// apps/web/lib/websocket.ts
import { io, type Socket } from 'socket.io-client'
import { RealtimeEvents, RealtimeNamespaces, type RealtimeClientSocket } from '@platform/core-domain/realtime'
import { ErrorCodes } from '@platform/core-domain/errors'
import { webEnv } from './env'
import { useConnectionStore } from '@/hooks/use-connection-store'

const MAX_RECONNECT_ATTEMPTS = 10
let socket: RealtimeClientSocket | null = null

export function connectWebSocket(storeId: string, getAccessToken: () => Promise<string>): RealtimeClientSocket {
  disconnectWebSocket()

  const next = io(`${webEnv.NEXT_PUBLIC_WS_URL}${RealtimeNamespaces.AGENTS}`, {
    auth: async cb => cb({ token: await getAccessToken(), storeId }),   // Fresh token on every (re)connect
    transports: ['websocket'],          // Skip long-polling handshake; no sticky sessions needed
    reconnection: true,
    reconnectionAttempts: MAX_RECONNECT_ATTEMPTS,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30_000,
    randomizationFactor: 0.5,           // Jitter avoids thundering herd
    timeout: 20_000,
  }) as RealtimeClientSocket

  next.on('connect', () => {
    useConnectionStore.getState().setStatus('connected')
    void offlineQueue.flush()
  })

  next.on('disconnect', reason => {
    useConnectionStore.getState().setStatus('disconnected')
    // Server-initiated disconnect requires an explicit reconnect
    if (reason === 'io server disconnect') next.connect()
  })

  next.on('connect_error', () => {
    useConnectionStore.getState().setStatus('reconnecting')
  })

  next.on(RealtimeEvents.AUTH_ERROR, ({ code }) => {
    // The auth callback above already fetches a fresh token; a second failure means the
    // refresh token is gone and the user must log in again.
    if (code === ErrorCodes.AUTH_TOKEN_INVALID || code === ErrorCodes.AUTH_TOKEN_EXPIRED) {
      useConnectionStore.getState().setStatus('unauthenticated')
    }
  })

  socket = next
  return next
}

export function getSocket(): RealtimeClientSocket {
  if (!socket) throw new Error('WebSocket not connected')   // Programming error, never user-facing
  return socket
}

export function disconnectWebSocket(): void {
  socket?.disconnect()
  socket = null
}
```

**Cache invalidation on realtime events** — handlers are stored in variables so `off()`
removes only this hook's listeners, and invalidations are debounced so a burst of inbound
messages triggers one refetch:

```typescript
export function useRealtimeSync(storeId: string): void {
  const queryClient = useQueryClient()

  useEffect(() => {
    const socket = getSocket()
    const invalidate = debounce((keys: readonly unknown[][]) => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key })
    }, 150)

    const onMessageReceived = (payload: RealtimeEventMap[typeof RealtimeEvents.MESSAGE_RECEIVED]) => {
      invalidate([QueryKeys.conversations.all(storeId), QueryKeys.messages.thread(storeId, payload.conversationId)])
    }
    const onConversationUpdated = (payload: RealtimeEventMap[typeof RealtimeEvents.CONVERSATION_UPDATED]) => {
      invalidate([QueryKeys.conversations.all(storeId), QueryKeys.conversations.byId(storeId, payload.conversationId)])
    }
    const onStatusChanged = (payload: RealtimeEventMap[typeof RealtimeEvents.CONVERSATION_STATUS_CHANGED]) => {
      invalidate([QueryKeys.conversations.all(storeId), QueryKeys.conversations.byId(storeId, payload.conversationId), QueryKeys.conversations.counts(storeId)])
    }

    socket.on(RealtimeEvents.MESSAGE_RECEIVED, onMessageReceived)
    socket.on(RealtimeEvents.CONVERSATION_UPDATED, onConversationUpdated)
    socket.on(RealtimeEvents.CONVERSATION_STATUS_CHANGED, onStatusChanged)

    return () => {
      socket.off(RealtimeEvents.MESSAGE_RECEIVED, onMessageReceived)
      socket.off(RealtimeEvents.CONVERSATION_UPDATED, onConversationUpdated)
      socket.off(RealtimeEvents.CONVERSATION_STATUS_CHANGED, onStatusChanged)
      invalidate.cancel()
    }
  }, [storeId, queryClient])
}
```

**Connection status indicator** is always visible in the UI header:
`connected` (no indicator), `reconnecting` (amber dot), `disconnected` (red banner),
`unauthenticated` (redirect to login).

---

## 4. Offline support

Agents on mobile lose connectivity. Messages composed offline must not be lost.

```typescript
// apps/web/lib/offline-queue.ts
interface PendingMessage {
  id: string                 // Also the server-side idempotencyKey
  storeId: string
  conversationId: string
  content: string
  type: MessageType
  createdAt: string
  lastError: ErrorCode | null
}

const STORAGE_KEY = 'platform_pending_messages'

// Errors that will not succeed on retry — the message is surfaced to the agent instead
const TERMINAL_ERRORS = new Set<ErrorCode>([
  ErrorCodes.CHANNEL_WINDOW_EXPIRED,
  ErrorCodes.CONVERSATION_INVALID_STATUS_TRANSITION,
  ErrorCodes.CONVERSATION_HANDLED_BY_AI,
  ErrorCodes.PERMISSION_DENIED,
  ErrorCodes.TENANT_ACCESS_DENIED,
  ErrorCodes.TENANT_READ_ONLY,
  ErrorCodes.QUOTA_CONVERSATIONS_EXCEEDED,
  ErrorCodes.VALIDATION_FAILED,
  ErrorCodes.RESOURCE_NOT_FOUND,
])

class OfflineMessageQueue {
  private queue: PendingMessage[] = []

  restore(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      this.queue = stored ? pendingMessagesSchema.parse(JSON.parse(stored)) : []   // Zod at the storage boundary
    } catch {
      this.queue = []
    }
  }

  enqueue(message: Omit<PendingMessage, 'id' | 'createdAt' | 'lastError'>): PendingMessage {
    const pending: PendingMessage = { ...message, id: crypto.randomUUID(), createdAt: new Date().toISOString(), lastError: null }
    this.queue.push(pending)
    this.persist()
    return pending
  }

  async flush(): Promise<void> {
    for (const msg of [...this.queue]) {
      try {
        await apiClient.messages.create(msg.storeId, {
          conversationId: msg.conversationId,
          content: msg.content,
          type: msg.type,
          idempotencyKey: msg.id,            // Server dedupes on (conversationId, idempotencyKey)
        })
        this.remove(msg.id)
      } catch (error) {
        if (isApiError(error) && TERMINAL_ERRORS.has(error.code)) {
          // Will never succeed: drop from the retry loop, keep for the agent to see and edit
          this.markFailed(msg.id, error.code)
          continue
        }
        break                                // Transient (network, 5xx): stop, retry on next reconnect
      }
    }
  }

  failed(): PendingMessage[] { return this.queue.filter(m => m.lastError !== null) }
  discard(id: string): void { this.remove(id) }

  private markFailed(id: string, code: ErrorCode): void {
    this.queue = this.queue.map(m => (m.id === id ? { ...m, lastError: code } : m))
    this.persist()
  }
  private remove(id: string): void { this.queue = this.queue.filter(m => m.id !== id); this.persist() }
  private persist(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.queue)) } catch { /* quota exceeded: keep in memory */ }
  }
}

export const offlineQueue = new OfflineMessageQueue()
```

**UI treatment:** queued messages appear in the thread immediately with a "pending" clock
icon and switch to sent once flushed. A message with `lastError` shows the translated
error (`errors.<code>`) with "Edit" and "Discard" actions instead of retrying forever.

**Server-side idempotency:** `POST /messages` accepts `idempotencyKey`; the unique index on
`(conversationId, idempotencyKey)` (`TDD_01` §4) makes a retry return the existing message
with `200` instead of creating a duplicate.

---

## 5. Presence system

Presence is tracked **per socket**, so a user with two tabs (or the same user in two
stores) stays online until the last socket in that store closes.

```typescript
// libs/core/realtime/presence.service.ts
@Injectable()
export class PresenceService {
  private static readonly SOCKET_TTL_SECONDS = 60      // Heartbeat every 30s (§1.3)
  private static readonly AWAY_AFTER_SECONDS = 300

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly realtime: RealtimeService,
  ) {}

  async socketConnected(storeId: string, userId: string, socketId: string): Promise<void> {
    const sockets = CacheKeys.presence.sockets(storeId, userId)
    const wasOnline = (await this.redis.scard(sockets)) > 0

    await this.redis.multi()
      .sadd(sockets, socketId)
      .expire(sockets, PresenceService.SOCKET_TTL_SECONDS)
      .sadd(CacheKeys.presence.store(storeId), userId)
      .set(CacheKeys.presence.lastActivity(storeId, userId), Date.now())
      .exec()

    if (!wasOnline) this.realtime.broadcastToStore(storeId, RealtimeEvents.USER_ONLINE, { userId })
  }

  async socketDisconnected(storeId: string, userId: string, socketId: string): Promise<void> {
    const sockets = CacheKeys.presence.sockets(storeId, userId)
    await this.redis.srem(sockets, socketId)
    const remaining = await this.redis.scard(sockets)
    if (remaining === 0) {
      await this.redis.srem(CacheKeys.presence.store(storeId), userId)
      this.realtime.broadcastToStore(storeId, RealtimeEvents.USER_OFFLINE, { userId })
    }
  }

  // The client heartbeats every 30s while the socket is open — visible or not — so a
  // backgrounded tab stays "online". Activity (typing, navigation) is reported separately.
  async heartbeat(storeId: string, userId: string, socketId: string, active = false): Promise<void> {
    const sockets = CacheKeys.presence.sockets(storeId, userId)
    await this.redis.multi()
      .sadd(sockets, socketId)
      .expire(sockets, PresenceService.SOCKET_TTL_SECONDS)
      .exec()
    if (active) await this.redis.set(CacheKeys.presence.lastActivity(storeId, userId), Date.now())
  }

  async getStorePresence(storeId: string): Promise<Array<{ userId: string; status: PresenceStatus }>> {
    const members = await this.redis.smembers(CacheKeys.presence.store(storeId))
    if (members.length === 0) return []

    const pipeline = this.redis.pipeline()
    for (const id of members) {
      pipeline.exists(CacheKeys.presence.sockets(storeId, id))
      pipeline.get(CacheKeys.presence.lastActivity(storeId, id))
    }
    const results = await pipeline.exec()

    const now = Date.now()
    const online: Array<{ userId: string; status: PresenceStatus }> = []
    const stale: string[] = []
    members.forEach((userId, i) => {
      const exists = results?.[i * 2]?.[1] === 1
      const lastActivity = Number(results?.[i * 2 + 1]?.[1] ?? 0)
      if (!exists) { stale.push(userId); return }
      const idleSeconds = (now - lastActivity) / 1000
      online.push({ userId, status: idleSeconds > PresenceService.AWAY_AFTER_SECONDS ? PresenceStatus.AWAY : PresenceStatus.ONLINE })
    })
    if (stale.length) await this.redis.srem(CacheKeys.presence.store(storeId), ...stale)   // Self-heal after a crashed instance
    return online
  }
}

export enum PresenceStatus { ONLINE = 'online', AWAY = 'away', OFFLINE = 'offline' }
```

**Agent status values shown in the team widget:**
```
online   — at least one open socket, activity in the last 5 min
away     — at least one open socket, idle > 5 min
offline  — no open socket (or socket set expired: dead connection self-expires in 60s)
```

---

## 6. In-app notifications

### 6.1 Constants

```typescript
// libs/core/notifications/notification-constants.ts
export const NotificationTypes = {
  CONVERSATION_ASSIGNED: 'conversation.assigned',
  CONVERSATION_MENTIONED: 'conversation.mentioned',
  CONVERSATION_UNASSIGNED_QUEUE: 'conversation.unassigned_queue',
  CONVERSATION_SNOOZE_EXPIRED: 'conversation.snooze_expired',
  CONVERSATION_REOPENED: 'conversation.reopened',
  CONVERSATION_SLA_BREACH: 'conversation.sla_breach',
  CONVERSATION_ESCALATION_SUGGESTED: 'conversation.escalation_suggested',
  CONVERSATION_AI_HANDOFF: 'conversation.ai_handoff',

  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_FAILED: 'message.failed',

  ORDER_CREATED: 'order.created',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  ORDER_PAYMENT_FAILED: 'order.payment_failed',
  INVENTORY_LOW: 'inventory.low',

  MEMBER_JOINED: 'member.joined',
  INVITATION_ACCEPTED: 'invitation.accepted',

  CHANNEL_DISCONNECTED: 'channel.disconnected',
  WEBHOOK_AUTO_DISABLED: 'webhook.auto_disabled',
  PLUGIN_ERROR: 'plugin.error',
  EXPORT_READY: 'export.ready',
  QUOTA_WARNING: 'quota.warning',
  AI_CREDITS_LOW: 'ai_credits.low',
  DSR_DEADLINE_APPROACHING: 'dsr.deadline_approaching',
  DSR_MANUAL_REVIEW: 'dsr.manual_review',
  REFERRAL_REWARD_EARNED: 'referral.reward_earned',
  IMPERSONATION_STARTED: 'impersonation.started',
  IMPERSONATION_ENDED: 'impersonation.ended',
} as const

export type NotificationType = typeof NotificationTypes[keyof typeof NotificationTypes]

export const NotificationSeverity = {
  INFO: 'info',
  SUCCESS: 'success',
  WARNING: 'warning',
  ERROR: 'error',
} as const

export type NotificationSeverityType = typeof NotificationSeverity[keyof typeof NotificationSeverity]

// The i18n key for a notification is derived from its type — one rule, no table to maintain:
//   'conversation.assigned' → 'notifications.conversation.assigned.title' / '.body'
export const notificationMessageKey = (type: NotificationType): string => `notifications.${type}`

interface NotificationDefault {
  severity: NotificationSeverityType
  channels: readonly NotificationChannel[]
}

const { IN_APP, PUSH, EMAIL, SOUND } = NotificationChannel   // enum from TDD_02 §5

// Default delivery matrix per type — complete, one entry per NotificationType.
// TDD_09 §9 renders exactly this matrix; the two must never disagree.
export const NotificationDefaults: Record<NotificationType, NotificationDefault> = {
  [NotificationTypes.CONVERSATION_ASSIGNED]:            { severity: NotificationSeverity.INFO,    channels: [IN_APP, PUSH, SOUND] },
  [NotificationTypes.CONVERSATION_MENTIONED]:           { severity: NotificationSeverity.INFO,    channels: [IN_APP, PUSH, EMAIL, SOUND] },
  [NotificationTypes.CONVERSATION_UNASSIGNED_QUEUE]:    { severity: NotificationSeverity.INFO,    channels: [IN_APP] },
  [NotificationTypes.CONVERSATION_SNOOZE_EXPIRED]:      { severity: NotificationSeverity.INFO,    channels: [IN_APP, PUSH, SOUND] },
  [NotificationTypes.CONVERSATION_REOPENED]:            { severity: NotificationSeverity.INFO,    channels: [IN_APP, PUSH] },
  [NotificationTypes.CONVERSATION_SLA_BREACH]:          { severity: NotificationSeverity.WARNING, channels: [IN_APP, PUSH, EMAIL, SOUND] },
  [NotificationTypes.CONVERSATION_ESCALATION_SUGGESTED]:{ severity: NotificationSeverity.WARNING, channels: [IN_APP, PUSH] },
  [NotificationTypes.CONVERSATION_AI_HANDOFF]:          { severity: NotificationSeverity.INFO,    channels: [IN_APP, PUSH, SOUND] },
  [NotificationTypes.MESSAGE_RECEIVED]:                 { severity: NotificationSeverity.INFO,    channels: [IN_APP, SOUND] },
  [NotificationTypes.MESSAGE_FAILED]:                   { severity: NotificationSeverity.ERROR,   channels: [IN_APP, PUSH] },
  [NotificationTypes.ORDER_CREATED]:                    { severity: NotificationSeverity.INFO,    channels: [IN_APP] },
  [NotificationTypes.ORDER_STATUS_CHANGED]:             { severity: NotificationSeverity.INFO,    channels: [IN_APP] },
  [NotificationTypes.ORDER_PAYMENT_FAILED]:             { severity: NotificationSeverity.WARNING, channels: [IN_APP, PUSH, EMAIL] },
  [NotificationTypes.INVENTORY_LOW]:                    { severity: NotificationSeverity.WARNING, channels: [IN_APP] },
  [NotificationTypes.MEMBER_JOINED]:                    { severity: NotificationSeverity.INFO,    channels: [IN_APP] },
  [NotificationTypes.INVITATION_ACCEPTED]:              { severity: NotificationSeverity.INFO,    channels: [IN_APP] },
  [NotificationTypes.CHANNEL_DISCONNECTED]:             { severity: NotificationSeverity.ERROR,   channels: [IN_APP, PUSH, EMAIL] },
  [NotificationTypes.WEBHOOK_AUTO_DISABLED]:            { severity: NotificationSeverity.ERROR,   channels: [IN_APP, EMAIL] },
  [NotificationTypes.PLUGIN_ERROR]:                     { severity: NotificationSeverity.ERROR,   channels: [IN_APP] },
  [NotificationTypes.EXPORT_READY]:                     { severity: NotificationSeverity.SUCCESS, channels: [IN_APP] },
  [NotificationTypes.QUOTA_WARNING]:                    { severity: NotificationSeverity.WARNING, channels: [IN_APP, EMAIL] },
  [NotificationTypes.AI_CREDITS_LOW]:                   { severity: NotificationSeverity.WARNING, channels: [IN_APP, EMAIL] },
  [NotificationTypes.DSR_DEADLINE_APPROACHING]:         { severity: NotificationSeverity.WARNING, channels: [IN_APP, EMAIL] },
  [NotificationTypes.DSR_MANUAL_REVIEW]:                { severity: NotificationSeverity.INFO,    channels: [IN_APP, EMAIL] },
  [NotificationTypes.REFERRAL_REWARD_EARNED]:           { severity: NotificationSeverity.SUCCESS, channels: [IN_APP, EMAIL] },
  [NotificationTypes.IMPERSONATION_STARTED]:            { severity: NotificationSeverity.WARNING, channels: [IN_APP, EMAIL] },
  [NotificationTypes.IMPERSONATION_ENDED]:              { severity: NotificationSeverity.INFO,    channels: [IN_APP] },
}

// Realtime payload delivered to the browser (TDD_02 §2 RealtimeEventMap[NOTIFICATION])
export interface NotificationRealtimePayload {
  id: string
  type: NotificationType
  severity: NotificationSeverityType
  messageKey: string
  params: Record<string, string | number>
  actionPath: string | null
  sound: boolean
  createdAt: string
}
```

### 6.2 Service

```typescript
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly preferences: NotificationPreferencesService,
    @InjectQueue(QueueNames.NOTIFICATIONS) private readonly queue: Queue<NotificationJob>,
  ) {}

  async send(params: {
    userId: string
    storeId: string
    type: NotificationType
    params?: Record<string, string | number>      // Interpolated into the i18n message at display time
    resourceType?: string
    resourceId?: string
    actionPath?: string                             // Built with AppPaths (TDD_09 §12), never a literal
  }): Promise<void> {
    const defaults = NotificationDefaults[params.type]
    const prefs = await this.preferences.resolve(params.userId, params.storeId, params.type)

    // Quiet hours suppress push and sound, but the notification is still persisted
    if (await this.preferences.isInQuietHours(params.userId, params.storeId)) {
      prefs.push = false
      prefs.sound = false
    }

    // 1. Persist — always, so it appears in the notification center
    const notification = await this.prisma.client.notification.create({
      data: {
        userId: params.userId,
        storeId: params.storeId,
        type: params.type,
        severity: defaults.severity,
        messageKey: notificationMessageKey(params.type),
        params: params.params ?? {},
        resourceType: params.resourceType,
        resourceId: params.resourceId,
        actionPath: params.actionPath,
      }
    })

    // 2. Realtime delivery
    if (prefs.inApp) {
      this.realtime.notifyUser(params.userId, RealtimeEvents.NOTIFICATION, {
        id: notification.id,
        type: params.type,
        severity: defaults.severity,
        messageKey: notification.messageKey,
        params: params.params ?? {},
        actionPath: notification.actionPath,
        sound: prefs.sound,
        createdAt: notification.createdAt.toISOString(),
      })
    }

    // 3. Web push (fires whether or not the user is connected)
    if (prefs.push) {
      await this.queue.add(JobNames.SEND_WEB_PUSH, { userId: params.userId, notificationId: notification.id })
    }

    // 4. Email: immediate or batched into the user's digest (UserNotificationSettings.digestFrequency)
    if (prefs.email) {
      await this.queue.add(JobNames.QUEUE_EMAIL_DIGEST, { userId: params.userId, notificationId: notification.id })
    }
  }

  async sendToStore(params: {
    storeId: string
    type: NotificationType
    params?: Record<string, string | number>
    resourceType?: string
    resourceId?: string
    actionPath?: string
    excludeUserIds?: string[]
    requiredPermission?: Permission
  }): Promise<void> {
    const members = await this.prisma.client.membership.findMany({
      where: {
        storeId: params.storeId,
        status: MembershipStatus.ACTIVE,
        userId: { notIn: params.excludeUserIds ?? [] },
        ...(params.requiredPermission && {
          role: { permissions: { some: { name: params.requiredPermission } } }
        })
      },
      select: { userId: true }
    })

    await Promise.all(members.map(m => this.send({ ...params, userId: m.userId })))
  }

  // Organization-level notice (billing, impersonation, DSR): every active member of any
  // store in the org holding the permission, deduplicated by user, persisted against
  // the member's first store so the notification center has a store to show it under.
  async sendToOrganization(params: {
    organizationId: string
    type: NotificationType
    params?: Record<string, string | number>
    actionPath?: string
    requiredPermission: Permission
  }): Promise<void> {
    const members = await this.prisma.client.membership.findMany({
      where: {
        organizationId: params.organizationId,
        status: MembershipStatus.ACTIVE,
        role: { permissions: { some: { name: params.requiredPermission } } }
      },
      select: { userId: true, storeId: true },
      orderBy: { createdAt: 'asc' },
      distinct: ['userId'],
    })

    await Promise.all(members.map(m => this.send({ ...params, userId: m.userId, storeId: m.storeId })))
  }

  async markAsRead(userId: string, notificationIds: string[]): Promise<void> {
    await this.prisma.client.notification.updateMany({
      where: { id: { in: notificationIds }, userId },
      data: { readAt: new Date() }
    })
  }

  async getUnreadCount(userId: string, storeId: string): Promise<number> {
    return this.prisma.client.notification.count({
      where: { userId, storeId, readAt: null }
    })
  }
}
```

The client renders `t(`${messageKey}.title`, params)` / `t(`${messageKey}.body`, params)`.
Email digests render the same keys server-side (`libs/core/i18n`).

### 6.3 Quiet hours

Stored in `UserNotificationSettings` (`TDD_01` §4).

```typescript
async isInQuietHours(userId: string, storeId: string): Promise<boolean> {
  const settings = await this.getUserSettings(userId)
  if (!settings.quietHoursEnabled) return false

  if (settings.quietHoursFollowStore) {
    return !(await this.businessHours.isOpenNow(storeId))    // Quiet = outside business hours
  }

  const hour = toZonedTime(new Date(), settings.timezone).getHours()   // date-fns-tz v3

  // Handles ranges crossing midnight, e.g. 22:00 to 07:00
  return settings.quietHoursStart > settings.quietHoursEnd
    ? hour >= settings.quietHoursStart || hour < settings.quietHoursEnd
    : hour >= settings.quietHoursStart && hour < settings.quietHoursEnd
}
```

### 6.4 Email digest

`QUEUE_EMAIL_DIGEST` only records that a notification is pending email delivery. Two
schedulers drain it (`Schedules.SEND_EMAIL_DIGEST_HOURLY` / `_DAILY`, `TDD_07` §4): for
every user whose `digestFrequency` matches, the pending notifications since
`lastDigestSentAt` are rendered into one `EmailTemplates.NOTIFICATION_DIGEST` email.
`digestFrequency = IMMEDIATE` sends one email per notification from the queue processor
directly; `OFF` drops the job.

---

## 7. Web push

### 7.1 Service

Web push only — native push providers arrive with the React Native app (Phase 2,
`TDD_09` §16.6), not before.

```typescript
// libs/core/notifications/push.service.ts
import webpush, { WebPushError } from 'web-push'

@Injectable()
export class PushService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(PushService.name) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
      webpush.setVapidDetails(`mailto:${env.EMAIL_FROM}`, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY)
    } else {
      this.logger.warn('web push disabled: VAPID keys not configured')
    }
  }

  async sendToUser(userId: string, payload: PushPayload): Promise<void> {
    if (!env.VAPID_PUBLIC_KEY) return

    const subscriptions = await this.prisma.client.pushSubscription.findMany({ where: { userId } })

    await Promise.allSettled(
      subscriptions.map(async sub => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload)
          )
          await this.prisma.client.pushSubscription.update({ where: { id: sub.id }, data: { lastUsed: new Date() } })
        } catch (error: unknown) {
          // 404 / 410 mean the subscription is dead — clean it up
          if (error instanceof WebPushError && (error.statusCode === 410 || error.statusCode === 404)) {
            await this.prisma.client.pushSubscription.delete({ where: { id: sub.id } })
          } else {
            this.logger.warn({ userId, err: error instanceof Error ? error.message : 'unknown' }, 'push delivery failed')
          }
        }
      })
    )
  }
}

export interface PushPayload {
  notificationId: string
  title: string          // Rendered server-side in the user's locale (libs/core/i18n) — the SW has no i18n
  body: string
  tag: string
  severity: NotificationSeverityType
  actionPath: string | null
}
```

### 7.2 Service Worker (push handlers)

The service worker is built by Serwist from `apps/web/sw.ts` (`TDD_09` §16.3); push
handling lives in the same file so there is exactly one worker.

```typescript
// apps/web/sw.ts (push section)
import type { PushPayload } from '@platform/core-domain/notifications'

self.addEventListener('push', (event: PushEvent) => {
  const data = event.data?.json() as PushPayload | undefined
  if (!data) return

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/notification-192.png',
      badge: '/icons/badge-72.png',
      tag: data.tag,                          // Same tag replaces previous notification
      renotify: false,
      requireInteraction: data.severity === 'error',
      data: { actionPath: data.actionPath, notificationId: data.notificationId },
    })
  )
})

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close()
  const { actionPath } = event.notification.data as { actionPath: string | null }
  const target = actionPath ?? '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Reuse an existing tab when possible
      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          void client.navigate(target)
          return client.focus()
        }
      }
      return self.clients.openWindow(target)
    })
  )
})
```

### 7.3 Subscription registration

```typescript
export async function subscribeToPush(): Promise<PushSubscribeResult> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported'
  if (!webEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY) return 'unsupported'

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'

  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(webEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
  })

  const json = subscription.toJSON()
  await apiClient.notifications.registerPushSubscription({
    endpoint: subscription.endpoint,
    p256dh: json.keys?.p256dh ?? '',
    auth: json.keys?.auth ?? '',
    userAgent: navigator.userAgent
  })
  return 'subscribed'
}

type PushSubscribeResult = 'subscribed' | 'denied' | 'unsupported'
```

**Prompt timing:** never on first load. Ask after the agent resolves their first
conversation, framed with `t('notifications.push.prompt')`.

---

## 8. Notification center UI

```
┌──────────────────────────────────────────────┐
│ Notifications              [Mark all read]   │
├──────────────────────────────────────────────┤
│ [All] [Unread] [Mentions]                    │
├──────────────────────────────────────────────┤
│ ● Conversation assigned to you               │
│   Juan Pérez · WhatsApp                      │
│   2 minutes ago                              │
├──────────────────────────────────────────────┤
│ ● María mentioned you in a note              │
│   "@you can you check this order?"           │
│   15 minutes ago                             │
├──────────────────────────────────────────────┤
│   Export ready                               │
│   customers-2026-09-03.csv                   │
│   1 hour ago                          [↓]    │
├──────────────────────────────────────────────┤
│ [Notification settings]                      │
└──────────────────────────────────────────────┘
```

Copy above is illustrative; every string is `t(messageKey + '.title', params)`.
Unread badge on the bell icon shows the count, capped at `99+`.
Clicking a notification marks it read and navigates to `actionPath`.

---

## 9. Notification preferences

This screen is generated from `NotificationDefaults` (§6.1): rows are the types, columns
are the channels, default checks are the matrix. Missing `NotificationPreference` rows
fall back to the defaults.

```
Settings → My Account → Notifications

                                In-app  Push  Email  Sound
CONVERSATIONS
  Assigned to me                  [x]   [x]   [ ]    [x]
  Mentioned in a note             [x]   [x]   [x]    [x]
  New unassigned conversation     [x]   [ ]   [ ]    [ ]
  Snooze expired                  [x]   [x]   [ ]    [x]
  Reopened by the customer        [x]   [x]   [ ]    [ ]
  SLA breach warning              [x]   [x]   [x]    [x]
  Escalation suggested            [x]   [x]   [ ]    [ ]
  AI handed off to the team       [x]   [x]   [ ]    [x]

MESSAGES
  New message in my conversation  [x]   [ ]   [ ]    [x]
  Message failed to send          [x]   [x]   [ ]    [ ]

ORDERS
  Order created                   [x]   [ ]   [ ]    [ ]
  Order status changed            [x]   [ ]   [ ]    [ ]
  Payment failed                  [x]   [x]   [x]    [ ]
  Low stock                       [x]   [ ]   [ ]    [ ]

SYSTEM
  Channel disconnected            [x]   [x]   [x]    [ ]
  Webhook disabled                [x]   [ ]   [x]    [ ]
  Export ready                    [x]   [ ]   [ ]    [ ]
  Quota warning                   [x]   [ ]   [x]    [ ]
  AI credits low                  [x]   [ ]   [x]    [ ]

QUIET HOURS
  [x] Pause push and sound during quiet hours
      From [22:00] to [07:00]   Timezone: America/El_Salvador
  [ ] Follow store business hours instead

EMAIL DIGEST
  ( ) Immediate   (o) Hourly   ( ) Daily   ( ) Off

CROSS-STORE
  [x] Notify me about conversations in my other stores
  [ ] Only where I am a supervisor
```

Per-type toggles are stored per `(userId, storeId, type)` in `NotificationPreference`;
quiet hours, digest and cross-store are user-level in `UserNotificationSettings`.
Notification types that are always org-level (impersonation, DSR, quota) are not
user-configurable and do not appear in the matrix.

---

## 10. Performance considerations

- **Broadcast scope:** never broadcast to all connected clients. Always target a
  store, conversation, organization or user room.
- **Payload size:** realtime payloads carry identifiers and minimal fields.
  The client refetches full objects through TanStack Query.
- **Invalidation batching:** invalidations are debounced by 150ms (§3) so a burst of
  incoming messages triggers a single refetch.
- **Connection limit:** one socket per browser tab. Use a shared worker or
  BroadcastChannel if multiple tabs become common.
- **Presence cost:** Redis set operations only, pipelined; no database writes on
  connect/disconnect.
