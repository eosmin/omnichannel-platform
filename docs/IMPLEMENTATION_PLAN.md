# Implementation Plan

> Omnichannel Commerce Platform — build order with dependencies (TDD v1.2)
> **Read `TDD_02_Conventions.md` before writing any code.**
>
> **v1.2 MVP scope — single owner.** Steps marked **DEFERRED (Phase 2)** are out of scope and
> must not be built, and the "MVP trim" notes remove SaaS pieces from steps that stay. Full
> list and rationale: `INDEX.md` → "MVP scope". Constants, schema and env entries for deferred
> features are not created until Phase 2. **File-by-file list of what to omit or adjust:
> `MVP_TRIM_CHECKLIST.md`** (schema and constants for Steps 0.3 and 0.4, behavior changes for
> the steps that name it, test changes for every step that writes tests).

---

## How to use this plan

Steps are ordered by dependency. Later steps assume earlier ones exist.
Do not jump ahead.

Each step lists:
- **Files** to create
- **TDD reference** for the specification
- **Done when** — the verifiable completion criterion

Mark a step complete only when its "done when" criterion passes.

Versions for every dependency come from `TDD_01 §2.4` and nowhere else. Before installing
a package, resolve it with Context7; if the pinned version does not exist or is
incompatible, fix the table first and say why in the commit.

---

## CI rollout and the `main` ruleset

CI is not written at the end. It starts in Step 0.1 and each step adds the job (or the check)
that the step makes possible, so GitHub verifies every step as it lands. A GitHub ruleset on
`main` grows in lockstep: **a status check is added as required only after its job has run
once on GitHub** (GitHub lists a check only after it has reported), and never before, or
every PR would be blocked.

Ruleset on `main` (created in Step 0.1): pull request required with **0 approvals** (a sole
owner cannot approve their own PR, `MVP_TRIM_CHECKLIST.md` §7, D7), force pushes and deletion
blocked, conversations resolved, branch up to date. Job names are the ones of `TDD_03 §4`.

| Step | CI work | Add to the ruleset as required |
|---|---|---|
| 0.1 | `ci.yml` with `lint-and-types` (Nx affected lint and type-check); create the ruleset | `lint-and-types` |
| 0.4 | `integration-tests` job born with Postgres and Redis services: `prisma migrate deploy` on an empty database and `check-rollbacks` | `integration-tests` |
| 0.5 | Dockerfiles for `api` and `worker`; `security-scan` job born: build both images, Trivy (CRITICAL/HIGH fails; unfixed ignored) | `security-scan` |
| 0.6 | add gitleaks to `security-scan`; add commitlint, `validate:translations` and `validate:deprecations` to `lint-and-types` | none new |
| 1.1 | `unit-tests` job with Nx affected and coverage thresholds (only for paths that exist so far) | `unit-tests` |
| 1.3 | `integration-tests` now runs the integration suites; `security-tests` job born with the tenant isolation suite | `security-tests` (no bypass) |
| 2.5 | `integration-tests` also runs `pnpm test:contracts` | none new |
| 3.1 | Dockerfile for `web` added to `security-scan`; `e2e-tests` job born with Postgres, Redis, MinIO and Mailpit (magic-link login); `lighthouse` job (PRs only) | `e2e-tests` (`lighthouse` stays optional, as in `TDD_14 §8`) |
| 7.3 | Railway deployment config; nothing new in the ruleset | none new |

From Step 0.1 on, a step is not done until **its PR is green on GitHub** with every job that
exists at that point. Thresholds, services and secrets (for example `SNYK_TOKEN`) are added
to a job when that job is created.

---

## Milestone 0 — Foundation

No product functionality. This milestone exists so that everything after it
is fast, safe and consistent.

### Step 0.1 — Nx workspace
- [ ] Create the Nx workspace with pnpm (`packageManager` in `package.json`, Node `>=22`)
- [ ] `.nvmrc` with the exact Node version from `TDD_01 §2.4` (`24.20.0`) — `engines` stays the
      `>=22` range; `.nvmrc` pins what developers, CI and tooling actually run
- [ ] Create apps: `api` (NestJS), `web` (Next.js), `worker` (NestJS), `widget` (Vite/vanilla TS) — `admin` is DEFERRED (Phase 2, Step 7.6)
- [ ] Configure `tsconfig.base.json` with strict mode per `TDD_02 §11` (TypeScript 5.9)
- [ ] Configure project tags (`scope:core-domain`, `scope:core`, …) and module boundaries per `TDD_14 §6`, `§9`
- [ ] `eslint.config.js` (flat), Prettier, `.env.example` files per `TDD_14 §6`, `§10`
- [ ] `.github/workflows/ci.yml` with the `lint-and-types` job (actions pinned to SHAs, Node and pnpm from `package.json`), and the `main` ruleset described in "CI rollout"; after the first run, add `lint-and-types` as a required check

**Files:** `nx.json`, `tsconfig.base.json`, `package.json`, `.nvmrc`, `eslint.config.js`, `apps/*/project.json`
**TDD:** `TDD_01 §1`, `§2.4`, `TDD_14 §6`, `§9`
**Done when:** `pnpm nx graph` renders, `pnpm lint` passes on the empty workspace, an
import from `libs/core/config` inside `apps/web` fails lint, `cat .nvmrc` matches the
Node version pinned in `TDD_01 §2.4`, and `lint-and-types` is green on GitHub for a PR.

### Step 0.2 — Local infrastructure
- [ ] `docker-compose.yml` with Postgres 18.6, PgBouncer, Redis 8.10, MinIO (+ `minio-init`), Mailpit, ClamAV
- [ ] `scripts/bootstrap.sh`
- [ ] `.env.example` (api/worker) and `apps/web/.env.example` per `TDD_02 §9`, **MVP trim:** omit `GOOGLE_*`, `STRIPE_*`, `NEXT_PUBLIC_STRIPE_*`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `STAFF_*`

**TDD:** `TDD_03 §3.1`, `TDD_14 §1`, `§10`
**Done when:** `docker compose up -d --wait` succeeds, every health check passes, and the
`platform-dev` bucket exists in MinIO.

### Step 0.3 — Constants library (blocking dependency for everything)
- [ ] `libs/core/config/env.ts` — Zod-validated environment (`z.stringbool`, `z.url`)
- [ ] `apps/web/lib/env.ts` — `NEXT_PUBLIC_*` schema
- [ ] `libs/core/errors/error-codes.ts` + `PlatformException`
- [ ] `libs/core/events/event-names.ts` + `event-payloads.ts`
- [ ] `libs/core/cache/cache-keys.ts` + `CacheTTL`
- [ ] `libs/core/auth/permissions.ts` + `RolePresets` (`libs/core/admin/staff-constants.ts` + `StaffRolePresets` DEFERRED)
- [ ] `libs/core/domain/status-enums.ts` + i18n keys, colors, transitions, editable fields
- [ ] `libs/core/api/api-routes.ts` (`ApiRoutes`, `InfraRoutes`; `AdminRoutes` DEFERRED)
- [ ] `libs/core/queues/queue-names.ts` + `JobNames`; `schedules.ts` + `LockNames`
- [ ] `libs/core/realtime/realtime-events.ts` (complete `RealtimeEventMap`) + `room-names.ts`
- [ ] `libs/core/notifications/notification-constants.ts` (complete `NotificationDefaults`)
- [ ] `libs/core/audit/audit-actions.ts`, `libs/core/metrics/metric-names.ts`
- [ ] `libs/core/analytics/analytics-constants.ts`, `libs/core/compliance/compliance-constants.ts` (`billing`, `ai` and `referrals` constants DEFERRED)
- [ ] `libs/api-client/src/query-keys.ts`, `app-paths.ts`
- [ ] **MVP trim:** omit every constant, error code, event, cache key, permission, queue, metric, audit action and realtime event that belongs to billing, plans/quotas, AI, referrals, SaaS support or staff admin. Add `SEED_OWNER_EMAIL`, `SEED_OWNER_NAME` (required only when running the seed) and `BULL_BOARD_ENABLED` (default `false`), `BULL_BOARD_ADMIN_EMAILS` (comma-separated, default empty) to the `env.ts` Zod schema (plus `SEED_ORGANIZATION_NAME` and `SEED_STORE_NAME`, `MVP_TRIM_CHECKLIST.md` §7, D3)

**TDD:** `TDD_02` in full, plus the constants sections of `TDD_05 §9.1`, `§10.1`, `TDD_06 §1.4`, `§6.1`, `TDD_07 §4`, `TDD_11 §7.1` (TDD_11 §1 billing constants are DEFERRED; trims per `MVP_TRIM_CHECKLIST.md` §1, §2)
**Done when:** every constant file compiles and is exported from its barrel, and the
`_AssertComplete` check in `realtime-events.ts` passes.
**This step is non-negotiable.** Everything downstream imports from here.

### Step 0.4 — Database schema
- [ ] `libs/core/database/prisma/schema.prisma` — full schema with `@@map`/`@map`, generator `prisma-client`
- [ ] `libs/core/database/prisma.config.ts` + root re-export
- [ ] Initial migration
- [ ] Raw SQL migration: extensions, generated `tsvector` columns, GIN/trigram indexes, partial indexes, partial uniques, CHECK constraints
- [ ] Rollback scripts in `libs/core/database/rollbacks/` + `scripts/check-rollbacks.ts`
- [ ] `PrismaService` with `@prisma/adapter-pg` and the read-replica extension
- [ ] `libs/core/crypto` (AES-256-GCM helpers) and the seed
- [ ] **MVP trim:** the schema has no `Subscription`, plan, `PlanLimits`, `OrganizationOverride`, `AiCreditBalance`, usage/billable-window, dunning, referral or staff/admin tables. They return later as additive migrations
- [ ] **Owner bootstrap (closed signup):** idempotent and production-safe. Creates the system roles from `RolePresets`, the owner `User` (email from `SEED_OWNER_EMAIL`, marked verified, no password: users have none), the `Organization`, the first `Store` with `StoreSettings` and `RetentionSettings`, and the owner `Membership`. This replaces the password-based seed with test logins in `TDD_03 §5.5`: no `passwordHash`, no shared test password, no `faker`
- [ ] **Dev fixtures script** (dev and CI only, never run in production): the fixture users without passwords, a second store, products, customers and conversations from `TDD_03 §5.5`. Split, names and env variables per `MVP_TRIM_CHECKLIST.md` §7, D3

- [ ] CI: create the `integration-tests` job with Postgres and Redis service containers; it runs `prisma migrate deploy` on an empty database and `check-rollbacks`. Add `integration-tests` as a required check

**TDD:** `TDD_01 §2.3`, `§4`, `§5`, `TDD_03 §5`
**Done when:** `pnpm prisma migrate deploy` succeeds against a fresh database, `prisma studio`
shows every table with snake_case names, the seed runs twice without duplicates and the
seeded owner exists with a working Membership, and
`psql -c "\d conversations"` shows `search_vector` only on `messages`, `customers`, `products`,
and `integration-tests` is green on GitHub.

### Step 0.5 — Observability
- [ ] `libs/core/logger` — Pino with redaction and correlation ID, `AuthenticatedRequest` type
- [ ] `libs/core/metrics` — `@prometheus-io/client` with `MetricNames`
- [ ] `GlobalExceptionFilter`
- [ ] Health controller: `/health` and `/health/ready`; global prefix `/api/v1` with the `InfraRoutes` exclusions
- [ ] Sentry instrumentation file
- [ ] Dockerfiles for `api` and `worker` (multi-stage, pinned Node image from `TDD_01 §2.4`, non-root user)
- [ ] CI: create the `security-scan` job: build both images and scan them with Trivy (CRITICAL/HIGH fails, unfixed ignored). Add `security-scan` as a required check

**TDD:** `TDD_04 §1`, `§2`, `§3`, `§4`, `TDD_02 §7`
**Done when:** `GET /health/ready` returns 200 and `GET /metrics` exposes metrics, both
**without** the `/api/v1` prefix, a request to `/api/v1/unknown` returns the error contract,
both images build and pass Trivy, and `security-scan` is green on GitHub.

### Step 0.6 — Tooling
- [ ] Husky pre-commit (lint-staged + `gitleaks git --pre-commit`) and commit-msg hooks
- [ ] `scripts/validate-translations.ts`, `validate-deprecations.ts`, `check-isolation-coverage.ts`
- [ ] CI: add gitleaks to `security-scan`, and commitlint, `validate:translations` and `validate:deprecations` to `lint-and-types`. The remaining jobs of `TDD_03 §4` are created by the steps listed in "CI rollout" (unit tests 1.1, security tests 1.3, e2e and Lighthouse 3.1)

**TDD:** `TDD_14 §6`, `§7`, `TDD_03 §4`
**Done when:** a commit violating conventions is rejected locally and in CI, and every job that
exists so far is green on GitHub.

---

## Milestone 1 — Auth and tenancy

The security foundation. Everything after this depends on it being correct.

### Step 1.1 — Authentication
- [ ] `apps/api/src/modules/auth/` — service, controller, JWT strategy. **MVP trim — magic link only:** no password, no Google/OAuth strategy (both DEFERRED)
- [ ] Access token 15 min; refresh token 7 days, hashed, family-tracked, rotated with reuse detection
- [ ] Magic link login via `VerificationToken` (single-use, short expiry, hashed at rest): request link and consume link (requesting again is the resend; there is no separate resend route). Consuming is a `POST` with the token in the body, never a `GET` with the token in the URL. It issues the access/refresh pair and marks the email verified. Requesting a link for an unknown email returns the same response as for a known one (no user enumeration). Expiry and throttle values per `MVP_TRIM_CHECKLIST.md` §7, D1, D2, held in constants
- [ ] Rate limits per `TDD_05 §3.1` (Redis storage), applied to magic-link request, magic-link consume, signup and resend instead of the login/forgot-password endpoints named there
- [ ] `ApiRoutes.auth` and `AuditActions` carry the magic-link request/consume routes and events; the password login, `forgotPassword`, reset and `PASSWORD_*` entries from `TDD_02`/`TDD_05` are not created
- [ ] **MVP trim — closed signup:** there is no public signup endpoint and no Organization, Subscription or `AiCreditBalance` created here. Users come from the seed (Step 0.4) or from invitation acceptance (Step 1.4, which needs the `Invitation` model). The session issuing code (access/refresh pair) is a reusable service so Step 1.4 can call it

- [ ] CI: create the `unit-tests` job (Nx affected, coverage thresholds from `TDD_13 §9` only for paths that exist so far). Add `unit-tests` as a required check

**TDD:** `TDD_01 §7`, `TDD_05 §3`, `TDD_07 §5.3`
**Done when:** the seeded owner can request a magic link (visible in Mailpit), consume it,
and refresh; a magic link cannot be used twice or after expiry; a link requested for an
unknown email returns the same response as for a known one; and refresh token reuse revokes
the session family, and `unit-tests` is green on GitHub.

### Step 1.2 — Tenancy
- [ ] `TenantGuard` reading `X-Store-Id` (cached context: store, organization, membership; no subscription). `AccessLevelGuard` is DEFERRED with dunning
- [ ] `@CurrentStore()`, `@CurrentUser()`, `@CurrentOrganization()` decorators
- [ ] `PermissionGuard` + `@RequirePermissions()`
- [ ] `AuditService` + `AuditInterceptor`
- [ ] Role seeding with `RolePresets`

**TDD:** `TDD_01 §3.2`, `TDD_02 §4`, `TDD_05 §9`
**Done when:** the tenant isolation test suite passes for a first resource, a request with
`storeId` in the body/query but no header returns `TENANT_HEADER_MISSING`, and a request to a
store the user has no membership in is rejected.

### Step 1.3 — Tenant isolation test suite
- [ ] `tests/security/tenant-isolation.spec.ts` — parameterized
- [ ] `tests/helpers/` — `createTestApp`, `api()`, truncate, `seedTestContext`, token minting (user; staff DEFERRED)
- [ ] `tests/builders/` — entity builders
- [ ] CI: `integration-tests` now runs the integration suites; create the `security-tests` job (Postgres, Redis, MinIO services) with the isolation suite. Add `security-tests` as a required check, with no bypass

**TDD:** `TDD_13 §3`, `§6`
**Done when:** the suite runs in CI as the `security-tests` blocking gate, it is a required check
on `main`, and `check-isolation-coverage` lists every `store_id` model.
**Every subsequent resource must be added to this suite.**

### Step 1.4 — Organizations, stores, memberships
- [ ] Organization read/update and stores CRUD (`ApiRoutes.organizations.*`); there is no create-organization endpoint (the bootstrap creates it). `StoreSettings` and `RetentionSettings` are created with each store
- [ ] `Invitation` flow with mandatory acceptance; `Membership` created on accept. Invitation token: hashed at rest, single-use, expiring, valid only for the invited email
- [ ] `GET /invitations/:token` (public): preview only (store, role, inviter, invited email), no other data
- [ ] Accept as `POST`, three cases: (a) **no account:** signup with the email fixed to the invited one, creating the `User` (email verified, since the link reached that inbox), the `Membership` and the session in one transaction; (b) **existing account:** requires a session for the invited email (magic link, then back to the invitation page), then creates the `Membership`; (c) **session for another email:** rejected with a mismatch error. Rate limits per Step 1.1
- [ ] Web page `/invitations/[token]` (built in Step 3.1) handling the three cases, plus a "no access" screen for users with no membership (revoked invitation, removed from every store)
- [ ] Team management endpoints, custom roles
- [ ] **MVP trim:** no `EffectivePlanLimitsService` and no `QuotaGuard(SEATS|STORES)`; seats and stores are unlimited

**TDD:** `TDD_01 §4`, `TDD_07 §5.3` (TDD_11 §1.1 effective plan limits is DEFERRED)
**Done when:** the owner can create a store, invite a member by email (no account yet), and
the invitee gets no access until the explicit accept. Accept with no account creates user,
membership and session atomically (a failure leaves no user behind); a reused, expired or
revoked token is rejected; a token cannot be accepted for a different email; signup without
a valid invitation token is rejected; and an authenticated user with no membership is
never sent to `/onboarding`.

---

## Milestone 2 — Core messaging

The product's reason to exist.

### Step 2.1 — Queues and workers
- [ ] `libs/core/queues/queues.module.ts` — `@nestjs/bullmq`, seven queues plus DLQ (the `ai` queue is DEFERRED)
- [ ] `apps/worker` NestJS bootstrap with health routes, graceful shutdown, `LeaderLockService`
- [ ] Email worker + `ResendProvider` (+ Mailpit dev provider) + React Email templates + server-side i18n
- [ ] Bull Board at `/admin/queues`, mounted only when `BULL_BOARD_ENABLED=true`; access requires a valid JWT whose `email` claim is in `BULL_BOARD_ADMIN_EMAILS` (empty allowlist = nobody). Applied as middleware, not through `@RequirePermissions()` or `TenantGuard`, because it is cross-tenant. Replay of a dead-lettered job = retry the **failed job in its original queue** from Bull Board (kept by `removeOnFail`); the dead-letter queue is a triage index (see `MVP_TRIM_CHECKLIST.md` §3)
- [ ] Resend webhook with transactional idempotency

**TDD:** `TDD_07 §1`, `§3`, `§4`, `§5`
**Done when:** a magic link email is visible in Mailpit; `/admin/queues` returns 404 with the flag off, 401 without a token, 403 for an email outside the allowlist and 200 for one inside it; and killing the worker
mid-job lets the job complete or retry without loss.

### Step 2.2 — Customers
- [ ] Customers module with store-scoped `CustomerIdentity` resolution
- [ ] `findOrCreateByIdentity` (with `phoneNormalized`), link identity
- [ ] Addresses, notes, customer tags
- [ ] Merge with `CustomerMerge` snapshot and unmerge within 30 days

**TDD:** `TDD_01 §4`, `TDD_09 §6`
**Done when:** two identities on different channels can be merged into one customer and
unmerged; the same phone number exists as two customers in two stores.

### Step 2.3 — Conversations and messages
- [ ] Conversations module with the status state machine (`updateStatus`, reasons, actors) and read state
- [ ] Messages module with `idempotencyKey`, `mediaIds`, mentions, outbound delivery tracking
- [ ] `MessagingWindowService`
- [ ] Cursor pagination per `TDD_08 §2.4`, list view model per `TDD_09 §2`
- [ ] Tags, snippets, routing rules, business hours, store settings endpoints

**TDD:** `TDD_08 §2.4`, `TDD_09 §2`, `§3`, `TDD_02 §5`
**Done when:** conversations list under 300ms p95 with 10k seeded rows, invalid status
transitions are rejected, and `POST /messages` with a repeated `idempotencyKey` returns the
existing message.

### Step 2.4 — Realtime
- [ ] Socket.io gateway with the ioredis adapter, typed events, conversation rooms
- [ ] `RealtimeService` + event listeners + `EVENTS_BRIDGE`
- [ ] Per-socket presence with heartbeat and away detection
- [ ] Client connection manager, `useRealtimeSync` with `QueryKeys`, offline queue with terminal-error handling

**TDD:** `TDD_06 §1`–`§5`
**Done when:** two browser sessions see each other's messages instantly, closing one of two
tabs keeps the user online, and a message composed offline sends on reconnect.

### Step 2.5 — Plugin SDK and registry
- [ ] `libs/plugins/sdk` — `ChannelPlugin`, `ChannelEvent` (with `connectionId`), `ChannelContext`, types
- [ ] `libs/plugins/runtime` — registry with contract validation, `PluginsModule`
- [ ] `tests/contracts/channel-plugin.contract.ts` with per-plugin fixtures
- [ ] CI: `integration-tests` also runs `pnpm test:contracts`

**TDD:** `TDD_10 §2`, `§3`, `§9`
**Done when:** the contract suite exists, runs in `integration-tests`, and the registry rejects a plugin that
declares a capability it does not implement.

### Step 2.6 — Inbound pipeline
- [ ] `ChannelWebhookController` (verify, normalize, enqueue) + `InboundProcessor`
- [ ] `InboundMessageService`: connection → store resolution, identity, reopen/wake/create, dedupe, media job, routing, events (billing window DEFERRED)
- [ ] `ChannelConnection` management + `libs/core/crypto` encryption + health scheduler
- [ ] **MVP trim:** no `UsageMeteringService`; inbound conversations are never metered or blocked

**TDD:** `TDD_10 §4`, `§10`
**Done when:** a simulated webhook addressed to store B's connection creates customer,
conversation and message in store B only, a replayed webhook creates nothing, and the
endpoint answers in under 300ms p99 while the worker does the work.

### Step 2.7 — WhatsApp plugin
- [ ] `libs/channels/meta` shared client (signature, handshake, media download)
- [ ] `libs/channels/whatsapp` — full implementation, templates, inbound media fetch
- [ ] 24-hour messaging window enforced by the core
- [ ] Contract tests with captured fixtures

**TDD:** `TDD_10 §5.1`
**Done when:** real inbound and outbound messages work against a WhatsApp test number, and
an inbound image is stored, scanned and rendered.

### Step 2.8 — Instagram, Messenger, web widget, email
- [ ] `MetaChannelPlugin` base class; Instagram and Messenger plugins with capability declarations
- [ ] `libs/channels/web-widget` + `apps/widget` bundle + `/widget` public endpoints and socket namespace
- [ ] `libs/channels/email` on Resend Receiving
- [ ] Contract tests for all four

**TDD:** `TDD_10 §5.2`, `§5.4`, `§5.5`
**Done when:** all five channels deliver into the same unified inbox, and the widget works
on a page with a strict CSP.

---

## Milestone 3 — Inbox interface

### Step 3.1 — Frontend foundation
- [ ] Next.js App Router structure with `/s/[storeId]`, `/org`, `/account`, `/invitations/[token]`, `proxy.ts`. A user with no membership is redirected to the "no access" screen, not `/onboarding` (DEFERRED)
- [ ] shadcn/ui components, Lucide icons, Tailwind, CSP headers
- [ ] Auth flow with token refresh; `apiClient` setting `X-Store-Id`
- [ ] `libs/api-client` typed HTTP client, `QueryKeys`, `AppPaths`
- [ ] i18n with next-intl, `es` and `en`, generated enum keys
- [ ] Dockerfile for `web`, added to the `security-scan` build and Trivy scan
- [ ] CI: create the `e2e-tests` job (Postgres, Redis, MinIO and Mailpit services; Playwright reads the magic link from Mailpit) and add it as a required check; create the `lighthouse` job for PRs (optional, not required)

**TDD:** `TDD_01 §2.1`, `TDD_09 §12`, `§15`, `TDD_05 §6`
**Done when:** magic link login works, `/invitations/[token]` handles the no-account, existing-account and mismatched-session cases, the UI renders in both locales with no hardcoded strings,
`validate:translations` passes, securityheaders.com grades the web app A, and `e2e-tests` and
`security-scan` are green on GitHub.

### Step 3.2 — Inbox
- [ ] Three-column layout, responsive
- [ ] Virtualized conversation list from `ConversationListItem`
- [ ] Filters: all, mine, unassigned, by status, by channel, by agent (AI-handled filter DEFERRED)
- [ ] Message thread with realtime updates, read state
- [ ] Composer with slash commands, attachments (media-first), messaging-window states
- [ ] Keyboard shortcuts, bulk actions

**TDD:** `TDD_09 §2`, `§3`, `§4`, `§9`, `§10`
**Done when:** an agent can triage and reply entirely by keyboard.

### Step 3.3 — Customer panel
- [ ] Sidebar with identities, stats, tags, addresses
- [ ] Profile drawer with activity timeline
- [ ] Merge / unmerge flow, link identity

**TDD:** `TDD_09 §6`
**Done when:** the panel shows a unified view across channels.

### Step 3.4 — Media
- [ ] Pre-signed upload with progress, purposes and key prefixes
- [ ] Scan-then-process worker chain (ClamAV, sharp variants as keys)
- [ ] Signed download with variants
- [ ] Media gallery with lightbox, bulk ZIP export

**TDD:** `TDD_07 §6`, `§7`
**Done when:** an image uploads, is scanned, generates variants, and is served through
signed URLs; a `confirmUpload` with a foreign store prefix returns `FILE_KEY_OUT_OF_SCOPE`.

### Step 3.5 — Notifications
- [ ] Notification service with `messageKey` + params, preference resolution, quiet hours from `UserNotificationSettings`
- [ ] Notification center UI rendering keys
- [ ] Web Push with the Serwist service worker
- [ ] Preferences settings page generated from `NotificationDefaults`; email digests

**TDD:** `TDD_06 §6`–`§9`, `TDD_09 §16.3`
**Done when:** assignment triggers in-app and push notifications, quiet hours suppress push
while still persisting the notification, and an hourly digest email arrives in Mailpit.

---

## Milestone 4 — Commerce

### Step 4.1 — Products and inventory
- [ ] Products + variants CRUD
- [ ] Inventory movements with stock calculation and low-stock notification
- [ ] Product search with sub-200ms autocomplete

**TDD:** `TDD_01 §4`, `TDD_08 §5.4`
**Done when:** autocomplete responds under 200ms p95 with 5k products and a `%` query
returns nothing.

### Step 4.2 — Orders
- [ ] Orders module with server-side totals in cents from catalog prices
- [ ] Status state machine with `OrderStatusTransitions`, cancellation reason, proof of delivery
- [ ] Field-level edit restrictions with `OrderEditableFields`
- [ ] Inventory reservation on creation
- [ ] Transactional emails and system messages

**TDD:** `TDD_02 §5`, `§13`, `TDD_09 §5`
**Done when:** totals are never trusted from the client, and illegal transitions
are rejected.

### Step 4.3 — Order UI
- [ ] Create-order side drawer with the chat visible, variants
- [ ] Status change flows with proof upload
- [ ] Print documents (PDF)

**TDD:** `TDD_09 §5`
**Done when:** an agent creates an order without leaving the conversation.

---

## Milestone 5 — Operations

### Step 5.1 — Search
- [ ] Search service over PostgreSQL FTS (`regconfig` literal, normalized phone, escaped LIKE)
- [ ] Command palette with Cmd+K
- [ ] Search analytics

**TDD:** `TDD_08 §5`
**Done when:** global search returns results under 300ms and leaks nothing across tenants.

### Step 5.2 — Analytics
- [ ] Rollup workers, hourly and daily (2-period recompute)
- [ ] Metrics query service
- [ ] Dashboard UI
- [ ] Scheduled reports (PDF/CSV/Excel)

**TDD:** `TDD_11 §7`, `TDD_08 §6`
**Done when:** the dashboard loads under 1s reading only rollup tables.

### Step 5.3 — Caching and performance
- [ ] Redis cache service with metrics and null sentinel
- [ ] Complete cache invalidation listener
- [ ] Read replica routing through the extension
- [ ] PgBouncer configuration verified end to end

**TDD:** `TDD_08 §1`, `§2.5`, `§2.6`
**Done when:** cache hit rate exceeds 40% in a scripted run against seeded data (the k6 load suite of Step 7.5 is DEFERRED, so this uses a throwaway script).

### Step 5.4 — Settings
- [ ] Settings pages per `TDD_09 §13`, **MVP trim:** no Billing, Referrals or AI features pages, and no `PlanFeatures` gating on custom roles
- [ ] Safety and confirmations configuration, inbox behavior
- [ ] Webhooks with resolve-time SSRF protection, delivery log, auto-disable
- [ ] Tenant API keys (`ApiKeyGuard`)
- [ ] Data retention configuration; retention, platform cleanup and audit cold-export schedulers. **MVP trim:** the effective window is `RetentionSettings` only (no `plan.historyRetentionDays`)

**TDD:** `TDD_09 §11`, `§13`, `TDD_05 §9.3`, `§10.4`, `TDD_07 §2`
**Done when:** retention deletes expired data on schedule, and a webhook to a hostname
resolving to a private IP is rejected.

### Step 5.5 — Onboarding — DEFERRED (Phase 2)
> Out of scope for the v1.2 MVP: signup is closed and the owner configures stores and channel
> connections through the Step 5.4 settings pages and the seed.

- [ ] Signup wizard
- [ ] Channel connection flow (web widget on Free, embed snippet)
- [ ] Team invitation step

**TDD:** `TDD_09 §14`
**Done when:** a new user goes from signup to first connected channel without help.

---

## Milestone 6 — Monetization — DEFERRED (Phase 2)

> **Entire milestone out of scope for the v1.2 MVP** (single owner, no paying tenants). Steps
> below are kept as the Phase 2 plan. Do not build, and do not create their constants,
> tables or env variables.

### Step 6.1 — Usage metering
- [ ] Billable conversation windows (done in 2.6) + voiding
- [ ] Usage summary service with caching and invalidation

**TDD:** `TDD_11 §2`
**Done when:** the same conversation within one window is counted exactly once, including
under concurrent inbound messages.

### Step 6.2 — Stripe
- [ ] Checkout (lazy customer) and customer portal
- [ ] Webhook handler with transactional idempotency
- [ ] Subscription sync, trial ending notices
- [ ] Billing Meters overage reporting

**TDD:** `TDD_11 §4`
**Done when:** a full subscribe → invoice → pay cycle completes in Stripe test mode and the
overage meter shows the reported delta.

### Step 6.3 — Quotas and gating
- [ ] `QuotaGuard(CONVERSATIONS|CHANNELS)`, `FeatureGuard`, `ChannelGuard`
- [ ] Quota warning cron
- [ ] Billing UI and plan comparison from `GET /billing/plans`

**TDD:** `TDD_11 §3`, `§6`, `§6.5`
**Done when:** the free tier blocks replies to new conversations at its limit while still
storing inbound messages, and paid tiers bill overage.

### Step 6.4 — Dunning
- [ ] Dunning scheduler with completed-step tracking
- [ ] Access level enforcement: full, read-only, suspended
- [ ] Dunning emails and in-app banners

**TDD:** `TDD_11 §5`
**Done when:** a failed payment progresses through the schedule without data loss, and a
skipped cron day catches up.

---

## Milestone 7 — Production readiness

### Step 7.1 — Security hardening
- [ ] Helmet on the API, CSP in Next with per-store plugin origins
- [ ] Rate limiting: application (Redis), edge (Cloudflare rules)
- [ ] Secrets as env-file secrets in Secret Manager
- [ ] Security scanning gates in CI, weekly ZAP
- [ ] Full internal pentest checklist executed (skip password, staff and billing items; magic-link token reuse and prediction do apply)

**TDD:** `TDD_05` in full
**Done when:** securityheaders.com grade A and the pentest checklist is clean.

### Step 7.2 — Compliance
- [ ] DSR flow with verification tokens: access, portability, erasure, manual review
- [ ] Consent records, cookie consent (`CookieConsent`)
- [ ] Audit log viewer and export (tenant side)

**TDD:** `TDD_05 §10`
**Done when:** an erasure request completes correctly while respecting the
tax-retention legal hold on orders, and the day-25 alert fires in a test.

### Step 7.3 — Deployment
- [ ] **MVP platform: Railway** (`MVP_TRIM_CHECKLIST.md` §7, D9). The Dockerfiles for api, worker and web already exist (Steps 0.5 and 3.1); this step adds PgBouncer and ClamAV as Docker services in the same Railway project (`admin` image and service DEFERRED). Google Cloud (Cloud Run, Cloud Build, Cloud SQL, Memorystore, Secret Manager) is the Phase 2 target
- [ ] Railway project with staging and production environments; Postgres and Redis as Railway services; the worker always running (one instance minimum); secrets as Railway variables; private networking between services
- [ ] Migrations run before each production release as a pre-deploy or one-off command; verify the exact Railway mechanism with Context7 when building this step, and fix `TDD_03 §4`'s release flow (tag plus manual approval) accordingly
- [ ] Postgres backups: volume backups and PITR enabled from day one (`railway postgres pitr`), plus periodic `pg_dump` copies stored outside Railway. Check that Railway offers the Postgres version pinned in `TDD_01 §2.4` (18.6); if not, fix that table first and say why in the commit
- [ ] Media stays on AWS S3 (versioning and replication per `TDD_03 §7.3`; only `S3_*` and `AWS_*` variables change). Railway buckets lack versioning and lifecycle rules
- [ ] Backup restore drill executed and documented (PITR restore into a new sibling service)
- [ ] Owner bootstrap runs once as a one-off Railway command after the first migration, so the first login is possible with closed signup; it never creates fixtures (`MVP_TRIM_CHECKLIST.md` §7, D4)

**TDD:** `TDD_03 §1`, `§3`, `§7` (rewritten for Railway per `MVP_TRIM_CHECKLIST.md` §3)
**Done when:** a restore drill completes within the 4-hour RTO target and a job enqueued
in production is processed by the worker within 10 seconds.

### Step 7.4 — Monitoring
- [ ] Sentry for errors, an external uptime check on `/health/ready`, and Railway's own service metrics. Google Managed Prometheus does not exist on Railway: the `/metrics` endpoint stays, but a Prometheus/Grafana stack (for example Grafana Cloud) is an **OPEN** item that gates the queue-depth, dead-letter and `TenantViolation` alerts of `TDD_04 §6`; decide before building this step
- [ ] Alerts go to one Slack channel with push notifications on the owner's phone (`MVP_TRIM_CHECKLIST.md` §7, D6); no PagerDuty; no AI alert or dashboard panels
- [ ] Status page on separate infrastructure
- [ ] Runbooks written in `docs/runbooks/` (no `ai-kill-switch.md`)

**TDD:** `TDD_04 §5`, `§6`, `TDD_11 §9.5`
**Done when:** a simulated incident (for example stopping the worker or failing `/health/ready`)
sends a Slack message that reaches the owner's phone with a runbook link.

### Step 7.5 — Load validation — DEFERRED (Phase 2)
> Out of scope for the v1.2 MVP.

- [ ] k6 inbox load test (200 users)
- [ ] k6 webhook burst test (500/s)
- [ ] All latency budgets verified

**TDD:** `TDD_13 §7`, `TDD_08 §4.5`
**Done when:** every threshold passes at 200 concurrent users.

### Step 7.6 — Internal admin console (core) — DEFERRED (Phase 2)
> Out of scope for the v1.2 MVP. Bull Board itself is built in Step 2.1 behind an email
> allowlist, so it is not part of this deferral.

- [ ] Staff OIDC login, `StaffAuthGuard`, `StaffPermissionGuard`, `apps/admin` scaffold
- [ ] Organization search/detail with effective limits and usage
- [ ] `OrganizationOverride` writes
- [ ] Impersonation (time-boxed, read-only, elevation, customer banner, customer-side end)
- [ ] Staff audit log viewer, Bull Board, DLQ replay
- [ ] Feature flags + `FeatureFlagService`, `PlatformSetting`

**TDD:** `TDD_15 §1`–`§4`, `§8`, `§9`
**Done when:** a staff member can find any org, view its plan and usage, apply a
time-boxed override with a reason that changes the org's effective limits, impersonate in
read-only mode and be blocked from writing, and every action is visible in the audit log.

---

## Milestone 8 — Optional enhancements

Only after Milestone 7. Each is independently shippable. In the v1.2 MVP only Step 8.3 (PWA)
remains in scope; 8.1, 8.2, 8.4 and 8.5 are DEFERRED (Phase 2).

### Step 8.1 — AI assist — DEFERRED (Phase 2)
> Its plan, consent, quota and credit gates depend on Milestone 6. Re-scope those gates when
> it is picked up.

- [ ] AI service layer with plan/feature/consent/quota/credit gates, Zod-validated outputs, prompt versions
- [ ] Suggested replies, summaries
- [ ] Tag/intent suggestions (auto-apply opt-in), sentiment, spam detection with window voiding
- [ ] Chispas: balances, monthly reset schedule, top-ups, pay-as-you-go
- [ ] Settings with explicit consent

**TDD:** `TDD_12 §1`–`§12`
**Done when:** all features are off by default, a Free store cannot enable them, every
failure path degrades silently, and a prompt-injection test finds no tenant text in the
system prompt.

### Step 8.2 — Autonomous chatbot (Scale) — DEFERRED (Phase 2)
- [ ] Separate consent, `ConversationHandler`, AI queue with per-conversation dedupe
- [ ] Turn processor with all guardrails, handoff with summary, take-over
- [ ] Customer-facing labels on every channel, kill switches (platform and org)
- [ ] AI operations panel

**TDD:** `TDD_12 §13`, `TDD_15 §6`
**Done when:** the bot answers only from approved snippets and order status, hands off on
turn 5, on low confidence, on credit exhaustion and on the kill switch, and every reply is
labeled to the customer.

### Step 8.3 — PWA
- [ ] Manifest and Serwist caching
- [ ] Mobile stack navigation
- [ ] Install prompt

**TDD:** `TDD_09 §16`
**Done when:** the app installs on Android and iOS home screens.

### Step 8.4 — Referral program — DEFERRED (Phase 2)
- [ ] Attribution in `proxy.ts`, click tracking, referral creation at signup with fraud scoring
- [ ] Commission calculation with holding period
- [ ] Approvals, Stripe balance credits
- [ ] Partner dashboard and idempotent payouts

**TDD:** `TDD_11 §8`
**Done when:** a referral converts, qualifies, and pays out correctly; a $0 invoice does not
qualify.

### Step 8.5 — SaaS support — DEFERRED (Phase 2)
- [ ] Dogfooding store for support (WhatsApp, email channel, our own widget)
- [ ] In-app support widget with contextual articles
- [ ] Help center

**TDD:** `TDD_11 §9`
**Done when:** the team handles real support tickets inside the product.

---

## Explicitly deferred (Phase 2 / MATURE — not in this plan)

- v1.2 MVP deferrals: Milestone 6, Steps 5.5, 7.5, 7.6, 8.1, 8.2, 8.4, 8.5 and the "MVP trim" items (see `INDEX.md` → "MVP scope")
- Versioned plan editor (`TDD_15 §5`)
- Third-party plugin marketplace UI, moderation queue, revenue-share ledger (`TDD_10 §8`, `TDD_15 §7`)
- Cross-tenant BI / data warehouse (`TDD_15 §10`, `TDD_11 §7.5`)
- Elasticsearch (`TDD_08 §5.7`), Kubernetes (`TDD_03 §2`), React Native (`TDD_09 §16.6`)
- 2FA for platform users, OpenAI adapter, prompt canary rollouts

---

## Dependency graph

```
M0 Foundation
 └─> M1 Auth and tenancy
      ├─> M2 Core messaging
      │    └─> M3 Inbox interface
      │         └─> M4 Commerce
      │              └─> M5 Operations
      │                   ├─> M6 Monetization (DEFERRED, Phase 2)
      │                   └─> M7 Production readiness
      │                        └─> M8 Enhancements (only 8.3 in MVP)
      └─> (M2 step 2.1 Queues can start in parallel with 1.4)
```

**Critical path:** 0.3 constants → 0.4 schema → 1.2 tenancy → 2.6 inbound
pipeline → 3.2 inbox. Everything else can be parallelized around it.

---

## Rules for the executor

1. **Never skip Step 0.3.** Constants are a blocking dependency.
2. **Every new tenant-scoped resource** gets added to the tenant isolation
   suite in the same PR that introduces it (`check-isolation-coverage` enforces it).
3. **Every migration ships with a rollback script** (`check-rollbacks` enforces it).
4. **Every endpoint** has `AuthGuard`, `TenantGuard` and a permission decorator unless it is
   explicitly public (`ApiRoutes.webhooks.*`, `ApiRoutes.widget.*`, invitation preview and
   accept, auth magic-link endpoints, DSR verify, health). `AccessLevelGuard` joins this list in Phase 2.
5. **`storeId` comes from `X-Store-Id` through `TenantGuard`** — never from a body or query.
6. **No user-facing string is hardcoded.** i18n keys only — including persisted notifications.
7. **`pnpm validate:all` must pass** before any commit; `pnpm validate:ci` before any PR.
8. **When the TDD is ambiguous, stop and ask.** Do not invent a design.
9. **Anything marked MATURE or Phase 2 is out of scope** unless this plan
   explicitly includes it.
10. **A step is done only when its PR is green on GitHub** with every CI job that exists at
    that point. When a step creates a CI job, it also says which check to add to the `main`
    ruleset (see "CI rollout"); add it after the job has run once.

---

## Progress tracking

Copy this checklist into the project tracker.

```
Milestone 0  Foundation              [ ] 0.1  [ ] 0.2  [ ] 0.3  [ ] 0.4  [ ] 0.5  [ ] 0.6
Milestone 1  Auth and tenancy        [ ] 1.1  [ ] 1.2  [ ] 1.3  [ ] 1.4
Milestone 2  Core messaging          [ ] 2.1  [ ] 2.2  [ ] 2.3  [ ] 2.4  [ ] 2.5  [ ] 2.6  [ ] 2.7  [ ] 2.8
Milestone 3  Inbox interface         [ ] 3.1  [ ] 3.2  [ ] 3.3  [ ] 3.4  [ ] 3.5
Milestone 4  Commerce                [ ] 4.1  [ ] 4.2  [ ] 4.3
Milestone 5  Operations              [ ] 5.1  [ ] 5.2  [ ] 5.3  [ ] 5.4  (5.5 deferred)
Milestone 6  Monetization            DEFERRED (Phase 2)
Milestone 7  Production readiness    [ ] 7.1  [ ] 7.2  [ ] 7.3  [ ] 7.4  (7.5, 7.6 deferred)
Milestone 8  Enhancements            [ ] 8.3  (8.1, 8.2, 8.4, 8.5 deferred)
```
