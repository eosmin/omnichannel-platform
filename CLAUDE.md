# CLAUDE.md

> This file is auto-loaded by Claude Code at the start of every session in this repo.
> It is the entry point. Do not skip the steps below.

---

## What this project is

Omnichannel Commerce Platform — a multi-tenant SaaS that unifies WhatsApp,
Instagram, Messenger, a web widget and email into one inbox, with order
management, customer management and a plugin system. Full specification
lives in `docs/` (TDD v1.2). The v1.2 MVP serves a single owner and their own
stores: billing, plans, public signup, the staff console, referrals and AI are
deferred to Phase 2 (see `docs/INDEX.md` → "MVP scope").

---

## Mandatory reading order (do this before writing any code)

1. `docs/INDEX.md` — index and non-negotiable rules
2. `docs/TDD_00_Overview.md` — vision, principles, scope boundaries
3. `docs/TDD_02_Conventions.md` — constants, naming, type safety. **This is not optional.**
4. `docs/IMPLEMENTATION_PLAN.md` — full build order with dependencies
5. `docs/MVP_TRIM_CHECKLIST.md` — what the v1.2 MVP omits or changes in each TDD file.
   Where a TDD file and this checklist disagree, the checklist wins.

After reading these five, do not re-read the entire `docs/` folder on every
turn. Load only the specific `TDD_XX` file(s) referenced in the current
`IMPLEMENTATION_PLAN.md` step's **TDD:** line.

---

## How to work

1. Find the first step whose status is not `done` in the "Progress tracking" table of
   `IMPLEMENTATION_PLAN.md`. Work on milestones and steps strictly in order — later steps
   assume earlier ones exist.
2. Before implementing a step, open the TDD file(s) referenced in its
   **TDD:** line and re-read that specific section.
3. Implement the step's file list.
4. Verify the step's **Done when** criterion actually passes (run the
   command, run the test, check the behavior). Do not mark a step done on
   assumption.
5. In `IMPLEMENTATION_PLAN.md`, check the step's task boxes and update its row in the
   "Progress tracking" table (status, PR number, date), as the last commit of the step's PR.
6. Propose a commit using the conventional commit format from
   `TDD_14_DX.md §7` (e.g. `feat(auth): add JWT refresh rotation`).
7. Move to the next step.

If a step's "Done when" fails, fix it before moving on. Do not accumulate
broken steps.

---

## Git workflow (branch-first, never direct to main)

- **Never commit or open a PR proactively.** Only when the user explicitly
  asks, in that specific moment. Approving one commit/PR does not authorize
  the next one.
- **Never work directly against `main`.** Before any commit, create a
  feature branch first (naming per portfolio `CLAUDE.md`: `feat/`, `fix/`,
  etc.).
- Push only that branch, then open a PR against `main`. No direct pushes to
  `main`, ever.
- **No documentation-only PRs.** A PR must carry a real change (code,
  configuration, CI). The step's progress row, its task boxes and any doc
  fix go inside the step's own PR (`IMPLEMENTATION_PLAN.md` → "Progress
  tracking"). A doc slip found after the merge waits for the next PR that
  carries a real change; a red `main` is fixed by its own fix PR.

---

## Absolute rules (violating these requires stopping and asking first)

1. **No magic strings, anywhere.** Every event name, cache key, permission,
   error code, route, status and notification type comes from a constant in
   `libs/core/*` as defined in `TDD_02_Conventions.md`. If you need a new
   constant, add it to the appropriate file in `libs/core/*` — do not inline it.
2. **Every tenant-scoped table query is filtered by `storeId`** (or by
   `organizationId` for the organization-scoped inventory resources of
   `TDD_16 §1`). The id is read from `TenantGuard` request context
   (populated from the `X-Store-Id` header), **never** from the request body
   or query string, not even inside the guard.
3. **Every new tenant-scoped resource** gets a corresponding case added to
   `tests/security/tenant-isolation.spec.ts` in the same change that
   introduces the resource.
4. **Every database migration ships with a rollback script** per
   `TDD_03_Deployment.md §5.4`.
5. **Every new endpoint** has `AuthGuard` + `TenantGuard` + a
   `@RequirePermissions()` decorator, unless it is explicitly public
   (magic-link auth endpoints, invitation preview and accept, channel webhooks,
   widget endpoints, carrier webhooks, health checks), or it is a plugin route under
   `/api/v1/plugin-api/*`, which uses `PluginApiKeyGuard` instead. The Stripe
   webhook joins the public list in Phase 2.
6. **No user-facing string is hardcoded in any language.** Always an i18n key.
7. **Logger is Pino.** Never `console.log`, never Winston.
8. **Package manager is `pnpm`.** Never `npm` or `yarn`.
9. **No emojis in product UI.** Lucide React SVG icons only.
10. **AI features are suggest-only by default.** The only two that may act
    without a human approving the specific action are spam detection and the
    Scale-tier autonomous chatbot, exactly as bounded in `TDD_12_AI.md §1`
    and `§13`. Do not widen that exception to any other feature. The v1.2 MVP
    builds no AI feature at all.
11. **Anything marked MATURE or "Phase 2"** in the TDD is out of scope unless
    `IMPLEMENTATION_PLAN.md` explicitly includes it in the current milestone.
12. **When the TDD is ambiguous or silent on something, stop and ask.**
    Do not invent a design decision that contradicts or extends the TDD
    silently.

---

## Definition of done for any step

- [ ] Code compiles, `pnpm type-check` passes
- [ ] `pnpm lint` passes with zero warnings
- [ ] Unit tests written and passing for new business logic
- [ ] Integration test added if the step touches an API endpoint
- [ ] Tenant isolation test added if the step introduces a tenant-scoped resource
- [ ] The step's own "Done when" criterion verified, not assumed
- [ ] The step's PR is green on GitHub with every CI job that exists at that point; if the step created a CI job, the plan says which check to add to the `main` ruleset
- [ ] The step's task boxes are checked and its "Progress tracking" row is updated

---

## Quick reference: where things live

| Need                                                    | File                                                |
| ------------------------------------------------------- | --------------------------------------------------- |
| Event name                                              | `libs/core/domain/events/event-names.ts`                   |
| Cache key                                               | `libs/core/platform/cache/cache-keys.ts`                     |
| Permission                                              | `libs/core/domain/auth/permissions.ts`                     |
| Error code                                              | `libs/core/domain/errors/error-codes.ts`                   |
| API route constant                                      | `libs/core/domain/api/api-routes.ts`                       |
| Status enum                                             | `libs/core/domain/status-enums.ts`                  |
| Shipping constant (carrier ids, capabilities, label formats) | `libs/core/domain/shipping-constants.ts`       |
| Store preference and its factory default                | `libs/core/platform/config/store-preferences.ts`             |
| Queue/job name                                          | `libs/core/platform/queues/queue-names.ts`                   |
| Realtime event                                          | `libs/core/domain/realtime/realtime-events.ts`             |
| Notification type                                       | `libs/core/domain/notifications/notification-constants.ts` |
| Audit action                                            | `libs/core/platform/audit/audit-actions.ts`                  |
| Cron schedule                                           | `libs/core/platform/queues/schedules.ts`                     |
| Metric name                                             | `libs/core/platform/metrics/metric-names.ts`                 |
| Staff role / permission (Phase 2, not built in the MVP) | `libs/core/admin/staff-constants.ts`                |
| TanStack query key                                      | `libs/api-client/src/query-keys.ts`                 |
| Env variable (api/worker)                               | `libs/core/platform/config/env-schema.ts` (add to the Zod schema, then to `.env.example`) |
| Env variable (web, `NEXT_PUBLIC_*`)                     | `apps/web/lib/env-schema.ts` (add to the Zod schema, then to `apps/web/.env.example`) |

---

## Current status

Check `IMPLEMENTATION_PLAN.md` → "Progress tracking" section at the bottom:
a table with one row per step, its status and the PR that delivered it
(Milestone 6 and several steps are deferred in the v1.2 MVP). Start there every session.

<!-- code-review-graph MCP tools -->

## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool                        | Use when                                               |
| --------------------------- | ------------------------------------------------------ |
| `detect_changes`            | Reviewing code changes — gives risk-scored analysis    |
| `get_review_context`        | Need source snippets for review — token-efficient      |
| `get_impact_radius`         | Understanding blast radius of a change                 |
| `get_affected_flows`        | Finding which execution paths are impacted             |
| `query_graph`               | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes`     | Finding functions/classes by name or keyword           |
| `get_architecture_overview` | Understanding high-level codebase structure            |
| `refactor_tool`             | Planning renames, finding dead code                    |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
