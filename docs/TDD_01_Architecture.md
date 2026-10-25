# TDD 01 — Architecture

> Part of the Omnichannel Commerce Platform TDD v1.1
> **MVP v1.2:** this file describes the full product. Before implementing from it, read `MVP_TRIM_CHECKLIST.md`;
> where the two disagree, the checklist wins.
> Covers: tech stack detail, monorepo structure, multi-tenancy, full data model

---

## 1. Monorepo structure (Nx)

```
platform/
├─ apps/
│  ├─ api/                       # NestJS REST API + WebSocket gateway (tenant + staff routes)
│  │  └─ src/modules/
│  │     ├─ auth/                # JWT, Google OAuth, sessions, verification tokens
│  │     ├─ tenancy/             # TenantGuard, PermissionGuard, organizations, stores, invitations
│  │     ├─ users/               # Profile, preferences
│  │     ├─ conversations/       # Lifecycle, assignment, tags, read state, routing rules
│  │     ├─ messages/            # Outbound send, inbound pipeline, idempotency
│  │     ├─ customers/           # Identities, merge/unmerge, notes, addresses
│  │     ├─ orders/
│  │     ├─ products/            # Products, variants, inventory
│  │     ├─ media/
│  │     ├─ channels/            # ChannelConnection CRUD, health, webhooks controller
│  │     ├─ plugins/             # Installations, plugin API (PluginApiKeyGuard)
│  │     ├─ webhooks/            # Tenant outbound webhooks + Stripe/Resend inbound controllers
│  │     ├─ widget/              # Public web-widget endpoints (TDD_10 §5.4)
│  │     ├─ billing/
│  │     ├─ notifications/
│  │     ├─ search/
│  │     ├─ analytics/
│  │     ├─ settings/            # Store settings, safety, business hours, snippets, api keys, retention
│  │     ├─ compliance/          # DSR, consent, audit log viewer
│  │     ├─ referrals/
│  │     ├─ ai/
│  │     ├─ support/
│  │     ├─ admin/               # Staff console API (/admin/v1), TDD_15
│  │     ├─ realtime/            # Socket.io gateway
│  │     └─ health/
│  ├─ web/                       # Next.js 16 App Router (tenant-facing)
│  ├─ admin/                     # Next.js 16 App Router (staff console, TDD_15)
│  ├─ widget/                    # Embeddable web-widget script bundle (vanilla TS, Vite build)
│  └─ worker/                    # NestJS application context: BullMQ processors + schedulers
│
├─ libs/
│  ├─ core/
│  │  ├─ domain/                 # Status enums, shared interfaces, Zod schemas
│  │  ├─ database/               # Prisma schema, prisma.config.ts, migrations, rollbacks, seed, PrismaService
│  │  ├─ events/                 # Event names, payload types, EventBusModule
│  │  ├─ cache/                  # Redis + memory cache, CacheKeys, invalidation listener
│  │  ├─ queues/                 # QueueNames, JobNames, Schedules, job payload types, QueuesModule
│  │  ├─ storage/                # S3 abstraction, key builders, upload constants
│  │  ├─ email/                  # Email provider + React Email templates
│  │  ├─ logger/                 # Pino setup, correlation id
│  │  ├─ metrics/                # Prometheus, MetricNames
│  │  ├─ config/                 # Typed env validation (Zod)
│  │  ├─ errors/                 # ErrorCodes, PlatformException, GlobalExceptionFilter
│  │  ├─ auth/                   # Permissions, RolePresets, guard decorators
│  │  ├─ audit/                  # AuditAction, AuditService
│  │  ├─ admin/                  # StaffRoles, StaffPermissions, StaffRolePresets
│  │  ├─ realtime/               # RealtimeEvents, RoomNames, RealtimeService, PresenceService
│  │  ├─ search/                 # Search constants and service
│  │  ├─ notifications/          # Notification constants and service
│  │  ├─ billing/                # PlanLimits, AvailableChannels, EffectivePlanLimitsService, Stripe
│  │  ├─ compliance/             # DSR, retention, consent
│  │  ├─ referrals/              # Partner and commission logic, referral enums
│  │  ├─ ai/                     # AI constants, AIService, credit service, prompts
│  │  ├─ crypto/                 # AES-256-GCM helpers for credentials and API keys
│  │  └─ i18n/                   # Locales, formatters, server-side translator
│  │
│  ├─ plugins/
│  │  ├─ sdk/                    # Public plugin interfaces (ChannelPlugin, ChannelEvent, …)
│  │  └─ runtime/                # Plugin registry, contract validation
│  │
│  ├─ channels/
│  │  ├─ meta/                   # Shared Meta Graph API client + MetaChannelPlugin base
│  │  ├─ whatsapp/
│  │  ├─ instagram/
│  │  ├─ messenger/
│  │  ├─ web-widget/             # Server side of the widget channel
│  │  └─ email/                  # Email-to-conversation bridge (Resend inbound)
│  │
│  └─ api-client/                # Typed HTTP client + QueryKeys (web, admin, future mobile)
│
├─ tests/
│  ├─ builders/
│  ├─ fixtures/
│  ├─ helpers/
│  ├─ integration/
│  ├─ e2e/
│  ├─ security/
│  ├─ contracts/
│  └─ load/
│
├─ scripts/
├─ docker-compose.yml
├─ nx.json
├─ eslint.config.js
├─ prisma.config.ts              # Re-exports libs/core/database/prisma.config.ts
└─ package.json
```

**Module boundary rules (enforced by `@nx/enforce-module-boundaries`, `TDD_14_DX.md` §6):**

| Source tag | May depend on |
|---|---|
| `scope:api`, `scope:worker` | `scope:core`, `scope:plugins`, `scope:channels` |
| `scope:web`, `scope:admin` | `scope:core-domain` (types, enums, schemas, constants only), `scope:api-client` |
| `scope:widget` | `scope:core-domain` |
| `scope:channels` | `scope:plugins`, `scope:core` |
| `scope:plugins` | `scope:core-domain` |
| `scope:core` | `scope:core` |

`libs/core/*` never imports from `apps/*`. Frontend apps never import `libs/core/config`,
`libs/core/database` or anything that touches Node-only modules — they get the
`scope:core-domain` subset (`domain`, `events` names, `auth` constants, `api` routes,
`i18n`, `notifications` constants) which is published as the `@platform/core-domain`
path alias.

---

## 2. Tech stack detail and rationale

### 2.1 Frontend — Next.js 16.4 (App Router)

| Choice | Version | Rationale |
|--------|---------|-----------|
| App Router + RSC | `next@16.4.3` | Server Components reduce client bundle; inbox lists render server-side. Request interception uses the `proxy.ts` convention (Next 16 renamed `middleware.ts`). |
| Server Actions | — | Mutations without hand-written API glue for simple forms |
| Streaming + Suspense | — | Inbox shell renders instantly, panels stream in |
| React | `react@19.2.8`, `react-dom@19.2.8` | — |
| Tailwind + shadcn/ui | `tailwindcss@4.3.3`, `shadcn@4.20.1` (CLI) | Copy-in components, no external dependency, Radix primitives are WCAG-accessible |
| Lucide React | `lucide-react@1.39.0` | Consistent SVG icon set. **No emojis in product UI.** |
| Zustand | `zustand@5.0.15` | Global client state: session, current store, UI state (sidebar collapsed) |
| TanStack Query | `@tanstack/react-query@5.102.8` | Server state: conversations, orders, customers. Invalidated by WebSocket events through `QueryKeys` (`TDD_02` §14) |
| TanStack Virtual | `@tanstack/react-virtual@3.13.12` | Virtualized conversation list |
| React Hook Form + Zod | `react-hook-form@7.87.0`, `zod@4.6.7` | Same Zod schemas shared with backend DTO validation |
| Socket.io-client | `socket.io-client@4.8.3` | Realtime, with Redis Adapter on the server for multi-instance |
| next-intl | `next-intl@4.5.3` | i18n (`TDD_09` §15) |
| cmdk | `cmdk@1.1.1` | Command palette |
| DOMPurify | `dompurify@3.2.6` | Sanitizing search snippets (`<mark>` only) |
| Serwist | `serwist@9.2.1`, `@serwist/next@9.2.1` | Service worker build for the PWA (`TDD_09` §16.3) — replaces the hand-written `sw.js` |
| Storybook | `storybook@10.6.0`, `@storybook/nextjs@10.6.0`, `@storybook/addon-a11y@10.6.0` | Component development/docs in isolation. `@storybook/addon-essentials` is **not** installed — built into core since v9 |

**Frontend structure (`apps/web`):**
```
apps/web/
├─ app/
│  ├─ (auth)/
│  │  ├─ login/
│  │  ├─ signup/
│  │  ├─ verify-email/
│  │  ├─ forgot-password/
│  │  ├─ reset-password/
│  │  └─ invitations/[token]/
│  ├─ onboarding/
│  ├─ s/[storeId]/                 # Everything tenant-scoped lives under the store id
│  │  ├─ layout.tsx                # Validates membership, sets X-Store-Id for the api client
│  │  ├─ inbox/
│  │  ├─ customers/
│  │  ├─ orders/
│  │  ├─ products/
│  │  ├─ analytics/
│  │  └─ settings/
│  ├─ org/                         # Organization scope: billing, usage, stores, audit log, referrals
│  ├─ account/                     # User scope: profile, preferences, notifications, security
│  ├─ proxy.ts                     # Referral attribution, auth redirects (Next 16 convention)
│  └─ providers.tsx
├─ components/
│  ├─ ui/                          # shadcn primitives
│  ├─ inbox/
│  ├─ orders/
│  ├─ customers/
│  ├─ settings/
│  └─ shared/
├─ hooks/
├─ lib/
│  ├─ env.ts                       # NEXT_PUBLIC_* Zod schema (TDD_02 §9.2)
│  ├─ auth.ts
│  ├─ websocket.ts
│  ├─ offline-queue.ts
│  ├─ upload.ts
│  └─ utils.ts
├─ messages/                       # i18n JSON files (en.json is the source of truth)
├─ public/
│  ├─ manifest.json
│  └─ icons/
└─ sw.ts                           # Serwist source, compiled to public/sw.js at build
```

`apps/admin` mirrors this shape with `app/organizations`, `app/plans`, `app/ai`,
`app/plugins`, `app/feature-flags`, `app/audit-log` and its own copied `components/ui/`
(`TDD_15_InternalAdmin.md` §1).

### 2.2 Backend — NestJS 12

| Choice | Version | Rationale |
|--------|---------|-----------|
| NestJS | `@nestjs/core@12.0.1`, `@nestjs/common@12.0.1`, `@nestjs/platform-express@12.0.1` | DI container, guards, interceptors and module system map cleanly to a modular monolith. Express adapter (not Fastify) — broader plugin/middleware compatibility. `NestFactory.create(AppModule, { rawBody: true })` because Stripe, Resend and Meta webhooks verify the raw body |
| Prisma | `prisma@7.10.1` (CLI), `@prisma/client@7.10.1`, `@prisma/adapter-pg@7.10.1`, `pg@8.16.3`, `@prisma/extension-read-replicas@0.5.0` | Prisma 7 requires a driver adapter; connection string and migrations config live in `prisma.config.ts`. Generator is `prisma-client` with an explicit `output`. Read replica routing via the official extension |
| PostgreSQL | `18.6` (server) | Relational integrity, JSONB for flexible metadata, mature FTS, RLS support |
| Redis | `8.10.1` (server), `ioredis@6.0.0` (client) | Cache, BullMQ backing store, Socket.io pub/sub, presence. `ioredis` chosen over the `redis` package — wider adoption with BullMQ/NestJS, richer cluster/sentinel support. **Every Redis client in the codebase is ioredis**, including the Socket.io adapter |
| BullMQ | `bullmq@6.3.4`, `@nestjs/bullmq@12.0.0`, `@bull-board/api@9.10.5`, `@bull-board/express@9.10.5`, `@bull-board/ui@9.10.5` | Reliable job processing with retries, backoff, DLQ. Queues and workers are registered through `@nestjs/bullmq` (no module-level `new Queue()`). Bull Board is mounted on Express by hand with `@bull-board/api` and the Express adapter (not `@bull-board/nestjs`, see `MVP_TRIM_CHECKLIST.md` §3 "Auth build details"), behind a JWT plus the `BULL_BOARD_ADMIN_EMAILS` allowlist in the MVP (`StaffAuthGuard` is Phase 2, `TDD_15`) |
| Event bus | `@nestjs/event-emitter@3.0.1` | In-process domain events (`@OnEvent`) |
| Scheduling | `@nestjs/schedule@12.0.2` | `@Cron` schedulers — **registered only in `apps/worker`** |
| Rate limiting | `@nestjs/throttler@6.7.1` and a `ThrottlerStorage` of our own over ioredis | Redis-backed so limits hold across instances. `@nest-lab/throttler-storage-redis` declares no Nest 12, so the storage is ours (an atomic Lua script), as `MetricsModule` replaces `@willsoto/nestjs-prometheus` |
| Health | `@nestjs/terminus@12.1.0` | Liveness/readiness indicators. Terminus 11 does not declare Nest 12; 12 replaced the `HealthIndicator` base class with `HealthIndicatorService` |
| Passport | `passport@0.7.0`, `passport-jwt@4.0.1`, `passport-google-oauth20@2.0.0`, `openid-client@6.6.2`, `@nestjs/passport@12.0.0`, `@nestjs/jwt@12.0.1` | JWT strategy for the tenant API, Google OAuth for customer login, generic OIDC (Google Workspace / Okta) for staff SSO |
| Supporting `@nestjs/*` | `@nestjs/websockets@12.0.1`, `@nestjs/platform-socket.io@12.0.1`, `@nestjs/swagger@12.0.1`, `nestjs-zod@5.0.1` | WebSocket gateway, OpenAPI generated from the shared Zod schemas |
| Socket.io | `socket.io@4.8.3`, `@socket.io/redis-adapter@8.3.0` | Multi-instance broadcast |
| Logger | `pino@10.3.1`, `nestjs-pino@5.1.0`, `pino-http@11.0.0`, `pino-pretty@13.1.3` (dev only) | See `TDD_04_Observability.md` §1 — Pino, not Winston |
| Env loading | `dotenv-flow@4.1.0` | `.env` / `.env.local` for api and worker in development only |
| Security headers | `helmet@8.3.0` | API hardening; the web CSP lives in Next (`TDD_05` §6) |
| Image processing | `sharp@0.35.4` | — |
| Virus scanning | `clamscan@2.4.0` + `clamav/clamav` container | Inbound and uploaded files (`TDD_07` §6.5) |
| HTTP client | `axios@1.20.0` | Outbound calls to Meta Graph API, tenant webhooks |
| Email | `resend@6.25.0`, `react-email@6.9.3` (components and `render`), `nodemailer@10.2.1` (dev-only Mailpit provider) | Outbound + inbound (Resend Receiving for the email channel) |
| Push | `web-push@3.6.7` | VAPID web push |
| Cache | `node-cache@5.1.2` | L1 in-memory cache |
| Dates | `date-fns@4.1.0`, `date-fns-tz@3.2.0` | `toZonedTime`/`fromZonedTime` (v3 API) |
| PDF | `@react-pdf/renderer@4.3.0` | Scheduled reports, order print documents |
| Meta Graph API | `v23.0` (`META_GRAPH_API_VERSION`) | REST version string, not a package — bump with Meta's deprecation calendar (each version lives ~2 years) |

### 2.3 Data layer

**Connection pooling:**
```
Prisma (pg adapter) → PgBouncer 1.25 (6432, transaction mode) → PostgreSQL 18.6 (5432)

DATABASE_URL="postgresql://user:pass@pgbouncer:6432/platform"
DIRECT_DATABASE_URL="postgresql://user:pass@postgres:5432/platform"   # migrations only
```
PgBouncer tuning: see `TDD_08_Performance.md` §2.6. The `pg` driver uses unnamed prepared
statements, which are safe in transaction mode; no `pgbouncer=true` flag is needed with
Prisma 7 driver adapters.

```typescript
// libs/core/database/prisma.config.ts
import 'dotenv-flow/config'
import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: 'libs/core/database/prisma/schema.prisma',
  migrations: {
    path: 'libs/core/database/prisma/migrations',
    seed: 'tsx libs/core/database/prisma/seed.ts',
  },
  datasource: {
    url: process.env.DIRECT_DATABASE_URL,   // CLI only, bypasses PgBouncer; DATABASE_URL is platform_app, which cannot run migrations
  },
})
```

```typescript
// libs/core/database/src/prisma.service.ts
import { PrismaClient } from './generated/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { readReplicas } from '@prisma/extension-read-replicas'

function createClient(): ExtendedPrismaClient {
  const primary = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL, max: 20 }) })
  // With a driver adapter the extension takes client instances, not URLs
  const replica = env.DATABASE_REPLICA_URL
    ? new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_REPLICA_URL, max: 20 }) })
    : primary                                            // Replica == primary in dev and in the MVP
  return primary.$extends(readReplicas({ replicas: [replica] }))
}

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  readonly client = createClient()   // Composition, not inheritance: $extends returns a new type
  async onModuleInit(): Promise<void> { await this.client.$connect() }
  async onModuleDestroy(): Promise<void> { await this.client.$disconnect() }
}
```

Services inject `PrismaService` and use `this.prisma.client.<model>`; reads that tolerate
replication lag use `this.prisma.client.$replica().<model>` (`TDD_08` §2.5).

**Redis topology:**
```
Phase 1 (SCAFFOLD / early PRODUCTION): single Redis instance
  cache + queue + pub/sub

Phase 2 (MATURE): split by purpose
  Redis Cache  (6379) — allkeys-lru, 2GB max
  Redis Queue  (6380) — noeviction, AOF enabled
```

**Object storage:**
```
Phase 1: AWS S3 (managed) — @aws-sdk/client-s3@3.1125.0, @aws-sdk/s3-request-presigner@3.1125.0
         SeaweedFS locally, same SDK (S3_ENDPOINT + S3_FORCE_PATH_STYLE=true)
Phase 2: MinIO self-hosted, only if S3 cost becomes material

Bucket layout (keys are built ONLY by libs/core/storage/storage-keys.ts):
platform-production/
├─ stores/{storeId}/messages/{mediaId}/{filename}          # chat attachments, before or after the message exists
├─ stores/{storeId}/messages/{mediaId}/variants/{full|medium|thumb}.webp
├─ stores/{storeId}/products/{productId}/{mediaId}/{filename}
├─ stores/{storeId}/orders/{orderId}/{mediaId}/{filename}   # proof of delivery, printed docs
├─ stores/{storeId}/exports/{exportId}/{filename}
├─ users/{userId}/avatar/{mediaId}/{filename}
├─ compliance/dsr/{requestId}/export.zip
└─ audit/{year}/{month}/audit-logs.jsonl.gz                 # cold export, TDD_05 §9.3
```

The first path segment of every tenant key is `stores/{storeId}`. `confirmUpload` and every
download path verify that prefix against the current store before touching the object.

### 2.4 Locked dependency versions (all phases)

> **Rule:** these versions are the source of truth for the entire platform. Every other
> TDD and every implementation step must use these exact versions — do not upgrade,
> downgrade, or substitute without updating this table first and stating the reason.
> Pin the **exact version** in `package.json` (no `^`/`~`); `pnpm-lock.yaml` mirrors it.
>
> During Step 0.1 the executor resolves every row with Context7 / the npm registry. If a
> pinned version does not exist or has a known breaking incompatibility, the executor
> **stops, fixes this table, and states the reason in the commit** before installing.

**Runtime / language / monorepo**

| Package | Version |
|---|---|
| Node.js | `24.20.0` (engines `>=22`) — used in Docker images, CI and Cloud Build |
| TypeScript | `5.9.3` — TypeScript 7.x is not adopted until `typescript-eslint`, `ts-jest`, Nx and NestJS declare support |
| Nx | `23.2.0` |
| pnpm | `11.25.0` |

**Frontend**

| Package | Version |
|---|---|
| `next` | `16.4.3` |
| `react` / `react-dom` | `19.2.8` |
| `tailwindcss` | `4.3.3` |
| `shadcn` (CLI) | `4.20.1` |
| `lucide-react` | `1.39.0` |
| `zustand` | `5.0.15` |
| `@tanstack/react-query` | `5.102.8` |
| `@tanstack/react-virtual` | `3.13.12` |
| `react-hook-form` | `7.87.0` |
| `@hookform/resolvers` | `5.2.2` |
| `zod` | `4.6.7` |
| `socket.io-client` | `4.8.3` |
| `next-intl` | `4.5.3` |
| `cmdk` | `1.1.1` |
| `dompurify` | `3.2.6` |
| `react-textarea-autosize` | `8.5.9` |
| `serwist`, `@serwist/next` | `9.2.1` |
| `storybook`, `@storybook/nextjs`, `@storybook/addon-a11y` | `10.6.0` |

**Backend**

| Package | Version |
|---|---|
| `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express` | `12.0.1` |
| `@nestjs/jwt` | `12.0.1` |
| `@nestjs/passport` | `12.0.0` |
| `@nestjs/websockets`, `@nestjs/platform-socket.io` | `12.0.1` |
| `@nestjs/swagger` | `12.0.1` |
| `@nestjs/event-emitter` | `3.0.1` |
| `@nestjs/schedule` | `12.0.2` |
| `@nestjs/throttler` | `6.7.1` (the `6.4.0` line is replaced: it predates Nest 12) |
| `@nestjs/terminus` | `12.1.0` |
| `@nestjs/bullmq` | `12.0.0` |
| `nestjs-zod` | `5.0.1`, **not installed in Step 1.1**: it declares Nest up to 11. The validation pipe is our own `ZodValidationPipe`; decide again when OpenAPI generation is built (`TDD_14`) |
| `reflect-metadata` | `0.2.2` — peer of `@nestjs/common` |
| `rxjs` | `7.8.2` — peer of `@nestjs/common` |
| `prisma` (CLI), `@prisma/client`, `@prisma/adapter-pg` | `7.10.1` |
| `@prisma/extension-read-replicas` | `0.5.0` |
| `pg` | `8.16.3` |
| `ioredis` | `6.0.0` |
| `bullmq` | `6.3.4` |
| `@bull-board/api`, `@bull-board/express`, `@bull-board/ui` | `9.10.5` (9.6.1 declares Nest up to 11 and BullMQ 5) |
| `socket.io` | `4.8.3` |
| `@socket.io/redis-adapter` | `8.3.0` |
| `passport` | `0.7.0` |
| `passport-jwt` | `4.0.1` |
| `passport-google-oauth20` | `2.0.0` |
| `openid-client` | `6.6.2` |
| `helmet` | `8.3.0` |
| `sharp` | `0.35.4` |
| `clamscan` | `2.4.0` |
| `axios` | `1.20.0` |
| `nestjs-pino` | `5.1.0` |
| `pino-http` | `11.0.0` |
| `web-push` | `3.6.7` |
| `node-cache` | `5.1.2` |
| `date-fns` | `4.1.0` |
| `date-fns-tz` | `3.2.0` |
| `dotenv-flow` | `4.1.0` |
| `@react-pdf/renderer` | `4.3.0` |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | `3.1125.0` |
| `ipaddr.js` | `2.2.0` — SSRF address classification (`TDD_07` §2) |
| `@node-rs/argon2` | `2.0.2` — password hashing (Argon2id) |
| `email-reply-parser` | `2.0.0` — quoted-history stripping for the email channel (`TDD_10` §5.5) |

**Email**

| Package | Version |
|---|---|
| `resend` | `6.25.0` |
| `react-email` (components and `render`; `@react-email/components` and `@react-email/render` are deprecated since React Email 6) | `6.9.3` |
| `nodemailer` (the dev-only Mailpit provider, SMTP; ships its own types) | `10.2.1` |

**Infra — Phase 1 (not npm packages; version = server/service)**

| Component | Version |
|---|---|
| Docker Engine | `29.7.2` |
| Docker Compose | `5.5.0` |
| PostgreSQL | `18.6` (`postgres:18.6-alpine`) |
| Redis | `8.10.1` (`redis:8.10.1-alpine`) |
| PgBouncer | `1.25` (`edoburu/pgbouncer:v1.25.2-p0`; the `1.25.0` tag does not exist, the image tags carry a `v` and a `-pN` suffix) |
| SeaweedFS | `chrislusf/seaweedfs:4.48` (local and CI S3-compatible storage; MinIO stopped publishing images in October 2025, so its Docker Hub and Quay tags are gone) |
| Mailpit | `axllent/mailpit:v1.28` (local mail catcher; MailHog is unmaintained) |
| ClamAV | `clamav/clamav:1.5.4-debian` (the plain `1.5` tag has no arm64 build) |
| AWS S3 | managed service |

**Infra — Phase 2 / MATURE (out of scope until `IMPLEMENTATION_PLAN.md` says otherwise)**

| Component | Version |
|---|---|
| Kubernetes | pin when migration is actually scheduled |
| MinIO (production) | pin when adopted |
| Elasticsearch | pin when adopted (`TDD_08` §5.7) |

React Native and Elasticsearch clients are **not** added to `package.json` until their
phase starts (YAGNI).

**Observability**

| Package | Version |
|---|---|
| `pino` | `10.3.1` |
| `pino-pretty` (dev only) | `13.1.3` |
| `@prometheus-io/client` | `0.16.1` — `prom-client` is deprecated upstream in favor of this package |
| `@willsoto/nestjs-prometheus` | `6.0.2` — pinned to a release that depends on `@prometheus-io/client`; if the installed release still requires `prom-client`, write a thin `MetricsModule` over `@prometheus-io/client` instead of adding `prom-client` back |
| Grafana | `13.2.1` (service) |
| `@sentry/nestjs` | `11.5.0` — the 10.x line does not declare Nest 12; `@sentry/node` comes with it. `@sentry/profiling-node` is not used: its native binary is loaded by path at run time and cannot be bundled (MVP_TRIM_CHECKLIST.md) |
| `@sentry/nextjs` | `11.5.0` (installed with the web observability, Step 3.x) |

**Third-party SDKs**

| Package | Version |
|---|---|
| `stripe` | `22.6.1` — Billing Meters API; usage records were removed in API version 2025-03-31 |
| `@anthropic-ai/sdk` | `0.123.0` |
| `openai` | `7.9.0` — installed only when the OpenAI adapter is wired (`TDD_12` §2) |
| Meta Graph API | `v23.0` (REST API version string, `META_GRAPH_API_VERSION`) |

**Testing**

| Package | Version |
|---|---|
| `jest` | `30.5.1` |
| `ts-jest` | `29.4.12` |
| `jest-mock-extended` | `4.0.0` |
| `@nestjs/testing` | `12.0.1` |
| `jest-environment-node` | `30.5.1` |
| `@types/jest` | `30.0.0` |
| `ts-node` | `10.9.1` — Jest loads `jest.config.cts` through it |
| `@playwright/test` | `1.62.1` |
| `supertest` | `7.2.2` |
| `@types/supertest` | `7.2.1` |
| `@faker-js/faker` | `10.1.0` |
| k6 | `1.2.1` (binary) |

**Dev tooling**

| Package | Version |
|---|---|
| `eslint` | `10.9.1` — flat config only (`eslint.config.js`) |
| `typescript-eslint` | `8.69.0` |
| `@nx/eslint-plugin` | `23.2.0` |
| `eslint-plugin-import-x` | `4.16.1` |
| `eslint-import-resolver-typescript` | `4.4.5` — import-x loads it by name; without it lint fails when `NODE_ENV=test` |
| `prettier` | `3.9.6` |
| `prettier-plugin-tailwindcss` | `0.8.1` |
| `husky` | `9.1.7` |
| `lint-staged` | `17.4.1` |
| `@commitlint/cli`, `@commitlint/config-conventional` | `21.2.2` |
| `tsx` | `4.20.5` |
| `@eslint/js` | `10.0.1` |
| `@next/eslint-plugin-next` | `16.4.3` |
| `@nx/eslint`, `@nx/jest`, `@nx/js` | `23.2.0` |
| `@nestjs/cli` | `12.0.10` — builds `api` and `worker` with the Rspack builder, the default of Nest 12 for monorepos |
| `@rspack/core` | `2.2.9` |
| `webpack-node-externals`, `tsconfig-paths-webpack-plugin` | `3.0.0`, `4.2.0` — required by the Rspack builder of the Nest CLI |
| `@types/express` | `5.0.6` |
| `@types/node` | `24.19.2` |
| `@types/react` | `19.2.18` |
| `@types/react-dom` | `19.2.3` |
| gitleaks (Go binary, not npm) | `v8.28.0` — installed via Homebrew/CI download, invoked as `gitleaks`, never through pnpm |

**Explicit decisions behind the choices above (ADR-style, so nobody re-litigates these):**
- **`ioredis` over `redis`** — wider BullMQ/NestJS ecosystem adoption, richer Sentinel/Cluster support. Applies to every Redis consumer including `@socket.io/redis-adapter`.
- **`@nestjs/platform-express` over `platform-fastify`** — broader middleware/plugin compatibility; performance ceiling of Fastify not needed at target scale.
- **`@bull-board/nestjs` + `@bull-board/express` adapter** — mounts as a Nest module so the dashboard route carries `StaffAuthGuard` + `StaffPermissionGuard` (`TDD_15` §2). It is a staff tool; tenant guards do not apply.
- **`resend` only, no SendGrid/SES/Postmark fallback wired** — simplicity for Phase 1; the `EmailProvider` interface in `TDD_07_Queues.md` §5.1 still allows adding a provider later without touching callers. No other provider class exists in the codebase until it is needed.
- **`@prometheus-io/client` instead of `prom-client`** — `prom-client` carries an npm deprecation notice pointing to this package.
- **`prisma@7.10.1` with `@prisma/adapter-pg`** — Prisma 7 removed the Rust engine and client middleware; driver adapters and `$extends` are the supported path.
- **TypeScript 5.9, not 7** — `typescript-eslint@8` declares `typescript >=4.8.4 <6.1.0`; ts-jest and Nx executors have not certified 7.x. Revisit when all three do.
- **`@storybook/addon-essentials` deliberately not installed** — its features shipped into Storybook core as of v9+.

---

## 3. Multi-tenancy

### 3.1 Strategy: shared database + row-level security

**Decision:** one database, `organizationId` / `storeId` on every tenant-scoped table.

**Rationale:**
- Scales to thousands of tenants without operational explosion
- One migration, one backup, one connection pool
- Cross-tenant analytics remain possible for internal use
- Rejected alternative: database-per-tenant (operationally unmanageable at our target scale)

**Hierarchy:**
```
Organization  ("Mi Empresa")          ← owns billing, Stripe customer, AI credits
  ├─ Store A  ("Tienda Principal")    ← owns inbox, customers, orders, channel connections
  ├─ Store B  ("Tienda Escalón")
  └─ Store C  ("Tienda Santa Ana")

A User holds a Membership per Store, each with its own Role.
Example: Juan is Admin in Store A and Agent in Store B.
```

### 3.2 Isolation — three layers

**Layer 1 — TenantGuard (request scoped).** The active store travels in the
`X-Store-Id` header. Never in the body, never in the query string — a client that puts it
there is ignored, and a service that reads it from anywhere but the guard context fails
review.

```typescript
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RedisCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const user = request.user                       // Set by AuthGuard (JWT)
    const storeId = request.header(TenantHeaders.STORE_ID)

    if (!storeId) {
      throw new PlatformException(ErrorCodes.TENANT_HEADER_MISSING, 'X-Store-Id header is required', 400)
    }

    const tenant = await this.cache.getOrSet(
      CacheKeys.agent.permissions(user.id, storeId),
      () => this.loadTenantContext(user.id, storeId),
      CacheTTL.VERY_SHORT
    )

    if (!tenant) {
      throw new PlatformException(ErrorCodes.TENANT_ACCESS_DENIED, 'No access to this store', 403)
    }

    if (tenant.organization.accessLevel === AccessLevel.SUSPENDED) {
      throw new PlatformException(ErrorCodes.SUBSCRIPTION_SUSPENDED, 'Organization suspended', 402)
    }

    request.store = tenant.store
    request.organization = tenant.organization      // includes subscription
    request.membership = tenant.membership
    request.permissions = tenant.permissions
    request.accessLevel = request.impersonation?.mode === ImpersonationMode.READ_ONLY
      ? AccessLevel.READ_ONLY
      : tenant.organization.accessLevel
    return true
  }

  private async loadTenantContext(userId: string, storeId: string): Promise<TenantContext | null> {
    const membership = await this.prisma.client.membership.findFirst({
      where: { userId, storeId, status: MembershipStatus.ACTIVE },
      include: {
        store: { include: { organization: { include: { subscription: true } } } },
        role: { include: { permissions: true } },
      },
    })
    if (!membership) return null
    return {
      store: membership.store,
      organization: membership.store.organization,
      membership,
      permissions: membership.role.permissions.map(p => p.name as Permission),
    }
  }
}

export const TenantHeaders = { STORE_ID: 'x-store-id' } as const
```

`CacheInvalidationListener` (`TDD_08` §1.3) drops the cached context on
`MEMBER_ROLE_CHANGED`, `MEMBER_REMOVED`, `ROLE_UPDATED`, `SUBSCRIPTION_UPDATED` and
`ORGANIZATION_ACCESS_LEVEL_CHANGED`.

**`AccessLevelGuard`** runs after `TenantGuard` on every mutating handler: when
`request.accessLevel` is `READ_ONLY` (dunning, `TDD_11` §5, or read-only impersonation,
`TDD_15` §4) any `POST`/`PATCH`/`PUT`/`DELETE` throws `TENANT_READ_ONLY`, except handlers
decorated `@AllowReadOnly()` (billing portal, ending an impersonation session).

**Layer 2 — forced storeId in services:**
```typescript
// WRONG — unscoped query
async findAll() {
  return this.prisma.client.conversation.findMany()
}

// CORRECT — always scoped
async findAll(storeId: string) {
  return this.prisma.client.conversation.findMany({ where: { storeId } })
}

// CORRECT — storeId forced from guard context, never from client body
@Post(ApiRoutes.conversations.list)
async create(@CurrentStore() store: Store, @Body(new ZodValidationPipe(createConversationSchema)) data: CreateConversationInput) {
  return this.conversationsService.create({ ...data, storeId: store.id })
}
```

Zod schemas for request bodies never declare `storeId` / `organizationId`; a body that
carries one is stripped by `z.object()` before it reaches a service.

**Layer 3 — PostgreSQL Row-Level Security.** In the v1.2 MVP the roles are created in Step 0.4 and the policies enabled in Step 7.1 (see `MVP_TRIM_CHECKLIST.md`, D16).

RLS is defence in depth against a missed `where: { storeId }`. PgBouncer runs in transaction mode, so a
tenant variable only survives **inside one transaction**. The mechanism below was **verified with a
throwaway spike on 2026-10-24** (PostgreSQL 18, PgBouncer in transaction mode authenticating roles with
`auth_user` and `auth_query`, Prisma 7.10.1 with `@prisma/adapter-pg` 7.10.1). The v1.1 snippet that used to
be here, a `tenantRls` extension whose nested `client.$transaction` ran `query(args)` outside the
transaction, **does not work**: the context never reaches the query and every read returns no rows.

**The mechanism: one interactive transaction per unit of work, `set_config` as its first statement.**

```typescript
// libs/core/database/src/prisma.service.ts (the tenant part)
type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]
const tenantTx = new AsyncLocalStorage<{ tx: Tx; ctx: TenantContext }>()

// Called by the tenant interceptor after TenantGuard, around the whole handler.
tenantTransaction<T>(ctx: TenantContext, fn: () => Promise<T>, options?: TxOptions): Promise<T> {
  return this.base.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.store_ids', ${ctx.storeIds.join(',')}, true)`
    await tx.$executeRaw`SELECT set_config('app.organization_ids', ${ctx.organizationIds.join(',')}, true)`
    return tenantTx.run({ tx, ctx }, fn)
  }, { maxWait: 5_000, timeout: 15_000, ...options })
}

get client() { return tenantTx.getStore()?.tx ?? this.base }              // what services use
transaction<T>(fn: (tx: Tx) => Promise<T>) {                                // joins the tenant transaction when there is one
  const s = tenantTx.getStore()
  return s ? fn(s.tx) : this.base.$transaction(fn)
}
```

```sql
-- Generated by scripts/rls.sql from the schema, for every table that has store_id.
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;

CREATE POLICY conversations_isolation ON conversations
  USING      (store_id = ANY (string_to_array(nullif(current_setting('app.store_ids', true), ''), ',')::uuid[]))
  WITH CHECK (store_id = ANY (string_to_array(nullif(current_setting('app.store_ids', true), ''), ',')::uuid[]));
```

**What the spike established** (each item was run against the stack above; the spike itself is not kept in the repository):

- **The per-operation alternative is rejected.** An extension that wraps every operation as
  `$transaction([set_config, query(args)])` does deliver the context, but it **breaks atomicity**: inside an
  interactive transaction opened by a service, a write was committed even though the transaction threw, because
  the extension's batch ran as its own transaction. It also costs about five times the latency per query
  (1.75 ms against 0.35 ms) and covers raw SQL only when installed at the top level, not under `$allModels`.
  Services (inventory reservations, order creation with allocations) rely on atomic transactions, so this is a
  data-integrity bug and not a tuning issue.
- **The per-unit-of-work transaction is atomic and free.** A rolled-back write left no row, the latency per query
  inside it equals a plain query (0.36 ms), raw SQL, parallel queries on the same transaction and nested creates
  work, the context is gone after the commit, and 60 concurrent requests of two tenants through a pool of four
  server connections never saw each other's rows.
- **Never use a session-level setting** (`set_config(..., false)` or `SET`): in transaction mode it stays on a
  pooled server connection and was seen by unrelated queries. The only allowed form is `set_config(..., true)`;
  a lint rule forbids `false`.
- **Prisma queries are lazy**: they run when awaited, so the `await` must happen **inside** the
  `AsyncLocalStorage` scope (`tenantTx.run`). Never return an un-awaited query out of the scope.
- **A tenant transaction holds a database connection for its whole duration.** The default limits (`maxWait`
  2 s, `timeout` 5 s) abort a longer one with "a commit cannot be executed on an expired transaction", so they
  are set deliberately above, and **no external I/O (carrier or channel APIs, S3, e-mail) runs inside a tenant
  transaction**: such work is queued and runs in the worker as `platform_worker`, which needs no transaction.
  Twelve 800 ms transactions over a pool of four connections complete in three waves, so the pool size and
  these limits are capacity settings (`TDD_08`).
- **Policy behaviour:** a connection with no context sees **no rows** (not an error); an `INSERT` into another
  store is refused by `WITH CHECK` (error `42501`); an `UPDATE` or `DELETE` by id of another store's row
  affects 0 rows and a `findUnique` by id returns nothing (it looks like a 404); organization-scoped tables follow
  `app.organization_ids`; `audit_logs` refuses `UPDATE` and `DELETE` to `platform_app` while `platform_worker`
  may delete; a `SECURITY DEFINER` function returns a store id from an API-key hash with **no** tenant context;
  PgBouncer authenticates every role through `auth_query`.

- `app.store_ids` carries every store the user is a member of; the guard sets it from the membership list, so
  cross-store screens (org billing, multi-store switcher) keep working.
- Two database roles: `platform_app` (subject to RLS, used by `apps/api` tenant requests) and `platform_worker`
  (`BYPASSRLS`, used by `apps/worker` and inbound webhooks, which are scoped in code and audited). Never a superuser.
- **Child tables:** large ones carry their **own denormalized `store_id`** and a plain index-friendly policy
  (`messages`, `inventory_movements`, as the models already do). Small child tables without `store_id`
  (`order_items`, transfer and count lines) are protected through the parent with
  `USING (EXISTS (SELECT 1 FROM parent p WHERE p.id = child.parent_id))`, which the spike showed isolates correctly
  because the parent's own policy applies inside the subquery; its plan hashes the visible parents, so the cost
  grows with the store's number of parents and it is not used for big tables. `scripts/rls.sql` lists each policy.

**Tenant isolation is verified by mandatory automated tests.** See `TDD_13_Testing.md` §6.

---

## 4. Complete Prisma schema

Conventions (`TDD_02` §10): every model has `@@map("<snake_case_plural>")`, every
multi-word field has `@map`. Money is stored as integer cents. States are `String` columns
backed by the enums in `TDD_02` §5. Generated `tsvector` columns and CHECK constraints are
added by the raw SQL migration in §5 and are **not** declared here.

```prisma
// The CJS output has no import.meta and bare imports, so the Jest suites (compiled as CJS) and the
// ESM code run by tsx load the same generated client. The ESM output breaks under Jest.
generator client {
  provider            = "prisma-client"
  output              = "../generated/client"
  moduleFormat        = "cjs"
  importFileExtension = ""
}

datasource db {
  provider = "postgresql"
}

// ============================================================
// ORGANIZATIONS & TENANCY
// ============================================================

model Organization {
  id                   String   @id @default(uuid())
  name                 String
  slug                 String   @unique
  billingEmail         String?  @map("billing_email")
  stripeCustomerId     String?  @unique @map("stripe_customer_id")   // Created lazily on first checkout
  accessLevel          String   @default("full") @map("access_level")   // AccessLevel
  // Some Enterprise contracts forbid staff impersonation entirely — set by
  // Sales/Finance during onboarding, not by the org itself. TDD_15 §4.
  impersonationBlocked Boolean  @default(false) @map("impersonation_blocked")
  createdAt            DateTime @default(now()) @map("created_at")
  updatedAt            DateTime @updatedAt @map("updated_at")

  stores               Store[]
  memberships          Membership[]
  invitations          Invitation[]
  subscription         Subscription?
  dataSubjectRequests  DataSubjectRequest[]
  overrides            OrganizationOverride[]
  aiCreditBalance      AiCreditBalance?
  aiCreditTransactions AiCreditTransaction[]
  impersonations       ImpersonationSession[]

  @@map("organizations")
}

model Store {
  id                  String   @id @default(uuid())
  organizationId      String   @map("organization_id")
  name                String
  slug                String
  timezone            String   @default("America/El_Salvador")
  currency            String   @default("USD")
  defaultLocale       String   @default("es") @map("default_locale")
  // Starter-tier only: which of the "choose one" social channels (Instagram
  // or Messenger) this store activated. Null on every other tier. TDD_11 §6.5.
  activeSocialChannel String?  @map("active_social_channel")   // ChannelType
  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")

  organization        Organization         @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  settings            StoreSettings?
  businessHours       BusinessHours?
  routingRules        RoutingRule[]
  memberships         Membership[]
  invitations         Invitation[]
  roles               Role[]
  conversations       Conversation[]
  messages            Message[]
  customers           Customer[]
  customerIdentities  CustomerIdentity[]
  customerMerges      CustomerMerge[]
  orders              Order[]
  products            Product[]
  inventoryMovements  InventoryMovement[]
  tags                Tag[]
  snippets            Snippet[]
  media               Media[]
  channelConnections  ChannelConnection[]
  pluginInstallations PluginInstallation[]
  webhooks            Webhook[]
  apiKeys             ApiKey[]
  notifications       Notification[]
  notificationPrefs   NotificationPreference[]
  aiSettings          AISettings?
  aiUsageRecords      AIUsageRecord[]
  retentionSettings   RetentionSettings?
  scheduledReports    ScheduledReport[]
  analyticsEvents     AnalyticsEvent[]
  metricsHourly       MetricHourly[]
  metricsDaily        MetricDaily[]
  billableConversations BillableConversation[]
  consentRecords      ConsentRecord[]
  exports             Export[]

  @@unique([organizationId, slug])
  @@map("stores")
}

// Per-store behaviour toggles (TDD_09 §3, §11). One row per store, created with the store.
model StoreSettings {
  storeId                 String   @id @map("store_id")
  reopenWindowDays        Int      @default(7) @map("reopen_window_days")
  autoArchiveAfterDays    Int      @default(30) @map("auto_archive_after_days")
  resolveShowOptions      Boolean  @default(true) @map("resolve_show_options")
  sendClosingMessage      Boolean  @default(false) @map("send_closing_message")
  closingSnippetId        String?  @map("closing_snippet_id")
  requestCsat             Boolean  @default(false) @map("request_csat")
  agentLoadThreshold      Int      @default(8) @map("agent_load_threshold")      // Team widget "above threshold"
  // Safety & confirmations (TDD_09 §11.2): { confirmDeleteCustomer, confirmDisconnectChannel,
  // confirmRemoveMember, applyToRoles: RoleName[], moderateRiskMode: 'dialog'|'undo'|'none' }
  safety                  Json     @default("{}")
  updatedAt               DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@map("store_settings")
}

model BusinessHours {
  storeId          String   @id @map("store_id")
  timezone         String
  // { mon: [{ from: "09:00", to: "18:00" }], ..., sun: [] }
  schedule         Json
  awayMessageSnippetId String? @map("away_message_snippet_id")
  updatedAt        DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@map("business_hours")
}

// Assignment rules evaluated in priority order on every new inbound conversation
// (TDD_10 §4 step "routing"). conditions/action shapes are Zod schemas in
// libs/core/domain/schemas/routing-rule.schema.ts.
model RoutingRule {
  id         String   @id @default(uuid())
  storeId    String   @map("store_id")
  name       String
  priority   Int
  enabled    Boolean  @default(true)
  // { channelTypes?: ChannelType[], intents?: string[], tagIds?: string[], keywords?: string[], outsideBusinessHours?: boolean }
  conditions Json
  // { type: 'assign_user' | 'round_robin' | 'unassigned', userIds?: string[] }
  action     Json
  createdBy  String   @map("created_by")
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, priority])
  @@index([storeId, enabled])
  @@map("routing_rules")
}

model User {
  id            String    @id @default(uuid())
  email         String    @unique
  name          String
  passwordHash  String?   @map("password_hash")
  emailVerified Boolean   @default(false) @map("email_verified")
  emailValid    Boolean   @default(true) @map("email_valid")
  avatarMediaId String?   @map("avatar_media_id")
  locale        String    @default("es")
  timezone      String?
  density       String    @default("comfortable")   // UI preference
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")

  memberships             Membership[]
  messages                Message[]
  notifications           Notification[]
  notificationPreferences NotificationPreference[]
  notificationSettings    UserNotificationSettings?
  pushSubscriptions       PushSubscription[]
  auditLogs               AuditLog[]
  sessions                Session[]
  verificationTokens      VerificationToken[]
  invitationsSent         Invitation[]   @relation("InvitedBy")
  invitationsAccepted     Invitation[]   @relation("AcceptedBy")
  cookieConsents          CookieConsent[]

  @@map("users")
}

// Refresh-token rotation with family tracking (§7). One row per issued refresh token;
// a family is the chain started at login. Reuse of a consumed token revokes the family.
model Session {
  id               String    @id @default(uuid())
  userId           String    @map("user_id")
  familyId         String    @map("family_id")
  refreshTokenHash String    @unique @map("refresh_token_hash")   // sha256; the raw token is never stored
  replacedById     String?   @unique @map("replaced_by_id")
  userAgent        String?   @map("user_agent")
  ipAddress        String?   @map("ip_address")
  expiresAt        DateTime  @map("expires_at")
  consumedAt       DateTime? @map("consumed_at")
  revokedAt        DateTime? @map("revoked_at")
  revokedReason    String?   @map("revoked_reason")
  createdAt        DateTime  @default(now()) @map("created_at")

  user       User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  replacedBy Session? @relation("SessionRotation", fields: [replacedById], references: [id])
  replaces   Session? @relation("SessionRotation")

  @@index([userId])
  @@index([familyId])
  @@index([expiresAt])
  @@map("sessions")
}

// Email verification, password reset, DSR verification (TDD_07 §5.3, TDD_05 §10.2).
model VerificationToken {
  id        String    @id @default(uuid())
  type      String                              // VerificationTokenType
  tokenHash String    @unique @map("token_hash")
  userId    String?   @map("user_id")
  subject   String?                             // Email or DSR id when there is no user
  expiresAt DateTime  @map("expires_at")
  usedAt    DateTime? @map("used_at")
  createdAt DateTime  @default(now()) @map("created_at")

  user User? @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId, type])
  @@index([expiresAt])
  @@map("verification_tokens")
}

// A pending invitation is NOT a Membership: the invitee may not have a User yet.
// Membership rows are created only on acceptance (TDD_07 §5.3).
model Invitation {
  id             String    @id @default(uuid())
  organizationId String    @map("organization_id")
  storeId        String    @map("store_id")
  email          String
  roleId         String    @map("role_id")
  tokenHash      String    @unique @map("token_hash")
  status         String    @default("PENDING")   // InvitationStatus
  invitedById    String    @map("invited_by_id")
  acceptedById   String?   @map("accepted_by_id")
  expiresAt      DateTime  @map("expires_at")
  acceptedAt     DateTime? @map("accepted_at")
  createdAt      DateTime  @default(now()) @map("created_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  store        Store        @relation(fields: [storeId], references: [id], onDelete: Cascade)
  role         Role         @relation(fields: [roleId], references: [id])
  invitedBy    User         @relation("InvitedBy", fields: [invitedById], references: [id])
  acceptedBy   User?        @relation("AcceptedBy", fields: [acceptedById], references: [id])

  @@unique([storeId, email, status])   // One PENDING invitation per email per store (partial index in §5)
  @@index([storeId, status])
  @@map("invitations")
}

model Membership {
  id             String    @id @default(uuid())
  userId         String    @map("user_id")
  organizationId String    @map("organization_id")
  storeId        String    @map("store_id")
  roleId         String    @map("role_id")
  status         String    @default("ACTIVE")   // MembershipStatus
  invitationId   String?   @map("invitation_id")
  revokedAt      DateTime? @map("revoked_at")
  createdAt      DateTime  @default(now()) @map("created_at")
  updatedAt      DateTime  @updatedAt @map("updated_at")

  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  store        Store        @relation(fields: [storeId], references: [id], onDelete: Cascade)
  role         Role         @relation(fields: [roleId], references: [id])

  @@unique([userId, storeId])
  @@index([storeId, status])
  @@index([userId])
  @@index([organizationId, status])
  @@map("memberships")
}

// System presets have storeId = null and isSystem = true. Uniqueness of system role
// names is enforced by a partial unique index in §5 (NULLs are distinct in Postgres).
model Role {
  id          String   @id @default(uuid())
  storeId     String?  @map("store_id")
  name        String
  description String?
  isSystem    Boolean  @default(false) @map("is_system")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  store       Store?       @relation(fields: [storeId], references: [id], onDelete: Cascade)
  permissions Permission[]
  memberships Membership[]
  invitations Invitation[]

  @@index([storeId])
  @@map("roles")
}

model Permission {
  id     String @id @default(uuid())
  name   String                    // Permission (TDD_02 §4)
  roleId String @map("role_id")

  role Role @relation(fields: [roleId], references: [id], onDelete: Cascade)

  @@unique([roleId, name])
  @@map("permissions")
}

// ============================================================
// CUSTOMERS
// ============================================================

model Customer {
  id              String    @id @default(uuid())
  storeId         String    @map("store_id")
  name            String?
  email           String?
  phone           String?                            // As displayed
  phoneNormalized String?   @map("phone_normalized") // E.164 digits only, for search
  locale          String?                            // Detected from channel/messages, for customer-facing copy
  erasedAt        DateTime? @map("erased_at")
  mergedIntoId    String?   @map("merged_into_id")   // Set when absorbed by a merge (row kept 30 days for unmerge)
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @updatedAt @map("updated_at")

  store         Store              @relation(fields: [storeId], references: [id], onDelete: Cascade)
  identities    CustomerIdentity[]
  conversations Conversation[]
  orders        Order[]
  addresses     Address[]
  notes         CustomerNote[]
  consents      ConsentRecord[]
  tags          Tag[]              @relation("CustomerTags")
  media         Media[]

  @@index([storeId])
  @@index([storeId, phoneNormalized])
  @@index([storeId, email])
  @@index([storeId, mergedIntoId])
  @@map("customers")
}

// One row per (store, channel, handle). The SAME phone number in two stores is two
// rows — customers are always store-scoped (TDD_10 §5.2).
model CustomerIdentity {
  id              String   @id @default(uuid())
  storeId         String   @map("store_id")
  customerId      String   @map("customer_id")
  channelType     String   @map("channel_type")        // ChannelType
  channelIdentity String   @map("channel_identity")    // phone (E.164), page-scoped id, visitor id, email
  displayName     String?  @map("display_name")        // Profile name as reported by the channel
  channelMetadata Json?    @map("channel_metadata")
  lastInboundAt   DateTime? @map("last_inbound_at")    // Drives messaging windows (TDD_10 §4)
  createdAt       DateTime @default(now()) @map("created_at")

  store         Store          @relation(fields: [storeId], references: [id], onDelete: Cascade)
  customer      Customer       @relation(fields: [customerId], references: [id], onDelete: Cascade)
  conversations Conversation[]

  @@unique([storeId, channelType, channelIdentity])
  @@index([customerId])
  @@map("customer_identities")
}

model Address {
  id         String   @id @default(uuid())
  customerId String   @map("customer_id")
  label      String?
  line1      String
  line2      String?
  city       String
  state      String?
  postalCode String?  @map("postal_code")
  country    String   @default("SV")
  isDefault  Boolean  @default(false) @map("is_default")
  createdAt  DateTime @default(now()) @map("created_at")

  customer Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

  @@index([customerId])
  @@map("addresses")
}

model CustomerNote {
  id         String   @id @default(uuid())
  customerId String   @map("customer_id")
  authorId   String   @map("author_id")
  content    String
  createdAt  DateTime @default(now()) @map("created_at")

  customer Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

  @@index([customerId, createdAt])
  @@map("customer_notes")
}

// Snapshot that makes "Unmerge within 30 days" possible (TDD_09 §6.1).
model CustomerMerge {
  id           String    @id @default(uuid())
  storeId      String    @map("store_id")
  survivorId   String    @map("survivor_id")
  absorbedId   String    @map("absorbed_id")
  // { absorbed: Customer, identityIds, conversationIds, orderIds, addressIds, noteIds, tagIds, fieldChoices }
  snapshot     Json
  mergedById   String    @map("merged_by_id")
  mergedAt     DateTime  @default(now()) @map("merged_at")
  unmergeUntil DateTime  @map("unmerge_until")
  unmergedAt   DateTime? @map("unmerged_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@index([storeId, survivorId])
  @@index([unmergeUntil])
  @@map("customer_merges")
}

// ============================================================
// CONVERSATIONS & MESSAGES
// ============================================================

model Conversation {
  id                  String    @id @default(uuid())
  storeId             String    @map("store_id")
  customerId          String    @map("customer_id")
  customerIdentityId  String    @map("customer_identity_id")   // Which handle the customer used
  channelConnectionId String    @map("channel_connection_id")  // Which of our accounts received it → outbound route
  channelType         String    @map("channel_type")           // ChannelType, denormalized for filters
  status              String    @default("OPEN")               // ConversationStatus
  handler             String    @default("human")              // ConversationHandler (TDD_12 §13)
  assignedTo          String?   @map("assigned_to")
  unreadCount         Int       @default(0) @map("unread_count")   // Inbound messages not yet read by an agent
  lastReadAt          DateTime? @map("last_read_at")
  lastReadBy          String?   @map("last_read_by")
  lastMessageAt       DateTime? @map("last_message_at")
  lastInboundAt       DateTime? @map("last_inbound_at")
  lastOutboundAt      DateTime? @map("last_outbound_at")
  firstResponseAt     DateTime? @map("first_response_at")      // First agent/AI reply, for analytics
  resolvedAt          DateTime? @map("resolved_at")
  resolutionReason    String?   @map("resolution_reason")
  csatScore           Int?      @map("csat_score")             // 1-5
  csatComment         String?   @map("csat_comment")
  archivedAt          DateTime? @map("archived_at")
  snoozedUntil        DateTime? @map("snoozed_until")
  detectedIntent      String?   @map("detected_intent")
  aiTurnCount         Int       @default(0) @map("ai_turn_count")           // Autonomous turns taken (TDD_12 §13)
  aiChargedAt         DateTime? @map("ai_charged_at")                       // Flat per-conversation Chispa charge applied
  aiMetadata          Json?     @map("ai_metadata")
  createdAt           DateTime  @default(now()) @map("created_at")
  updatedAt           DateTime  @updatedAt @map("updated_at")

  store             Store             @relation(fields: [storeId], references: [id], onDelete: Cascade)
  customer          Customer          @relation(fields: [customerId], references: [id])
  customerIdentity  CustomerIdentity  @relation(fields: [customerIdentityId], references: [id])
  channelConnection ChannelConnection @relation(fields: [channelConnectionId], references: [id])
  messages          Message[]
  tags              Tag[]             @relation("ConversationTags")
  billableWindows   BillableConversation[]

  @@index([storeId, status, assignedTo, lastMessageAt(sort: Desc)])
  @@index([storeId, lastMessageAt(sort: Desc)])
  @@index([storeId, channelType, status])
  @@index([storeId, customerId])
  @@index([customerIdentityId])
  @@index([snoozedUntil])
  @@index([status, resolvedAt])    // Auto-archive scheduler
  @@map("conversations")
}

model Message {
  id                  String    @id @default(uuid())
  storeId             String    @map("store_id")               // Denormalized: RLS, exports, retention
  conversationId      String    @map("conversation_id")
  type                String                                    // MessageType
  content             String?
  authorType          String    @map("author_type")            // AuthorType
  authorId            String?   @map("author_id")              // User id for AGENT, null otherwise
  channelMessageId    String?   @map("channel_message_id")     // Provider id; unique per conversation
  idempotencyKey      String?   @map("idempotency_key")        // Client-generated for outbound (TDD_06 §4)
  replyToMessageId    String?   @map("reply_to_message_id")
  deliveryStatus      String?   @map("delivery_status")        // DeliveryStatus, outbound only
  deliveryError       String?   @map("delivery_error")         // ErrorCode when FAILED
  mentions            String[]  @default([])                   // User ids mentioned in an internal note
  sentiment           String?                                  // SentimentLabel
  sentimentConfidence Float?    @map("sentiment_confidence")
  metadata            Json?                                    // Channel-specific + AI metadata ({ ai: { usageRecordId, confidence } })
  createdAt           DateTime  @default(now()) @map("created_at")

  store        Store        @relation(fields: [storeId], references: [id], onDelete: Cascade)
  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  author       User?        @relation(fields: [authorId], references: [id])
  media        Media[]

  @@unique([conversationId, channelMessageId])
  @@unique([conversationId, idempotencyKey])
  @@index([conversationId, createdAt])
  @@index([storeId, createdAt])
  @@map("messages")
}

model Tag {
  id          String   @id @default(uuid())
  storeId     String   @map("store_id")
  name        String
  color       String
  description String?
  createdAt   DateTime @default(now()) @map("created_at")

  store         Store          @relation(fields: [storeId], references: [id], onDelete: Cascade)
  conversations Conversation[] @relation("ConversationTags")
  customers     Customer[]     @relation("CustomerTags")

  @@unique([storeId, name])
  @@map("tags")
}

model Snippet {
  id         String   @id @default(uuid())
  storeId    String   @map("store_id")
  shortcut   String
  title      String
  content    String
  aiApproved Boolean  @default(false) @map("ai_approved")   // Usable by the autonomous chatbot as a source (TDD_12 §13)
  createdBy  String   @map("created_by")
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, shortcut])
  @@map("snippets")
}

// ============================================================
// ORDERS, PRODUCTS & INVENTORY
// ============================================================

model Order {
  id                     String    @id @default(uuid())
  storeId                String    @map("store_id")
  customerId             String    @map("customer_id")
  conversationId         String?   @map("conversation_id")
  orderNumber            String    @map("order_number")
  status                 String    @default("CONFIRMED")       // OrderStatus
  subtotalCents          Int       @map("subtotal_cents")
  shippingCents          Int       @default(0) @map("shipping_cents")
  discountCents          Int       @default(0) @map("discount_cents")
  totalCents             Int       @map("total_cents")
  currency               String    @default("USD")
  paymentMethod          String    @map("payment_method")     // PaymentMethod
  paymentStatus          String    @default("PENDING") @map("payment_status")   // PaymentStatus
  shippingAddress        Json?     @map("shipping_address")
  customerNotes          String?   @map("customer_notes")
  internalNotes          String?   @map("internal_notes")
  trackingNumber         String?   @map("tracking_number")
  cancellationReason     String?   @map("cancellation_reason")
  cancelledBy            String?   @map("cancelled_by")
  proofOfDeliveryMediaId String?   @map("proof_of_delivery_media_id")
  createdBy              String    @map("created_by")
  createdAt              DateTime  @default(now()) @map("created_at")
  updatedAt              DateTime  @updatedAt @map("updated_at")
  shippedAt              DateTime? @map("shipped_at")
  deliveredAt            DateTime? @map("delivered_at")
  cancelledAt            DateTime? @map("cancelled_at")

  store    Store       @relation(fields: [storeId], references: [id])   // No cascade: tax retention
  customer Customer    @relation(fields: [customerId], references: [id])
  items    OrderItem[]
  media    Media[]

  @@unique([storeId, orderNumber])
  @@index([storeId, status, createdAt(sort: Desc)])
  @@index([storeId, customerId])
  @@index([conversationId])
  @@map("orders")
}

model OrderItem {
  id             String  @id @default(uuid())
  orderId        String  @map("order_id")
  productId      String  @map("product_id")
  variantId      String? @map("variant_id")
  productName    String  @map("product_name")     // Denormalized snapshot at time of order
  variantName    String? @map("variant_name")
  quantity       Int
  unitPriceCents Int     @map("unit_price_cents") // Snapshot; never trusted from the client

  order   Order           @relation(fields: [orderId], references: [id], onDelete: Cascade)
  product Product         @relation(fields: [productId], references: [id])
  variant ProductVariant? @relation(fields: [variantId], references: [id])

  @@index([orderId])
  @@map("order_items")
}

model Product {
  id          String   @id @default(uuid())
  storeId     String   @map("store_id")
  name        String
  description String?
  priceCents  Int      @map("price_cents")
  sku         String?
  imageMediaId String? @map("image_media_id")
  trackInventory Boolean @default(true) @map("track_inventory")
  lowStockThreshold Int  @default(5) @map("low_stock_threshold")
  active      Boolean  @default(true)
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  store      Store               @relation(fields: [storeId], references: [id], onDelete: Cascade)
  variants   ProductVariant[]
  inventory  InventoryMovement[]
  orderItems OrderItem[]
  media      Media[]

  @@unique([storeId, sku])
  @@index([storeId, active])
  @@map("products")
}

// "Size 42", "Red / L". A product without variants sells the product row itself.
model ProductVariant {
  id         String   @id @default(uuid())
  productId  String   @map("product_id")
  name       String                            // Display: "42", "Rojo / L"
  sku        String?
  priceCents Int?     @map("price_cents")      // Null = inherits Product.priceCents
  attributes Json                              // { size: "42", color: "red" }
  active     Boolean  @default(true)
  createdAt  DateTime @default(now()) @map("created_at")

  product    Product             @relation(fields: [productId], references: [id], onDelete: Cascade)
  inventory  InventoryMovement[]
  orderItems OrderItem[]

  @@unique([productId, name])
  @@index([productId, active])
  @@map("product_variants")
}

model InventoryMovement {
  id        String   @id @default(uuid())
  storeId   String   @map("store_id")
  productId String   @map("product_id")
  variantId String?  @map("variant_id")
  type      String                          // InventoryMovementType
  quantity  Int
  reference String?                         // Order id or manual adjustment note
  createdBy String?  @map("created_by")
  createdAt DateTime @default(now()) @map("created_at")

  store   Store           @relation(fields: [storeId], references: [id], onDelete: Cascade)
  product Product         @relation(fields: [productId], references: [id])
  variant ProductVariant? @relation(fields: [variantId], references: [id])

  @@index([productId, variantId, type, createdAt(sort: Desc)])
  @@map("inventory_movements")
}

// ============================================================
// MEDIA
// ============================================================

model Media {
  id          String    @id @default(uuid())
  storeId     String?   @map("store_id")          // Null only for user avatars
  purpose     String                              // MediaPurpose: message | product | order | avatar | export
  messageId   String?   @map("message_id")
  customerId  String?   @map("customer_id")       // Set for message media: gallery queries
  productId   String?   @map("product_id")
  orderId     String?   @map("order_id")
  uploadedBy  String?   @map("uploaded_by")       // User id; null for inbound channel media
  key         String    @unique                   // S3 object key, built by storage-keys.ts
  filename    String
  contentType String    @map("content_type")
  fileSize    Int       @map("file_size")
  // { full: key, medium: key, thumb: key } — KEYS, signed at read time (TDD_07 §6.6)
  variants    Json?
  status      String    @default("pending")       // MediaStatus
  scanResult  Json?     @map("scan_result")       // { viruses: string[] } when infected
  processedAt DateTime? @map("processed_at")
  scannedAt   DateTime? @map("scanned_at")
  createdAt   DateTime  @default(now()) @map("created_at")

  store    Store?    @relation(fields: [storeId], references: [id], onDelete: Cascade)
  message  Message?  @relation(fields: [messageId], references: [id], onDelete: SetNull)
  customer Customer? @relation(fields: [customerId], references: [id], onDelete: SetNull)
  product  Product?  @relation(fields: [productId], references: [id], onDelete: SetNull)
  order    Order?    @relation(fields: [orderId], references: [id], onDelete: SetNull)

  @@index([storeId, createdAt])
  @@index([storeId, customerId, createdAt(sort: Desc)])
  @@index([messageId])
  @@index([status, createdAt])
  @@map("media")
}

// ============================================================
// CHANNELS, PLUGINS & WEBHOOKS
// ============================================================

// One row per (store, plugin, account). connectionId is what the provider sends as the
// RECIPIENT of an inbound webhook (WhatsApp phone_number_id, Facebook Page id, Instagram
// business account id, widget site key, inbound mailbox address). It is unique per plugin
// platform-wide — a phone number belongs to exactly one store — which is how the inbound
// pipeline resolves the store (TDD_10 §4).
model ChannelConnection {
  id            String    @id @default(uuid())
  storeId       String    @map("store_id")
  pluginId      String    @map("plugin_id")          // ChannelType / plugin id
  connectionId  String    @map("connection_id")
  displayName   String    @map("display_name")       // "+503 2222-3333", "Mi Empresa (Page)"
  status        String    @default("active")         // ChannelConnectionStatus
  credentials   Bytes                                // AES-256-GCM ciphertext (libs/core/crypto)
  metadata      Json?
  lastHealthyAt DateTime? @map("last_healthy_at")
  lastError     String?   @map("last_error")
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")

  store         Store          @relation(fields: [storeId], references: [id], onDelete: Cascade)
  conversations Conversation[]

  @@unique([pluginId, connectionId])
  @@index([storeId, status])
  @@map("channel_connections")
}

// The marketplace catalog entry — one row per published plugin, independent of how many
// stores installed it. Official channel plugins are seeded here with pricingModel
// 'plan_gated'. Third-party submissions arrive through TDD_10 §8 / TDD_15 §7.
model Plugin {
  // The manifest's own declared id (TDD_10 §6.1, e.g. "telegram-connector", or "whatsapp"
  // for an official channel) — not a generated uuid, so it matches PluginInstallation.pluginId
  // and the in-memory registry key exactly.
  id                          String   @id
  name                        String
  authorName                  String   @map("author_name")
  authorEmail                 String   @map("author_email")
  type                        String                                     // 'channel' | 'integration'
  isOfficial                  Boolean  @default(false) @map("is_official")
  manifest                    Json                                       // Full manifest JSON, TDD_10 §6.1
  pricingModel                String   @map("pricing_model")             // PluginPricingModels
  priceCents                  Int?     @map("price_cents")               // pricingModel = 'paid' only
  platformRevenueSharePercent Int?     @default(20) @map("platform_revenue_share_percent")
  allowedTiers                String[] @default([]) @map("allowed_tiers") // pricingModel = 'plan_gated' only
  status                      String   @default("submitted")             // PluginStatus
  reviewNotes                 String?  @map("review_notes")
  reviewedByStaffId           String?  @map("reviewed_by_staff_id")
  createdAt                   DateTime @default(now()) @map("created_at")
  updatedAt                   DateTime @updatedAt @map("updated_at")

  installations PluginInstallation[]
  reviewedBy    Staff?               @relation(fields: [reviewedByStaffId], references: [id])

  @@index([status])
  @@map("plugins")
}

model PluginInstallation {
  id             String   @id @default(uuid())
  storeId        String   @map("store_id")
  pluginId       String   @map("plugin_id")
  scopes         String[]                            // PluginScope[]
  status         String   @default("pending_setup")  // PluginInstallationStatus
  apiKeyPrefix   String   @map("api_key_prefix")     // First 12 chars, shown in UI
  apiKeyHash     String   @unique @map("api_key_hash") // sha256 of the full key
  rateLimitPerMinute Int  @default(60) @map("rate_limit_per_minute")   // From manifest.limits
  config         Json?
  installedBy    String   @map("installed_by")
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")
  revokedAt      DateTime? @map("revoked_at")

  store  Store  @relation(fields: [storeId], references: [id], onDelete: Cascade)
  plugin Plugin @relation(fields: [pluginId], references: [id], onDelete: Restrict)

  @@unique([storeId, pluginId])
  @@index([storeId, status])
  @@map("plugin_installations")
}

// Tenant-created outbound webhooks (Settings → Webhooks).
model Webhook {
  id                  String    @id @default(uuid())
  storeId             String    @map("store_id")
  url                 String
  events              String[]                          // EventName[]
  secret              Bytes                             // Encrypted HMAC secret
  status              String    @default("active")      // WebhookStatus
  consecutiveFailures Int       @default(0) @map("consecutive_failures")
  lastFailureAt       DateTime? @map("last_failure_at")
  createdBy           String    @map("created_by")
  createdAt           DateTime  @default(now()) @map("created_at")
  updatedAt           DateTime  @updatedAt @map("updated_at")

  store      Store             @relation(fields: [storeId], references: [id], onDelete: Cascade)
  deliveries WebhookDelivery[]

  @@index([storeId, status])
  @@map("webhooks")
}

model WebhookDelivery {
  id         String   @id @default(uuid())
  webhookId  String   @map("webhook_id")
  event      String
  statusCode Int?     @map("status_code")
  durationMs Int      @map("duration_ms")
  success    Boolean
  error      String?
  attempt    Int      @default(1)
  createdAt  DateTime @default(now()) @map("created_at")

  webhook Webhook @relation(fields: [webhookId], references: [id], onDelete: Cascade)

  @@index([webhookId, createdAt(sort: Desc)])
  @@index([createdAt])    // 30-day cleanup
  @@map("webhook_deliveries")
}

// Idempotency for inbound provider webhooks (Stripe, Resend). Channel webhooks dedupe on
// Message.channelMessageId instead.
model ProcessedWebhookEvent {
  source      String                                    // 'stripe' | 'resend'
  eventId     String   @map("event_id")
  type        String
  processedAt DateTime @default(now()) @map("processed_at")

  @@id([source, eventId])
  @@index([processedAt])
  @@map("processed_webhook_events")
}

// Tenant API keys (Settings → API keys) for the public REST API. Distinct from plugin keys.
model ApiKey {
  id         String    @id @default(uuid())
  storeId    String    @map("store_id")
  name       String
  keyPrefix  String    @map("key_prefix")               // "pk_live_ab12…" shown in UI
  keyHash    String    @unique @map("key_hash")
  scopes     String[]                                   // Permission[] subset
  status     String    @default("active")               // ApiKeyStatus
  lastUsedAt DateTime? @map("last_used_at")
  expiresAt  DateTime? @map("expires_at")
  createdBy  String    @map("created_by")
  createdAt  DateTime  @default(now()) @map("created_at")
  revokedAt  DateTime? @map("revoked_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@index([storeId, status])
  @@map("api_keys")
}

// ============================================================
// NOTIFICATIONS
// ============================================================

// Persisted as an i18n key + params (TDD_02 §12). Rendered at display time in the
// recipient's locale; emails render server-side.
model Notification {
  id           String    @id @default(uuid())
  userId       String    @map("user_id")
  storeId      String    @map("store_id")
  type         String                                   // NotificationType
  severity     String                                   // NotificationSeverity
  messageKey   String    @map("message_key")            // e.g. "notifications.conversation.assigned"
  params       Json      @default("{}")                 // { customerName, conversationId, … }
  resourceType String?   @map("resource_type")
  resourceId   String?   @map("resource_id")
  actionPath   String?   @map("action_path")            // App-relative path, built from AppPaths
  readAt       DateTime? @map("read_at")
  createdAt    DateTime  @default(now()) @map("created_at")

  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@index([userId, readAt, createdAt(sort: Desc)])
  @@index([storeId, createdAt(sort: Desc)])
  @@map("notifications")
}

model NotificationPreference {
  id      String  @id @default(uuid())
  userId  String  @map("user_id")
  storeId String  @map("store_id")
  type    String                                        // NotificationType
  inApp   Boolean @default(true) @map("in_app")
  push    Boolean @default(true)
  email   Boolean @default(false)
  sound   Boolean @default(true)

  user  User  @relation(fields: [userId], references: [id], onDelete: Cascade)
  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([userId, storeId, type])
  @@map("notification_preferences")
}

// User-level (not per store) notification behaviour: quiet hours, digest, cross-store.
model UserNotificationSettings {
  userId                   String   @id @map("user_id")
  quietHoursEnabled        Boolean  @default(false) @map("quiet_hours_enabled")
  quietHoursStart          Int      @default(22) @map("quiet_hours_start")   // 0-23, in `timezone`
  quietHoursEnd            Int      @default(7) @map("quiet_hours_end")
  quietHoursFollowStore    Boolean  @default(false) @map("quiet_hours_follow_store")
  timezone                 String   @default("America/El_Salvador")
  digestFrequency          String   @default("hourly") @map("digest_frequency")   // DigestFrequency
  crossStoreEnabled        Boolean  @default(true) @map("cross_store_enabled")
  crossStoreSupervisorOnly Boolean  @default(false) @map("cross_store_supervisor_only")
  lastDigestSentAt         DateTime? @map("last_digest_sent_at")
  updatedAt                DateTime @updatedAt @map("updated_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@map("user_notification_settings")
}

model PushSubscription {
  id        String   @id @default(uuid())
  userId    String   @map("user_id")
  endpoint  String   @unique
  p256dh    String
  auth      String
  userAgent String?  @map("user_agent")
  createdAt DateTime @default(now()) @map("created_at")
  lastUsed  DateTime @default(now()) @map("last_used")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("push_subscriptions")
}

// ============================================================
// ANALYTICS & EXPORTS
// ============================================================

model AnalyticsEvent {
  id        String   @id @default(uuid())
  storeId   String   @map("store_id")
  event     String                                    // AnalyticsEventNames (TDD_11 §7.1)
  data      Json
  date      DateTime @db.Date
  timestamp DateTime @default(now())

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@index([storeId, event, date])
  @@index([date])
  @@map("analytics_events")
}

// dimension/dimensionId default to '' (never NULL) so the unique constraint works with upsert.
model MetricHourly {
  id          String   @id @default(uuid())
  storeId     String   @map("store_id")
  hour        DateTime
  metric      String
  dimension   String   @default("")
  dimensionId String   @default("") @map("dimension_id")
  value       Decimal  @db.Decimal(18, 4)
  count       Int      @default(0)
  updatedAt   DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, hour, metric, dimension, dimensionId])
  @@index([storeId, metric, hour])
  @@map("metrics_hourly")
}

model MetricDaily {
  id          String   @id @default(uuid())
  storeId     String   @map("store_id")
  date        DateTime @db.Date
  metric      String
  dimension   String   @default("")
  dimensionId String   @default("") @map("dimension_id")
  value       Decimal  @db.Decimal(18, 4)
  count       Int      @default(0)
  updatedAt   DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, date, metric, dimension, dimensionId])
  @@index([storeId, metric, date])
  @@map("metrics_daily")
}

model ScheduledReport {
  id         String    @id @default(uuid())
  storeId    String    @map("store_id")
  name       String
  metrics    String[]
  frequency  String                                   // ReportFrequency
  format     String                                   // ReportFormats
  recipients String[]
  filters    Json?
  timezone   String    @default("America/El_Salvador")
  sendAtHour Int       @default(8) @map("send_at_hour")
  enabled    Boolean   @default(true)
  lastSentAt DateTime? @map("last_sent_at")
  createdBy  String    @map("created_by")
  createdAt  DateTime  @default(now()) @map("created_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@index([storeId])
  @@index([enabled, frequency])
  @@map("scheduled_reports")
}

// Generated exports (CSV/Excel/ZIP/PDF) — the record behind ApiRoutes.exports and the
// EXPORT_READY notification (TDD_07 §7).
model Export {
  id          String    @id @default(uuid())
  storeId     String    @map("store_id")
  requestedBy String    @map("requested_by")
  type        String                                  // ExportTypes (TDD_07 §1.3)
  format      String
  filters     Json?
  status      String    @default("pending")           // ExportStatus: pending | ready | failed | expired
  key         String?                                 // S3 key when ready
  rowCount    Int?      @map("row_count")
  error       String?
  expiresAt   DateTime  @map("expires_at")
  createdAt   DateTime  @default(now()) @map("created_at")
  completedAt DateTime? @map("completed_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@index([storeId, createdAt(sort: Desc)])
  @@index([expiresAt])
  @@map("exports")
}

// ============================================================
// BILLING
// ============================================================

// One per organization, created at signup on the FREE tier (no Stripe objects yet).
// Limits are NOT stored here: EffectivePlanLimitsService resolves
// PlanLimits[tier] + OrganizationOverride at read time (TDD_11 §1, TDD_15 §3.1).
model Subscription {
  id                       String    @id @default(uuid())
  organizationId           String    @unique @map("organization_id")
  stripeSubscriptionId     String?   @unique @map("stripe_subscription_id")
  stripeMeteredItemId      String?   @map("stripe_metered_item_id")
  tier                     String    @default("free")            // PlanTiers
  interval                 String    @default("monthly")         // BillingIntervals
  status                   String    @default("active")          // SubscriptionStatus
  currentPeriodStart       DateTime  @map("current_period_start")
  currentPeriodEnd         DateTime  @map("current_period_end")
  trialEndsAt              DateTime? @map("trial_ends_at")
  cancelAtPeriodEnd        Boolean   @default(false) @map("cancel_at_period_end")
  canceledAt               DateTime? @map("canceled_at")
  pastDueSince             DateTime? @map("past_due_since")
  dunningStepsCompleted    Int[]     @default([]) @map("dunning_steps_completed")   // dayOffsets already executed
  lastUsageReportedAt      DateTime? @map("last_usage_reported_at")
  createdAt                DateTime  @default(now()) @map("created_at")
  updatedAt                DateTime  @updatedAt @map("updated_at")

  organization Organization  @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  usageRecords UsageRecord[]
  invoices     Invoice[]

  @@index([status])
  @@index([currentPeriodEnd, status])
  @@map("subscriptions")
}

// Per-organization overrides on top of the shared plan (TDD_15 §3.1) — negotiated
// Enterprise terms, goodwill comps, legacy grandfathering.
model OrganizationOverride {
  id               String    @id @default(uuid())
  organizationId   String    @map("organization_id")
  field            String                              // OverridableLimitField (TDD_11 §1)
  value            Float
  reason           String                              // Required — shown in the audit log
  expiresAt        DateTime? @map("expires_at")        // Null = permanent, requires Finance sign-off
  approvedByStaffId String?  @map("approved_by_staff_id")   // Finance, required when expiresAt is null
  createdByStaffId String    @map("created_by_staff_id")
  createdAt        DateTime  @default(now()) @map("created_at")
  revokedAt        DateTime? @map("revoked_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  createdBy    Staff        @relation(fields: [createdByStaffId], references: [id])

  @@index([organizationId, revokedAt])
  @@map("organization_overrides")
}

model UsageRecord {
  id               String   @id @default(uuid())
  subscriptionId   String   @map("subscription_id")
  organizationId   String   @map("organization_id")
  metric           String
  quantity         Int
  periodStart      DateTime @map("period_start")
  periodEnd        DateTime @map("period_end")
  reportedToStripe Boolean  @default(false) @map("reported_to_stripe")
  createdAt        DateTime @default(now()) @map("created_at")

  subscription Subscription @relation(fields: [subscriptionId], references: [id], onDelete: Cascade)

  @@unique([subscriptionId, metric, periodStart])
  @@index([organizationId, periodStart])
  @@index([reportedToStripe, periodEnd])
  @@map("usage_records")
}

model BillableConversation {
  id             String   @id @default(uuid())
  organizationId String   @map("organization_id")
  storeId        String   @map("store_id")
  conversationId String   @map("conversation_id")
  windowStart    DateTime @map("window_start")
  windowEnd      DateTime @map("window_end")
  voidedAt       DateTime? @map("voided_at")        // Set when the conversation is marked SPAM within the window
  createdAt      DateTime @default(now()) @map("created_at")

  store        Store        @relation(fields: [storeId], references: [id], onDelete: Cascade)
  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@unique([conversationId, windowStart])
  @@index([organizationId, windowStart, voidedAt])
  @@index([storeId, windowStart])
  @@map("billable_conversations")
}

model Invoice {
  id               String    @id @default(uuid())
  subscriptionId   String    @map("subscription_id")
  stripeInvoiceId  String    @unique @map("stripe_invoice_id")
  number           String
  status           String
  billingReason    String    @map("billing_reason")
  subtotalCents    Int       @map("subtotal_cents")
  taxCents         Int       @default(0) @map("tax_cents")
  totalCents       Int       @map("total_cents")
  amountPaidCents  Int       @default(0) @map("amount_paid_cents")
  currency         String    @default("usd")
  periodStart      DateTime  @map("period_start")
  periodEnd        DateTime  @map("period_end")
  dueAt            DateTime? @map("due_at")
  paidAt           DateTime? @map("paid_at")
  hostedInvoiceUrl String?   @map("hosted_invoice_url")
  invoicePdfUrl    String?   @map("invoice_pdf_url")
  createdAt        DateTime  @default(now()) @map("created_at")

  subscription Subscription @relation(fields: [subscriptionId], references: [id])
  commissions  Commission[]

  @@index([subscriptionId, createdAt(sort: Desc)])
  @@index([status])
  @@map("invoices")
}

// ============================================================
// REFERRALS
// ============================================================

model ReferralProgram {
  id                        String   @id @default(uuid())
  type                      String                       // ReferralProgramTypes
  name                      String
  active                    Boolean  @default(true)
  // Program terms live here, NOT in a constant, so a new program never needs a deploy
  referrerCreditCents       Int      @default(0) @map("referrer_credit_cents")
  refereeCreditCents        Int      @default(0) @map("referee_credit_cents")
  commissionPercent         Decimal? @db.Decimal(5, 2) @map("commission_percent")
  commissionMonths          Int?     @map("commission_months")
  maxRewardsPerYear         Int?     @map("max_rewards_per_year")
  minPayoutCents            Int      @default(10000) @map("min_payout_cents")
  holdingPeriodDays         Int      @default(45) @map("holding_period_days")
  termsUrl                  String   @map("terms_url")
  createdAt                 DateTime @default(now()) @map("created_at")

  partners Partner[]

  @@map("referral_programs")
}

model Partner {
  id               String    @id @default(uuid())
  programId        String    @map("program_id")
  userId           String?   @map("user_id")
  organizationId   String?   @map("organization_id")   // Customer-referral partners: their own org
  email            String
  name             String
  companyName      String?   @map("company_name")
  referralCode     String    @unique @map("referral_code")
  status           String    @default("active")        // PartnerStatus
  payoutMethod     String?   @map("payout_method")
  stripeConnectAccountId String? @map("stripe_connect_account_id")
  taxFormSubmitted Boolean   @default(false) @map("tax_form_submitted")
  taxFormType      String?   @map("tax_form_type")
  totalClicks      Int       @default(0) @map("total_clicks")
  totalSignups     Int       @default(0) @map("total_signups")
  totalConversions Int       @default(0) @map("total_conversions")
  totalEarnedCents Int       @default(0) @map("total_earned_cents")
  totalPaidCents   Int       @default(0) @map("total_paid_cents")
  approvedAt       DateTime? @map("approved_at")
  createdAt        DateTime  @default(now()) @map("created_at")

  program   ReferralProgram @relation(fields: [programId], references: [id])
  referrals Referral[]
  payouts   Payout[]
  clicks    ReferralClick[]

  @@index([status])
  @@map("partners")
}

model ReferralClick {
  id          String   @id @default(uuid())
  partnerId   String   @map("partner_id")
  code        String
  ipHash      String   @map("ip_hash")
  userAgent   String?  @map("user_agent")
  referrerUrl String?  @map("referrer_url")
  landingPath String?  @map("landing_path")
  utmSource   String?  @map("utm_source")
  utmMedium   String?  @map("utm_medium")
  utmCampaign String?  @map("utm_campaign")
  visitorId   String   @map("visitor_id")
  clickedAt   DateTime @default(now()) @map("clicked_at")

  partner Partner @relation(fields: [partnerId], references: [id])

  @@index([visitorId, clickedAt(sort: Desc)])
  @@index([partnerId, clickedAt])
  @@map("referral_clicks")
}

model Referral {
  id                        String    @id @default(uuid())
  partnerId                 String    @map("partner_id")
  referredOrgId             String    @unique @map("referred_org_id")
  referralCode              String    @map("referral_code")
  status                    String    @default("pending")   // ReferralStatus
  attributedVisitorId       String?   @map("attributed_visitor_id")
  attributedClickId         String?   @map("attributed_click_id")
  signupIpHash              String?   @map("signup_ip_hash")
  signedUpAt                DateTime  @default(now()) @map("signed_up_at")
  convertedAt               DateTime? @map("converted_at")
  holdingEndsAt             DateTime? @map("holding_ends_at")
  approvedAt                DateTime? @map("approved_at")
  rewardType                String    @map("reward_type")
  rewardAmountCents         Int       @default(0) @map("reward_amount_cents")
  commissionPercent         Decimal?  @db.Decimal(5, 2) @map("commission_percent")
  commissionMonthsRemaining Int?      @map("commission_months_remaining")
  rejectionReason           String?   @map("rejection_reason")
  fraudScore                Int       @default(0) @map("fraud_score")
  fraudSignals              String[]  @default([]) @map("fraud_signals")

  partner     Partner      @relation(fields: [partnerId], references: [id])
  commissions Commission[]

  @@index([partnerId, status])
  @@index([status, holdingEndsAt])
  @@map("referrals")
}

model Commission {
  id          String   @id @default(uuid())
  referralId  String   @map("referral_id")
  partnerId   String   @map("partner_id")
  invoiceId   String   @map("invoice_id")
  amountCents Int      @map("amount_cents")
  periodStart DateTime @map("period_start")
  periodEnd   DateTime @map("period_end")
  status      String   @default("pending")   // CommissionStatus
  payoutId    String?  @map("payout_id")
  createdAt   DateTime @default(now()) @map("created_at")

  referral Referral @relation(fields: [referralId], references: [id])
  invoice  Invoice  @relation(fields: [invoiceId], references: [id])
  payout   Payout?  @relation(fields: [payoutId], references: [id])

  @@unique([referralId, invoiceId])
  @@index([partnerId, status])
  @@map("commissions")
}

model Payout {
  id                String    @id @default(uuid())
  partnerId         String    @map("partner_id")
  amountCents       Int       @map("amount_cents")
  currency          String    @default("usd")
  method            String
  status            String    @default("pending")   // PayoutStatus
  idempotencyKey    String    @unique @map("idempotency_key")   // Stripe transfer idempotency
  stripeTransferId  String?   @map("stripe_transfer_id")
  externalReference String?   @map("external_reference")
  periodStart       DateTime  @map("period_start")
  periodEnd         DateTime  @map("period_end")
  processedAt       DateTime? @map("processed_at")
  failureReason     String?   @map("failure_reason")
  createdAt         DateTime  @default(now()) @map("created_at")

  partner     Partner      @relation(fields: [partnerId], references: [id])
  commissions Commission[]

  @@index([partnerId, createdAt(sort: Desc)])
  @@index([status])
  @@map("payouts")
}

// ============================================================
// COMPLIANCE & AUDIT
// ============================================================

model AuditLog {
  id             String   @id @default(uuid())
  action         String                                   // AuditActionType
  // Exactly one of userId/staffId is set (CHECK constraint in §5) — a tenant action
  // or a staff action (TDD_15), never both, never neither.
  userId         String?  @map("user_id")
  staffId        String?  @map("staff_id")
  storeId        String?  @map("store_id")
  // Org-level actions (an OrganizationOverride write, a suspension) have no single store.
  organizationId String?  @map("organization_id")
  impersonationSessionId String? @map("impersonation_session_id")   // Set when a staff acts as the org
  resourceType   String?  @map("resource_type")
  resourceId     String?  @map("resource_id")
  metadata       Json?
  ipAddress      String?  @map("ip_address")
  userAgent      String?  @map("user_agent")
  timestamp      DateTime @default(now())

  user  User?  @relation(fields: [userId], references: [id])
  staff Staff? @relation(fields: [staffId], references: [id])

  @@index([userId, timestamp(sort: Desc)])
  @@index([staffId, timestamp(sort: Desc)])
  @@index([storeId, timestamp(sort: Desc)])
  @@index([organizationId, timestamp(sort: Desc)])
  @@index([action, timestamp(sort: Desc)])
  @@index([timestamp])    // Cold export / purge
  @@map("audit_logs")
}

model DataSubjectRequest {
  id                     String    @id @default(uuid())
  organizationId         String    @map("organization_id")
  storeId                String?   @map("store_id")
  type                   String                                  // DsrType
  status                 String    @default("pending_verification")   // DsrStatus
  subjectType            String    @map("subject_type")          // 'customer' | 'user'
  subjectId              String?   @map("subject_id")
  subjectEmail           String?   @map("subject_email")
  subjectPhone           String?   @map("subject_phone")
  requestedBy            String?   @map("requested_by")
  requestedAt            DateTime  @default(now()) @map("requested_at")
  deadlineAt             DateTime  @map("deadline_at")
  deadlineAlertSentAt    DateTime? @map("deadline_alert_sent_at")
  verifiedAt             DateTime? @map("verified_at")
  completedAt            DateTime? @map("completed_at")
  resultKey              String?   @map("result_key")
  resultExpiresAt        DateTime? @map("result_expires_at")
  rejectionReason        String?   @map("rejection_reason")
  retainedRecordsSummary Json?     @map("retained_records_summary")   // What was kept and under which legal basis
  notes                  String?

  organization Organization @relation(fields: [organizationId], references: [id])

  @@index([organizationId, status])
  @@index([deadlineAt, status])
  @@index([subjectEmail])
  @@map("data_subject_requests")
}

model ConsentRecord {
  id         String    @id @default(uuid())
  storeId    String    @map("store_id")
  customerId String    @map("customer_id")
  purpose    String
  legalBasis String    @map("legal_basis")   // LegalBases
  granted    Boolean
  grantedAt  DateTime? @map("granted_at")
  revokedAt  DateTime? @map("revoked_at")
  ipAddress  String?   @map("ip_address")
  userAgent  String?   @map("user_agent")
  source     String
  createdAt  DateTime  @default(now()) @map("created_at")

  store    Store    @relation(fields: [storeId], references: [id], onDelete: Cascade)
  customer Customer @relation(fields: [customerId], references: [id], onDelete: Cascade)

  @@index([customerId, purpose])
  @@index([storeId, purpose, granted])
  @@map("consent_records")
}

// Cookie consent for platform users and anonymous visitors (TDD_05 §10.5).
model CookieConsent {
  id         String   @id @default(uuid())
  userId     String?  @map("user_id")
  visitorId  String   @map("visitor_id")
  categories Json                              // { functional: true, analytics: false, marketing: false }
  policyVersion String @map("policy_version")
  ipHash     String?  @map("ip_hash")
  userAgent  String?  @map("user_agent")
  createdAt  DateTime @default(now()) @map("created_at")

  user User? @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([visitorId, createdAt(sort: Desc)])
  @@index([userId, createdAt(sort: Desc)])
  @@map("cookie_consents")
}

model RetentionSettings {
  storeId          String   @id @map("store_id")
  conversationDays Int      @default(730) @map("conversation_days")
  mediaDays        Int      @default(365) @map("media_days")
  analyticsDays    Int      @default(395) @map("analytics_days")
  notificationDays Int      @default(90) @map("notification_days")
  updatedAt        DateTime @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@map("retention_settings")
}

// ============================================================
// AI
// ============================================================

model AISettings {
  storeId               String    @id @map("store_id")
  enabledFeatures       String[]  @default([]) @map("enabled_features")   // AIFeature[]
  dailyRequestCap       Int       @default(5000) @map("daily_request_cap")
  dataProcessingConsent Boolean   @default(false) @map("data_processing_consent")
  consentedAt           DateTime? @map("consented_at")
  consentedBy           String?   @map("consented_by")
  // Separate from dataProcessingConsent — covers the autonomous chatbot (TDD_12 §1, §13).
  // Both must be true for §13 to run.
  autonomousConsent     Boolean   @default(false) @map("autonomous_consent")
  autonomousConsentedAt DateTime? @map("autonomous_consented_at")
  autonomousConsentedBy String?   @map("autonomous_consented_by")
  autonomousKillSwitch  Boolean   @default(false) @map("autonomous_kill_switch")   // Org-level stop from TDD_15 §6
  updatedAt             DateTime  @updatedAt @map("updated_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@map("ai_settings")
}

model AIUsageRecord {
  id            String   @id @default(uuid())
  storeId       String   @map("store_id")
  feature       String                                  // AIFeature
  provider      String                                  // AIProvider
  modelId       String   @map("model_id")
  promptVersion String   @map("prompt_version")         // From the prompt file's exported PROMPT_VERSION (TDD_12 §11)
  inputTokens   Int      @map("input_tokens")
  outputTokens  Int      @map("output_tokens")
  costMicros    Int      @map("cost_micros")            // USD micro-dollars, computed from the model registry setting
  latencyMs     Int      @map("latency_ms")
  cached        Boolean  @default(false)
  accepted      Boolean?
  conversationId String? @map("conversation_id")
  createdAt     DateTime @default(now()) @map("created_at")

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@index([storeId, createdAt])
  @@index([feature, createdAt])
  @@map("ai_usage_records")
}

// AI credits ("Chispas") — TDD_12 §9.5. Pooled per ORGANIZATION, not per store.
model AiCreditBalance {
  organizationId       String   @id @map("organization_id")
  remaining            Int      @default(0)
  payAsYouGoEnabled    Boolean  @default(false) @map("pay_as_you_go_enabled")
  payAsYouGoCapCents   Int?     @map("pay_as_you_go_cap_cents")       // Monthly cap set by the admin
  payAsYouGoSpentCents Int      @default(0) @map("pay_as_you_go_spent_cents")   // Reset with the billing period
  periodStart          DateTime @map("period_start")                   // Last monthly reset
  updatedAt            DateTime @updatedAt @map("updated_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@map("ai_credit_balances")
}

model AiCreditTransaction {
  id             String   @id @default(uuid())
  organizationId String   @map("organization_id")
  storeId        String?  @map("store_id")          // Which store's AI call triggered a spend
  amount         Int                                // Negative = spend, positive = credit
  reason         String                             // AiCreditReason
  usageRecordId  String?  @map("usage_record_id")   // reason = spend
  conversationId String?  @map("conversation_id")   // reason = spend (autonomous, per conversation)
  staffId        String?  @map("staff_id")          // reason = staff_adjustment
  note           String?                            // Staff reason, top-up package id
  createdAt      DateTime @default(now()) @map("created_at")

  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, createdAt])
  @@map("ai_credit_transactions")
}

// ============================================================
// PLATFORM / INTERNAL ADMIN — TDD_15_InternalAdmin.md
// Staff are a separate identity space from User: they sign in via OIDC SSO, never a
// customer credential, and never hold a Membership row.
// ============================================================

model Staff {
  id         String   @id @default(uuid())
  email      String   @unique
  name       String
  role       String                                    // StaffRoles
  ssoSubject String   @unique @map("sso_subject")      // Subject claim from the OIDC token
  active     Boolean  @default(true)
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")

  auditLogs             AuditLog[]
  impersonationSessions ImpersonationSession[]
  organizationOverrides OrganizationOverride[]
  pluginReviews         Plugin[]
  platformSettings      PlatformSetting[]

  @@index([role])
  @@map("staff")
}

model ImpersonationSession {
  id             String    @id @default(uuid())
  staffId        String    @map("staff_id")
  organizationId String    @map("organization_id")
  reason         String
  mode           String    @default("read_only")      // ImpersonationMode
  tokenHash      String    @unique @map("token_hash")  // The short-lived JWT issued for the customer app
  expiresAt      DateTime  @map("expires_at")
  elevatedAt     DateTime? @map("elevated_at")         // When mode switched to write (second confirmation)
  endedAt        DateTime? @map("ended_at")
  endedBy        String?   @map("ended_by")            // 'staff' | 'customer' | 'expired'
  createdAt      DateTime  @default(now()) @map("created_at")

  staff        Staff        @relation(fields: [staffId], references: [id])
  organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@index([organizationId, endedAt])
  @@index([staffId, createdAt])
  @@index([expiresAt, endedAt])
  @@map("impersonation_sessions")
}

model FeatureFlag {
  key            String   @id
  description    String
  rolloutPercent Int      @default(0) @map("rollout_percent")
  orgAllowlist   String[] @default([]) @map("org_allowlist")
  orgDenylist    String[] @default([]) @map("org_denylist")
  updatedAt      DateTime @updatedAt @map("updated_at")

  @@map("feature_flags")
}

// Runtime platform configuration edited from the staff console (TDD_15 §6):
// active AI provider, platform-wide chatbot kill switch, maintenance mode.
model PlatformSetting {
  key              String   @id                         // PlatformSettingKeys
  value            Json
  updatedByStaffId String?  @map("updated_by_staff_id")
  updatedAt        DateTime @updatedAt @map("updated_at")

  updatedBy Staff? @relation(fields: [updatedByStaffId], references: [id])

  @@map("platform_settings")
}
```

---

## 5. Required SQL beyond Prisma

Prisma does not express these. They live in `libs/core/database/prisma/migrations/<ts>_raw_sql/migration.sql`,
applied right after the initial schema migration, with a matching rollback in
`libs/core/database/rollbacks/` (`TDD_03` §5.4). Table and column names are the
`@@map`/`@map` names.

```sql
-- Extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Full-text search vectors (generated columns, not declared in the Prisma schema)
ALTER TABLE messages
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(content, ''))) STORED;
CREATE INDEX idx_messages_search ON messages USING GIN (search_vector);

ALTER TABLE customers
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('spanish', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple',  coalesce(email, '')), 'B') ||
    setweight(to_tsvector('simple',  coalesce(phone_normalized, '')), 'B')
  ) STORED;
CREATE INDEX idx_customers_search ON customers USING GIN (search_vector);

ALTER TABLE products
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('spanish', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple',  coalesce(sku, '')), 'B') ||
    setweight(to_tsvector('spanish', coalesce(description, '')), 'C')
  ) STORED;
CREATE INDEX idx_products_search ON products USING GIN (search_vector);

-- Trigram indexes for typo-tolerant matching
CREATE INDEX idx_customers_name_trgm ON customers USING GIN (name gin_trgm_ops);
CREATE INDEX idx_products_name_trgm  ON products  USING GIN (name gin_trgm_ops);

-- Partial indexes Prisma cannot declare
CREATE INDEX idx_conversations_active_inbox
  ON conversations (store_id, assigned_to, last_message_at DESC)
  WHERE status IN ('OPEN', 'PENDING');

CREATE INDEX idx_notifications_unread
  ON notifications (user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX idx_customers_phone
  ON customers (store_id, phone_normalized)
  WHERE phone_normalized IS NOT NULL;

-- Uniqueness with NULLs / conditional uniqueness
CREATE UNIQUE INDEX uq_roles_system_name ON roles (name) WHERE store_id IS NULL;
CREATE UNIQUE INDEX uq_roles_store_name  ON roles (store_id, name) WHERE store_id IS NOT NULL;
DROP INDEX IF EXISTS invitations_store_id_email_status_key;
CREATE UNIQUE INDEX uq_invitations_pending ON invitations (store_id, email) WHERE status = 'PENDING';

-- Invariants
ALTER TABLE audit_logs
  ADD CONSTRAINT chk_audit_actor
  CHECK ((user_id IS NULL) <> (staff_id IS NULL));

ALTER TABLE ai_credit_balances
  ADD CONSTRAINT chk_ai_credit_non_negative CHECK (remaining >= 0);

ALTER TABLE conversations
  ADD CONSTRAINT chk_csat_range CHECK (csat_score IS NULL OR csat_score BETWEEN 1 AND 5);
```

The two Prisma-declared indexes that these partial indexes supersede
(`@@index([storeId, status, assignedTo, lastMessageAt])` and
`@@index([userId, readAt, createdAt])`) stay in the schema because Prisma needs them for
non-inbox queries; do **not** add SQL duplicates of any index Prisma already declares.

RLS policies: `scripts/rls.sql`, see §3.2.

---

## 6. Internal event bus

Services emit domain events; listeners react. Keeps modules decoupled without a message broker.

```typescript
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
  ) {}

  async create(input: CreateOrderInput, ctx: TenantContext): Promise<Order> {
    const order = await this.prisma.client.order.create({ data: this.buildOrder(input, ctx) })

    this.events.emit(Events.ORDER_CREATED, {
      storeId: order.storeId,
      orderId: order.id,
      orderNumber: order.orderNumber,
      customerId: order.customerId,
      conversationId: order.conversationId,
      totalCents: order.totalCents,
      currency: order.currency,
    } satisfies OrderCreatedPayload)

    return order
  }
}

@Injectable()
export class OrderEventsListener {
  constructor(
    private readonly webhooks: WebhooksService,
    @InjectQueue(QueueNames.EMAIL) private readonly emailQueue: Queue<SendEmailJob>,
    @InjectQueue(QueueNames.ANALYTICS) private readonly analyticsQueue: Queue<TrackAnalyticsJob>,
  ) {}

  @OnEvent(Events.ORDER_CREATED)
  async handleOrderCreated(payload: OrderCreatedPayload): Promise<void> {
    await this.webhooks.trigger(Events.ORDER_CREATED, payload)
    await this.emailQueue.add(JobNames.SEND_EMAIL, {
      template: EmailTemplates.ORDER_CONFIRMATION,
      to: await this.customers.emailFor(payload.customerId),
      locale: await this.customers.localeFor(payload.customerId),
      data: { orderId: payload.orderId },
      tags: { storeId: payload.storeId, template: EmailTemplates.ORDER_CONFIRMATION },
    })
    await this.analyticsQueue.add(JobNames.TRACK_EVENT, {
      event: AnalyticsEventNames.ORDER_CREATED,
      storeId: payload.storeId,
      data: { orderId: payload.orderId, totalCents: payload.totalCents },
      timestamp: new Date().toISOString(),
    })
  }
}
```

**Rules:**
- Event names come from `Events`, job names from `JobNames`, queues from `@InjectQueue(QueueNames.X)`.
- Emit **after** the write commits. Inside a `$transaction`, collect payloads and emit once
  the transaction returns.
- Listeners are idempotent: a payload may be delivered twice after a crash/retry.

---

## 7. Authentication design

```
Passport strategies:
├─ JWT Strategy         — tenant API requests (AuthGuard)
├─ Google OAuth 2.0     — customer social login (emailVerified = true on first login)
├─ Staff OIDC           — Google Workspace / Okta for apps/admin (StaffAuthGuard, TDD_15 §1)
├─ Plugin API key       — PluginApiKeyGuard (TDD_10 §6.4)
└─ Tenant API key       — ApiKeyGuard for the public REST API (Settings → API keys)

Tokens:
├─ Access token   — 15 min TTL, stateless JWT: { sub: userId, sid: sessionFamilyId, imp?: impersonationSessionId }
└─ Refresh token  — 7 days, opaque 256-bit random, stored HASHED in Session, rotated on use

Rotation: using a refresh token marks it consumedAt, creates the next Session row in the same
familyId with replacedById linking them, and returns a new pair.
Reuse detection: presenting a token whose consumedAt is set revokes EVERY row in the family
(revokedReason = 'reuse_detected') and returns AUTH_REFRESH_TOKEN_REUSED.
Logout: revokes the family. Password reset: revokes all families of the user.

Verification tokens (email verification 24h, password reset 1h, DSR 7d) are
256-bit random values stored hashed in VerificationToken, single use (usedAt).
```

- Email verification is mandatory before any authenticated action other than
  `resendVerification` and `logout`.
- Invitations require explicit acceptance: the `Invitation` row is created with a hashed
  token; on acceptance (logged in as the invited email, `TENANT_INVITATION_EMAIL_MISMATCH`
  otherwise) the `Membership` row is created with `status = ACTIVE`. No Membership exists
  before acceptance.
- Staff never hold a `User` row. Impersonation (`TDD_15` §4) mints a short-lived access
  token with the `imp` claim; `AuthGuard` resolves it to `request.impersonation` and
  `TenantGuard` applies `READ_ONLY` unless the session was elevated.
