# TDD 08 — Performance & Search

> Part of the Omnichannel Commerce Platform TDD v1.1
> Covers: caching layers, query optimization, CDN, code splitting, full-text search

---

## 1. Caching strategy (three layers)

```
Request
  ↓
L1: In-memory (per process)     TTL 5-30s     — permissions, hot config
  ↓ miss
L2: Redis (shared)              TTL 1-60min   — settings, counts, search results
  ↓ miss
L3: PostgreSQL read replica                   — heavy list queries
  ↓
Response
```

### 1.1 L1 — in-memory

Use only for data that is read on nearly every request and changes rarely.
Stale data for up to 30 seconds must be acceptable.

```typescript
// libs/core/cache/memory-cache.service.ts
import NodeCache from 'node-cache'

@Injectable()
export class MemoryCacheService {
  private readonly cache = new NodeCache({ stdTTL: 30, checkperiod: 60, useClones: false })

  get<T>(key: string): T | undefined {
    return this.cache.get<T>(key)
  }

  set<T>(key: string, value: T, ttl: number = CacheTTL.VERY_SHORT): void {
    this.cache.set(key, value, ttl)
  }

  del(key: string): void {
    this.cache.del(key)
  }
}
```

**Valid L1 use cases:** platform settings, feature flags, plugin manifests, channel
capability lists. Nothing tenant-specific.

**Caveat:** L1 is per-instance. Invalidation does not propagate across replicas.
Only cache data where 30 seconds of staleness is harmless.

### 1.2 L2 — Redis

```typescript
// libs/core/cache/redis-cache.service.ts
const NULL_SENTINEL = '__null__'

@Injectable()
export class RedisCacheService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectMetric(MetricNames.CACHE_HITS) private readonly hits: Counter,
    @InjectMetric(MetricNames.CACHE_MISSES) private readonly misses: Counter
  ) {}

  // Returns undefined on a miss, so a cached null/false/0/"" is a hit
  async get<T>(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(key)
    if (raw === null) { this.misses.inc(); return undefined }
    this.hits.inc()
    return raw === NULL_SENTINEL ? (null as T) : (JSON.parse(raw) as T)   // JSON boundary; writers control the shape
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value === null ? NULL_SENTINEL : JSON.stringify(value), 'EX', ttlSeconds)
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length) await this.redis.del(...keys)
  }

  // SCAN, never KEYS — KEYS blocks the Redis event loop
  async delPattern(pattern: string): Promise<void> {
    let cursor = '0'
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = next
      if (keys.length) await this.redis.del(...keys)
    } while (cursor !== '0')
  }

  async getOrSet<T>(key: string, factory: () => Promise<T>, ttlSeconds: number): Promise<T> {
    const cached = await this.get<T>(key)
    if (cached !== undefined) return cached

    const fresh = await factory()
    await this.set(key, fresh, ttlSeconds)
    return fresh
  }
}
```

### 1.3 Invalidation

Cache invalidation is driven by domain events, never by manual calls
scattered through services. **Every `CacheKeys` entry that is written somewhere has an
invalidation here** — the table in §1.4 lists them side by side.

```typescript
// libs/core/cache/cache-invalidation.listener.ts
@Injectable()
export class CacheInvalidationListener {
  constructor(
    private readonly cache: RedisCacheService,
    private readonly memory: MemoryCacheService,
  ) {}

  @OnEvent(Events.CONVERSATION_STATUS_CHANGED)
  @OnEvent(Events.CONVERSATION_ASSIGNED)
  @OnEvent(Events.CONVERSATION_UNASSIGNED)
  @OnEvent(Events.CONVERSATION_READ)
  @OnEvent(Events.MESSAGE_RECEIVED)
  @OnEvent(Events.MESSAGE_SENT)
  async onConversationChanged(payload: { storeId: string; conversationId: string }): Promise<void> {
    await this.cache.del(
      CacheKeys.conversation.counts(payload.storeId),
      CacheKeys.conversation.byId(payload.storeId, payload.conversationId)
    )
  }

  @OnEvent(Events.PRODUCT_CREATED)
  @OnEvent(Events.PRODUCT_UPDATED)
  @OnEvent(Events.PRODUCT_DELETED)
  @OnEvent(Events.INVENTORY_MOVED)
  async onProductChanged(payload: { storeId: string; productId: string }): Promise<void> {
    await Promise.all([
      this.cache.del(
        CacheKeys.store.products(payload.storeId),
        CacheKeys.product.byId(payload.storeId, payload.productId),
        CacheKeys.product.inventory(payload.storeId, payload.productId)
      ),
      this.cache.delPattern(CacheKeys.patterns.productSearchAll(payload.storeId))
    ])
  }

  @OnEvent(Events.CUSTOMER_UPDATED)
  @OnEvent(Events.CUSTOMER_MERGED)
  @OnEvent(Events.CUSTOMER_UNMERGED)
  @OnEvent(Events.CUSTOMER_IDENTITY_LINKED)
  @OnEvent(Events.CUSTOMER_ERASED)
  async onCustomerChanged(payload: { storeId: string; customerId: string; identities?: Array<{ channelType: string; channelIdentity: string }> }): Promise<void> {
    await this.cache.del(
      CacheKeys.customer.profile(payload.storeId, payload.customerId),
      CacheKeys.customer.orders(payload.storeId, payload.customerId),
      ...(payload.identities ?? []).map(i => CacheKeys.customer.byIdentity(payload.storeId, i.channelType, i.channelIdentity))
    )
  }

  @OnEvent(Events.ORDER_CREATED)
  @OnEvent(Events.ORDER_STATUS_CHANGED)
  async onOrderChanged(payload: { storeId: string; customerId: string }): Promise<void> {
    await this.cache.del(CacheKeys.customer.orders(payload.storeId, payload.customerId))
  }

  @OnEvent(Events.MEMBER_ROLE_CHANGED)
  @OnEvent(Events.MEMBER_REMOVED)
  @OnEvent(Events.MEMBER_JOINED)
  async onMembershipChanged(payload: { userId: string; storeId: string }): Promise<void> {
    await this.cache.del(
      CacheKeys.agent.permissions(payload.userId, payload.storeId),   // TenantGuard context (TDD_01 §3.2)
      CacheKeys.store.agents(payload.storeId)
    )
  }

  @OnEvent(Events.ROLE_UPDATED)
  async onRoleUpdated(payload: { storeId: string; memberUserIds: string[] }): Promise<void> {
    await this.cache.del(...payload.memberUserIds.map(id => CacheKeys.agent.permissions(id, payload.storeId)))
  }

  @OnEvent(Events.STORE_UPDATED)
  @OnEvent(Events.STORE_SETTINGS_UPDATED)
  async onStoreUpdated(payload: { storeId: string }): Promise<void> {
    await this.cache.del(CacheKeys.store.settings(payload.storeId), CacheKeys.store.routing(payload.storeId))
  }

  @OnEvent(Events.TAG_CREATED) @OnEvent(Events.TAG_UPDATED) @OnEvent(Events.TAG_DELETED)
  async onTagChanged(payload: { storeId: string }): Promise<void> {
    await this.cache.del(CacheKeys.store.tags(payload.storeId))
  }

  @OnEvent(Events.SNIPPET_CREATED) @OnEvent(Events.SNIPPET_UPDATED) @OnEvent(Events.SNIPPET_DELETED)
  async onSnippetChanged(payload: { storeId: string }): Promise<void> {
    await this.cache.del(CacheKeys.store.snippets(payload.storeId))
  }

  @OnEvent(Events.AI_SETTINGS_UPDATED)
  async onAiSettingsUpdated(payload: { storeId: string }): Promise<void> {
    await this.cache.del(CacheKeys.store.aiSettings(payload.storeId))
  }

  @OnEvent(Events.CHANNEL_CONNECTED) @OnEvent(Events.CHANNEL_DISCONNECTED)
  async onChannelChanged(payload: { storeId: string; pluginId: string; connectionId: string; organizationId: string }): Promise<void> {
    await this.cache.del(
      CacheKeys.channel.connection(payload.pluginId, payload.connectionId),
      CacheKeys.billing.usage(payload.organizationId)
    )
  }

  @OnEvent(Events.SUBSCRIPTION_CREATED) @OnEvent(Events.SUBSCRIPTION_UPDATED) @OnEvent(Events.SUBSCRIPTION_CANCELED)
  @OnEvent(Events.ORGANIZATION_ACCESS_LEVEL_CHANGED)
  async onSubscriptionChanged(payload: { organizationId: string; memberUserStoreIds: Array<{ userId: string; storeId: string }> }): Promise<void> {
    await this.cache.del(
      CacheKeys.billing.subscription(payload.organizationId),
      CacheKeys.billing.usage(payload.organizationId),
      CacheKeys.billing.effectivePlanLimits(payload.organizationId),
      ...payload.memberUserStoreIds.map(m => CacheKeys.agent.permissions(m.userId, m.storeId))
    )
  }

  @OnEvent(Events.STORE_CREATED) @OnEvent(Events.STORE_DELETED)
  @OnEvent(Events.MEMBER_INVITED)
  async onOrgUsageChanged(payload: { organizationId: string }): Promise<void> {
    await this.cache.del(CacheKeys.billing.usage(payload.organizationId))
  }

  // TDD_15 §3.1 — EffectivePlanLimitsService caches its resolved result
  @OnEvent(Events.ORGANIZATION_OVERRIDE_CHANGED)
  async onOrganizationOverrideChanged(payload: PlanLimitsInvalidatedPayload): Promise<void> {
    await this.cache.del(CacheKeys.billing.effectivePlanLimits(payload.organizationId))
  }

  @OnEvent(Events.AI_CREDITS_CHANGED)
  async onAiCreditsChanged(payload: { organizationId: string }): Promise<void> {
    await this.cache.del(CacheKeys.billing.aiCredits(payload.organizationId))
  }

  @OnEvent(Events.PLATFORM_SETTING_CHANGED) @OnEvent(Events.FEATURE_FLAG_CHANGED)
  async onPlatformChanged(payload: { key: string; kind: 'setting' | 'flag' }): Promise<void> {
    const key = payload.kind === 'setting' ? CacheKeys.platform.setting(payload.key) : CacheKeys.platform.featureFlag(payload.key)
    await this.cache.del(key)
    this.memory.del(key)
  }

  @OnEvent(Events.PLUGIN_ENABLED) @OnEvent(Events.PLUGIN_DISABLED) @OnEvent(Events.PLUGIN_REVOKED)
  async onPluginChanged(payload: { storeId: string; pluginId: string }): Promise<void> {
    await this.cache.del(CacheKeys.plugin.installation(payload.storeId, payload.pluginId))
  }
}
```

**Rule:** if you write a `cache.set()` (or `getOrSet`), you must also add the corresponding
invalidation to this listener, and if the invalidating event does not exist yet, add it to
`Events` first. No exceptions.

### 1.4 What to cache and what not to

| Cache key | Written by | Invalidated by | TTL |
|---|---|---|---|
| `agent.permissions` | `TenantGuard` | membership/role/subscription/access-level events | VERY_SHORT |
| `store.settings`, `store.routing` | settings services | `STORE_UPDATED`, `STORE_SETTINGS_UPDATED` | MEDIUM |
| `store.agents` | team service | membership events | MEDIUM |
| `store.tags`, `store.snippets` | tags/snippets services | `TAG_*`, `SNIPPET_*` | MEDIUM |
| `store.aiSettings` | `AIService` | `AI_SETTINGS_UPDATED` | MEDIUM |
| `conversation.counts` | inbox counts | conversation/message events | VERY_SHORT |
| `customer.byIdentity` | inbound pipeline | customer events | LONG |
| `product.search` | `SearchService` | product/inventory events | SHORT |
| `channel.connection` | inbound pipeline | channel events | LONG |
| `plugin.manifest` | registry | boot only (manifests are code) | VERY_LONG |
| `billing.usage`, `billing.subscription`, `billing.effectivePlanLimits`, `billing.aiCredits` | billing services | subscription/override/credit events | MEDIUM |
| `platform.*` (L1 + L2) | `PlatformSettingsService`, `FeatureFlagService` | platform events | VERY_SHORT (L1), MEDIUM (L2) |

**Never cached:** conversation lists and message threads (they change constantly and are
served by indexed queries), order details, anything the agent just edited, analytics for the
current hour, anything containing PII beyond identifiers.

---

## 2. Database query optimization

### 2.1 Index strategy

All indexes live in one of two places, never both:

- **Prisma `@@index` / `@@unique`** in the schema (`TDD_01` §4) for everything Prisma can
  express.
- **Raw SQL** (`TDD_01` §5) only for what Prisma cannot: partial indexes, GIN/trigram
  indexes, generated columns, partial uniques.

Adding an SQL index that duplicates a Prisma index fails review. The query shapes below are
the ones those indexes were designed for:

| Query | Index |
|---|---|
| Inbox list (store, active statuses, assignee, newest first) | partial `idx_conversations_active_inbox` |
| Thread loading | `messages (conversation_id, created_at)` |
| Inbound identity lookup | unique `customer_identities (store_id, channel_type, channel_identity)` |
| Inbound connection lookup | unique `channel_connections (plugin_id, connection_id)` |
| Customer phone search | partial `idx_customers_phone (store_id, phone_normalized)` |
| Order list with status filter | `orders (store_id, status, created_at DESC)` |
| Stock calculation | `inventory_movements (product_id, variant_id, type, created_at DESC)` |
| Unread badge | partial `idx_notifications_unread` |
| Billing usage count | `billable_conversations (organization_id, window_start, voided_at)` |
| Snooze wake / auto-archive | `conversations (snoozed_until)`, `conversations (status, resolved_at)` |

### 2.2 EXPLAIN ANALYZE workflow

Every new query touching a table expected to exceed 100k rows must be
profiled before merge.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT c.id, c.status, c.last_message_at,
       cust.name AS customer_name,
       last_msg.content AS last_message
FROM conversations c
JOIN customers cust ON cust.id = c.customer_id
LEFT JOIN LATERAL (
  SELECT content, created_at FROM messages
  WHERE conversation_id = c.id
  ORDER BY created_at DESC LIMIT 1
) last_msg ON true
WHERE c.store_id = $1 AND c.status = $2
ORDER BY c.last_message_at DESC
LIMIT 25;
```

**Red flags in the output:**
```
Seq Scan on a table > 10k rows        → missing index
Rows Removed by Filter: 50000         → index not selective enough
Buffers: shared read=5000             → cache miss, consider covering index
Nested Loop with high loop count      → likely N+1 in disguise
Sort with external merge              → work_mem too low or result set too large
```

### 2.3 N+1 prevention

```typescript
// WRONG — 1 + N queries
const conversations = await prisma.client.conversation.findMany({ where: { storeId } })
for (const c of conversations) {
  c.customer = await prisma.client.customer.findUnique({ where: { id: c.customerId } })
}

// CORRECT — one query, and only the columns the list needs
const conversations = await prisma.client.$replica().conversation.findMany({
  where: { storeId, status: ConversationStatus.OPEN },
  select: {
    id: true, status: true, channelType: true, assignedTo: true, unreadCount: true, lastMessageAt: true,
    customer: { select: { id: true, name: true, phone: true } },
    messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, authorType: true, type: true, content: true, createdAt: true } },
    tags: { select: { id: true, name: true, color: true } },
  },
  orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
  take: 25
})
```

The list preview truncates `content` in the DTO mapper (`contentPreview`, 200 chars);
full content is loaded by the thread endpoint only.

### 2.4 Cursor pagination

```typescript
// WRONG — OFFSET scans and discards every preceding row
await prisma.client.conversation.findMany({ where: { storeId }, skip: 500, take: 25 })

// CORRECT — cursor is constant-time regardless of depth
async listConversations(params: {
  storeId: string
  status?: ConversationStatus
  cursor?: string
  limit?: number
}): Promise<CursorPage<ConversationListItem>> {
  const limit = Math.min(params.limit ?? 25, 100)

  const items = await this.prisma.client.$replica().conversation.findMany({
    where: { storeId: params.storeId, ...(params.status && { status: params.status }) },
    select: conversationListSelect,
    take: limit + 1,                                    // Fetch one extra to detect more
    ...(params.cursor && { cursor: { id: params.cursor }, skip: 1 }),
    orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }]  // Tiebreaker for stability
  })

  const hasMore = items.length > limit
  const data = hasMore ? items.slice(0, limit) : items
  const last = data.at(-1)

  return {
    data: data.map(toConversationListItem),
    nextCursor: hasMore && last ? last.id : null,
    hasMore
  }
}
```

**Standard response shape for all list endpoints:**
```typescript
interface CursorPage<T> {
  data: T[]
  nextCursor: string | null
  hasMore: boolean
}
```

### 2.5 Read replicas

Routing uses `@prisma/extension-read-replicas`, wired in `PrismaService` (`TDD_01` §2.3).
`this.prisma.client` is the primary; `this.prisma.client.$replica()` is the replica (which is
the same database in development and staging).

```typescript
// Reads that tolerate replication lag go to the replica
async listConversations(storeId: string) {
  return this.prisma.client.$replica().conversation.findMany({ where: { storeId } })
}

// Anything read-then-written must use the primary
async resolveConversation(id: string, storeId: string) {
  const conv = await this.prisma.client.conversation.findFirst({ where: { id, storeId } })
  // ... primary, because we write immediately after
}
```

**Rule:** analytics, exports, search and list views use the replica.
Anything in a write path, guards and the inbound pipeline use the primary.

### 2.6 Connection pooling (PgBouncer)

```ini
[pgbouncer]
pool_mode = transaction          ; Correct choice for stateless web apps
max_client_conn = 1000           ; Clients connecting to PgBouncer
default_pool_size = 25           ; Server connections per user/db pair
reserve_pool_size = 5
reserve_pool_timeout = 3
server_idle_timeout = 600
max_db_connections = 100         ; Must be <= Postgres max_connections
ignore_startup_parameters = extra_float_digits
auth_type = scram-sha-256
```

**Why transaction mode:** a connection is held only for the duration of a
transaction, not the whole session. This is what allows 1000 clients to share
25 backend connections.

**Prisma 7 implication:** the `pg` driver adapter uses unnamed prepared statements, which
are compatible with transaction pooling; no `pgbouncer=true` flag exists any more. Anything
that relies on session state (`SET LOCAL` for RLS, advisory locks) must run inside a
`$transaction` (`TDD_01` §3.2). Migrations bypass PgBouncer through `DIRECT_DATABASE_URL`.

```sql
-- Monitoring (connect to the pgbouncer admin database)
SHOW POOLS;     -- cl_waiting > 0 with sv_idle = 0 means exhaustion
SHOW STATS;
```

---

## 3. CDN and asset delivery

One CDN: **Cloudflare**, in front of `app.platform.com` (Next static assets) and
`widget.platform.com` (the embeddable script). Private media never goes through a CDN — it
is served by short-lived signed URLs on the S3 bucket host (`TDD_07` §6.6). There is no
CloudFront and no Cloud CDN.

```typescript
// apps/web/next.config.ts
import type { NextConfig } from 'next'

const config: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.s3.amazonaws.com' },      // Signed URLs only; the bucket is private
      { protocol: 'https', hostname: '*.amazonaws.com' },
    ],
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 60 * 60 * 24 * 30,
    deviceSizes: [640, 750, 828, 1080, 1200],
    imageSizes: [16, 32, 48, 64, 96, 128, 256],
  },
  compress: true,
  poweredByHeader: false,
  headers: securityHeaders,     // TDD_05 §6
}

export default withSerwist(config)
```

**Cloudflare cache rules:**
```
app.platform.com/_next/static/*    Cache 1 year   (content-hashed, immutable)
app.platform.com/icons/*           Cache 30 days
widget.platform.com/*              Cache 1 hour, browser 10 min  (versioned filename busts on deploy)
api.platform.com/*                 Bypass cache
```

Health endpoints are never cached: probes must see the origin.

---

## 4. Frontend performance

### 4.1 Code splitting

```tsx
import dynamic from 'next/dynamic'

// Heavy, conditionally rendered components
const AnalyticsChart = dynamic(() => import('@/components/analytics/AnalyticsChart'), {
  loading: () => <ChartSkeleton />,
  ssr: false
})

const MediaGallery = dynamic(() => import('@/components/inbox/MediaGallery'), {
  loading: () => <GallerySkeleton />
})

const CreateOrderDrawer = dynamic(() => import('@/components/orders/CreateOrderDrawer'))
const CustomerProfileDrawer = dynamic(() => import('@/components/customers/ProfileDrawer'))
const CommandPalette = dynamic(() => import('@/components/shared/CommandPalette'), { ssr: false })
```

### 4.2 Suspense boundaries

```tsx
export default function InboxPage() {
  return (
    <div className="flex h-screen">
      {/* Critical path: renders immediately */}
      <ConversationList />

      {/* Streams in after the shell */}
      <Suspense fallback={<ConversationSkeleton />}>
        <ActiveConversation />
      </Suspense>

      <Suspense fallback={<CustomerSidebarSkeleton />}>
        <CustomerSidebar />
      </Suspense>
    </div>
  )
}
```

### 4.3 Virtualized lists

Conversation lists can hold thousands of items. Render only what is visible.

```tsx
import { useVirtualizer } from '@tanstack/react-virtual'

function ConversationList({ conversations }: Props) {
  const parentRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 88,
    overscan: 5
  })

  return (
    <div ref={parentRef} className="h-full overflow-auto">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map(item => {
          const conversation = conversations[item.index]
          if (!conversation) return null
          return (
            <div
              key={item.key}
              style={{ position: 'absolute', top: 0, transform: `translateY(${item.start}px)`, width: '100%' }}
            >
              <ConversationItem conversation={conversation} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

### 4.4 Performance budgets

```
First Contentful Paint       < 1.5s
Largest Contentful Paint     < 2.5s
Time to Interactive          < 3.5s
Cumulative Layout Shift      < 0.1
Interaction to Next Paint    < 200ms

Initial JS bundle            < 200 KB gzipped
Per-route JS                 < 100 KB gzipped
```

Enforced in CI by the `lighthouse` job (`TDD_03` §4) with `lighthouserc.json` asserting
these budgets on `/login` and `/s/{seed-store}/inbox`. A regression fails the build.

### 4.5 API latency budgets

```
GET  /conversations          p95 < 300ms
GET  /conversations/:id      p95 < 200ms
GET  /conversations/:id/messages  p95 < 250ms
POST /messages               p95 < 500ms   (includes channel API call)
GET  /products/search        p95 < 200ms   (autocomplete must feel instant)
POST /orders                 p95 < 600ms
GET  /analytics/metrics      p95 < 1000ms  (reads pre-aggregated rollups)
POST /webhooks/channels/:id  p99 < 300ms   (enqueue only, TDD_10 §4)
```

---

## 5. Full-text search

### 5.1 Decision: PostgreSQL FTS first

**Why not Elasticsearch on day one:**
- Zero additional infrastructure (~$0 vs ~$100/month)
- Sufficient up to roughly 5-10M messages
- Transactionally consistent — no indexing lag
- One backup, one migration path

**Migrate to Elasticsearch when:**
- More than 10M indexed messages
- Search latency consistently above 500ms
- Advanced relevance tuning or complex facets become product requirements

### 5.2 Constants

```typescript
// libs/core/search/search-constants.ts
export const SearchEntities = {
  CONVERSATIONS: 'conversations',
  MESSAGES: 'messages',
  CUSTOMERS: 'customers',
  ORDERS: 'orders',
  PRODUCTS: 'products',
} as const

export type SearchEntity = typeof SearchEntities[keyof typeof SearchEntities]

export const SearchConfig = {
  MIN_QUERY_LENGTH: 2,
  MAX_QUERY_LENGTH: 200,
  DEFAULT_LIMIT: 25,
  MAX_LIMIT: 100,
  SIMILARITY_THRESHOLD: 0.3,
  SNIPPET_MAX_WORDS: 20,
  DEBOUNCE_MS: 250,
  CACHE_TTL_SECONDS: 60,
  GLOBAL_SEARCH_PER_GROUP: 5,
} as const

// The generated tsvector columns use the 'spanish' configuration (TDD_01 §5): the target
// market writes Spanish. Stores with defaultLocale 'en' still get trigram + prefix matching;
// per-store FTS configurations are an Elasticsearch-era feature (§5.7).
export const SearchLanguage = 'spanish' as const
export const SEARCH_LANGUAGE_SQL = Prisma.raw(`'${SearchLanguage}'::regconfig`)   // Literal, never a bind parameter
```

### 5.3 Schema support

Generated `tsvector` columns (see `TDD_01_Architecture.md` §5) plus trigram
indexes for typo tolerance. Generated columns update automatically —
no triggers, no application code, no drift. Customers are searched on
`phone_normalized` (E.164 digits), which the customers service maintains on every write.

### 5.4 Service

`websearch_to_tsquery` and `ts_headline` take a `regconfig` as first argument; a bind
parameter would arrive as `text` and Postgres would report "function does not exist", so the
configuration is spliced as a literal (`SEARCH_LANGUAGE_SQL`). User input is always a bind
parameter.

```typescript
@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RedisCacheService,
  ) {}

  async searchMessages(params: {
    storeId: string
    query: string
    conversationId?: string
    limit?: number
  }): Promise<SearchResult<MessageSearchHit>> {
    this.validateQuery(params.query)
    const limit = Math.min(params.limit ?? SearchConfig.DEFAULT_LIMIT, SearchConfig.MAX_LIMIT)
    const headlineOptions = `StartSel=<mark>, StopSel=</mark>, MaxWords=${SearchConfig.SNIPPET_MAX_WORDS}, MinWords=5`

    // websearch_to_tsquery supports "quoted phrases", -exclusions and OR
    const rows = await this.prisma.client.$replica().$queryRaw<unknown[]>`
      SELECT
        m.id,
        m.conversation_id AS "conversationId",
        m.type,
        m.created_at      AS "createdAt",
        cust.id           AS "customerId",
        cust.name         AS "customerName",
        ts_rank(m.search_vector, websearch_to_tsquery(${SEARCH_LANGUAGE_SQL}, ${params.query})) AS rank,
        ts_headline(
          ${SEARCH_LANGUAGE_SQL}, m.content,
          websearch_to_tsquery(${SEARCH_LANGUAGE_SQL}, ${params.query}),
          ${headlineOptions}
        ) AS snippet
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN customers cust  ON cust.id = c.customer_id
      WHERE m.store_id = ${params.storeId}::uuid
        AND m.type <> ${MessageType.INTERNAL_NOTE}
        AND m.search_vector @@ websearch_to_tsquery(${SEARCH_LANGUAGE_SQL}, ${params.query})
        ${params.conversationId
          ? Prisma.sql`AND m.conversation_id = ${params.conversationId}::uuid`
          : Prisma.empty}
      ORDER BY rank DESC, m.created_at DESC
      LIMIT ${limit}
    `
    const hits = messageSearchHitSchema.array().parse(rows)   // Raw SQL is a boundary

    return { entity: SearchEntities.MESSAGES, query: params.query, hits, hasMore: hits.length === limit }
  }

  async searchCustomers(params: {
    storeId: string
    query: string
    limit?: number
  }): Promise<SearchResult<CustomerSearchHit>> {
    this.validateQuery(params.query)
    const limit = Math.min(params.limit ?? SearchConfig.DEFAULT_LIMIT, SearchConfig.MAX_LIMIT)
    const digitsOnly = params.query.replace(/\D/g, '')

    // Hybrid: FTS for relevance, trigram for typos, LIKE on normalized digits for phone fragments
    const rows = await this.prisma.client.$replica().$queryRaw<unknown[]>`
      SELECT c.id, c.name, c.email, c.phone,
        GREATEST(
          ts_rank(c.search_vector, websearch_to_tsquery(${SEARCH_LANGUAGE_SQL}, ${params.query})),
          similarity(coalesce(c.name, ''), ${params.query})
        ) AS rank
      FROM customers c
      WHERE c.store_id = ${params.storeId}::uuid
        AND c.erased_at IS NULL
        AND c.merged_into_id IS NULL
        AND (
          c.search_vector @@ websearch_to_tsquery(${SEARCH_LANGUAGE_SQL}, ${params.query})
          OR similarity(coalesce(c.name, ''), ${params.query}) > ${SearchConfig.SIMILARITY_THRESHOLD}
          ${digitsOnly.length >= 4
            ? Prisma.sql`OR c.phone_normalized LIKE ${'%' + digitsOnly + '%'}`
            : Prisma.empty}
        )
      ORDER BY rank DESC
      LIMIT ${limit}
    `
    const hits = customerSearchHitSchema.array().parse(rows)

    return { entity: SearchEntities.CUSTOMERS, query: params.query, hits, hasMore: hits.length === limit }
  }

  // Product autocomplete — hard requirement: under 200ms
  async searchProducts(storeId: string, query: string): Promise<ProductSearchHit[]> {
    this.validateQuery(query)
    const prefix = escapeLike(query) + '%'                  // Escapes %, _ and \ in user input

    return this.cache.getOrSet(
      CacheKeys.product.search(storeId, hashQuery(query)),
      async () => {
        const rows = await this.prisma.client.$replica().$queryRaw<unknown[]>`
          SELECT p.id, p.name, p.sku, p.price_cents AS "priceCents", p.image_media_id AS "imageMediaId"
          FROM products p
          WHERE p.store_id = ${storeId}::uuid
            AND p.active = true
            AND (
              p.search_vector @@ websearch_to_tsquery(${SEARCH_LANGUAGE_SQL}, ${query})
              OR p.name ILIKE ${prefix} ESCAPE '\\'
              OR p.sku  ILIKE ${prefix} ESCAPE '\\'
            )
          ORDER BY
            CASE WHEN p.name ILIKE ${prefix} ESCAPE '\\' THEN 0 ELSE 1 END,
            similarity(p.name, ${query}) DESC
          LIMIT 10
        `
        return productSearchHitSchema.array().parse(rows)
      },
      SearchConfig.CACHE_TTL_SECONDS
    )
  }

  async searchOrders(params: { storeId: string; query: string; limit?: number }): Promise<SearchResult<OrderSearchHit>> {
    this.validateQuery(params.query)
    const limit = Math.min(params.limit ?? SearchConfig.DEFAULT_LIMIT, SearchConfig.MAX_LIMIT)
    const prefix = escapeLike(params.query) + '%'

    // Orders are matched on order number (prefix) and customer name (trigram)
    const rows = await this.prisma.client.$replica().$queryRaw<unknown[]>`
      SELECT o.id, o.order_number AS "orderNumber", o.status, o.total_cents AS "totalCents",
             o.created_at AS "createdAt", cust.name AS "customerName"
      FROM orders o
      JOIN customers cust ON cust.id = o.customer_id
      WHERE o.store_id = ${params.storeId}::uuid
        AND (o.order_number ILIKE ${prefix} ESCAPE '\\'
             OR similarity(coalesce(cust.name, ''), ${params.query}) > ${SearchConfig.SIMILARITY_THRESHOLD})
      ORDER BY o.created_at DESC
      LIMIT ${limit}
    `
    const hits = orderSearchHitSchema.array().parse(rows)
    return { entity: SearchEntities.ORDERS, query: params.query, hits, hasMore: hits.length === limit }
  }

  async globalSearch(storeId: string, query: string): Promise<GlobalSearchResult> {
    this.validateQuery(query)
    const perGroup = SearchConfig.GLOBAL_SEARCH_PER_GROUP

    const [customers, messages, orders, products] = await Promise.all([
      this.searchCustomers({ storeId, query, limit: perGroup }),
      this.searchMessages({ storeId, query, limit: perGroup }),
      this.searchOrders({ storeId, query, limit: perGroup }),
      this.searchProducts(storeId, query)
    ])

    return {
      query,
      groups: [
        { entity: SearchEntities.CUSTOMERS, hits: customers.hits },
        { entity: SearchEntities.MESSAGES,  hits: messages.hits },
        { entity: SearchEntities.ORDERS,    hits: orders.hits },
        { entity: SearchEntities.PRODUCTS,  hits: products.slice(0, perGroup) }
      ].filter(g => g.hits.length > 0)
    }
  }

  private validateQuery(query: string): void {
    if (query.length < SearchConfig.MIN_QUERY_LENGTH) {
      throw new PlatformException(ErrorCodes.VALIDATION_INVALID_INPUT, 'Query too short', 400,
        { minLength: SearchConfig.MIN_QUERY_LENGTH })
    }
    if (query.length > SearchConfig.MAX_QUERY_LENGTH) {
      throw new PlatformException(ErrorCodes.VALIDATION_INVALID_INPUT, 'Query too long', 400,
        { maxLength: SearchConfig.MAX_QUERY_LENGTH })
    }
  }
}
```

**Every search query is store-scoped.** Cross-tenant leakage through search is
explicitly covered by the security test suite. Internal notes are excluded from message
search results unless the caller has `MESSAGES_INTERNAL_NOTE` (separate query flag).

### 5.5 Command palette

```tsx
// apps/web/components/shared/CommandPalette.tsx
export function CommandPalette({ storeId }: { storeId: string }) {
  const t = useTranslations()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const debounced = useDebouncedValue(query, SearchConfig.DEBOUNCE_MS)

  const { data, isLoading } = useQuery({
    queryKey: QueryKeys.search.global(storeId, debounced),
    queryFn: () => apiClient.search.global(storeId, debounced),
    enabled: debounced.length >= SearchConfig.MIN_QUERY_LENGTH,
    staleTime: 30_000
  })

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen(o => !o)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  return (
    <Command.Dialog open={open} onOpenChange={setOpen}>
      <Command.Input value={query} onValueChange={setQuery} placeholder={t('search.placeholder')} />
      <Command.List>
        {isLoading && <Command.Loading>{t('common.loading')}</Command.Loading>}
        {!isLoading && !data?.groups.length && <Command.Empty>{t('common.noResults')}</Command.Empty>}
        {data?.groups.map(group => (
          <Command.Group key={group.entity} heading={t(`search.groups.${group.entity}`)}>
            {group.hits.map(hit => (
              <Command.Item key={hit.id} onSelect={() => router.push(searchHitPath(storeId, group.entity, hit))}>
                <SearchHitRow entity={group.entity} hit={hit} />
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  )
}
```

`searchHitPath` builds the target from `AppPaths` (`TDD_09` §12).

**Snippet rendering:** `ts_headline` returns `<mark>` tags. Sanitize before
injecting — allow only `<mark>`, strip everything else (DOMPurify, `TDD_01` §2.1).

```tsx
<span
  className="[&_mark]:bg-yellow-200 [&_mark]:font-medium"
  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(hit.snippet, { ALLOWED_TAGS: ['mark'], ALLOWED_ATTR: [] }) }}
/>
```

### 5.6 Search analytics

```typescript
// Zero-result queries reveal product gaps
async getZeroResultQueries(storeId: string, days = 30): Promise<ZeroResultQuery[]> {
  const rows = await this.prisma.client.$replica().$queryRaw<unknown[]>`
    SELECT data->>'query' AS query, COUNT(*)::int AS occurrences
    FROM analytics_events
    WHERE store_id = ${storeId}::uuid
      AND event = ${AnalyticsEventNames.SEARCH_PERFORMED}
      AND (data->>'resultCount')::int = 0
      AND timestamp > NOW() - make_interval(days => ${days})
    GROUP BY data->>'query'
    ORDER BY occurrences DESC
    LIMIT 50
  `
  return zeroResultQuerySchema.array().parse(rows)
}
```

Every search is tracked (`JobNames.TRACK_SEARCH`) with: query hash, entity, result count,
whether a result was clicked, and duration. The raw query is stored for the zero-result
report only, capped at 200 chars.

### 5.7 Elasticsearch migration path (MATURE)

The `SearchService` interface stays identical. Only the provider changes.

```
Phase 1  Dual-write: index to ES on every message event; Postgres stays authoritative
Phase 2  Backfill historical messages in batches
Phase 3  Switch reads to ES, keep dual-write for 30 days
Phase 4  Drop tsvector columns and their GIN indexes
```

---

## 6. Analytics performance

Analytics never queries raw tables at read time. It reads pre-aggregated rollups.

```
Raw events (analytics_events, conversations, orders)
  ↓ hourly rollup job at :05 (recomputes the previous 2 hours to absorb late webhooks)
metrics_hourly
  ↓ daily rollup job at 00:15 (recomputes the previous 2 days)
metrics_daily
  ↓
Dashboard API (sub-second reads)
```

```typescript
// libs/core/analytics/metrics-query.service.ts
const GRANULARITY_SOURCE: Record<TimeGranularityType, { table: Prisma.Sql; column: Prisma.Sql; trunc: string }> = {
  [TimeGranularity.HOUR]:  { table: Prisma.raw('metrics_hourly'), column: Prisma.raw('hour'), trunc: 'hour' },
  [TimeGranularity.DAY]:   { table: Prisma.raw('metrics_daily'),  column: Prisma.raw('date'), trunc: 'day' },
  [TimeGranularity.WEEK]:  { table: Prisma.raw('metrics_daily'),  column: Prisma.raw('date'), trunc: 'week' },
  [TimeGranularity.MONTH]: { table: Prisma.raw('metrics_daily'),  column: Prisma.raw('date'), trunc: 'month' },
}

async getMetric(params: {
  storeId: string
  metric: AnalyticsMetric
  from: Date
  to: Date
  granularity: TimeGranularityType
}): Promise<TimeSeriesResult> {
  const src = GRANULARITY_SOURCE[params.granularity]      // Identifiers come from a closed table, never from input

  const rows = await this.prisma.client.$replica().$queryRaw<unknown[]>`
    SELECT DATE_TRUNC(${src.trunc}, ${src.column}) AS timestamp,
           SUM(value)::float8 AS value,
           SUM(count)::int    AS count
    FROM ${src.table}
    WHERE store_id = ${params.storeId}::uuid AND metric = ${params.metric}
      AND ${src.column} >= ${params.from} AND ${src.column} <= ${params.to}
    GROUP BY DATE_TRUNC(${src.trunc}, ${src.column})
    ORDER BY timestamp ASC
  `
  const points = timeSeriesPointSchema.array().parse(rows)

  return { metric: params.metric, granularity: params.granularity, points, summary: this.computeSummary(points) }
}
```

`TimeGranularity`, `AnalyticsMetrics` and `AnalyticsEventNames` live in
`libs/core/analytics/analytics-constants.ts` (`TDD_11` §7.1).

**Comparison periods** (the "+12% vs previous 30 days" indicator) run both
queries in parallel against the same rollup tables.

---

## 7. Performance testing

The canonical scripts are in `TDD_13_Testing.md` §7 (`tests/load/inbox.load.js`, 200
concurrent users; `tests/load/webhook-burst.load.js`, 500 webhooks/s). The thresholds
there are the API latency budgets from §4.5.

Run against staging before every major release, and after any change to
indexing, caching or pagination.
