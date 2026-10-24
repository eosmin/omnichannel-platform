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
| 0.1 | `ci.yml` with `lint-and-types` (Nx affected lint and type-check, and `format:check`); create the ruleset | `lint-and-types` |
| 0.4 | `integration-tests` job born with Postgres and Redis services: `prisma migrate deploy` on an empty database and `check-rollbacks` | `integration-tests` |
| 0.5 | Dockerfiles for `api` and `worker`; `security-scan` job born: build both images, Trivy (CRITICAL/HIGH fails; unfixed ignored); `nx affected --target=build` joins `lint-and-types` | `security-scan` |
| 0.6 | add gitleaks to `security-scan`; add commitlint, `validate:translations` and `validate:deprecations` to `lint-and-types` | none new |
| 1.1 | `unit-tests` job with Nx affected and coverage thresholds (only for paths that exist so far) | `unit-tests` |
| 1.3 | `integration-tests` now runs the integration suites; `security-tests` job born with the tenant isolation suite | `security-tests` (no bypass) |
| 2.5 | `integration-tests` also runs `pnpm test:contracts` | none new |
| 3.1 | Dockerfile for `web` added to `security-scan`; `e2e-tests` job born with Postgres, Redis, MinIO and Mailpit (magic-link login); `lighthouse` job (PRs only) | `e2e-tests` (`lighthouse` stays optional, as in `TDD_14 §8`) |
| 7.3 | Railway deployment config; nothing new in the ruleset | none new |

From Step 0.1 on, a step is not done until **its PR is green on GitHub** with every job that
exists at that point. Thresholds, services and secrets (for example `SNYK_TOKEN`) are added
to a job when that job is created.

### Local gates and CI performance

**What runs where.** Local gates are a convenience that catches problems in seconds; CI is the authority
and cannot be skipped (`--no-verify` is forbidden by `CLAUDE.md`, and the ruleset blocks the merge anyway).
Nothing heavy runs at commit time, so committing often stays cheap.

| Moment | What runs | Budget |
|---|---|---|
| Editor | ESLint and Prettier on save (optional, not enforced) | instant |
| `pre-commit` | `lint-staged` (ESLint `--fix` with `--max-warnings=0`, Prettier, `prisma format`) which fixes and re-stages instead of rejecting; `gitleaks` on the staged files; the translations and rollbacks validators only when such files are staged | under 10 s |
| `commit-msg` | `commitlint`, showing the exact rule that failed | under 1 s |
| `pre-push` | `pnpm validate:affected`: Nx affected `lint`, `type-check` and `test`, `format:check`, `validate:deprecations`, `validate:isolation`, translations and rollbacks; no Docker needed; skipped when only `docs/` changed | 30 to 90 s |
| Before opening a PR (manual) | `pnpm validate:ci`: the full local mirror of CI with the compose services up (integration, contracts, security tests) | minutes |
| CI | every job of `TDD_03 §4`, required by the ruleset as they are born | 5 to 15 min |
| After the merge | staging deploy from `main`, production from a version tag with manual approval (Step 7.3) | n/a |

`TDD_14 §2` calls `validate:all` the pre-push check but defines no hook for it and runs the whole
repository; this plan makes the hook real and affected-only (`validate:affected`), and keeps `validate:all`
as the full local run. `gitleaks` is a local binary (`brew install gitleaks`): the hook fails with a message that
says so, and the README lists it as a prerequisite. Husky is disabled in CI (`HUSKY=0`).

**CI performance and cost.** The repository is private, and a free GitHub plan includes a limited number of
CI minutes per month, so speed and cost are the same goal. Rules for `ci.yml` and every later workflow
(versions of the actions are resolved through Context7 when the file is written and kept current by Dependabot,
always pinned to SHAs):

- **One run per branch:** workflow-level `concurrency` (`workflow` plus `ref`) with `cancel-in-progress: true` for
  pull requests, so a new push cancels the superseded run. Never for `main` or tag runs, which must finish.
- **Least privilege and a ceiling:** `permissions: contents: read` by default, widened per job (for example
  `security-events: write` for the Trivy upload), and a `timeout-minutes` on every job.
- **Affected only:** `actions/checkout` with `fetch-depth: 0` and `filter: tree:0`, then `nrwl/nx-set-shas`, then
  `nx affected`. A docs-only change finishes in seconds.
- **Dependency cache:** `actions/setup-node` with `cache: pnpm`, and `pnpm install --frozen-lockfile --prefer-offline`.
- **Nx task cache:** `lint`, `type-check`, `test`, `build` and `prisma generate` are cacheable in `nx.json`
  (`targetDefaults` with `cache: true` and `namedInputs` where `production` excludes tests and config of tests), so a
  task whose inputs did not change is replayed, not run. `.nx/cache` persists between runs with `actions/cache`:
  **pull requests only restore** it and **pushes to `main` save it** (a cache entry is immutable, so a unique key
  per run with `restore-keys` falls back to the nearest one; saving only from `main` avoids filling the repository's
  cache quota, and pull requests can read the cache of `main`). A hosted remote cache (Nx Cloud) is a later option, not an MVP dependency.
- **Docker:** `docker/build-push-action` with the GitHub cache backend (`cache-from` and `cache-to` of `type=gha`,
  one scope per image) in `security-scan`, and the Trivy vulnerability database cached.
- **Playwright:** the browsers directory cached by Playwright version in `e2e-tests`; system dependencies installed on every run.
- **Jobs in parallel:** no `needs` chain between the test jobs, so the wall time is the slowest job, and each job
  that is not needed for a change is skipped with a **job-level `if`** (a `changes` job decides). A job skipped by
  `if` reports success to a required check; a workflow-level `paths` filter would leave the check pending and
  block the merge, so it is never used.
- **Full run as a safety net:** pull requests run affected only; pushes to `main` and a nightly `schedule` run the
  suites in full, to catch anything the project graph missed.
- **Coverage upload** runs on pull requests (for the diff) and on `main`; the heavy jobs (`e2e-tests`, `lighthouse`,
  image scans) run only when the changed projects can affect them.

---

## Milestone 0 — Foundation

No product functionality. This milestone exists so that everything after it
is fast, safe and consistent.

### Step 0.1 — Nx workspace
- [x] Create the Nx workspace with pnpm (`packageManager` in `package.json`, Node `>=22`)
- [x] `.nvmrc` with the exact Node version from `TDD_01 §2.4` (`24.20.0`) — `engines` stays the
      `>=22` range; `.nvmrc` pins what developers, CI and tooling actually run
- [x] Create apps: `api` (NestJS), `web` (Next.js), `worker` (NestJS), `widget` (Vite/vanilla TS) — `admin` is DEFERRED (Phase 2, Step 7.6)
- [x] Configure `tsconfig.base.json` with strict mode per `TDD_02 §11` (TypeScript 5.9)
- [x] Configure project tags (`scope:core-domain`, `scope:core`, …) and module boundaries per `TDD_14 §6`, `§9`
- [x] `nx.json` with `namedInputs` (`default`, `production` excluding test files and test config) and `targetDefaults` that make `lint`, `type-check`, `test`, `build` and `prisma generate` cacheable, with their inputs and outputs, as described in "Local gates and CI performance"
- [x] Root `package.json` scripts as in `TDD_14 §2` (`lint`, `lint:fix`, `type-check`, `format`, `format:check`, `test` and its variants), and a `lint`, `type-check` and `test` target in every `project.json` (the `build` target comes with the Dockerfiles in Step 0.5)
- [x] `.prettierrc` per `TDD_14 §6` and a `.prettierignore` that excludes `docs/` (the specifications are maintained by hand with wide tables), generated code, build output, `node_modules` and the lockfile, so that `format:check` covers code and configuration only
- [ ] `eslint.config.js` (flat), Prettier, `.env.example` files per `TDD_14 §6`, `§10`; include a `no-restricted-syntax` rule that forbids calling `$transaction` on the Prisma client (services use `PrismaService.transaction(fn)`, created in Step 0.4; the rule exempts `PrismaService` itself)
- [ ] `.github/workflows/ci.yml` with the `lint-and-types` job (actions pinned to SHAs, Node and pnpm from `package.json`; it runs Nx affected `lint` and `type-check` and `pnpm format:check`; workflow-level `concurrency` that cancels superseded pull-request runs, least-privilege `permissions`, `timeout-minutes`, `fetch-depth: 0` with `nrwl/nx-set-shas`, the pnpm store cache, and the `.nx/cache` restored on pull requests and saved on `main`), and the `main` ruleset described in "CI rollout"; after the first run, add `lint-and-types` as a required check
- [x] `.github/dependabot.yml` (weekly, grouped by ecosystem, as `TDD_03 §4` and `TDD_05 §7` already describe): `npm` for the pnpm workspace root and `github-actions` (it also moves the SHA pins and their version comments); the `docker` entries for the Dockerfiles and the compose file are added in Steps 0.2 and 0.5, when those files exist. Minor and patch updates are grouped, major updates come as separate PRs and are never merged without reading the changelog, because the stack's versions are pinned by the TDD and an upgrade re-fetches its documentation first (`CLAUDE.md`, deprecation discipline). `commit-message` prefixes `chore(deps)` (npm, docker) and `ci(deps)` (actions) so the commits satisfy commitlint, whose `deps` scope already exists; open-pull-requests limit 5
- [ ] Repository security settings, applied once with `gh api` and recorded in the README: enable Dependabot alerts and Dependabot security updates (free on private repositories). **Secret scanning and push protection are tried, not assumed:** for private repositories they belong to GitHub Secret Protection, a paid add-on, and on this account `security_and_analysis` reports nothing; verify when doing the step, enable them if the plan allows, and otherwise rely on gitleaks (pre-commit and `security-scan`, Step 0.6), which is the layer the plan depends on. Until Step 0.6 lands no secret exists in the repository, and nothing may be committed that looks like one

**Files:** `nx.json`, `tsconfig.base.json`, `package.json`, `.nvmrc`, `eslint.config.js`, `.prettierrc`, `.prettierignore`, `apps/*/project.json`, `.github/dependabot.yml`
**TDD:** `TDD_01 §1`, `§2.4`, `TDD_14 §2`, `§6`, `§9`, `TDD_03 §4`, `TDD_05 §7`
**Done when:** `pnpm nx graph` renders, `pnpm lint` passes on the empty workspace, an
import from `libs/core/config` inside `apps/web` fails lint, `cat .nvmrc` matches the
Node version pinned in `TDD_01 §2.4`, `pnpm format:check` passes and fails on a badly formatted file, a second CI run of an unchanged project replays its tasks from the cache, a new push cancels the previous pull-request run, `lint-and-types` is green on GitHub for a PR, GitHub reads
`dependabot.yml` without errors (Insights, Dependency graph, Dependabot) and Dependabot alerts are on.

### Step 0.2 — Local infrastructure
- [ ] `docker-compose.yml` with Postgres 18.6, PgBouncer, Redis 8.10, MinIO (+ `minio-init`), Mailpit, ClamAV. PgBouncer authenticates every role through an `auth_user` + `auth_query` lookup (not a single fixed `DB_USER`), because from Step 0.4 the api and the worker connect as different roles; verify the exact settings of the pinned image with Context7
- [ ] `scripts/bootstrap.sh`
- [ ] `.env.example` (api/worker) and `apps/web/.env.example` per `TDD_02 §9`, **MVP trim:** omit `GOOGLE_*`, `STRIPE_*`, `NEXT_PUBLIC_STRIPE_*`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `STAFF_*`. Document two `DATABASE_URL` examples (api as `platform_app`, worker as `platform_worker`) next to `DIRECT_DATABASE_URL` (owner), plus `DB_APP_PASSWORD` and `DB_WORKER_PASSWORD`, which only the role script of Step 0.4 reads (validated with its own Zod schema, never imported by the api or worker); `scripts/validate-env-example.ts` diffs `.env.example` against the api/worker schema plus that script's schema

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
- [ ] The shipping constants of `TDD_17 §3` (`PENDING_CONFIRMATION` and its transitions, `CASH_ON_DELIVERY`, the shipping, pickup, return and message enums and constants, permissions and role presets, events, realtime events, notification types, audit actions, error codes, jobs, schedules, metrics, routes, paths, query keys, `MediaPurpose` values, plugin scopes), in the same barrels
- [ ] The inventory constants of `TDD_16 §3` (permissions and role presets, enums, events, notification types, audit actions, error codes, job, schedule, metric, routes, paths, query keys, plugin scopes), so that Step 0.3 stays the single place constants are born
- [ ] **MVP trim:** omit every constant, error code, event, cache key, permission, queue, metric, audit action and realtime event that belongs to billing, plans/quotas, AI, referrals, SaaS support or staff admin. Add `SEED_OWNER_EMAIL`, `SEED_OWNER_NAME` (required only when running the seed) and `BULL_BOARD_ENABLED` (default `false`), `BULL_BOARD_ADMIN_EMAILS` (comma-separated, default empty) to the `env.ts` Zod schema (plus `SEED_ORGANIZATION_NAME` and `SEED_STORE_NAME`, `MVP_TRIM_CHECKLIST.md` §7, D3)

**TDD:** `TDD_02` in full, plus the constants sections of `TDD_05 §9.1`, `§10.1`, `TDD_06 §1.4`, `§6.1`, `TDD_07 §4`, `TDD_11 §7.1` (TDD_11 §1 billing constants are DEFERRED; trims per `MVP_TRIM_CHECKLIST.md` §1, §2; the inventory constants of `TDD_16 §3` and the shipping constants of `TDD_17 §3`)
**Done when:** every constant file compiles and is exported from its barrel, and the
`_AssertComplete` check in `realtime-events.ts` passes.
**This step is non-negotiable.** Everything downstream imports from here.

### Step 0.4 — Database schema
- [ ] `libs/core/database/prisma/schema.prisma` — the full schema with `@@map`/`@map`, generator `prisma-client`, **without the inventory models of `TDD_16 §2`**, which arrive in Step 4.2 as an additive migration, and without the new shipping tables of `TDD_17 §2` (Step 4.8); the columns that `TDD_17 §2` adds to existing models (`Order.confirmedAt`, `confirmedBy`, `confirmedVia`, `exchangeOfOrderId`, `copiedFromOrderId`, `discountReason` and the price-approval columns, status default `PENDING_CONFIRMATION`; `StoreSettings.returnShippingPayer`, `defaultCarrierConnectionId`, `bulkLabelRetentionDays`, `preferences`; `OrderItem` override and `freeShipping` columns; `Order.freeShipping`; `Product.freeShipping`; `Order.carrierConnectionId` (a plain column until Step 4.8 adds the foreign key) and `priceApprovedShippingCents`; `Customer.isCaution`, `cautionReason`, `cautionSetBy`, `cautionSetAt`; `Shipment` COD columns; `CarrierConnection.remittanceDeductsFee`, `defaultShippingFeeCents`, `minShippingFeeCents`, `maxShippingFeeCents`) are in the initial schema
- [ ] `libs/core/database/prisma.config.ts` + root re-export
- [ ] Initial migration
- [ ] Raw SQL migration: extensions, generated `tsvector` columns, GIN/trigram indexes, partial indexes, partial uniques, CHECK constraints
- [ ] **Database roles** (decision D16, `MVP_TRIM_CHECKLIST.md` §7): the raw SQL migration creates `platform_app` and `platform_worker` idempotently as `NOLOGIN` (the worker `BYPASSRLS`, neither a superuser), grants `SELECT`, `INSERT`, `UPDATE`, `DELETE` on all tables and sequences and sets `ALTER DEFAULT PRIVILEGES` so tables created by later migrations are covered, then revokes `UPDATE` and `DELETE` on `audit_logs` from `platform_app` (`TDD_05 §9.3`; the worker keeps `DELETE` for the retention export). `scripts/set-db-role-passwords.ts` gives both roles `LOGIN` and their passwords from `DB_APP_PASSWORD` and `DB_WORKER_PASSWORD`; it runs after `migrate deploy` in `bootstrap.sh`, CI and the Railway release. Passwords are never in a migration
- [ ] Connections: the api uses `DATABASE_URL` as `platform_app`, the worker as `platform_worker`, migrations, the owner bootstrap and the dev fixtures use `DIRECT_DATABASE_URL` (owner). RLS policies are NOT enabled yet: they arrive in Step 7.1, so until then both roles behave like a normal application user
- [ ] Rollback scripts in `libs/core/database/rollbacks/` + `scripts/check-rollbacks.ts`
- [ ] `PrismaService` with `@prisma/adapter-pg` and the read-replica extension. Shaped from the start so Step 7.1 only changes its internals: `client` is a getter that returns the current tenant transaction when one exists and the base client otherwise (the mechanism of `TDD_01 §3.2`, verified by the 2026-10-24 spike, so Step 7.1 only adds the interceptor and the policies), services never call `client.$transaction` directly but `PrismaService.transaction(fn)`, which joins the tenant transaction when there is one (a lint rule forbids the direct call), and the replica is reached through `PrismaService.replica()`, not `client.$replica()`. In the MVP there is no replica, so `replica()` returns the same database
- [ ] `libs/core/crypto` (AES-256-GCM helpers) and the seed
- [ ] **MVP trim:** the schema has no `Subscription`, plan, `PlanLimits`, `OrganizationOverride`, `AiCreditBalance`, usage/billable-window, dunning, referral or staff/admin tables. They return later as additive migrations
- [ ] **Owner bootstrap (closed signup):** idempotent and production-safe. Creates the system roles from `RolePresets`, the owner `User` (email from `SEED_OWNER_EMAIL`, marked verified, no password: users have none), the `Organization`, the first `Store` with `StoreSettings` and `RetentionSettings`, and the owner `Membership`. This replaces the password-based seed with test logins in `TDD_03 §5.5`: no `passwordHash`, no shared test password, no `faker`
- [ ] **Dev fixtures script** (dev and CI only, never run in production): the fixture users without passwords, a second store, products, customers and conversations from `TDD_03 §5.5`. Split, names and env variables per `MVP_TRIM_CHECKLIST.md` §7, D3
- [ ] CI: create the `integration-tests` job with Postgres and Redis service containers; it runs `prisma migrate deploy` on an empty database, the role-password script and `check-rollbacks`, and the application connects as `platform_app`. Add `integration-tests` as a required check

**TDD:** `TDD_01 §2.3`, `§3.2`, `§4`, `§5`, `TDD_03 §5`, `TDD_05 §9.3`
**Done when:** `pnpm prisma migrate deploy` succeeds against a fresh database, a connection as `platform_app` can read and write ordinary tables but is refused `UPDATE` and `DELETE` on `audit_logs`, a connection as `platform_worker` can delete from it, `prisma studio`
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
- [ ] In `security-scan`: `docker/build-push-action` with the GitHub cache backend (one scope per image) and the Trivy database cached
- [ ] A `build` target in every `project.json` (`api`, `worker`, `web`, `widget`) and `nx affected --target=build` in `lint-and-types`, because a project that type-checks can still fail to compile and the `widget` has no Dockerfile that would build it

**TDD:** `TDD_04 §1`, `§2`, `§3`, `§4`, `TDD_02 §7`
**Done when:** `GET /health/ready` returns 200 and `GET /metrics` exposes metrics, both
**without** the `/api/v1` prefix, a request to `/api/v1/unknown` returns the error contract,
both images build and pass Trivy, and `security-scan` is green on GitHub.

### Step 0.6 — Tooling
- [ ] Husky pre-commit (lint-staged + `gitleaks git --pre-commit`, failing with a clear message when `gitleaks` is not installed), commit-msg and **pre-push** hooks; the pre-push hook runs `pnpm validate:affected` (Nx affected `lint`, `type-check` and `test`, `format:check`, the validators) and is skipped when only `docs/` changed; `HUSKY=0` in CI; commitlint `ignores` commits authored by `dependabot[bot]`, whose generated titles and body lines can exceed the length rules
- [ ] `scripts/validate-translations.ts`, `validate-deprecations.ts`, `check-isolation-coverage.ts`, and the `validate:affected` script (affected-only version of `validate:all`)
- [ ] CI: add gitleaks to `security-scan`, and commitlint, `validate:translations` and `validate:deprecations` to `lint-and-types`. The remaining jobs of `TDD_03 §4` are created by the steps listed in "CI rollout" (unit tests 1.1, security tests 1.3, e2e and Lighthouse 3.1)

**TDD:** `TDD_14 §6`, `§7`, `TDD_03 §4`
**Done when:** a commit violating conventions is rejected locally and in CI, a push with a failing affected test is stopped by the pre-push hook, a docs-only push is not slowed by it, and every job that
exists so far is green on GitHub.

---

## Milestone 1 — Auth and tenancy

The security foundation. Everything after this depends on it being correct.

### Step 1.0 — Queues, workers and email
Placed first in this milestone because Step 1.1 sends magic links through the email queue.
- [ ] `libs/core/queues/queues.module.ts` — `@nestjs/bullmq`, seven queues plus DLQ (the `ai` queue is DEFERRED)
- [ ] `apps/worker` NestJS bootstrap with health routes, graceful shutdown, `LeaderLockService`
- [ ] Email worker + `ResendProvider` (+ Mailpit dev provider) + React Email template mechanism + server-side i18n
- [ ] Resend webhook with transactional idempotency

**TDD:** `TDD_07 §1`, `§4`, `§5`
**Done when:** a `SEND_EMAIL` job enqueued from a test is delivered and visible in Mailpit, and
killing the worker mid-job lets the job complete or retry without loss.

### Step 1.1 — Authentication
- [ ] `apps/api/src/modules/auth/` — service, controller, JWT strategy. **MVP trim — magic link only:** no password, no Google/OAuth strategy (both DEFERRED)
- [ ] Access token 15 min; refresh token 7 days, hashed, family-tracked, rotated with reuse detection
- [ ] Magic link login via `VerificationToken` (single-use, short expiry, hashed at rest): request link and consume link (requesting again is the resend; there is no separate resend route). Consuming is a `POST` with the token in the body, never a `GET` with the token in the URL. It issues the access/refresh pair and marks the email verified. Requesting a link for an unknown email returns the same response as for a known one (no user enumeration). Expiry and throttle values per `MVP_TRIM_CHECKLIST.md` §7, D1, D2, held in constants
- [ ] Rate limits per `TDD_05 §3.1` (Redis storage), applied to magic-link request, magic-link consume and invitation accept (`MVP_TRIM_CHECKLIST.md` §7, D2) instead of the login, signup, forgot-password and resend endpoints named there
- [ ] `ApiRoutes.auth` and `AuditActions` carry the magic-link request/consume routes and events; the password login, `forgotPassword`, reset and `PASSWORD_*` entries from `TDD_02`/`TDD_05` are not created
- [ ] `MAGIC_LINK` email template, sent through the `SEND_EMAIL` job of Step 1.0
- [ ] Bull Board at `/admin/queues`, mounted only when `BULL_BOARD_ENABLED=true`; access requires a valid JWT whose `email` claim is in `BULL_BOARD_ADMIN_EMAILS` (empty allowlist = nobody). Applied as middleware, not through `@RequirePermissions()` or `TenantGuard`, because it is cross-tenant. It lives here because it needs this step's JWT strategy. Replay of a dead-lettered job = retry the **failed job in its original queue** from Bull Board (kept by `removeOnFail`); the dead-letter queue is a triage index (see `MVP_TRIM_CHECKLIST.md` §3)
- [ ] **MVP trim — closed signup:** there is no public signup endpoint and no Organization, Subscription or `AiCreditBalance` created here. Users come from the seed (Step 0.4) or from invitation acceptance (Step 1.4, which needs the `Invitation` model). The session issuing code (access/refresh pair) is a reusable service so Step 1.4 can call it
- [ ] CI: create the `unit-tests` job (Nx affected, coverage thresholds from `TDD_13 §9` only for paths that exist so far). Add `unit-tests` as a required check

**TDD:** `TDD_01 §7`, `TDD_05 §3`, `TDD_07 §3`, `§5.3`
**Done when:** the seeded owner can request a magic link (visible in Mailpit), consume it,
and refresh; a magic link cannot be used twice or after expiry; a link requested for an
unknown email returns the same response as for a known one; and refresh token reuse revokes
the session family; `/admin/queues` returns 404 with the flag off, 401 without a token, 403 for an email outside the allowlist and 200 for one inside it; and `unit-tests` is green on GitHub.

### Step 1.2 — Tenancy
- [ ] `TenantGuard` reading `X-Store-Id` (cached context: store, organization, membership; no subscription). `AccessLevelGuard` is DEFERRED with dunning
- [ ] `@CurrentStore()`, `@CurrentUser()`, `@CurrentOrganization()` decorators
- [ ] `PermissionGuard` + `@RequirePermissions()`
- [ ] `AuditService` + `AuditInterceptor`
- [ ] System roles come from the owner bootstrap of Step 0.4; `seedTestContext` reuses the same function

**TDD:** `TDD_01 §3.2`, `TDD_02 §4`, `TDD_05 §9`
**Done when:** the tenant isolation test suite passes for a first resource, a request with
`storeId` in the body/query but no header returns `TENANT_HEADER_MISSING`, and a request to a
store the user has no membership in is rejected.

### Step 1.3 — Tenant isolation test suite
- [ ] `tests/security/tenant-isolation.spec.ts` — parameterized
- [ ] `tests/helpers/` — `createTestApp`, `api()`, truncate, `seedTestContext`, token minting (user; staff DEFERRED). The app under test connects as `platform_app`, but the helpers that set up and inspect data (truncate, `seedTestContext`, builders, assertions that count rows) use a second client on `DIRECT_DATABASE_URL` (the owner), because `platform_app` cannot `TRUNCATE` and, from Step 7.1, cannot see other stores' rows
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

The product's reason to exist. (Queues, workers and email moved to Step 1.0, because the magic-link login of Step 1.1 sends its emails through them; this milestone therefore starts at 2.2.)

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
- [ ] CI: create the `e2e-tests` job (Postgres, Redis, MinIO and Mailpit services; the Playwright browsers cached by version and the job skipped by a job-level `if` when the change cannot affect the web app; Playwright reads the magic link from Mailpit) and add it as a required check; create the `lighthouse` job for PRs (optional, not required)

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

Inventory is robust from the first release (`TDD_16_Inventory.md`): warehouses that serve
several stores, a movement ledger, reservations, transfers between warehouses and physical
counts. Orders depend on it, so it is built first.

### Step 4.1 — Products and variants
- [ ] Products + variants CRUD (store-scoped; `freeShipping` flag, `TDD_17 §4.13`; `trackInventory`; `lowStockThreshold` is optional, empty means no low-stock alert, `TDD_16 §4.4`)
- [ ] Product search with sub-200ms autocomplete

**TDD:** `TDD_01 §4`, `TDD_08 §5.4`
**Done when:** autocomplete responds under 200ms p95 with 5k products and a `%` query
returns nothing.

### Step 4.2 — Warehouses and stock
- [ ] `Warehouse`, `StoreWarehouse`, `InventoryLevel`, `OrderItemAllocation` models, the changes to `InventoryMovement` and `StoreSettings`, and the raw-SQL constraints and partial uniques of `TDD_16 §2` (with rollback)
- [ ] Check that the inventory constants born in Step 0.3 cover `TDD_16 §3`; add what is missing
- [ ] `InventoryService`: transactional, idempotent movements (row lock, `onHandAfter`/`reservedAfter`), reserve/release/issue/restock, manual adjustments with mandatory reason, low-stock alert, kardex
- [ ] Warehouses CRUD and store links with priority (organization-scoped, `ORG_MANAGE_WAREHOUSES`)
- [ ] Extend what earlier steps built: the owner bootstrap also creates a default warehouse linked to the first store (idempotent), the dev fixtures create warehouses and opening stock, `seedTestContext` creates warehouses and links, and product creation takes `StoreSettings.defaultLowStockThreshold`
- [ ] `StoreSettings.allowNegativeStock` and `allowSplitFulfillment` (both default off) and `defaultLowStockThreshold` (empty by default), honored by the rules of `TDD_16 §4.10`, `§4.1` and `§4.4`, with their Settings → Inventory controls
- [ ] `RECONCILE_INVENTORY` job and metric
- [ ] Extend `scripts/check-isolation-coverage.ts` to organization-scoped models, and the lint rule that forbids writing `inventoryLevel` or `inventoryMovement` outside `libs/core/inventory`
- [ ] Isolation cases for `Warehouse`, `StoreWarehouse`, `InventoryLevel`, `InventoryMovement`, `OrderItemAllocation` (`TDD_16 §8`)

**TDD:** `TDD_16 §1`–`§6`, `§8`, `§9`
**Done when:** two parallel reservations for the last unit leave exactly one success, a movement
retried with the same idempotency key applies once, stock never goes negative while
`allowNegativeStock` is off and orders are accepted beyond stock while it is on (a transfer
dispatch is still refused), a forged level mismatch is reported by the reconciliation job, and
the isolation suite covers the new resources.

### Step 4.3 — Orders
- [ ] Orders module with server-side totals in cents from catalog prices
- [ ] Status state machine with `OrderStatusTransitions` (orders start in `PENDING_CONFIRMATION`, `TDD_17 §4.3`), cancellation reason, proof of delivery; `CASH_ON_DELIVERY` payment method; the `CONFIRMED → SHIPPED` transition of `TDD_17 §3`
- [ ] Price control (`TDD_17 §4.13`): line prices locked unless `ORDERS_OVERRIDE_PRICE`; discounts limited by the store's `orders.discountLimitPercent` (0 by default) with a required reason; the shipping fee prefilled from the planned carrier and held to that carrier's minimum and maximum, with a free-shipping order (per `orders.freeShippingRule`, from `Product.freeShipping`) at fee 0 without approval; anything outside the limit or the range follows the approval flow (`PriceApprovalStatus`, `ORDERS_APPROVE_PRICE`, no self-approval, an order awaiting approval cannot be confirmed); audit; and the server refusing any price from the client. The carrier rules start to apply in Step 4.8, when connections exist
- [ ] Field-level edit restrictions with `OrderEditableFields`
- [ ] Inventory through `InventoryService` only: allocate by warehouse priority on creation (one warehouse, or several when `allowSplitFulfillment` is on) into `OrderItemAllocation`, and issue on `SHIPPED`, release on cancel and optional restock on return, all per allocation (`TDD_16 §4.1`)
- [ ] System messages in the thread (`ORDER_SUMMARY`); the customer messages and their email fallback are Step 4.9 (`TDD_17 §4.7`), which replaces the order emails and the unconditional enqueue of `TDD_01 §6`

**TDD:** `TDD_02 §5`, `§13`, `TDD_09 §5`, `TDD_16 §4.1`
**Done when:** totals are never trusted from the client, illegal transitions are rejected, an
order for stock that the linked warehouses cannot cover (one warehouse, or all together when split is on) is refused with `INSUFFICIENT_INVENTORY` unless the store allows negative stock, and
every order lifecycle change produces the inventory effect of `TDD_16 §4.1`.

### Step 4.4 — Order UI
- [ ] Create-order side drawer with the chat visible, variants, and per-line allocations and available stock per warehouse (the agent can change them)
- [ ] Status change flows with proof upload and the "restock" choice on returns (only for an order with no `OrderReturn`; the shipping, confirmation and returns UI is Step 4.14)
- [ ] Print documents (PDF)
- [ ] **Orders page** (`/s/[storeId]/orders`): a full-page table with search by order number or customer, filters (status, payment status, date range, customer), cursor pagination (`TDD_08 §2.4`), sorting and filters kept in the URL, and row selection that Step 4.14 turns into the bulk action bar; **order detail page** (`/s/[storeId]/orders/[orderId]`) with lines, allocations, status flows and edits

**TDD:** `TDD_09 §5`, `§12`, `TDD_16 §7`, `TDD_08 §2.4`, `TDD_17 §7`
**Done when:** an agent creates an order without leaving the conversation, and the orders page lists, filters, searches and opens orders of the store.

### Step 4.5 — Transfers between warehouses
- [ ] `StockTransfer` and `StockTransferLine` with the draft, dispatch, receive (partial), close-with-shortage and cancel flows of `TDD_16 §4.5`
- [ ] Line visibility limited to the caller's stores; store-link validation on both warehouses
- [ ] Notifications and audit actions
- [ ] Isolation cases for `StockTransfer` and its lines

**TDD:** `TDD_16 §4.5`, `§6`, `§8`
**Done when:** a transfer goes draft to dispatched to partially received to closed with a
shortage and every step leaves the right movements; cancelling an in-transit transfer returns
the stock to the source; a line for a store the caller does not belong to is not visible.

### Step 4.6 — Physical counts
- [ ] `StockCount` and `StockCountLine` with create, start (snapshot), count, submit, apply and cancel (`TDD_16 §4.6`)
- [ ] Apply writes the variance, never "counted minus current"
- [ ] Isolation cases for `StockCount` and its lines

**TDD:** `TDD_16 §4.6`, `§6`, `§8`
**Done when:** a count applied after sales happened during counting adjusts only by the
counted variance and leaves the sales intact.

### Step 4.7 — Inventory UI
- [ ] Settings → Inventory (negative-stock and split-fulfillment toggles); store screens: stock by warehouse with low-stock filter, movements and kardex, adjustment dialog
- [ ] Organization screens: warehouses with store links and priority, transfers, counts
- [ ] Mobile-first receive and count screens

**TDD:** `TDD_16 §7`, `TDD_09 §11`, `§16`
**Done when:** the owner can run a full cycle from the UI on a phone: adjust stock, dispatch and
receive a transfer, run and apply a count.

### Step 4.8 — Carrier SDK, shipment engine and the `local` carrier
- [ ] `CarrierPlugin` in `libs/plugins/sdk` (capabilities, the three creation modes, params and results, typed errors), held by a `CarrierRegistry` beside the channel `PluginRegistry` of Step 2.5 with the same fail-fast capability check; the lint rule (`TDD_14 §6`) forbidding writes to `shipment.status`, `shipment.codStatus`, `pickupRequest.status`, `orderReturn.status`, `codRemittance.status` and `order.priceApprovalStatus` outside their services; `tests/contracts/carrier-plugin.contract.ts` and a **fake carrier** with switches for reject, timeout before and after the carrier acted, idempotent create, no cancel, no webhook and pickup-bound mode
- [ ] The `TDD_17 §2` models and raw SQL as an additive migration (`CarrierConnection`, `CarrierService`, `GuideSequence`, `Shipment`, `ShipmentEvent`, `PickupRequest`, `BulkLabelJob`, `OrderMessageTemplate`, `OrderReturn`, `OrderReturnLine`); the reception tables arrive with Step 4.12 and the remittance tables with Step 4.13, each as an additive migration; every new table joins the isolation suite and `check-isolation-coverage` in the step that creates it
- [ ] `libs/core/shipping` `ShippingService`: `createShipments` for the three creation modes (standalone: one call per guide; internal: the core makes the guide, for `local`; pickup-bound, where guides exist only inside a pickup: one call per batch that carries the pickup and returns every guide, with partial success and an unknown outcome sending the whole batch to review) and its single-guide form (validate, write first with a deterministic idempotency key, call, store the label as `Media` `SHIPPING_LABEL`, advisory lock per order, unknown outcome to `REQUIRES_REVIEW`), the forward-only shipment state machine and `ShipmentEvent` history, manual events, "check with the carrier"
- [ ] The foreign key `Order.carrierConnectionId` and the enforcement of the carrier fee rules of `TDD_17 §4.13` (fee range, a fee needs a carrier, the check at guide time)
- [ ] Connections: connect, test, edit and disconnect with encrypted credentials and webhook secret, the default shipping fee and its minimum and maximum per connection (also for `local`), `CarrierService` rows seeded from the plugin catalog, `GET /carriers/registry`, Settings → Carriers API (`SETTINGS_MANAGE_CARRIERS`)
- [ ] `libs/carriers/local`: guide numbering (`GuideSequence`) and the label template (barcode, recipient, COD amount or "PAID"), rendered at the connection's label format
- [ ] Status flow: public `POST /webhooks/carriers/:connectionId` (raw body, signature, queue, `200` fast), `PROCESS_CARRIER_EVENT` with dedupe and out-of-order handling, `POLL_SHIPMENT_STATUS`, and the listener that applies the order effects of `TDD_17 §4.9` (`SHIPPED` with the inventory `ISSUE`, `DELIVERED`, COD payment completion, notifications)

**TDD:** `TDD_17 §1`, `§2`, `§3`, `§4.1`, `§4.2`, `§4.4`, `§4.5`, `§4.9`, `§4.12`, `§4.13`, `TDD_10 §3`, `§9`, `TDD_16 §4.1`
**Done when:** with the fake carrier, an order creates exactly one shipment even under two parallel requests,
an unknown outcome never creates a second guide, a duplicate or out-of-order webhook changes nothing,
every shipment status produces the order effect of `TDD_17 §4.9`, and a `local` shipment gets a unique
guide and a printable label; the contract suite runs in `integration-tests`.

### Step 4.9 — Order confirmation and customer messages
- [ ] `PENDING_CONFIRMATION` in the order state machine, with `confirmedAt`, `confirmedBy`, `confirmedVia`; "mark as confirmed" (single and bulk, `ORDERS_CONFIRM`); `ShippingService` refuses guides for unconfirmed orders
- [ ] `OrderMessagesService`: the generic `ORDER_MESSAGE` email template for the fallback (replacing the four order emails), the "Notify customer" checkbox of manual status changes initialised from the matching template's `autoSend`, and templates per kind and locale with the variable allowlist, rendering by substitution, preview, `autoSend` (not for the order summary, which follows the store preference) and `attachSummary`, the order summary document, sending through the conversation's channel as an outbound `Message`
- [ ] The messaging-window decision of `TDD_17 §4.7`: free text inside the window, the linked channel-approved template outside it (variables mapped in order), and free text always for a channel that declares no window, email fallback or the `ORDER_MESSAGE_NOT_SENT` notification otherwise; idempotent automatic sends per `(shipmentId, status, kind)`
- [ ] Settings → Order messages API (`SETTINGS_MANAGE_ORDER_TEMPLATES`) with the link to an approved channel template; whether a message goes as free text or as a template comes only from the channel plugin's declared `messagingWindow` and `TEMPLATES` capability, never from its name
- [ ] Store preferences (`TDD_17 §4.14`): `storePreferencesSchema` as the only place of factory defaults, `StoreSettings.preferences`, `GET` and `PUT /settings/preferences` (`SETTINGS_MANAGE_PREFERENCES`), the ESLint rule that forbids a hardcoded initial state on checkboxes and switches in `apps/web`; the summary is sent on creation according to `orders.sendSummaryOnCreate` (default on) and `autoSend` is refused for `ORDER_SUMMARY`
- [ ] Confirm at creation (`confirmOnCreate`, initial value from `orders.confirmOnCreate`, default false, `ORDERS_CONFIRM`) and `GET /orders/:id/copy` (a prefilled draft with warnings, current prices, `copiedFromOrderId`)

**TDD:** `TDD_17 §4.3`, `§4.7`, `TDD_10 §2`, `§4`, `§5.1`, `TDD_09 §5`
**Done when:** a new order stays `PENDING_CONFIRMATION` unless created with the confirm checkbox, a guide for an unconfirmed order is refused, a copied order
starts from a draft with current prices, a channel plugin that declares no window gets free text at any time, the
summary goes as free text inside the window and as the approved template outside it, a missing template
produces the fallback or the notification and never a silent drop, and a repeated carrier event sends
nothing twice.

### Step 4.10 — Labels, bulk generation and cancellation
- [ ] Single and bulk guide creation: `POST /shipments/bulk` with `BulkLabelJob`, per-connection concurrency cap for standalone carriers and one call per batch (with the pickup date and window) for pickup-bound ones, skipped orders reported with the reason, `BULK_LABELS_PROGRESS` and `BULK_LABELS_DONE`, merge of the stored PDFs with `pdf-lib` in selection order into one `BULK_LABELS` file, `CLEAN_BULK_LABELS`
- [ ] "Print labels" for orders that already have a shipment: merge the stored files with no carrier call; voided labels are never merged
- [ ] Cancellation: the table of `TDD_17 §4.8` (no guide, `LABEL_CREATED`, after pickup refused, unknown outcome refused), `CANCEL_SHIPMENT` with retries, `refundStatus`, "mark as voided", release of stock, leaving the pickup, cancel-and-recreate when the address, items or payment method change after a guide exists (the new guide waits until the old one is `CANCELLED`)

**TDD:** `TDD_17 §4.6`, `§4.8`, `TDD_09 §11`, `TDD_16 §4.1`
**Done when:** with the fake carrier, a bulk run over a mixed selection produces one PDF with the successes in the
selected order and a per-order report for the rest, reprinting calls the carrier zero times, and cancelling
an order with a guide voids it (or leaves `CANCEL_PENDING` with a notification when the carrier cannot),
releases the stock once and is refused after pickup.

### Step 4.11 — Pickups
- [ ] Per-connection pickup rules (days, cutoff, auto-request time, reminder) and `ShippingService.ensurePickup` with the advisory lock and the one-open-pickup-per-day rule for standalone carriers (a service rule, not a database index, because a pickup-bound carrier may need several per day)
- [ ] Joining and modifying a pickup's package count where the carrier has `PICKUP_MODIFY`, waiting for the next day where it does not, `MANUAL_REQUIRED` with the printable manifest where there is no pickup API
- [ ] `EVALUATE_PICKUPS` every minute (one job for all connections), the cutoff reminder, retries and `FAILED`; for pickup-bound carriers `autoPickup` generates guides and pickup together (off by default)

**TDD:** `TDD_17 §4.10`, `TDD_07 §4`
**Done when:** the scheduler creates one pickup per due connection, a later shipment joins it or waits as the
capability dictates, the reminder fires once, a manual request racing the scheduler ends with one pickup,
and a cancelled shipment lowers the count.

### Step 4.12 — Returns, exchanges and reception
- [ ] `ReturnsService` with the state machine of `TDD_17 §3`, quantity limits per order item, the return leg (return guide when the carrier has `RETURN_SHIPMENT`, manual otherwise), `StoreSettings.returnShippingPayer`
- [ ] Exchange: the replacement order (`exchangeOfOrderId`, already `CONFIRMED`, the returned items' value applied as a system credit so the total is the price difference) through `OrdersService`
- [ ] Return reception by scanner (`ReturnReceptionService`, `TDD_17 §4.16`): a persistent batch, lookup by guide number, per-item reason, condition, warehouse, note and caution toggle, `ReturnsService.receiveFromScan` per item in its own transaction, retry of failed items
- [ ] Customer caution flag (`Customer.isCaution`, `CUSTOMERS_FLAG_CAUTION`): set and clear, shown in the create-order drawer, the customer panel, the conversation header and the orders list; merge and erasure behaviour
- [ ] Inventory on receipt through `InventoryService`: `RETURN_IN` for resellable items, `RETURN_IN` then `ADJUSTMENT_OUT` (`DAMAGED`) for defective ones; the order becomes `RETURNED` only when received returns cover every unit; refund recorded by hand

**TDD:** `TDD_17 §4.11`, `§4.16`, `TDD_16 §4.1`
**Done when:** scanning a batch of guides receives each package with its own reason, condition and note, a failing item does not roll back the others, a flagged customer is shown at the next order, an exchange creates the replacement with the right stock and total, a defective item leaves net stock
unchanged and a resellable one adds it back, a partial return keeps the order `DELIVERED`, and a return
above the delivered quantity is refused.

### Step 4.13 — COD remittances
- [ ] `Shipment.codStatus` lifecycle (`NOT_DELIVERED`, `PENDING_REMITTANCE` on delivery with `codExpectedCents`, `VOID` on cancel or return) and `CarrierConnection.remittanceDeductsFee`
- [ ] `RemittancesService`: draft from an import or by hand, matching with the outcomes of `TDD_17 §4.15`, confirm in one transaction under a lock per connection, void, the pending list with age and total owed
- [ ] Deterministic import: CSV, TSV and pasted tables, `RemittanceImportProfile` with the column mapper, strict parsing with row errors, the file kept as `REMITTANCE_FILE` media (no AI, no formula evaluation)
- [ ] `CHECK_REMITTANCES` daily job and `REMITTANCE_OVERDUE`, threshold from the store preferences

**TDD:** `TDD_17 §4.15`, `TDD_07 §6`
**Done when:** a delivered COD shipment becomes pending with the right expected amount (with and without the carrier fee
deducted, and with the recipient paying), an import with a saved profile produces a draft whose lines carry every outcome, a
confirm marks matches as remitted and differences as discrepancies, two overlapping confirms end with one, a void restores the
statuses, and an invalid cell is reported instead of read as zero.

### Step 4.14 — Shipping UI
- [ ] Orders page (built in Step 4.4): multi-select action bar (confirm, send summary, generate labels, print labels, request pickup), carrier, guide and shipment columns and filters, skipped-order reporting
- [ ] Create-order drawer: the "Mark as confirmed" and "Send the order summary" checkboxes initialised from the store preferences, the price editing and discount-limit UI with approval state, the caution banner, and "Copy order" from the order detail and the customer's orders
- [ ] Order detail: confirmation step, Shipping, Messages and Returns panels, the create-guide dialog (default connection, service and payer preselected, `SENDER` for a free-shipping order, COD amount read-only with its reason, location selectors when the carrier needs them, the pickup date and window for a pickup-bound carrier)
- [ ] Settings → Carriers, Order messages, Returns and **Preferences**; separate desktop-first screens for Shipments, Pickups, Returns (with the reception scan screen) and Remittances (with the import mapper)
- [ ] Controls shown only when the permission and the connection's capability exist

**TDD:** `TDD_17 §7`, `TDD_09 §5`, `§11`
**Done when:** the owner can confirm an order, generate and print the labels of many orders at once, request a
pickup, cancel a guide, process an exchange, receive a scanned batch of returns and import a remittance from the UI, against the fake carrier and with a `local`
courier; the Playwright journey of `TDD_17 §9` passes.

### Step 4.15 — Forza and C807 adapters
**Starts when the owner has the API documentation and credentials of each carrier** (`TDD_17 §14` lists what to
ask for); it is the only step of the plan that depends on an external input, so everything before it builds and
ships with the `local` carrier and the fake carrier.
- [ ] `libs/carriers/forza` and `libs/carriers/c807`: authentication and signing, guide creation with the service codes and COD and payer fields, the label, status mapping to `ShipmentStatus`, and exactly the capabilities the documentation confirms (cancel, pickup and its modification, return guide, webhook, polling, location lookup)
- [ ] Recorded provider fixtures for the contract suite; the carrier's webhook registration documented in Settings → Carriers
- [ ] A capability that cannot be confirmed is left out and the manual path covers it

**TDD:** `TDD_17 §4.1`, `§14`, `TDD_10 §9`
**Done when:** each adapter passes the carrier contract suite against its fixtures, and a real guide, its status
changes and (where the documentation allows) its cancellation and pickup work against the carrier's
sandbox.

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

### Step 5.6 — Integration plugins (runtime)

In the v1.2 MVP the platform runs third-party and private integration plugins (for example
the owner's own POS or inventory app, or a Shopify connector later). The marketplace, its
review queue and revenue sharing stay deferred (`TDD_10 §8`). Builds on Step 5.4 (webhook
delivery, SSRF protection, key hashing) and Step 1.0 (queues).
- [ ] **Private registration** instead of a marketplace: the owner registers a plugin by pasting its manifest in Settings → Plugins; it is validated by `pluginManifestSchema` and stored as a `Plugin` row (`status = approved`, `isOfficial = false`, `pricingModel = free`; `paid` and `plan_gated` are rejected) (`MVP_TRIM_CHECKLIST.md` §7, D10)
- [ ] Manifest, scopes and scope-to-permission mapping (`PluginScopes`, `PluginScopePermissions`, including the inventory scopes of `TDD_16 §3`)
- [ ] Install flow: consent screen, webhook-endpoint challenge with `assertPublicHttpsUrl`, `PluginInstallation` in `PENDING_SETUP`, scoped API key stored as prefix and sha256 hash only, one-time setup code (5 minutes, Redis) exchanged for the key, then `ACTIVE`
- [ ] `PluginApiKeyGuard` on `/api/v1/plugin-api/*`: scope check, per-installation rate limit, bound to exactly one store; thin controllers over the same services for conversations, messages, customers, orders, products and inventory
- [ ] Outbound plugin webhooks (`TRIGGER_PLUGIN_WEBHOOK`): signed, payload redacted to the granted scopes, same delivery log and auto-disable as tenant webhooks
- [ ] Revocation with typed confirmation, final `plugin.revoked` webhook, audit
- [ ] The shipment routes of `TDD_17 §4.1` under `PluginApiKeyGuard` (`shipments:read`, `shipments:write`), over the same `ShippingService` as the UI
- [ ] Settings → Plugins UI: register, list installations with their scopes, revoke (`SETTINGS_MANAGE_PLUGINS`)
- [ ] Tests: a plugin key for store A cannot read store B, scope escalation is denied, the key never appears in logs or in any response after setup, webhook signature; `PluginInstallation` in the isolation suite
- [ ] Registration by pasted JSON only (importing a manifest by URL is a later improvement, `MVP_TRIM_CHECKLIST.md` §6). Installed scopes are fixed at install: when a registered plugin's manifest later asks for more scopes, the existing installation keeps its old scopes until the owner approves the new ones in a new consent screen

**TDD:** `TDD_10 §6`, `§9`, `TDD_05 §9`
**Done when:** a sample plugin (a test fixture app) is registered and installed, calls the API
inside its scopes and gets 403 outside them, receives a redacted signed webhook, and after
revocation its key stops working immediately.

### Step 5.7 — Plugin widgets
- [ ] Sandboxed iframe widgets in the agent sidebar with the `MessageChannel` bridge, the per-store `frame-src` added by `proxy.ts`, and the short-lived widget session token sent only over the port
- [ ] Widget settings in Settings → Plugins

**TDD:** `TDD_10 §7`, `TDD_05 §6`
**Done when:** a sample widget renders in the sidebar, never receives the API key, and every
call it makes through the port is scope-checked server-side. This step is independent of 5.6's
API and can be moved after the MVP launch if the schedule requires it.

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
- [ ] **Row-Level Security** (`TDD_01 §3.2` layer 3; owner decision D16, `MVP_TRIM_CHECKLIST.md` §7):
  - The roles `platform_app` (subject to RLS, used by `apps/api`) and `platform_worker` (`BYPASSRLS`, used by `apps/worker`, which also processes every inbound channel event) already exist since Step 0.4, and the services already connect with them; this step only turns the policies on
  - `scripts/rls.sql`, generated from the schema, with `ENABLE` + `FORCE ROW LEVEL SECURITY` and one policy per table: tables with `store_id` use `app.store_ids`; the organization-scoped inventory tables (`warehouses`, `stock_transfers`, `stock_counts`) use `app.organization_ids`; `store_warehouses` uses its `store_id`; child tables (messages, order items, transfer and count lines, allocations, movements) follow their parent. The `audit_logs` grants already exist since Step 0.4
  - Identity and bootstrap tables are NOT under RLS, because the guards read them before any tenant context exists: `users`, `sessions`, `verification_tokens`, `invitations`, `organizations`, `stores`, `memberships` and `roles`. They stay protected by code (user id or token) and by the isolation suite
  - **The mechanism is already chosen and was verified by a spike** (2026-10-24, `TDD_01 §3.2`): one interactive transaction per unit of work with `set_config(..., true)` as its first statement, kept in an `AsyncLocalStorage`, with `PrismaService.client` returning that transaction and `PrismaService.transaction(fn)` joining it. The per-operation extension was rejected because it breaks atomicity. This step implements it and re-runs the same checks as tests: atomic rollback, no cross-tenant leak under concurrency through PgBouncer, raw SQL (`SearchService`), parallel queries on one transaction, and row locks (`TDD_16 §4.2`)
  - **Tenant interceptor:** after `TenantGuard`, a `TenantContextInterceptor` runs the whole handler inside `PrismaService.tenantTransaction(ctx, fn)`, which sets `app.store_ids` and `app.organization_ids` with `set_config(..., true)` (never the session-level form; a lint rule forbids `false`) and applies explicit `maxWait` and `timeout` limits. The `await` of every query stays inside the scope, and **no external I/O runs inside it** (carrier, channel, S3 and e-mail calls are queued and run in the worker). `TenantGuard` fills the context from the caller's memberships; plugin API requests set only the installation's store; widget requests set only the store of the site key's connection; requests with no context see no rows. Streaming endpoints and the WebSocket gateway use an explicit `TenantContext` instead of the interceptor
  - **API code that runs outside a tenant request fails loudly instead of returning empty results:** the WebSocket gateway, domain-event listeners fed by the events bridge (notifications, plugin webhooks), and the public endpoints must either run inside an explicit `TenantContext.run({ storeIds, organizationIds }, fn)` taken from the event payload or the verified credential, or hand the work to the worker. In the `api` process a query on a store-scoped table with no context throws in dev, test and CI
  - **Pre-context lookups** (widget site key to store, plugin API key hash to installation, tenant API key hash to store, an inbound mailbox to its connection, a carrier webhook's connection id to its store) use small `SECURITY DEFINER` SQL functions that `platform_app` may call and that return only the store id; the Resend inbound-email mapping resolves in the worker. A globally unique value that belongs to another store (a `ChannelConnection` `(pluginId, connectionId)`) is detected from the unique violation, never by reading the other store's row
  - Add the policies for the Step 4.2 to 4.12 tables here; the isolation suite and the integration, security and e2e CI jobs run as `platform_app` from this step on, and a test proves that a query without `storeId` still returns nothing from another store
- [ ] Secrets as Railway variables (no Secret Manager in the MVP), rotated with the procedure of `TDD_05 §1.1` adapted to Railway
- [ ] Weekly ZAP baseline against staging (the other scanning gates exist since Steps 0.5 and 0.6)
- [ ] Full internal pentest checklist executed (skip password, staff and billing items; magic-link token reuse and prediction do apply)

**TDD:** `TDD_05` in full, `TDD_01 §3.2` (the verified mechanism), `TDD_16 §8`, `TDD_17 §4.12`
**Done when:** securityheaders.com grade A, the pentest checklist is clean, and the whole isolation suite passes as `platform_app` with RLS forced, including a deliberately unfiltered query that returns zero rows from another store.

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
- [ ] Release flow (`MVP_TRIM_CHECKLIST.md` §7, D13): merges to `main` deploy to staging automatically; production deploys only from a version tag with manual approval, as `TDD_03 §4` says. Migrations run before each deploy. Verify with Context7 how Railway deploys from a tag, how to require approval and how to run migrations before a deploy, and write that into `TDD_03 §4`
- [ ] Postgres on Railway's official image, pinned by **major** tag (`:18`; Railway supports 14 to 18 and does not support minor tags such as 18.6; PITR also requires the official image), so production runs Postgres 18 at whatever minor Railway publishes while local development keeps `postgres:18.6-alpine`; record this in `TDD_01 §2.4`. Backups: volume backups and PITR enabled from day one (`railway postgres pitr`), plus periodic `pg_dump` copies stored outside Railway
- [ ] Media stays on AWS S3 (versioning and replication per `TDD_03 §7.3`; only `S3_*` and `AWS_*` variables change). Railway buckets lack versioning and lifecycle rules
- [ ] Backup restore drill executed and documented (PITR restore into a new sibling service)
- [ ] Role passwords: `DB_APP_PASSWORD` and `DB_WORKER_PASSWORD` are Railway variables, the api and worker services each get their own `DATABASE_URL` (as `platform_app` and `platform_worker`, through PgBouncer), and `scripts/set-db-role-passwords.ts` runs after every migration in the release flow
- [ ] Owner bootstrap (owner, organization, first store and its default warehouse) runs once as a one-off Railway command after the first migration, so the first login is possible with closed signup; it never creates fixtures (`MVP_TRIM_CHECKLIST.md` §7, D4)

**TDD:** `TDD_03 §1`, `§3`, `§7` (rewritten for Railway per `MVP_TRIM_CHECKLIST.md` §3)
**Done when:** a restore drill completes within the 4-hour RTO target and a job enqueued
in production is processed by the worker within 10 seconds.

### Step 7.4 — Monitoring
- [ ] Sentry for errors, an external uptime check on `/health/ready` and Railway's own service metrics, plus **Grafana Cloud** (free plan, `MVP_TRIM_CHECKLIST.md` §7, D12): a Grafana agent runs as a Docker service in the Railway project, scrapes `/metrics`, and the alert rules of `TDD_04 §6` (queue depth, dead letter, `TenantViolation`, error rate, latency) load there. Verify the free plan's limits with its documentation when building this step
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
> Out of scope for the v1.2 MVP. Bull Board itself is built in Step 1.1 behind an email
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
      └─> (inside M1, Step 1.0 Queues and email runs first: the magic link of 1.1 needs it)
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
7. **The pre-push hook (`pnpm validate:affected`) must pass** before any push, `pnpm validate:ci` before any PR, and `pnpm validate:all` is the full local run; the hooks never replace CI.
8. **When the TDD is ambiguous, stop and ask.** Do not invent a design.
9. **Anything marked MATURE or Phase 2 is out of scope** unless this plan
   explicitly includes it.
10. **A step is done only when its PR is green on GitHub** with every CI job that exists at
    that point. When a step creates a CI job, it also says which check to add to the `main`
    ruleset (see "CI rollout"); add it after the job has run once.

---

## Progress tracking

One row per step. The checkboxes inside each step track its tasks; this table tracks the step itself, with the
pull request that delivered it. **The step's own PR updates its row**, so the progress lives in the repository and
moves with the code.

| Status | Meaning |
|---|---|
| `todo` | not started |
| `in progress` | a branch for the step exists and is not merged |
| `done` | merged to `main` with every task checked and the "Done when" criterion verified |
| `deferred (Phase 2)` | out of the v1.2 MVP, kept for later |

How to keep it:
1. When the work on a step starts, the first commit of its branch sets the row to `in progress`.
2. When the step is complete, the last commit of its PR sets `done`, checks the step's task boxes, and fills in the PR
   number and the date (open the PR first to know its number, then add it as the last commit).
3. One step, one branch, one independent PR from an up-to-date `main`; never stack PRs.
4. Step 2.1 does not exist: it moved to Step 1.0. Step 8.3 is optional and is not needed to complete the MVP.

The MVP is complete when every row that is not `deferred` and not optional is `done`: **48 steps**.

| Step | Name | Status | PR | Date |
|---|---|---|---|---|
| **Milestone 0: Foundation** | | | | |
| 0.1 | Nx workspace | in progress | #7 | 2026-10-24 |
| 0.2 | Local infrastructure | todo | | |
| 0.3 | Constants library (blocking dependency for everything) | todo | | |
| 0.4 | Database schema | todo | | |
| 0.5 | Observability | todo | | |
| 0.6 | Tooling | todo | | |
| **Milestone 1: Auth and tenancy** | | | | |
| 1.0 | Queues, workers and email | todo | | |
| 1.1 | Authentication | todo | | |
| 1.2 | Tenancy | todo | | |
| 1.3 | Tenant isolation test suite | todo | | |
| 1.4 | Organizations, stores, memberships | todo | | |
| **Milestone 2: Core messaging** | | | | |
| 2.2 | Customers | todo | | |
| 2.3 | Conversations and messages | todo | | |
| 2.4 | Realtime | todo | | |
| 2.5 | Plugin SDK and registry | todo | | |
| 2.6 | Inbound pipeline | todo | | |
| 2.7 | WhatsApp plugin | todo | | |
| 2.8 | Instagram, Messenger, web widget, email | todo | | |
| **Milestone 3: Inbox interface** | | | | |
| 3.1 | Frontend foundation | todo | | |
| 3.2 | Inbox | todo | | |
| 3.3 | Customer panel | todo | | |
| 3.4 | Media | todo | | |
| 3.5 | Notifications | todo | | |
| **Milestone 4: Commerce** | | | | |
| 4.1 | Products and variants | todo | | |
| 4.2 | Warehouses and stock | todo | | |
| 4.3 | Orders | todo | | |
| 4.4 | Order UI | todo | | |
| 4.5 | Transfers between warehouses | todo | | |
| 4.6 | Physical counts | todo | | |
| 4.7 | Inventory UI | todo | | |
| 4.8 | Carrier SDK, shipment engine and the `local` carrier | todo | | |
| 4.9 | Order confirmation and customer messages | todo | | |
| 4.10 | Labels, bulk generation and cancellation | todo | | |
| 4.11 | Pickups | todo | | |
| 4.12 | Returns, exchanges and reception | todo | | |
| 4.13 | COD remittances | todo | | |
| 4.14 | Shipping UI | todo | | |
| 4.15 | Forza and C807 adapters | todo | | |
| **Milestone 5: Operations** | | | | |
| 5.1 | Search | todo | | |
| 5.2 | Analytics | todo | | |
| 5.3 | Caching and performance | todo | | |
| 5.4 | Settings | todo | | |
| 5.5 | Onboarding | deferred (Phase 2) | | |
| 5.6 | Integration plugins (runtime) | todo | | |
| 5.7 | Plugin widgets | todo | | |
| **Milestone 6: Monetization** (deferred) | | | | |
| 6.1 | Usage metering | deferred (Phase 2) | | |
| 6.2 | Stripe | deferred (Phase 2) | | |
| 6.3 | Quotas and gating | deferred (Phase 2) | | |
| 6.4 | Dunning | deferred (Phase 2) | | |
| **Milestone 7: Production readiness** | | | | |
| 7.1 | Security hardening | todo | | |
| 7.2 | Compliance | todo | | |
| 7.3 | Deployment | todo | | |
| 7.4 | Monitoring | todo | | |
| 7.5 | Load validation | deferred (Phase 2) | | |
| 7.6 | Internal admin console (core) | deferred (Phase 2) | | |
| **Milestone 8: Optional enhancements** | | | | |
| 8.1 | AI assist | deferred (Phase 2) | | |
| 8.2 | Autonomous chatbot (Scale) | deferred (Phase 2) | | |
| 8.3 | PWA | todo (optional) | | |
| 8.4 | Referral program | deferred (Phase 2) | | |
| 8.5 | SaaS support | deferred (Phase 2) | | |
