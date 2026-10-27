# TDD 02 — Conventions & Type Safety

> Part of the Omnichannel Commerce Platform TDD v1.1
> **MVP v1.2:** this file describes the full product. Before implementing from it, read `MVP_TRIM_CHECKLIST.md`;
> where the two disagree, the checklist wins.
> **Read this document before writing any code.**

---

## 0. The core rule

**No magic strings. Anywhere. Ever.**

Every event name, cache key, permission, error code, route, status, metric,
notification type, job name, cron schedule, query key and configuration value lives
in a typed constant in `libs/core/*` (or `libs/api-client/*` for frontend-only keys).

Rationale: a typo in `'conversation.updated'` fails silently at runtime.
A typo in `Events.CONVERSATON_UPDATED` fails at compile time.

```typescript
// WRONG
this.events.emit('conversation.updated', payload)
await this.cache.get(`store:${storeId}:setings`)
if (user.role === 'admin') { }
await prisma.media.update({ data: { status: 'clean' } })

// CORRECT
this.events.emit(Events.CONVERSATION_UPDATED, payload)
await this.cache.get(CacheKeys.store.settings(storeId))
if (hasPermission(Permissions.SETTINGS_EDIT)) { }
await prisma.media.update({ data: { status: MediaStatus.CLEAN } })
```

**Every string column in Prisma that holds a state, a type or a kind has a matching
enum in §5.** If you find yourself writing `status: 'active'`, the enum is missing —
add it here first.

---

## 1. Domain event names

`libs/core/events/event-names.ts`

```typescript
export const Events = {
  // Organizations & stores
  ORGANIZATION_CREATED: 'organization.created',
  ORGANIZATION_UPDATED: 'organization.updated',
  ORGANIZATION_ACCESS_LEVEL_CHANGED: 'organization.access_level_changed',
  STORE_CREATED: 'store.created',
  STORE_UPDATED: 'store.updated',
  STORE_SETTINGS_UPDATED: 'store.settings_updated',
  STORE_DELETED: 'store.deleted',

  // Conversations
  CONVERSATION_CREATED: 'conversation.created',
  CONVERSATION_UPDATED: 'conversation.updated',
  CONVERSATION_ASSIGNED: 'conversation.assigned',
  CONVERSATION_UNASSIGNED: 'conversation.unassigned',
  CONVERSATION_STATUS_CHANGED: 'conversation.status_changed',
  CONVERSATION_RESOLVED: 'conversation.resolved',
  CONVERSATION_REOPENED: 'conversation.reopened',
  CONVERSATION_SNOOZED: 'conversation.snoozed',
  CONVERSATION_SNOOZE_EXPIRED: 'conversation.snooze_expired',
  CONVERSATION_ARCHIVED: 'conversation.archived',
  CONVERSATION_TAGGED: 'conversation.tagged',
  CONVERSATION_READ: 'conversation.read',
  CONVERSATION_AI_HANDOFF: 'conversation.ai_handoff',

  // Messages
  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_SENT: 'message.sent',
  MESSAGE_DELIVERED: 'message.delivered',
  MESSAGE_READ: 'message.read',
  MESSAGE_FAILED: 'message.failed',
  MESSAGE_MENTION: 'message.mention',

  // Customers
  CUSTOMER_CREATED: 'customer.created',
  CUSTOMER_UPDATED: 'customer.updated',
  CUSTOMER_MERGED: 'customer.merged',
  CUSTOMER_UNMERGED: 'customer.unmerged',
  CUSTOMER_IDENTITY_LINKED: 'customer.identity_linked',
  CUSTOMER_ERASED: 'customer.erased',

  // Orders
  ORDER_CREATED: 'order.created',
  ORDER_UPDATED: 'order.updated',
  ORDER_STATUS_CHANGED: 'order.status_changed',
  ORDER_SHIPPED: 'order.shipped',
  ORDER_DELIVERED: 'order.delivered',
  ORDER_CANCELLED: 'order.cancelled',
  ORDER_PAYMENT_STATUS_CHANGED: 'order.payment_status_changed',

  // Products & inventory
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  PRODUCT_DELETED: 'product.deleted',
  INVENTORY_MOVED: 'inventory.moved',
  INVENTORY_LOW: 'inventory.low',

  // Tags & snippets
  TAG_CREATED: 'tag.created',
  TAG_UPDATED: 'tag.updated',
  TAG_DELETED: 'tag.deleted',
  SNIPPET_CREATED: 'snippet.created',
  SNIPPET_UPDATED: 'snippet.updated',
  SNIPPET_DELETED: 'snippet.deleted',

  // Users & auth
  USER_SIGNED_UP: 'user.signed_up',
  USER_LOGGED_IN: 'user.logged_in',
  USER_LOGGED_OUT: 'user.logged_out',
  USER_EMAIL_VERIFIED: 'user.email_verified',
  USER_PASSWORD_CHANGED: 'user.password_changed',
  USER_PREFERENCES_UPDATED: 'user.preferences_updated',

  // Team
  MEMBER_INVITED: 'member.invited',
  MEMBER_JOINED: 'member.joined',
  MEMBER_REMOVED: 'member.removed',
  MEMBER_ROLE_CHANGED: 'member.role_changed',
  ROLE_UPDATED: 'role.updated',

  // Channels & plugins
  CHANNEL_CONNECTED: 'channel.connected',
  CHANNEL_DISCONNECTED: 'channel.disconnected',
  CHANNEL_HEALTH_RESTORED: 'channel.health_restored',
  PLUGIN_INSTALLED: 'plugin.installed',
  PLUGIN_ENABLED: 'plugin.enabled',
  PLUGIN_DISABLED: 'plugin.disabled',
  PLUGIN_REVOKED: 'plugin.revoked',
  PLUGIN_ERROR: 'plugin.error',

  // Webhooks (tenant-configured outbound webhooks)
  WEBHOOK_CREATED: 'webhook.created',
  WEBHOOK_UPDATED: 'webhook.updated',
  WEBHOOK_DELETED: 'webhook.deleted',
  WEBHOOK_TRIGGERED: 'webhook.triggered',
  WEBHOOK_FAILED: 'webhook.failed',
  WEBHOOK_AUTO_DISABLED: 'webhook.auto_disabled',

  // API keys
  API_KEY_CREATED: 'api_key.created',
  API_KEY_REVOKED: 'api_key.revoked',

  // Billing
  SUBSCRIPTION_CREATED: 'subscription.created',
  SUBSCRIPTION_UPDATED: 'subscription.updated',
  SUBSCRIPTION_CANCELED: 'subscription.canceled',
  INVOICE_PAID: 'invoice.paid',
  INVOICE_PAYMENT_FAILED: 'invoice.payment_failed',
  TRIAL_ENDING: 'trial.ending',
  QUOTA_THRESHOLD_REACHED: 'quota.threshold_reached',
  ORGANIZATION_OVERRIDE_CHANGED: 'organization_override.changed',   // TDD_15 §3.1
  AI_CREDITS_CHANGED: 'ai_credits.changed',                          // TDD_12 §9.5

  // AI
  AI_SETTINGS_UPDATED: 'ai_settings.updated',

  // Media
  MEDIA_UPLOADED: 'media.uploaded',
  MEDIA_PROCESSED: 'media.processed',
  MEDIA_INFECTED: 'media.infected',

  // Exports & compliance
  EXPORT_REQUESTED: 'export.requested',
  EXPORT_READY: 'export.ready',
  DSR_CREATED: 'dsr.created',
  DSR_COMPLETED: 'dsr.completed',

  // Platform / staff (TDD_15)
  PLATFORM_SETTING_CHANGED: 'platform_setting.changed',
  FEATURE_FLAG_CHANGED: 'feature_flag.changed',
  IMPERSONATION_STARTED: 'impersonation.started',
  IMPERSONATION_ENDED: 'impersonation.ended',

  // System
  SYSTEM_MAINTENANCE_START: 'system.maintenance_start',
  SYSTEM_MAINTENANCE_END: 'system.maintenance_end',
} as const

export type EventName = typeof Events[keyof typeof Events]
```

**Event payload types** live in `libs/core/events/event-payloads.ts`, one interface per
event, named `<Event>Payload`. Payloads carry **identifiers and plain values only** —
never Prisma entities or `Decimal` instances, so `libs/core/events` does not depend on
the Prisma client and payloads serialize cleanly into BullMQ jobs and webhooks.

```typescript
export interface MessageReceivedPayload {
  storeId: string
  conversationId: string
  messageId: string
  customerId: string
  channelType: ChannelType
  authorType: AuthorType
  contentPreview: string | null     // First 200 chars, for listeners that only need a glance
  receivedAt: string                // ISO 8601
}

export interface ConversationCreatedPayload {
  storeId: string
  conversationId: string
  customerId: string
  channelType: ChannelType
  firstMessageId: string            // Emitted after the first message is persisted, never before
  firstMessageContent: string | null
}

export interface ConversationStatusChangedPayload {
  storeId: string
  conversationId: string
  previousStatus: ConversationStatus
  status: ConversationStatus
  assignedTo: string | null
  changedBy: ActorRef               // { type: 'user' | 'ai' | 'system' | 'staff', id: string | null }
}

export interface ConversationAssignedPayload {
  storeId: string
  conversationId: string
  assignedTo: string | null
  previousAssignee: string | null
  assignedBy: ActorRef
}

export interface OrderCreatedPayload {
  storeId: string
  orderId: string
  orderNumber: string
  customerId: string
  conversationId: string | null
  totalCents: number
  currency: string
}

export interface InvoicePaidPayload {
  organizationId: string
  tier: PlanTier
  invoiceId: string                 // Our Invoice.id
  stripeInvoiceId: string
  amountPaidCents: number
  billingReason: StripeBillingReason
  periodStart: string
  periodEnd: string
}

export interface PlanLimitsInvalidatedPayload {   // ORGANIZATION_OVERRIDE_CHANGED
  organizationId: string
}

export interface ActorRef {
  type: 'user' | 'ai' | 'system' | 'staff'
  id: string | null
}
```

A listener signature is always `(payload: <Event>Payload) => Promise<void>`. If a listener
needs the full entity it loads it by id — this keeps payloads small and makes replay safe.

---

## 2. Realtime (WebSocket) events

`libs/core/realtime/realtime-events.ts`

Separate from domain events: these are what the browser subscribes to.

```typescript
export const RealtimeEvents = {
  // Server → client
  CONVERSATION_CREATED: 'conversation.created',
  CONVERSATION_UPDATED: 'conversation.updated',
  CONVERSATION_ASSIGNED: 'conversation.assigned',
  CONVERSATION_STATUS_CHANGED: 'conversation.status_changed',
  CONVERSATION_READ: 'conversation.read',

  MESSAGE_RECEIVED: 'message.received',
  MESSAGE_SENT: 'message.sent',
  MESSAGE_DELIVERED: 'message.delivered',
  MESSAGE_READ: 'message.read',
  MESSAGE_FAILED: 'message.failed',

  TYPING_START: 'typing.start',
  TYPING_STOP: 'typing.stop',
  CUSTOMER_TYPING: 'customer.typing',

  USER_ONLINE: 'user.online',
  USER_OFFLINE: 'user.offline',

  ORDER_CREATED: 'order.created',
  ORDER_UPDATED: 'order.updated',

  NOTIFICATION: 'notification',
  IMPERSONATION_STATUS: 'impersonation.status',   // TDD_15 §4 customer-facing banner

  // Client → server
  HEARTBEAT: 'heartbeat',
  JOIN_CONVERSATION: 'conversation.join',
  LEAVE_CONVERSATION: 'conversation.leave',

  // Server → client, connection-level
  AUTH_ERROR: 'auth.error',
} as const

export type RealtimeEvent = typeof RealtimeEvents[keyof typeof RealtimeEvents]

// Typed payload map — every event in RealtimeEvents has an entry here. A missing
// entry is a compile error in RealtimeService (TDD_06 §1.5), which is the point.
export interface RealtimeEventMap {
  [RealtimeEvents.CONVERSATION_CREATED]: { conversationId: string; customerId: string; channelType: ChannelType }
  [RealtimeEvents.CONVERSATION_UPDATED]: { conversationId: string; status: ConversationStatus; assignedTo: string | null; lastMessageAt: string | null }
  [RealtimeEvents.CONVERSATION_ASSIGNED]: { conversationId: string; assignedTo: string | null; assignedBy: string | null }
  [RealtimeEvents.CONVERSATION_STATUS_CHANGED]: { conversationId: string; status: ConversationStatus; previousStatus: ConversationStatus }
  [RealtimeEvents.CONVERSATION_READ]: { conversationId: string; userId: string }

  [RealtimeEvents.MESSAGE_RECEIVED]: { conversationId: string; messageId: string; authorType: AuthorType; contentPreview: string | null; createdAt: string }
  [RealtimeEvents.MESSAGE_SENT]: { conversationId: string; messageId: string; clientMessageId: string | null }
  [RealtimeEvents.MESSAGE_DELIVERED]: { conversationId: string; messageId: string }
  [RealtimeEvents.MESSAGE_READ]: { conversationId: string; messageId: string }
  [RealtimeEvents.MESSAGE_FAILED]: { conversationId: string; messageId: string; errorCode: ErrorCode }

  [RealtimeEvents.TYPING_START]: { conversationId: string; userId: string; userName: string }
  [RealtimeEvents.TYPING_STOP]: { conversationId: string; userId: string }
  [RealtimeEvents.CUSTOMER_TYPING]: { conversationId: string }

  [RealtimeEvents.USER_ONLINE]: { userId: string }
  [RealtimeEvents.USER_OFFLINE]: { userId: string }

  [RealtimeEvents.ORDER_CREATED]: { orderId: string; conversationId: string | null; customerId: string }
  [RealtimeEvents.ORDER_UPDATED]: { orderId: string; status: OrderStatus }

  [RealtimeEvents.NOTIFICATION]: NotificationRealtimePayload   // TDD_06 §6.2
  [RealtimeEvents.IMPERSONATION_STATUS]: { active: boolean; sessionId: string | null; reason: string | null; expiresAt: string | null }

  [RealtimeEvents.HEARTBEAT]: Record<string, never>
  [RealtimeEvents.JOIN_CONVERSATION]: { conversationId: string }
  [RealtimeEvents.LEAVE_CONVERSATION]: { conversationId: string }

  [RealtimeEvents.AUTH_ERROR]: { code: ErrorCode }
}

// Compile-time guard in both directions: it resolves to `never`, and the assignment below stops
// compiling, when RealtimeEvents gains a key RealtimeEventMap lacks or the other way around.
// (v1.2.2: the earlier `Record<RealtimeEvent, unknown> extends RealtimeEventMap` always resolved to never.)
type AssertRealtimeMapComplete = [RealtimeEvent] extends [keyof RealtimeEventMap]
  ? [keyof RealtimeEventMap] extends [RealtimeEvent] ? true : never
  : never
export const realtimeEventMapIsComplete: AssertRealtimeMapComplete = true
```

Room names live next to them in `libs/core/realtime/room-names.ts` (`TDD_06_Realtime.md` §1.4).

---

## 3. Cache keys

`libs/core/cache/cache-keys.ts`

Namespaced by entity. Always functions, never template literals at call sites.
**Every key that holds tenant data carries the `storeId` (or `organizationId`) in the key.**

```typescript
export const CacheKeys = {
  store: {
    settings:   (storeId: string) => `store:${storeId}:settings`,
    agents:     (storeId: string) => `store:${storeId}:agents`,
    products:   (storeId: string) => `store:${storeId}:products`,
    tags:       (storeId: string) => `store:${storeId}:tags`,
    snippets:   (storeId: string) => `store:${storeId}:snippets`,
    aiSettings: (storeId: string) => `store:${storeId}:ai_settings`,
    routing:    (storeId: string) => `store:${storeId}:routing`,
    organizationId: (storeId: string) => `store:${storeId}:org_id`,
  },

  conversation: {
    byId:   (storeId: string, convId: string) => `store:${storeId}:conv:${convId}`,
    counts: (storeId: string) => `store:${storeId}:conv:counts`,
  },

  customer: {
    profile:    (storeId: string, customerId: string) => `store:${storeId}:customer:${customerId}`,
    byIdentity: (storeId: string, channelType: string, identity: string) =>
      `store:${storeId}:customer:identity:${channelType}:${identity}`,
    orders:     (storeId: string, customerId: string) => `store:${storeId}:customer:${customerId}:orders`,
  },

  agent: {
    convCount:   (storeId: string, agentId: string) => `store:${storeId}:agent:${agentId}:conv:count`,
    permissions: (userId: string, storeId: string) => `perms:${userId}:${storeId}`,
  },

  presence: {
    store:   (storeId: string) => `presence:store:${storeId}`,          // SET of userIds
    sockets: (storeId: string, userId: string) => `presence:store:${storeId}:user:${userId}:sockets`, // SET of socket ids
    lastActivity: (storeId: string, userId: string) => `presence:store:${storeId}:user:${userId}:last_activity`,
  },

  product: {
    byId:      (storeId: string, productId: string) => `store:${storeId}:product:${productId}`,
    search:    (storeId: string, queryHash: string) => `store:${storeId}:products:search:${queryHash}`,
    inventory: (storeId: string, productId: string) => `store:${storeId}:product:${productId}:inventory`,
  },

  channel: {
    connection: (pluginId: string, connectionId: string) => `channel:${pluginId}:conn:${connectionId}`, // → storeId + connection row
    capabilities: (pluginId: string) => `channel:${pluginId}:capabilities`,
  },

  plugin: {
    manifest:     (pluginId: string) => `plugin:${pluginId}:manifest`,
    installation: (storeId: string, pluginId: string) => `store:${storeId}:plugin:${pluginId}`,
  },

  billing: {
    usage:               (organizationId: string) => `org:${organizationId}:usage`,
    subscription:        (organizationId: string) => `org:${organizationId}:subscription`,
    effectivePlanLimits: (organizationId: string) => `org:${organizationId}:effective_plan_limits`,
    aiCredits:           (organizationId: string) => `org:${organizationId}:ai_credits`,
    quotaWarned:         (subscriptionId: string, periodStart: string, threshold: number) =>
      `sub:${subscriptionId}:quota_warned:${periodStart}:${threshold}`,
  },

  ai: {
    suggestions: (storeId: string, convId: string, lastMessageId: string) => `store:${storeId}:ai:sugg:${convId}:${lastMessageId}`,
    summary:     (storeId: string, convId: string, lastMessageId: string) => `store:${storeId}:ai:summ:${convId}:${lastMessageId}`,
    sentiment:   (storeId: string, messageId: string) => `store:${storeId}:ai:sent:${messageId}`,
    dailyCount:  (storeId: string, date: string) => `store:${storeId}:ai:count:${date}`,
  },

  platform: {
    setting:     (key: string) => `platform:setting:${key}`,
    featureFlag: (key: string) => `platform:flag:${key}`,
  },

  rateLimit: (subject: string, endpoint: string) => `rl:${subject}:${endpoint}`,
  lock:      (name: string) => `lock:${name}`,

  // Patterns for bulk invalidation — use with delPattern()
  patterns: {
    storeAll:          (storeId: string) => `store:${storeId}:*`,
    conversationAll:   (storeId: string) => `store:${storeId}:conv:*`,
    productSearchAll:  (storeId: string) => `store:${storeId}:products:search:*`,
    aiAll:             (storeId: string) => `store:${storeId}:ai:*`,
  }
} as const
```

Search queries are hashed (`sha1(query.toLowerCase().trim())`) before becoming part of a
key — raw user input never lands in a Redis key.

**TTL constants:**
```typescript
export const CacheTTL = {
  VERY_SHORT: 30,      // Permissions, counts
  SHORT: 60,           // Search results
  MEDIUM: 300,         // Store settings, effective plan limits
  LONG: 3600,          // Plugin manifests, AI results
  VERY_LONG: 86400,    // Rarely-changing reference data
} as const
```

---

## 4. Permissions

`libs/core/auth/permissions.ts`

Format: `resource:action`. Never invent one inline.

```typescript
export const Permissions = {
  // Conversations
  CONVERSATIONS_VIEW: 'conversations:view',
  CONVERSATIONS_VIEW_ALL: 'conversations:view_all',      // vs only assigned to me
  CONVERSATIONS_CREATE: 'conversations:create',
  CONVERSATIONS_ASSIGN: 'conversations:assign',
  CONVERSATIONS_RESOLVE: 'conversations:resolve',
  CONVERSATIONS_SNOOZE: 'conversations:snooze',
  CONVERSATIONS_ARCHIVE: 'conversations:archive',
  CONVERSATIONS_DELETE: 'conversations:delete',
  CONVERSATIONS_EXPORT: 'conversations:export',

  // Messages
  MESSAGES_VIEW: 'messages:view',
  MESSAGES_SEND: 'messages:send',
  MESSAGES_SEND_TEMPLATE: 'messages:send_template',
  MESSAGES_INTERNAL_NOTE: 'messages:internal_note',
  MESSAGES_DELETE: 'messages:delete',

  // Customers
  CUSTOMERS_VIEW: 'customers:view',
  CUSTOMERS_CREATE: 'customers:create',
  CUSTOMERS_EDIT: 'customers:edit',
  CUSTOMERS_DELETE: 'customers:delete',
  CUSTOMERS_MERGE: 'customers:merge',
  CUSTOMERS_EXPORT: 'customers:export',

  // Orders
  ORDERS_VIEW: 'orders:view',
  ORDERS_CREATE: 'orders:create',
  ORDERS_EDIT: 'orders:edit',
  ORDERS_CANCEL: 'orders:cancel',
  ORDERS_CHANGE_STATUS: 'orders:change_status',
  ORDERS_EXPORT: 'orders:export',

  // Products
  PRODUCTS_VIEW: 'products:view',
  PRODUCTS_CREATE: 'products:create',
  PRODUCTS_EDIT: 'products:edit',
  PRODUCTS_DELETE: 'products:delete',
  INVENTORY_ADJUST: 'inventory:adjust',

  // Media
  MEDIA_VIEW: 'media:view',
  MEDIA_UPLOAD: 'media:upload',
  MEDIA_DOWNLOAD_ALL: 'media:download_all',

  // Team
  TEAM_VIEW: 'team:view',
  TEAM_INVITE: 'team:invite',
  TEAM_REMOVE: 'team:remove',
  TEAM_MANAGE_ROLES: 'team:manage_roles',

  // Settings
  SETTINGS_VIEW: 'settings:view',
  SETTINGS_EDIT: 'settings:edit',
  SETTINGS_MANAGE_PLUGINS: 'settings:manage_plugins',
  SETTINGS_MANAGE_WEBHOOKS: 'settings:manage_webhooks',
  SETTINGS_MANAGE_API_KEYS: 'settings:manage_api_keys',
  SETTINGS_MANAGE_AI: 'settings:manage_ai',
  SETTINGS_MANAGE_RETENTION: 'settings:manage_retention',
  SETTINGS_MANAGE_ROUTING: 'settings:manage_routing',

  // Analytics
  ANALYTICS_VIEW: 'analytics:view',
  ANALYTICS_EXPORT: 'analytics:export',
  ANALYTICS_MANAGE_REPORTS: 'analytics:manage_reports',

  // Organization
  ORG_VIEW_BILLING: 'org:view_billing',
  ORG_MANAGE_BILLING: 'org:manage_billing',
  ORG_MANAGE_STORES: 'org:manage_stores',
  ORG_VIEW_AUDIT_LOG: 'org:view_audit_log',
  ORG_MANAGE_COMPLIANCE: 'org:manage_compliance',
  ORG_END_IMPERSONATION: 'org:end_impersonation',
  ORG_DELETE: 'org:delete',
} as const

export type Permission = typeof Permissions[keyof typeof Permissions]

export const RoleNames = {
  ADMIN: 'Admin',
  SUPERVISOR: 'Supervisor',
  AGENT: 'Agent',
  VIEWER: 'Viewer',
} as const

export type RoleName = typeof RoleNames[keyof typeof RoleNames]

export const RolePresets: Record<RoleName, readonly Permission[]> = {
  [RoleNames.ADMIN]: Object.values(Permissions),

  [RoleNames.SUPERVISOR]: [
    Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_VIEW_ALL,
    Permissions.CONVERSATIONS_CREATE, Permissions.CONVERSATIONS_ASSIGN,
    Permissions.CONVERSATIONS_RESOLVE, Permissions.CONVERSATIONS_SNOOZE,
    Permissions.CONVERSATIONS_ARCHIVE, Permissions.CONVERSATIONS_EXPORT,
    Permissions.MESSAGES_VIEW, Permissions.MESSAGES_SEND,
    Permissions.MESSAGES_SEND_TEMPLATE, Permissions.MESSAGES_INTERNAL_NOTE,
    Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_CREATE,
    Permissions.CUSTOMERS_EDIT, Permissions.CUSTOMERS_MERGE,
    Permissions.ORDERS_VIEW, Permissions.ORDERS_CREATE, Permissions.ORDERS_EDIT,
    Permissions.ORDERS_CANCEL, Permissions.ORDERS_CHANGE_STATUS,
    Permissions.PRODUCTS_VIEW, Permissions.INVENTORY_ADJUST,
    Permissions.MEDIA_VIEW, Permissions.MEDIA_UPLOAD, Permissions.MEDIA_DOWNLOAD_ALL,
    Permissions.TEAM_VIEW,
    Permissions.ANALYTICS_VIEW, Permissions.ANALYTICS_EXPORT,
  ],

  [RoleNames.AGENT]: [
    Permissions.CONVERSATIONS_VIEW, Permissions.CONVERSATIONS_CREATE,
    Permissions.CONVERSATIONS_RESOLVE, Permissions.CONVERSATIONS_SNOOZE,
    Permissions.MESSAGES_VIEW, Permissions.MESSAGES_SEND,
    Permissions.MESSAGES_SEND_TEMPLATE, Permissions.MESSAGES_INTERNAL_NOTE,
    Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_CREATE, Permissions.CUSTOMERS_EDIT,
    Permissions.ORDERS_VIEW, Permissions.ORDERS_CREATE,
    Permissions.PRODUCTS_VIEW,
    Permissions.MEDIA_VIEW, Permissions.MEDIA_UPLOAD,
  ],

  [RoleNames.VIEWER]: [
    Permissions.CONVERSATIONS_VIEW, Permissions.MESSAGES_VIEW,
    Permissions.CUSTOMERS_VIEW, Permissions.ORDERS_VIEW,
    Permissions.PRODUCTS_VIEW, Permissions.MEDIA_VIEW, Permissions.ANALYTICS_VIEW,
  ],
}
```

**Usage:**
```typescript
// Backend
@RequirePermissions(Permissions.CUSTOMERS_DELETE)
async delete(@Param('id') id: string) { }

// Frontend
const { hasPermission } = usePermissions()
{hasPermission(Permissions.CUSTOMERS_DELETE) && <DeleteButton />}
```

Staff roles and permissions for the internal console are a separate constant set
(`libs/core/admin/staff-constants.ts`, `TDD_15_InternalAdmin.md` §2).

---

## 5. Status enums

`libs/core/domain/status-enums.ts`

Prisma stores these as `String` (not native enums) so we can add values without a migration.
The TypeScript enum is the source of truth for validation. **Every `String` column that
holds a state has an enum here** — see the "Prisma column → enum" table at the end of this
section.

```typescript
export enum ConversationStatus {
  OPEN = 'OPEN',
  PENDING = 'PENDING',
  RESOLVED = 'RESOLVED',
  ARCHIVED = 'ARCHIVED',
  SNOOZED = 'SNOOZED',
  SPAM = 'SPAM',
}

export enum ConversationHandler {   // Who currently owns replies — TDD_12 §13
  HUMAN = 'human',
  AI = 'ai',
}

export enum OrderStatus {
  CONFIRMED = 'CONFIRMED',
  PREPARING = 'PREPARING',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
  RETURNED = 'RETURNED',
}

export enum PaymentStatus {
  PENDING = 'PENDING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  REFUNDED = 'REFUNDED',
}

export enum PaymentMethod {
  CASH = 'CASH',
  TRANSFER = 'TRANSFER',
  CARD = 'CARD',
  OTHER = 'OTHER',
}

export enum MessageType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  VIDEO = 'VIDEO',
  AUDIO = 'AUDIO',
  DOCUMENT = 'DOCUMENT',
  LOCATION = 'LOCATION',
  INTERNAL_NOTE = 'INTERNAL_NOTE',
  SYSTEM = 'SYSTEM',
  PRODUCT_CARD = 'PRODUCT_CARD',
  ORDER_SUMMARY = 'ORDER_SUMMARY',
  TEMPLATE = 'TEMPLATE',
}

export enum AuthorType {
  CUSTOMER = 'customer',
  AGENT = 'agent',
  AI_AGENT = 'ai_agent',     // Autonomous chatbot (TDD_12 §13). Never conflated with AGENT.
  SYSTEM = 'system',
}

export enum DeliveryStatus {
  QUEUED = 'queued',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
}

export enum MembershipStatus {
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}

export enum InvitationStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  EXPIRED = 'EXPIRED',
  REVOKED = 'REVOKED',
}

export enum ChannelType {
  WHATSAPP = 'whatsapp',
  INSTAGRAM = 'instagram',
  MESSENGER = 'messenger',
  WEB_WIDGET = 'web_widget',
  EMAIL = 'email',
}

export enum ChannelConnectionStatus {
  ACTIVE = 'active',
  ERROR = 'error',
  DISCONNECTED = 'disconnected',
}

export enum InventoryMovementType {
  IN = 'in',
  OUT = 'out',
  RESERVED = 'reserved',
  RELEASED = 'released',
  ADJUSTMENT = 'adjustment',
}

export enum AccessLevel {
  FULL = 'full',
  READ_ONLY = 'read_only',
  SUSPENDED = 'suspended',
}

export enum MediaStatus {
  PENDING = 'pending',
  CLEAN = 'clean',
  INFECTED = 'infected',
}

export enum WebhookStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',       // Auto-disabled after repeated failures, TDD_07 §2
  PAUSED = 'paused',           // Paused by the store admin
}

export enum PluginInstallationStatus {
  PENDING_SETUP = 'pending_setup',
  ACTIVE = 'active',
  DISABLED = 'disabled',
  REVOKED = 'revoked',
}

export enum PluginStatus {         // Marketplace catalog entry, TDD_10 §8 / TDD_15 §7
  SUBMITTED = 'submitted',
  CHANGES_REQUESTED = 'changes_requested',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  SUSPENDED = 'suspended',
}

export enum ApiKeyStatus {
  ACTIVE = 'active',
  REVOKED = 'revoked',
}

export enum DsrType {
  ACCESS = 'access',
  PORTABILITY = 'portability',
  RECTIFICATION = 'rectification',
  ERASURE = 'erasure',
  RESTRICTION = 'restriction',
  OBJECTION = 'objection',
}

export enum DsrStatus {
  PENDING_VERIFICATION = 'pending_verification',
  IN_PROGRESS = 'in_progress',
  MANUAL_REVIEW = 'manual_review',
  COMPLETED = 'completed',
  REJECTED = 'rejected',
}

export enum ImpersonationMode {
  READ_ONLY = 'read_only',
  WRITE = 'write',
}

export enum VerificationTokenType {
  EMAIL_VERIFICATION = 'email_verification',
  PASSWORD_RESET = 'password_reset',
  DSR_VERIFICATION = 'dsr_verification',
}

export enum NotificationChannel {
  IN_APP = 'in_app',
  PUSH = 'push',
  EMAIL = 'email',
  SOUND = 'sound',
}

export enum DigestFrequency {
  IMMEDIATE = 'immediate',
  HOURLY = 'hourly',
  DAILY = 'daily',
  OFF = 'off',
}
```

**Display metadata co-located with the enum — as i18n keys, never as strings:**
```typescript
// The frontend resolves these with next-intl; emails resolve them with the
// server-side renderer. No user-facing English lives in libs/core.
export const ConversationStatusI18nKeys: Record<ConversationStatus, string> = {
  [ConversationStatus.OPEN]: 'conversations.status.OPEN',
  [ConversationStatus.PENDING]: 'conversations.status.PENDING',
  [ConversationStatus.RESOLVED]: 'conversations.status.RESOLVED',
  [ConversationStatus.ARCHIVED]: 'conversations.status.ARCHIVED',
  [ConversationStatus.SNOOZED]: 'conversations.status.SNOOZED',
  [ConversationStatus.SPAM]: 'conversations.status.SPAM',
}

export const OrderStatusI18nKeys: Record<OrderStatus, string> = {
  [OrderStatus.CONFIRMED]: 'orders.status.CONFIRMED',
  [OrderStatus.PREPARING]: 'orders.status.PREPARING',
  [OrderStatus.SHIPPED]:   'orders.status.SHIPPED',
  [OrderStatus.DELIVERED]: 'orders.status.DELIVERED',
  [OrderStatus.CANCELLED]: 'orders.status.CANCELLED',
  [OrderStatus.RETURNED]:  'orders.status.RETURNED',
}

export const ConversationStatusColors: Record<ConversationStatus, string> = {
  [ConversationStatus.OPEN]: 'bg-blue-100 text-blue-800',
  [ConversationStatus.PENDING]: 'bg-yellow-100 text-yellow-800',
  [ConversationStatus.RESOLVED]: 'bg-green-100 text-green-800',
  [ConversationStatus.ARCHIVED]: 'bg-gray-100 text-gray-800',
  [ConversationStatus.SNOOZED]: 'bg-purple-100 text-purple-800',
  [ConversationStatus.SPAM]: 'bg-red-100 text-red-800',
}

// Which order statuses allow which edits — encodes business rules once
export const OrderEditableFields = {
  [OrderStatus.CONFIRMED]: ['items', 'shipping', 'discount', 'address', 'recipientPhones', 'paymentMethod', 'notes', 'scheduledDeliveryDate'],
  [OrderStatus.PREPARING]: ['shipping', 'address', 'recipientPhones', 'notes', 'scheduledDeliveryDate'],
  [OrderStatus.SHIPPED]:   ['address', 'recipientPhones', 'notes', 'trackingNumber', 'scheduledDeliveryDate'],
  [OrderStatus.DELIVERED]: ['notes'],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]:  ['notes'],
} as const satisfies Record<OrderStatus, readonly OrderEditableField[]>

export type OrderEditableField =
  'items' | 'shipping' | 'discount' | 'address' | 'recipientPhones' | 'paymentMethod' | 'notes' | 'trackingNumber' | 'scheduledDeliveryDate'

// Valid state transitions — prevents illegal jumps
export const OrderStatusTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
  [OrderStatus.CONFIRMED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
  [OrderStatus.PREPARING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  [OrderStatus.SHIPPED]:   [OrderStatus.DELIVERED, OrderStatus.RETURNED],
  [OrderStatus.DELIVERED]: [OrderStatus.RETURNED],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.RETURNED]:  [],
}

export const ConversationStatusTransitions: Record<ConversationStatus, readonly ConversationStatus[]> = {
  [ConversationStatus.OPEN]:     [ConversationStatus.PENDING, ConversationStatus.RESOLVED, ConversationStatus.SNOOZED, ConversationStatus.SPAM],
  [ConversationStatus.PENDING]:  [ConversationStatus.OPEN, ConversationStatus.RESOLVED, ConversationStatus.SNOOZED, ConversationStatus.SPAM],
  [ConversationStatus.RESOLVED]: [ConversationStatus.OPEN, ConversationStatus.ARCHIVED],
  [ConversationStatus.SNOOZED]:  [ConversationStatus.OPEN],
  [ConversationStatus.ARCHIVED]: [ConversationStatus.OPEN],
  [ConversationStatus.SPAM]:     [ConversationStatus.OPEN],
}
```

**Every status change goes through the owning service** (`ConversationsService.updateStatus`,
`OrdersService.updateStatus`). Those methods validate the transition, write the row and
emit the `*_STATUS_CHANGED` event. Schedulers, AI listeners and the internal console call
the service — never `prisma.conversation.update({ data: { status } })` directly. That is
what keeps cache invalidation, realtime and audit consistent.

**Prisma column → enum:**

| Column | Enum |
|---|---|
| `Conversation.status` | `ConversationStatus` |
| `Conversation.handler` | `ConversationHandler` |
| `Order.status` / `paymentStatus` / `paymentMethod` | `OrderStatus` / `PaymentStatus` / `PaymentMethod` |
| `Message.type` / `authorType` / `deliveryStatus` | `MessageType` / `AuthorType` / `DeliveryStatus` |
| `Membership.status` / `Invitation.status` | `MembershipStatus` / `InvitationStatus` |
| `CustomerIdentity.channelType` / `Conversation.channelType` / `ChannelConnection.pluginId` | `ChannelType` |
| `ChannelConnection.status` | `ChannelConnectionStatus` |
| `InventoryMovement.type` | `InventoryMovementType` |
| `Organization.accessLevel` | `AccessLevel` |
| `Media.status` | `MediaStatus` |
| `Webhook.status` | `WebhookStatus` |
| `PluginInstallation.status` / `Plugin.status` | `PluginInstallationStatus` / `PluginStatus` |
| `ApiKey.status` | `ApiKeyStatus` |
| `DataSubjectRequest.type` / `status` | `DsrType` / `DsrStatus` |
| `ImpersonationSession.mode` | `ImpersonationMode` |
| `VerificationToken.type` | `VerificationTokenType` |
| `Subscription.status` / `tier` / `interval` | `SubscriptionStatus` / `PlanTiers` / `BillingIntervals` (`libs/core/billing`, TDD_11 §1) |
| `Referral.status`, `Partner.status`, `Commission.status`, `Payout.status` | `ReferralStatus`, `PartnerStatus`, `CommissionStatus`, `PayoutStatus` (`libs/core/referrals`, TDD_11 §8) |
| `Staff.role` | `StaffRoles` (`libs/core/admin`, TDD_15 §2) |
| `AiCreditTransaction.reason` | `AiCreditReason` (`libs/core/ai`, TDD_12 §9.5) |

---

## 6. Error codes

`libs/core/errors/error-codes.ts`

Format: `DOMAIN_ENTITY_REASON`.

```typescript
export const ErrorCodes = {
  // Auth
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_REFRESH_TOKEN_REUSED: 'AUTH_REFRESH_TOKEN_REUSED',
  AUTH_EMAIL_NOT_VERIFIED: 'AUTH_EMAIL_NOT_VERIFIED',
  AUTH_UNAUTHORIZED: 'AUTH_UNAUTHORIZED',
  AUTH_EMAIL_ALREADY_EXISTS: 'AUTH_EMAIL_ALREADY_EXISTS',
  AUTH_VERIFICATION_TOKEN_INVALID: 'AUTH_VERIFICATION_TOKEN_INVALID',
  AUTH_VERIFICATION_TOKEN_EXPIRED: 'AUTH_VERIFICATION_TOKEN_EXPIRED',

  // Tenancy
  TENANT_NOT_FOUND: 'TENANT_NOT_FOUND',
  TENANT_HEADER_MISSING: 'TENANT_HEADER_MISSING',
  TENANT_ACCESS_DENIED: 'TENANT_ACCESS_DENIED',
  TENANT_MEMBER_ALREADY_EXISTS: 'TENANT_MEMBER_ALREADY_EXISTS',
  TENANT_INVITATION_INVALID: 'TENANT_INVITATION_INVALID',
  TENANT_INVITATION_EXPIRED: 'TENANT_INVITATION_EXPIRED',
  TENANT_INVITATION_EMAIL_MISMATCH: 'TENANT_INVITATION_EMAIL_MISMATCH',
  TENANT_CANNOT_REMOVE_LAST_ADMIN: 'TENANT_CANNOT_REMOVE_LAST_ADMIN',
  TENANT_READ_ONLY: 'TENANT_READ_ONLY',              // AccessLevel.READ_ONLY (dunning) or read-only impersonation

  // Permissions
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  STAFF_PERMISSION_DENIED: 'STAFF_PERMISSION_DENIED',

  // Resources
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  RESOURCE_ALREADY_EXISTS: 'RESOURCE_ALREADY_EXISTS',
  RESOURCE_CONFLICT: 'RESOURCE_CONFLICT',

  // Validation
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  VALIDATION_INVALID_INPUT: 'VALIDATION_INVALID_INPUT',
  VALIDATION_URL_NOT_ALLOWED: 'VALIDATION_URL_NOT_ALLOWED',   // SSRF guard, TDD_07 §2

  // Rate limiting
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  // Quotas (billing)
  QUOTA_CONVERSATIONS_EXCEEDED: 'QUOTA_CONVERSATIONS_EXCEEDED',
  QUOTA_SEATS_EXCEEDED: 'QUOTA_SEATS_EXCEEDED',
  QUOTA_STORES_EXCEEDED: 'QUOTA_STORES_EXCEEDED',
  QUOTA_CHANNELS_EXCEEDED: 'QUOTA_CHANNELS_EXCEEDED',
  SUBSCRIPTION_PAST_DUE: 'SUBSCRIPTION_PAST_DUE',
  SUBSCRIPTION_SUSPENDED: 'SUBSCRIPTION_SUSPENDED',
  SUBSCRIPTION_NOT_FOUND: 'SUBSCRIPTION_NOT_FOUND',
  FEATURE_NOT_IN_PLAN: 'FEATURE_NOT_IN_PLAN',
  CHANNEL_NOT_IN_PLAN: 'CHANNEL_NOT_IN_PLAN',   // Identity gate (TDD_11 §6.5) — distinct
                                                  // from QUOTA_CHANNELS_EXCEEDED's count gate
  AI_CREDITS_EXHAUSTED: 'AI_CREDITS_EXHAUSTED',

  // Channels
  CHANNEL_NOT_CONNECTED: 'CHANNEL_NOT_CONNECTED',
  CHANNEL_CONNECTION_NOT_FOUND: 'CHANNEL_CONNECTION_NOT_FOUND',
  CHANNEL_MESSAGE_FAILED: 'CHANNEL_MESSAGE_FAILED',
  CHANNEL_WINDOW_EXPIRED: 'CHANNEL_WINDOW_EXPIRED',
  CHANNEL_TEMPLATE_NOT_APPROVED: 'CHANNEL_TEMPLATE_NOT_APPROVED',
  CHANNEL_CREDENTIALS_INVALID: 'CHANNEL_CREDENTIALS_INVALID',
  CHANNEL_WEBHOOK_SIGNATURE_INVALID: 'CHANNEL_WEBHOOK_SIGNATURE_INVALID',
  CHANNEL_CAPABILITY_UNSUPPORTED: 'CHANNEL_CAPABILITY_UNSUPPORTED',

  // Plugins
  PLUGIN_NOT_FOUND: 'PLUGIN_NOT_FOUND',
  PLUGIN_ALREADY_REGISTERED: 'PLUGIN_ALREADY_REGISTERED',
  PLUGIN_ALREADY_INSTALLED: 'PLUGIN_ALREADY_INSTALLED',
  PLUGIN_INSTALLATION_FAILED: 'PLUGIN_INSTALLATION_FAILED',
  PLUGIN_CONTRACT_VIOLATION: 'PLUGIN_CONTRACT_VIOLATION',
  PLUGIN_SCOPE_DENIED: 'PLUGIN_SCOPE_DENIED',
  PLUGIN_API_KEY_INVALID: 'PLUGIN_API_KEY_INVALID',

  // Internal admin (TDD_15_InternalAdmin.md)
  IMPERSONATION_BLOCKED: 'IMPERSONATION_BLOCKED',
  IMPERSONATION_EXPIRED: 'IMPERSONATION_EXPIRED',
  IMPERSONATION_WRITE_REQUIRES_CONFIRMATION: 'IMPERSONATION_WRITE_REQUIRES_CONFIRMATION',

  // Business logic
  ORDER_CANNOT_BE_CANCELLED: 'ORDER_CANNOT_BE_CANCELLED',
  ORDER_INVALID_STATUS_TRANSITION: 'ORDER_INVALID_STATUS_TRANSITION',
  ORDER_FIELD_NOT_EDITABLE: 'ORDER_FIELD_NOT_EDITABLE',
  CONVERSATION_ALREADY_RESOLVED: 'CONVERSATION_ALREADY_RESOLVED',
  CONVERSATION_INVALID_STATUS_TRANSITION: 'CONVERSATION_INVALID_STATUS_TRANSITION',
  CONVERSATION_HANDLED_BY_AI: 'CONVERSATION_HANDLED_BY_AI',
  INSUFFICIENT_INVENTORY: 'INSUFFICIENT_INVENTORY',
  CUSTOMER_MERGE_SAME_ID: 'CUSTOMER_MERGE_SAME_ID',
  CUSTOMER_UNMERGE_WINDOW_EXPIRED: 'CUSTOMER_UNMERGE_WINDOW_EXPIRED',

  // Files
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_TYPE_NOT_ALLOWED: 'FILE_TYPE_NOT_ALLOWED',
  FILE_INFECTED: 'FILE_INFECTED',
  FILE_NOT_READY: 'FILE_NOT_READY',                 // Scan pending
  FILE_UPLOAD_FAILED: 'FILE_UPLOAD_FAILED',
  FILE_KEY_OUT_OF_SCOPE: 'FILE_KEY_OUT_OF_SCOPE',   // Key does not belong to the current store

  // Compliance
  DSR_VERIFICATION_INVALID: 'DSR_VERIFICATION_INVALID',
  DSR_ALREADY_COMPLETED: 'DSR_ALREADY_COMPLETED',

  // External
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
  EXTERNAL_SERVICE_TIMEOUT: 'EXTERNAL_SERVICE_TIMEOUT',

  // Generic
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes]
```

**Exception class:**
```typescript
export class PlatformException extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,                                  // English, for logs only
    public readonly statusCode: number = HttpStatusCodes.INTERNAL_SERVER_ERROR,
    public readonly metadata?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'PlatformException'
  }
}
```

**Error response contract (never changes):**
```json
{
  "error": {
    "code": "AUTH_INVALID_CREDENTIALS",
    "message": "Invalid credentials",
    "metadata": {}
  },
  "correlationId": "550e8400-e29b-41d4-a716-446655440000"
}
```

**Rule:** the backend returns codes. The frontend translates them via i18n.
The backend never returns user-facing localized strings (exception: emails, see `TDD_07_Queues.md`).

---

## 7. API routes

`libs/core/api/api-routes.ts`

Routes are **full paths relative to the version prefix**. Controllers declare
`@Controller()` with **no prefix** and use the constant on the method, passing `':id'`
placeholders to the path builders. This is the only decorator convention in the codebase:

```typescript
@Controller()
export class ConversationsController {
  @Get(ApiRoutes.conversations.list)            // '/conversations'
  list() {}

  @Get(ApiRoutes.conversations.byId(':id'))     // '/conversations/:id'
  findOne(@Param('id') id: string) {}
}
```

```typescript
export const ApiRoutes = {
  auth: {
    login: '/auth/login',
    logout: '/auth/logout',
    signup: '/auth/signup',
    refresh: '/auth/refresh',
    verifyEmail: '/auth/verify-email',
    resendVerification: '/auth/resend-verification',
    forgotPassword: '/auth/forgot-password',
    resetPassword: '/auth/reset-password',
    google: '/auth/google',
    googleCallback: '/auth/google/callback',
    me: '/auth/me',
    sessions: '/auth/sessions',
    sessionById: (id: string) => `/auth/sessions/${id}`,
  },

  organizations: {
    current: '/organizations/current',
    stores: '/organizations/current/stores',
    storeById: (id: string) => `/organizations/current/stores/${id}`,
    auditLog: '/organizations/current/audit-log',
    endImpersonation: '/organizations/current/impersonation/end',
  },

  invitations: {
    byToken: (token: string) => `/invitations/${token}`,        // Public: preview
    accept: (token: string) => `/invitations/${token}/accept`,  // Auth required
  },

  conversations: {
    list: '/conversations',
    byId: (id: string) => `/conversations/${id}`,
    messages: (id: string) => `/conversations/${id}/messages`,
    assign: (id: string) => `/conversations/${id}/assign`,
    status: (id: string) => `/conversations/${id}/status`,
    snooze: (id: string) => `/conversations/${id}/snooze`,
    tags: (id: string) => `/conversations/${id}/tags`,
    read: (id: string) => `/conversations/${id}/read`,
    takeOver: (id: string) => `/conversations/${id}/take-over`,   // From the AI handler, TDD_12 §13
    messagingWindow: (id: string) => `/conversations/${id}/messaging-window`,
    bulk: '/conversations/bulk',
    export: '/conversations/export',
  },

  messages: {
    create: '/messages',
    byId: (id: string) => `/messages/${id}`,
    markRead: (id: string) => `/messages/${id}/read`,
  },

  customers: {
    list: '/customers',
    byId: (id: string) => `/customers/${id}`,
    identities: (id: string) => `/customers/${id}/identities`,
    identityById: (id: string, identityId: string) => `/customers/${id}/identities/${identityId}`,
    merge: (id: string) => `/customers/${id}/merge`,
    unmerge: (id: string) => `/customers/${id}/unmerge`,
    orders: (id: string) => `/customers/${id}/orders`,
    conversations: (id: string) => `/customers/${id}/conversations`,
    notes: (id: string) => `/customers/${id}/notes`,
    addresses: (id: string) => `/customers/${id}/addresses`,
    tags: (id: string) => `/customers/${id}/tags`,
    media: (id: string) => `/customers/${id}/media`,
    timeline: (id: string) => `/customers/${id}/timeline`,
    export: '/customers/export',
  },

  orders: {
    list: '/orders',
    create: '/orders',
    byId: (id: string) => `/orders/${id}`,
    cancel: (id: string) => `/orders/${id}/cancel`,
    status: (id: string) => `/orders/${id}/status`,
    items: (id: string) => `/orders/${id}/items`,
    print: (id: string, doc: string) => `/orders/${id}/print/${doc}`,
    export: '/orders/export',
  },

  products: {
    list: '/products',
    create: '/products',
    byId: (id: string) => `/products/${id}`,
    variants: (id: string) => `/products/${id}/variants`,
    search: '/products/search',
    inventory: (id: string) => `/products/${id}/inventory`,
  },

  media: {
    uploadUrl: '/media/upload-url',
    confirmUpload: '/media/confirm-upload',
    byId: (id: string) => `/media/${id}`,
    downloadAll: '/media/download-all',
  },

  exports: {
    list: '/exports',
    byId: (id: string) => `/exports/${id}`,
    download: (id: string) => `/exports/${id}/download`,
  },

  search: {
    global: '/search',
    messages: '/search/messages',
    customers: '/search/customers',
    orders: '/search/orders',
    products: '/search/products',
  },

  notifications: {
    list: '/notifications',
    unreadCount: '/notifications/unread-count',
    markRead: '/notifications/read',
    markAllRead: '/notifications/read-all',
    preferences: '/notifications/preferences',
    pushSubscription: '/notifications/push-subscription',
  },

  analytics: {
    metrics: '/analytics/metrics',
    dashboard: '/analytics/dashboard',
    reports: '/analytics/reports',
    reportById: (id: string) => `/analytics/reports/${id}`,
    export: '/analytics/export',
  },

  plugins: {
    list: '/plugins',
    available: '/plugins/available',
    install: '/plugins/install',
    byId: (id: string) => `/plugins/${id}`,
    enable: (id: string) => `/plugins/${id}/enable`,
    disable: (id: string) => `/plugins/${id}/disable`,
    revoke: (id: string) => `/plugins/${id}/revoke`,
    config: (id: string) => `/plugins/${id}/config`,
  },

  channels: {
    connections: '/channels/connections',
    connect: (pluginId: string) => `/channels/${pluginId}/connect`,
    connectionById: (id: string) => `/channels/connections/${id}`,
    test: (id: string) => `/channels/connections/${id}/test`,
    disconnect: (id: string) => `/channels/connections/${id}/disconnect`,
    templates: (pluginId: string) => `/channels/${pluginId}/templates`,
  },

  settings: {
    store: '/settings/store',
    inbox: '/settings/inbox',
    safety: '/settings/safety',
    team: '/settings/team',
    members: '/settings/team/members',
    memberById: (id: string) => `/settings/team/members/${id}`,
    invitations: '/settings/team/invitations',
    invitationById: (id: string) => `/settings/team/invitations/${id}`,
    roles: '/settings/roles',
    roleById: (id: string) => `/settings/roles/${id}`,
    routing: '/settings/routing',
    routingRuleById: (id: string) => `/settings/routing/${id}`,
    businessHours: '/settings/business-hours',
    tags: '/settings/tags',
    tagById: (id: string) => `/settings/tags/${id}`,
    snippets: '/settings/snippets',
    snippetById: (id: string) => `/settings/snippets/${id}`,
    webhooks: '/settings/webhooks',
    webhookById: (id: string) => `/settings/webhooks/${id}`,
    webhookDeliveries: (id: string) => `/settings/webhooks/${id}/deliveries`,
    apiKeys: '/settings/api-keys',
    apiKeyById: (id: string) => `/settings/api-keys/${id}`,
    ai: '/settings/ai',
    retention: '/settings/retention',
  },

  account: {
    profile: '/account/profile',
    preferences: '/account/preferences',
    password: '/account/password',
  },

  billing: {
    subscription: '/billing/subscription',
    usage: '/billing/usage',
    invoices: '/billing/invoices',
    checkout: '/billing/checkout',
    portal: '/billing/portal',
    plans: '/billing/plans',
    aiCredits: '/billing/ai-credits',
    aiCreditsTopup: '/billing/ai-credits/topup',
    aiCreditsPayg: '/billing/ai-credits/pay-as-you-go',
  },

  referrals: {
    partner: '/referrals/partner',
    stats: '/referrals/stats',
    referrals: '/referrals/list',
    payouts: '/referrals/payouts',
    requestPayout: '/referrals/request-payout',
    trackClick: '/referrals/track-click',      // Public, rate-limited by IP
  },

  compliance: {
    dsr: '/compliance/dsr',
    dsrById: (id: string) => `/compliance/dsr/${id}`,
    dsrVerify: '/compliance/dsr/verify',       // Public, token in body
    consent: '/compliance/consent',
    cookieConsent: '/compliance/cookie-consent',
  },

  ai: {
    suggestReplies: (convId: string) => `/ai/conversations/${convId}/suggest-replies`,
    summarize: (convId: string) => `/ai/conversations/${convId}/summarize`,
    trackSuggestion: '/ai/track-suggestion',
    acceptSuggestedTag: (convId: string) => `/ai/conversations/${convId}/accept-tag`,
  },

  support: {
    articles: '/support/articles',              // Contextual help, TDD_11 §9.3
    ticket: '/support/ticket',
  },

  // Public, unauthenticated. No AuthGuard/TenantGuard; each has its own verification.
  webhooks: {
    stripe: '/webhooks/stripe',
    resend: '/webhooks/resend',
    channel: (pluginId: string) => `/webhooks/channels/${pluginId}`,
  },

  // Web widget public API (visitor-facing, signed with the site key). TDD_10 §5.4
  widget: {
    bootstrap: '/widget/bootstrap',
    messages: '/widget/messages',
    upload: '/widget/upload-url',
  },
} as const

// Mounted OUTSIDE the /api/v1 prefix (see below).
export const InfraRoutes = {
  healthLive: '/health',
  healthReady: '/health/ready',
  metrics: '/metrics',
  docs: '/docs',
  queues: '/admin/queues',
} as const

// Staff console API, mounted under /admin/v1 with StaffAuthGuard. TDD_15.
export const AdminRoutes = {
  organizations: {
    search: '/organizations',
    byId: (id: string) => `/organizations/${id}`,
    overrides: (id: string) => `/organizations/${id}/overrides`,
    overrideById: (id: string, overrideId: string) => `/organizations/${id}/overrides/${overrideId}`,
    suspend: (id: string) => `/organizations/${id}/suspend`,
    reinstate: (id: string) => `/organizations/${id}/reinstate`,
    extendTrial: (id: string) => `/organizations/${id}/extend-trial`,
    changePlan: (id: string) => `/organizations/${id}/change-plan`,
    credit: (id: string) => `/organizations/${id}/credit`,
    impersonate: (id: string) => `/organizations/${id}/impersonate`,
    auditLog: (id: string) => `/organizations/${id}/audit-log`,
  },
  impersonation: {
    byId: (id: string) => `/impersonation/${id}`,
    elevate: (id: string) => `/impersonation/${id}/elevate`,
    end: (id: string) => `/impersonation/${id}/end`,
  },
  ai: {
    settings: '/ai/settings',
    adjustCredits: (organizationId: string) => `/ai/organizations/${organizationId}/credits`,
  },
  plugins: {
    submissions: '/plugins/submissions',
    review: (id: string) => `/plugins/submissions/${id}/review`,
    suspend: (id: string) => `/plugins/${id}/suspend`,
  },
  featureFlags: {
    list: '/feature-flags',
    byKey: (key: string) => `/feature-flags/${key}`,
  },
  queues: {
    replay: '/queues/replay',            // Dead-letter replay, TDD_07 §3
  },
  auditLog: '/audit-log',
} as const
```

**API versioning and prefixes:**

```typescript
// apps/api/src/main.ts
app.setGlobalPrefix('api/v1', {
  exclude: [
    { path: InfraRoutes.healthLive, method: RequestMethod.GET },
    { path: InfraRoutes.healthReady, method: RequestMethod.GET },
    { path: InfraRoutes.metrics, method: RequestMethod.GET },
    { path: `${InfraRoutes.queues}/(.*)`, method: RequestMethod.ALL },
    { path: 'admin/v1/(.*)', method: RequestMethod.ALL },
  ]
})
```

- Tenant API: `/api/v1/...` — `ApiRoutes`, `AuthGuard` + `TenantGuard` + `@RequirePermissions()`.
- Staff API: `/admin/v1/...` — `AdminRoutes`, `StaffAuthGuard` + `StaffPermissionGuard`.
- Infra: `/health`, `/health/ready`, `/metrics`, `/docs`, `/admin/queues` — no prefix.
- The frontend `apiClient` prepends `/api/v1` once; no route constant contains it.

---

## 8. Queue, job and schedule names

`libs/core/queues/queue-names.ts`

```typescript
export const QueueNames = {
  EMAIL: 'email',
  WEBHOOKS: 'webhooks',
  NOTIFICATIONS: 'notifications',
  ANALYTICS: 'analytics',
  EXPORTS: 'exports',
  HEAVY_PROCESSING: 'heavy-processing',
  INBOUND: 'inbound',              // Channel webhook events, TDD_10 §4
  AI: 'ai',                        // Autonomous chatbot turns, TDD_12 §13
  DEAD_LETTER: 'dead-letter',
} as const

export const JobNames = {
  // email — one job, the template decides the content (TDD_07 §5)
  SEND_EMAIL: 'send-email',

  // webhooks
  TRIGGER_WEBHOOK: 'trigger-webhook',
  TRIGGER_PLUGIN_WEBHOOK: 'trigger-plugin-webhook',

  // notifications
  SEND_WEB_PUSH: 'send-web-push',
  QUEUE_EMAIL_DIGEST: 'queue-email-digest',
  SEND_EMAIL_DIGEST: 'send-email-digest',

  // analytics
  TRACK_EVENT: 'track-event',
  TRACK_SEARCH: 'track-search',
  ROLLUP_HOURLY: 'rollup-hourly',
  ROLLUP_DAILY: 'rollup-daily',
  REPORT_STRIPE_USAGE: 'report-stripe-usage',

  // exports
  GENERATE_EXPORT: 'generate-export',
  GENERATE_SCHEDULED_REPORT: 'generate-scheduled-report',
  GENERATE_MEDIA_ZIP: 'generate-media-zip',
  DSR_EXPORT_DATA: 'dsr-export-data',
  DSR_ERASE_DATA: 'dsr-erase-data',
  PROCESS_PARTNER_PAYOUT: 'process-partner-payout',
  EXPORT_AUDIT_LOGS_TO_COLD_STORAGE: 'export-audit-logs-to-cold-storage',

  // heavy processing
  SCAN_FILE: 'scan-file',
  PROCESS_IMAGE: 'process-image',          // Enqueued by SCAN_FILE only after a clean result
  FETCH_INBOUND_MEDIA: 'fetch-inbound-media',
  ENFORCE_RETENTION: 'enforce-retention',

  // inbound
  PROCESS_CHANNEL_EVENT: 'process-channel-event',

  // ai
  PROCESS_AUTONOMOUS_CHATBOT_TURN: 'process-autonomous-chatbot-turn',   // TDD_12 §13

  // dead letter
  EXHAUSTED: 'exhausted',
} as const

export type JobName = typeof JobNames[keyof typeof JobNames]
```

`libs/core/queues/schedules.ts` — cron expressions for every scheduler, defined once
(`TDD_07_Queues.md` §4). An inline cron string anywhere else is a lint failure.

---

## 9. Environment variables (type-safe)

### 9.1 API and worker — `libs/core/config/env.ts`

Validated at boot with Zod 4. The app refuses to start with an invalid environment.
Channel credentials are **per store** and live encrypted in `ChannelConnection.credentials`;
only platform-level app credentials (the Meta app, Stripe, providers) are environment variables.

```typescript
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  APP_ROLE: z.enum(['api', 'worker']).default('api'),
  PORT: z.coerce.number().default(8080),
  API_URL: z.url(),
  FRONTEND_URL: z.url().default('http://localhost:3000'),
  ADMIN_URL: z.url().optional(),
  COMMIT_SHA: z.string().optional(),

  // Database
  DATABASE_URL: z.url(),
  DATABASE_REPLICA_URL: z.url().optional(),

  // Redis
  REDIS_URL: z.url(),
  REDIS_QUEUE_URL: z.url().optional(),

  // Auth
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Encryption at rest for ChannelConnection.credentials and ApiKey secrets (AES-256-GCM)
  CREDENTIALS_ENCRYPTION_KEY: z.string().length(64),   // 32 bytes, hex

  // Storage (S3-compatible; MinIO locally)
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: z.string(),
  AWS_SECRET_ACCESS_KEY: z.string(),
  S3_BUCKET: z.string(),
  S3_ENDPOINT: z.url().optional(),                      // MinIO / non-AWS endpoint
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),   // true for MinIO

  // Email
  EMAIL_PROVIDER: z.enum(['resend']).default('resend'),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  EMAIL_FROM: senderAddress.default('noreply@platform.local'),   // A bare address or "Name <address>"; senderAddress is a z.string().refine() that accepts either form
  EMAIL_INBOUND_DOMAIN: z.string().optional(),          // e.g. inbound.platform.com, TDD_10 §5.5

  // Observability
  SENTRY_DSN: z.url().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Push
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),

  // Billing
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_PRICE_IDS_JSON: z.string().optional(),         // JSON: { [tier]: { monthly, yearly, overageMeter } }, parsed by libs/core/billing

  // AI — which provider is live is a PlatformSetting (TDD_15 §6); keys are env
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  // Meta (WhatsApp Cloud API, Instagram, Messenger) — one app for all three
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),               // Webhook HMAC + OAuth
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),
  META_GRAPH_API_VERSION: z.string().default('v23.0'),

  // Virus scanning
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().default(3310),

  // Staff SSO (TDD_15 §1)
  STAFF_OIDC_ISSUER: z.url().optional(),
  STAFF_OIDC_CLIENT_ID: z.string().optional(),
  STAFF_OIDC_CLIENT_SECRET: z.string().optional(),
  STAFF_ALLOWED_EMAIL_DOMAIN: z.string().optional(),

  // Deploy-time kill switches (runtime flags live in the FeatureFlag table, TDD_15 §8)
  FEATURE_BILLING_ENABLED: z.stringbool().default(false),
  FEATURE_REFERRALS_ENABLED: z.stringbool().default(false),
  FEATURE_AI_ENABLED: z.stringbool().default(false),
})

export type Env = z.infer<typeof envSchema>

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment variables:\n${issues}`)
  }
  return result.data
}

export const env = validateEnv()
```

`z.stringbool()` parses `"true"/"false"/"1"/"0"/"yes"/"no"`; `z.coerce.boolean()` is banned
because `Boolean("false") === true`.

Local `.env` loading for `apps/api` and `apps/worker` is done by `dotenv-flow` in `main.ts`
before anything imports `env` (`.env`, `.env.local`, `.env.${NODE_ENV}`); deployed
environments inject real variables and never ship `.env` files.

**Never use `process.env` directly outside this file.**

### 9.2 Web — `apps/web/lib/env.ts`

The browser bundle gets its own, much smaller schema. It never imports
`libs/core/config` (that would pull server secrets into the client build).

```typescript
import { z } from 'zod'

const webEnvSchema = z.object({
  NEXT_PUBLIC_API_URL: z.url(),
  NEXT_PUBLIC_WS_URL: z.url(),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  NEXT_PUBLIC_SENTRY_DSN: z.url().optional(),
  NEXT_PUBLIC_WIDGET_SCRIPT_URL: z.url(),
})

export const webEnv = webEnvSchema.parse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL,
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  NEXT_PUBLIC_WIDGET_SCRIPT_URL: process.env.NEXT_PUBLIC_WIDGET_SCRIPT_URL,
})
```

(Next.js inlines `NEXT_PUBLIC_*` only when accessed by full name, hence the explicit object.)

---

## 10. Naming conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Files | kebab-case | `conversations.service.ts` |
| Classes | PascalCase | `ConversationsService` |
| Interfaces | PascalCase, no `I` prefix | `ChannelPlugin` |
| Types | PascalCase | `ConversationStatus` |
| Constants object | PascalCase | `Events`, `CacheKeys` |
| Constant keys | SCREAMING_SNAKE | `CONVERSATION_CREATED` |
| Functions/methods | camelCase | `findAllByStore` |
| Variables | camelCase | `conversationId` |
| Boolean variables | `is`/`has`/`should` prefix | `isResolved`, `hasPermission` |
| Database tables | snake_case plural, via `@@map` | `customer_identities` |
| Database columns | snake_case, via `@map` | `created_at` |
| Prisma models | PascalCase singular | `CustomerIdentity` |
| Prisma fields | camelCase | `createdAt` |
| Env variables | SCREAMING_SNAKE | `DATABASE_URL` |
| React components | PascalCase | `ConversationList` |
| React hooks | `use` prefix — **only** hooks | `usePermissions` |
| Event handlers / callbacks | `handle`/`on` prefix | `handleSuggestionClick` |
| Event payload types | `<Event>Payload` | `MessageReceivedPayload` |
| Test files | `.spec.ts` / `.test.ts` | `orders.service.spec.ts` |

**Every Prisma model declares `@@map("<snake_case_plural>")` and every multi-word field
declares `@map("<snake_case>")`.** Raw SQL, RLS policies, indexes and rollup queries all
use the mapped names. A model without `@@map` fails review.

**Service method naming:**
```typescript
findAll(storeId)          // Returns array
findOne(id, storeId)      // Returns one or throws
findById(id)              // Returns one or null
create(data)
update(id, data)
delete(id)
exists(id): boolean
count(filters): number
```

---

## 11. TypeScript configuration

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

TypeScript is pinned to **5.9.x** (`TDD_01_Architecture.md` §2.4). `exactOptionalPropertyTypes`
is deliberately **off** — Prisma's generated input types and several NestJS decorators are
not compatible with it. `verbatimModuleSyntax` means classes used by the Nest DI container
must be imported as values (`import { PrismaService }`), types with `import type`.

**Banned:**
- `any` — use `unknown` and narrow. Enforced by `@typescript-eslint/no-explicit-any: error`
  in production **and** test code.
- `as` casts — use type guards. The only tolerated form is `as unknown as T` at a documented
  boundary (a raw SQL result, a JSON payload just validated with Zod, a third-party SDK type
  gap), with a one-line comment naming the boundary.
- Non-null assertion `!` — except immediately after an explicit check in the same expression.
- `@ts-ignore` — use `@ts-expect-error` with a comment explaining why.

---

## 12. Language rules

| Content | Language |
|---------|----------|
| Code, identifiers, file names | **English, always** |
| Code comments | **English, always** |
| Commit messages | **English, always** |
| Technical documentation | **English, always** |
| Log messages | **English, always** |
| Error messages in exceptions | **English** (they are for logs, not users) |
| User-facing UI copy | **i18n keys** — never hardcoded in any language |
| Persisted notifications | **i18n key + params** (`Notification.messageKey`, `Notification.params`) — rendered at display time |
| Email templates | **i18n**, resolved per recipient locale |
| Customer-facing channel messages (system, AI labels) | **i18n**, resolved from the customer's detected locale, falling back to `Store.defaultLocale` |

```typescript
// WRONG
throw new BadRequestException('El pedido no se puede cancelar')
<Button>Guardar</Button>
await notifications.send({ title: 'Export ready' })

// CORRECT
throw new PlatformException(ErrorCodes.ORDER_CANNOT_BE_CANCELLED, 'Order cannot be cancelled', 409)
<Button>{t('common.save')}</Button>
await notifications.send({ type: NotificationTypes.EXPORT_READY, params: { filename } })
```

---

## 13. Validation with Zod (shared schemas)

Define once in `libs/core/domain/schemas/`, use in both backend DTO validation and
frontend form validation. Zod 4 idioms: `z.uuid()`, `z.email()`, `z.url()`, `z.enum(NativeEnum)`.

```typescript
// libs/core/domain/schemas/order.schema.ts
import { z } from 'zod'
import { PaymentMethod } from '../status-enums'
import { RecipientPhones } from '../order-constants'

// The recipient's phones, as the carriers receive them (C807 and Forza take national digits,
// no country code): digits only. Spaces, '+' and dashes are stripped before validating, so
// what is stored is what is sent. The first one is the main number; a duplicate (same
// digits) is refused, not silently dropped. A number copied from Customer.phone (always
// international) is reduced to its national number by the form and the backfill, not here.
export const recipientPhonesSchema = z
  .array(z.string().transform((value) => value.replace(/\D/g, '')).pipe(z.string().min(1)))
  .min(1)
  .max(RecipientPhones.MAX_COUNT)
  .refine((phones) => new Set(phones).size === phones.length)

export const createOrderSchema = z.object({
  customerId: z.uuid(),
  conversationId: z.uuid().optional(),
  items: z.array(z.object({
    productId: z.uuid(),
    variantId: z.uuid().optional(),
    quantity: z.number().int().min(1)
    // No client-supplied price: the server reads Product/ProductVariant.price at creation time
  })).min(1),
  shippingCents: z.number().int().min(0).default(0),
  discountCents: z.number().int().min(0).default(0),
  paymentMethod: z.enum(PaymentMethod),
  shippingAddress: z.object({
    line1: z.string().min(1),
    line2: z.string().optional(),
    city: z.string().min(1),
    state: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().length(2).default('SV')
  }).optional(),
  recipientPhones: recipientPhonesSchema,   // the form pre-fills it from Customer.phone, as its national number
  customerNotes: z.string().max(1000).optional(),
  scheduledDeliveryDate: z.iso.date().nullable().default(null),   // 'YYYY-MM-DD', a calendar day in the store timezone; null = not scheduled; a past day is accepted
  sendConfirmationMessage: z.boolean().default(true)
})

export type CreateOrderInput = z.infer<typeof createOrderSchema>
```

```typescript
// Backend — ZodValidationPipe from nestjs-zod; the same package generates the
// OpenAPI schema for Swagger (TDD_14 §4), so DTOs are never written twice.
@Post(ApiRoutes.orders.create)
async create(@Body(new ZodValidationPipe(createOrderSchema)) data: CreateOrderInput) { }

// Frontend
const form = useForm<CreateOrderInput>({ resolver: zodResolver(createOrderSchema) })
```

**LLM output is an external boundary too.** Every AI parser validates the model's JSON
with a Zod schema before use (`TDD_12_AI.md` §3).

---

## 14. Frontend query keys

`libs/api-client/src/query-keys.ts`

TanStack Query keys are constants, built the same way as `CacheKeys`. Realtime
invalidation (`TDD_06_Realtime.md` §3) and mutations import them; nobody writes
`['conversations', storeId]` inline.

```typescript
export const QueryKeys = {
  conversations: {
    all:  (storeId: string) => ['conversations', storeId] as const,
    list: (storeId: string, filters: ConversationFilters) => ['conversations', storeId, 'list', filters] as const,
    byId: (storeId: string, id: string) => ['conversations', storeId, id] as const,
    counts: (storeId: string) => ['conversations', storeId, 'counts'] as const,
  },
  messages: {
    thread: (storeId: string, conversationId: string) => ['messages', storeId, conversationId] as const,
  },
  customers: {
    all:  (storeId: string) => ['customers', storeId] as const,
    byId: (storeId: string, id: string) => ['customers', storeId, id] as const,
  },
  orders: {
    all:  (storeId: string) => ['orders', storeId] as const,
    byId: (storeId: string, id: string) => ['orders', storeId, id] as const,
  },
  products: {
    search: (storeId: string, q: string) => ['products', storeId, 'search', q] as const,
  },
  search: {
    global: (storeId: string, q: string) => ['search', storeId, q] as const,
  },
  notifications: {
    list: (storeId: string) => ['notifications', storeId] as const,
    unread: (storeId: string) => ['notifications', storeId, 'unread'] as const,
  },
  billing: {
    usage: (organizationId: string) => ['billing', organizationId, 'usage'] as const,
  },
  session: ['session'] as const,
} as const
```

---

## 15. Where the smaller constant sets live

Other TDDs reference these by name. Each is a `as const` object in the file listed; none
may be redefined elsewhere.

| Constant | File |
|---|---|
| `TenantHeaders`, `ThrottlerNames`, `AuthenticatedRequest` | `libs/core/auth/` |
| `AuditAction`, `AuditActionType` | `libs/core/audit/audit-actions.ts` |
| `MetricNames` | `libs/core/metrics/metric-names.ts` |
| `Schedules`, `LockNames` | `libs/core/queues/schedules.ts` |
| `ExportTypes`, `ExportFormats`, `ExportStatus`, `ExportAuditActions`, `DeadLetterJob` and every job payload type | `libs/core/queues/job-types.ts` |
| `RoomNames`, `RealtimeNamespaces`, `PresenceStatus` | `libs/core/realtime/` |
| `NotificationTypes`, `NotificationSeverity`, `NotificationDefaults`, `notificationMessageKey` | `libs/core/notifications/notification-constants.ts` |
| `EmailTemplates`, `EmailTemplate` | `libs/core/email/templates/index.ts` |
| `UploadLimits`, `AllowedContentTypes`, `MediaPurpose`, `StorageKeys`, `ImageVariants` | `libs/core/storage/` |
| `WebhookHeaders`, `WebhookLimits`, `WebhookSources`, `ResendEventTypes`, `StripeEventTypes`, `StripeMeters`, `UsageMetrics` | `libs/core/domain/webhook-constants.ts`, `libs/core/billing/stripe-constants.ts` |
| `ConversationStatusReasons`, `BulkActions`, `BulkLimits`, `OrderCancellationReasons`, `OrderPrintDocuments`, `DestructiveActionTiers`, `Shortcuts` | `libs/core/domain/` |
| `PlanTiers`, `PlanFeatures`, `PlanLimits`, `AvailableChannels`, `OverridableLimitFields`, `BillingUnits`, `SubscriptionStatus`, `StripeBillingReasons`, `QuotaTypes`, `QuotaWarningThresholds`, `DunningActions`, `DunningSchedule` | `libs/core/billing/billing-constants.ts` |
| `AnalyticsMetrics`, `AnalyticsEventNames`, `MetricDimensions`, `TimeGranularity`, `DateRangePresets`, `ReportFrequency`, `ReportFormats` | `libs/core/analytics/analytics-constants.ts` |
| `ReferralProgramTypes`, `ReferralStatus`, `PartnerStatus`, `CommissionStatus`, `PayoutStatus`, `PayoutMethods`, `ReferralConfig`, `FraudSignals`, `ReferralRejectionReasons`, `PUBLIC_EMAIL_DOMAINS` | `libs/core/referrals/referral-constants.ts` |
| `SupportTiers`, `SupportChannels`, `SupportSLA`, `SupportMetrics` | `libs/core/billing/support-constants.ts` |
| `ComplianceConfig`, `DataRetentionPolicies`, `LegalBases`, `CookieCategories`, `COOKIE_POLICY_VERSION` | `libs/core/compliance/compliance-constants.ts` |
| `AIFeatures`, `AIProviders`, `ModelTiers`, `DefaultModelRegistry`, `modelRegistrySchema`, `AIConfig`, `SentimentLabels`, `IntentLabels`, `AiCreditReason`, `AiHandoffReasons`, `AiActorKinds`, `AutonomousActions`, `AICreditCosts`, `TOPUP_PACKAGES`, `CHISPA_UNIT_CENTS`, `PromptDefinition` and every `*_PROMPT` | `libs/core/ai/` |
| `ChannelCapability`, `ChannelEventTypes`, `PluginScopes`, `PluginScopePermissions`, `PluginPricingModels`, `PluginBridgeMessages`, `PLUGIN_SCOPES_KEY` | `libs/plugins/sdk/` |
| `StaffRoles`, `StaffPermissions`, `StaffRolePresets`, `PlatformSettingKeys`, `FeatureFlagKeys`, `ImpersonationConfig`, `ImpersonationEndedBy`, `EnvKillSwitches` | `libs/core/admin/` |
| `Locales`, `DEFAULT_LOCALE`, `SOURCE_LOCALE`, `SUPPORTED_LOCALES`, `LocaleLabels` | `libs/core/i18n/locales.ts` |
| `QueryKeys`, `AppPaths`, `StorageKeys` (browser `localStorage` keys), `API_PREFIX` | `libs/api-client/src/` |

---

## 16. Definition of done for any constant

Before adding a new string literal anywhere, ask:

1. Will this string appear in more than one file? → **Must be a constant.**
2. Is this a key, name, code or identifier consumed by another system? → **Must be a constant.**
3. Is it a value stored in a `String` column that represents a state or kind? → **Must be an enum in §5.**
4. Is it a one-off log message? → Inline is acceptable.
5. Is it user-facing copy? → **Must be an i18n key.**

When in doubt: make it a constant.
