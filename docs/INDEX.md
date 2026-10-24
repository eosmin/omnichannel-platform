# TDD — Omnichannel Commerce Platform

> **Version:** 1.2.2
> **Status:** Ready for Implementation
> **Single source of truth for implementation.** Any change must be versioned here (v1.1, v1.2...).

## Changelog

| Version | Date | Summary |
|---|---|---|
| 1.2.2 | 2026-10-24 | **Corrections and additions found while building the constants (Step 0.3).** (1) `RealtimeEventMap` completeness guard: the one in `TDD_02 §2` always resolved to `never`; it is now a two-way compile-time check. (2) `ShipmentStatusTransitions`: `LABEL_CREATED` can reach any later in-flight status (a carrier may skip events), and `FAILED_ATTEMPT` may repeat (`TDD_17 §3`, `§4.9`). (3) `SEND_EMAIL_DIGEST_DAILY` runs every hour: the TDD said 08:10 in each user's timezone but scheduled one 08:10 UTC run (`TDD_07 §4`, `TDD_06 §6.4`). (4) `EMAIL_FROM` accepts `Name <address>` (`TDD_02 §9.1`). (5) **New:** carrier status mapping, configurable by the owner (`TDD_17 §4.17`, Steps 4.8, 4.14, 4.15); the failed-attempt customer message policy `orders.failedAttemptMessages`, the `attemptNumber` and `maxAttempts` template variables and `CarrierConnection.maxDeliveryAttempts` (`TDD_17 §4.7`, `§4.14`). (6) The constants live in four Nx projects instead of one per area, with the import aliases unchanged (`MVP_TRIM_CHECKLIST.md` §3). (7) A written channel rule chooses the default channels of every notification (`TDD_06 §6.1`). (8) The minor constants of `TDD_02 §15` are built in Step 0.3 or assigned to the step that owns them (`IMPLEMENTATION_PLAN.md`). |
| 1.2.1 | 2026-10-24 | **Local S3 storage and image tags.** MinIO stopped publishing images (Docker Hub and Quay, October 2025; the repository is archived), so local development and CI use SeaweedFS `4.48` (owner's decision, Step 0.2). Tags that did not exist were corrected: PgBouncer `v1.25.2-p0`, ClamAV `1.5.4-debian` (the plain `1.5` has no arm64 build). Production storage is unaffected (AWS S3). The files that still say MinIO for local or CI use read SeaweedFS (`MVP_TRIM_CHECKLIST.md` §3). |
| 1.2 | 2026-10-24 | **Single-owner MVP scope.** The SaaS layer (billing, plans, quotas, dunning, public signup, internal admin console, referrals, SaaS support, autonomous chatbot) is deferred to Phase 2. Multi-tenancy (Organization → Store → Membership, `storeId` isolation) is unchanged. Login is magic link only (no password, no Google); Bull Board is gated by an email allowlist. See "MVP scope" below. The MVP also includes robust inventory (warehouses, transfers, counts: `TDD_16_Inventory.md`) and the runtime for integration plugins (the marketplace stays deferred). Only `INDEX.md`, `TDD_00_Overview.md` and `IMPLEMENTATION_PLAN.md` were edited, and `MVP_TRIM_CHECKLIST.md` and `TDD_16_Inventory.md` were added; the other TDD files are unchanged and their deferred or superseded sections stay in place as the Phase 2 specification. |
| 1.1 | 2026-09-03 | Fixes from `AUDIT_TDD_v1.0.md`: Prisma schema mapped to `snake_case` and completed (identities per store, tokens, invitations, session families, idempotency, store settings, API keys, notification keys); Prisma 7 / ESLint 10 / Next 16 / Stripe Meters / Zod 4 idioms; TypeScript pinned to 5.9; inbound pipeline resolves the store from the recipient connection; tenant context via `X-Store-Id` header and `/s/:storeId` URLs; single source of plan limits (`PlanLimits` + `OrganizationOverride`); web widget and email specified as channel plugins; autonomous chatbot kept as an explicit, narrow exception; worker is a NestJS app; unified infra versions; complete dependency list. |
| 1.0 | — | Initial specification. |

---

## How to use this documentation

This TDD is split into focused documents so an executor (Claude Code or any other) can load
only the context needed for the current task instead of the entire specification.

**Start here, in this order:**

1. `TDD_00_Overview.md` — What we are building and why
2. `TDD_02_Conventions.md` — **Read before writing any code.** Constants, naming, type safety
3. `IMPLEMENTATION_PLAN.md` — Exact build order, milestone by milestone
4. `MVP_TRIM_CHECKLIST.md` — what the v1.2 MVP omits or changes in each TDD file (it wins over them)
5. Then load the specific TDD file for the module you are implementing

---

## Document index

| File | Covers | Load when working on |
|------|--------|----------------------|
| `TDD_00_Overview.md` | Vision, principles, tech stack summary, glossary | Always (context) |
| `TDD_01_Architecture.md` | Stack detail, multi-tenancy, full Prisma schema | Data model, tenancy, modules |
| `TDD_02_Conventions.md` | Constants, enums, error codes, env validation, naming | **Always** |
| `TDD_03_Deployment.md` | Deployment (Railway in the v1.2 MVP; Cloud Run → K8s later), environments, migrations, cost | Infra, CI/CD, DB migrations |
| `TDD_04_Observability.md` | Pino logs, Prometheus, Sentry, health, backup & DR | Logging, metrics, alerting |
| `TDD_05_Security.md` | Secrets, network policies, rate limiting, DDoS, TLS, audit, GDPR | Auth, guards, compliance |
| `TDD_06_Realtime.md` | WebSocket scaling, presence, in-app notifications, web push | Inbox realtime, notifications |
| `TDD_07_Queues.md` | BullMQ design, workers, DLQ, email system, file upload | Background jobs, email, media |
| `TDD_08_Performance.md` | Caching layers, query optimization, CDN, full-text search | Perf work, search feature |
| `TDD_09_UX.md` | Inbox layout, flows, shortcuts, i18n, mobile/PWA | Any frontend work |
| `TDD_10_Plugins.md` | Plugin SDK, registry, channels, marketplace, widgets | Channels, plugin system |
| `TDD_11_Business.md` | Billing, subscriptions, quotas, referrals, SaaS support | Billing, monetization |
| `TDD_12_AI.md` | AI service layer, suggested replies, tagging, sentiment | AI features |
| `TDD_13_Testing.md` | Unit, integration, e2e, contract, security, load tests | Writing any test |
| `TDD_14_DX.md` | Local setup, tooling, linting, git workflow, Nx | Repo setup, CI |
| `TDD_15_InternalAdmin.md` | Staff backoffice, org overrides, impersonation, plan editor, AI ops, cross-tenant BI | Internal admin console work |
| `IMPLEMENTATION_PLAN.md` | Step-by-step build order with dependencies | **Always** |
| `TDD_16_Inventory.md` | v1.2: warehouses, stock levels, movement ledger, reservations, transfers, physical counts | Inventory and order work (Milestone 4) |
| `TDD_17_Shipping.md` | v1.2: carrier plugins, shipments, labels (single and bulk), pickups, order confirmation and copy, price control, store preferences, customer messages with templates, guide cancellation, returns and exchanges with scanner reception and a caution flag, COD remittances | Order, shipping and carrier work (Milestone 4) |
| `MVP_TRIM_CHECKLIST.md` | v1.2: per-file list of schema, constants, behavior and tests to omit or adjust for the single-owner MVP | **Always**, with `IMPLEMENTATION_PLAN.md` |
| `AUDIT_TDD_v1.0.md` | Findings that produced v1.1 (historical record) | Only when a v1.1 change needs its rationale |

---

## MVP scope — single owner (v1.2)

The first release runs for the owner and the owner's own stores only. There are no paying
tenants, so the SaaS layer is not built yet. **Where any TDD file conflicts with this
section, this section wins.** Deferred sections of the TDD files remain the Phase 2 spec and
are out of scope (rule 9 of `IMPLEMENTATION_PLAN.md`) until Phase 2 starts. The concrete
file-by-file edits live in `MVP_TRIM_CHECKLIST.md`.

**Kept unchanged:** Organization → Store → Membership, `storeId` isolation and the isolation
test suite, `TenantGuard` + `X-Store-Id`, invitations, roles and permissions, all five channel
plugins, inbox, customers, orders, inventory, search, analytics, settings, security hardening,
deployment, monitoring.

**Added to the MVP after the first scoping (owner's decisions D10, D11 and D17):** robust inventory
(`TDD_16_Inventory.md`, Steps 4.1 to 4.7), the runtime for integration plugins (Steps 5.6 and
5.7; the marketplace stays deferred) and shipping through carrier plugins (`TDD_17_Shipping.md`,
Steps 4.8 to 4.15).

**Deferred to Phase 2:**

| Area | Where it lives in the plan |
|---|---|
| Billing: usage metering, Stripe, quotas and gating, dunning (`TDD_11` §2–§6) | Milestone 6 (all steps) |
| Subscription, plan, `PlanLimits`, `OrganizationOverride`, `AiCreditBalance`, `AccessLevelGuard`, `QuotaGuard`, `FeatureGuard`, `ChannelGuard`, billable-conversation windows | Steps 0.3, 0.4, 1.1, 1.2, 1.4, 2.6 (trimmed) |
| Public signup and signup wizard | Steps 1.1, 5.5 |
| Password login, forgot/reset password, Google login (optional in Phase 2) | Step 1.1 |
| Internal admin console, staff auth, impersonation, feature flags (`TDD_15`) | Step 7.6, `apps/admin`, staff constants |
| Load validation (k6) | Step 7.5 |
| AI assist and autonomous chatbot (`TDD_12`) | Steps 8.1, 8.2 |
| Referral program, SaaS support (`TDD_11` §8, §9) | Steps 8.4, 8.5 |

**Access model in the MVP:**

- Signup is closed. A seed creates the owner user, the Organization and the first Store from
  `SEED_OWNER_*` env variables. Everyone else joins through an `Invitation`: the link opens
  `/invitations/[token]`, where accepting creates the account (if none), the Membership and the
  session in one transaction. No user exists without a Membership except after a revocation or
  removal, which lands on a "no access" screen.
- Login is magic link only (email, single-use token). There are no passwords and no Google or
  other OAuth login. Same model as `feedback-board`, implemented here with `VerificationToken`
  instead of Supabase.
- Bull Board and DLQ tooling are gated by a JWT plus the `BULL_BOARD_ADMIN_EMAILS` allowlist
  (empty = nobody) and the `BULL_BOARD_ENABLED` switch, instead of the deferred staff auth.
- Every Organization has unlimited seats, stores, channels and conversations. There is no
  plan concept in code: no limit check exists to bypass.
- A Store's inbound conversations are never blocked or metered.

**Platform:** the MVP deploys on Railway; Google Cloud (`TDD_03`, `TDD_05 §1.1`, `TDD_04 §5`)
is the SaaS-phase target. `MVP_TRIM_CHECKLIST.md` §3 lists what changes in those files.

**Decisions:** `MVP_TRIM_CHECKLIST.md` §7 holds seventeen owner-approved decisions (D1 to D17) (magic-link
expiry, throttle values, the seed split, the production bootstrap, e2e login through Mailpit,
Slack alerts, PR approvals, no welcome email, Railway, integration plugins, robust inventory, Row-Level Security (roles in Step 0.4, policies in Step 7.1), shipping as carrier plugins,
Grafana Cloud, the release flow, the configurable low-stock alert and Postgres 18 on Railway). No design decision is open; two checks happen when their steps start
(Railway's release mechanism in Step 7.3, Grafana Cloud's limits in Step 7.4). One input is needed
from the owner before Step 4.15: the API documentation and credentials of Forza and C807 Express,
which their sales advisors provide (`TDD_17 §14`); everything before it builds with the `local` carrier
and a fake carrier.

**Reactivating Phase 2:** un-defer Milestone 6 first, then re-add the trimmed items above as
additive migrations and decorators on endpoints that already exist.

---

## Non-negotiable rules for the executor

1. **Read `TDD_02_Conventions.md` first.** No magic strings anywhere. Every event name,
   cache key, permission, error code, route and status lives in a typed constant.
2. **Every tenant-scoped table has `storeId` (or `organizationId`).** Every query filters by it.
   The active store comes from the `X-Store-Id` header via `TenantGuard` — never from the
   body or the query string. See `TDD_01_Architecture.md` §3.2.
3. **No emojis in the product UI.** Use Lucide React SVG icons.
4. **Package manager is `pnpm`.** Never `npm` or `yarn`.
5. **Logger is Pino.** Never Winston, never bare `console.log` in application code.
6. **All code, comments, identifiers and file names in English.**
7. **AI is assistive by default.** It suggests; a human approves. The only two features that act
   without per-message approval are spam detection (reversible) and the autonomous chatbot
   (Scale tier, separately consented, hard guardrails). Both are specified in `TDD_12_AI.md` §1
   and §13; nothing else may act on its own. In the v1.2 MVP no AI feature is built.
8. **Follow `IMPLEMENTATION_PLAN.md` order.** Do not jump ahead — later steps assume
   earlier ones exist.

---

## Tech stack at a glance

```
Frontend    Next.js 16.3 (App Router) + React 19.2 + Tailwind 4.3 + shadcn/ui
Backend     NestJS 12 + Prisma 7.10 (driver adapter) + PostgreSQL 18.6 + Redis 8.10 + BullMQ 6.3
Realtime    Socket.io 4.8 + Redis Adapter
Monorepo    Nx 23.2 workspace, pnpm 11.25
Deployment  Railway (v1.2 MVP) → Google Cloud Run (SaaS phase) → Kubernetes (MATURE)
Storage     AWS S3 (Phase 1) → MinIO (optional Phase 2)
Language    TypeScript 5.9 (strict)
```

Exact pins for every dependency: `TDD_01_Architecture.md` §2.4. That table is the only source of versions; every other document defers to it.

---

## Phase terminology used throughout

| Term | Meaning |
|------|---------|
| **SCAFFOLD** | Initial build, pre-launch |
| **PRODUCTION** | Live with paying customers, single region |
| **MATURE** | Scaled, multi-region considerations, marketplace open |

When a document says "Phase 2" or "MATURE", that work is explicitly **out of scope
for the first implementation pass** unless the plan says otherwise.
