# CLAUDE.md

> This file is auto-loaded by Claude Code at the start of every session in this repo.
> It is the entry point. Do not skip the steps below.

---

## What this project is

Omnichannel Commerce Platform — a multi-tenant SaaS that unifies WhatsApp,
Instagram, Messenger and a web widget into one inbox, with order
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

- **Standing authorization (owner, 2026-10-31):** when a step's "Done when" is verified, the
  review of the step is done (see "Code review of a step") and the gates pass locally, commit, push
  the branch and open the PR without asking. Nothing else is authorized: never `main`, never
  `--no-verify`, never a force-push.
- **Merge (owner, 2026-10-31), only once the `main` ruleset with the required checks exists** (see
  `IMPLEMENTATION_PLAN.md` → "CI rollout and the `main` ruleset"): after opening the PR, run
  `gh pr merge --auto --squash`. GitHub then merges by itself when every required check is green and
  never before; the ruleset, not the assistant, is the gate. Never merge by hand, never bypass the
  ruleset, never disable a check to get a merge. Until the ruleset exists, the owner squash-merges.
  Do not start the next step until the PR is merged and `main` is pulled.
- **One PR per step** (two only when a step is too big to review as one). The old split into many
  sub-PRs is over: each PR costs a session, a review and a CI wait.
- **No stacked branches.** Never branch from work that is not merged: a conflict in the first
  propagates to every later one. Start the next step from an up-to-date `main` after the merge.
- **A red job that has nothing to do with the change** (a flaky test) is rerun once. If it fails
  again, record it in the PR description and fix it in its own PR; do not widen the current one.
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

## Git hooks (Husky)

Installed by `pnpm install` (the `prepare` script). Never skip them with `--no-verify`: CI runs the
same checks and the merge waits for it.

- `pre-commit`: `lint-staged` fixes and re-stages (ESLint, Prettier, `prisma format`), then `gitleaks`
  checks what is staged. **`gitleaks` must be installed** (`brew install gitleaks`); without it the
  commit is refused with a message that says so.
- `commit-msg`: `commitlint`. Conventional Commits, a lowercase subject of at most 72 characters,
  for example `feat(http): name the failed checks of a probe`. The title of a pull request follows
  the same rules, because it becomes the squash commit on `main`.
- `pre-push`: `pnpm validate:affected` (Nx affected `lint`, `type-check` and `test`, `format:check`,
  the validators and `pnpm test:contracts`). It does not build, and it leaves to CI the suites that need a database and a
  ref that is not the checked-out commit. A push that only changes `docs/` is not checked, except that one which edits the plan runs `validate:isolation` and `validate:frontend`, which read it.
- `pnpm validate:all` is the same on the whole repository.

---

## Absolute rules (violating one is never a shortcut; rule 12 says when to stop and ask)

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
   widget endpoints, carrier webhooks, the Resend webhook, health checks), or it is the agents' websocket gateway, which checks the token, the store and the permissions itself (`events.gateway.ts`), or it is a plugin route under
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
12. **When the TDD is ambiguous or silent, decide; do not ask the owner.** The owner is not expected to judge technical choices, so the decision is made here and made well.
    - **Priority, in this order:** security and data safety, then correctness, then maintainability, then the smallest scope, then speed. Speed and token cost never outrank the first three. Among options that are equally safe and correct, take the one that least extends the TDD.
    - **No shortcuts to finish sooner.** Never skip, loosen or delete a test, check, threshold, budget or lint rule; never add `any`, an ignore or a mock that hides the behavior under test; never leave a placeholder or a TODO; never pick the weaker option because the right one is bigger.
    - **When the right option is too big for the PR,** do the correct part and add a task to `IMPLEMENTATION_PLAN.md` in the same PR, naming the step that owns the rest. A deferral that is not written in the plan is a shortcut.
    - **Write it down** in a "Decisions" section of the PR description: what was chosen, the best alternative that was rejected, why, and any debt created with where it is tracked.
    - **Stop and ask only** when the choice contradicts an explicit statement of the TDD, cannot be undone (data, secrets, money, a real account) or acts outside the repository.

---

## Definition of done for any step

- [ ] Code compiles, `pnpm type-check` passes
- [ ] `pnpm lint` passes with zero warnings
- [ ] Unit tests written and passing for new business logic
- [ ] Integration test added if the step touches an API endpoint
- [ ] Tenant isolation test added if the step introduces a tenant-scoped resource
- [ ] Every new route, realtime event or channel capability is mapped in `scripts/frontend-coverage-map.ts` to the step that draws it (or to a reason it has no interface); `pnpm validate:frontend` fails otherwise
- [ ] The step's own "Done when" criterion verified, not assumed
- [ ] `/code-review` run on the working tree before the PR is opened, for every PR with no exception for size or kind (a test-only or docs-touching change included), with every lens the PR requires (see "Code review of a step"); the mechanical gates do not replace it
- [ ] The step's PR is green on GitHub with every CI job that exists at that point; if the step created a CI job, the plan says which check to add to the `main` ruleset
- [ ] The step's task boxes are checked and its "Progress tracking" row is updated

---

## Code review of a step

**No PR is opened, and `gh pr merge --auto` is not run, before `/code-review` has run on the change.** Auto-merge
ends the review window: once armed, GitHub merges as soon as the checks are green. Judging a change "too small
to review" is a shortcut under rule 12; say in the PR which review pass ran and what it found.

The automated `/code-review` reports at most 10 findings per run, even when asked for more (two
scoped runs returned exactly 10 each). A run that returns 10 has **not** run out of findings.

- Review in small batches (one library, or at most 8 to 10 files), never the whole step at once.
- Give each pass one lens: correctness, security (secrets, permissions, customer data), tests, or
- **Lenses every PR must pass:** correctness always, plus one pass for each area the PR touches: tests (any
  `*.spec.ts` or fixture), configuration, CI and Docker (workflows, Dockerfiles, `package.json`, env schemas),
  and security (auth, tenancy, permissions, migrations, payments, secrets, customer data). A PR that touches
  none of the last three still passes correctness. The PR description lists the lenses that ran and what each
  found; a lens that did not run is stated, with the reason.
  configuration, CI and Docker.
- **Fewer than 10 findings means the cap did not bind**: that batch is complete. Exactly 10 means
  the cap bound. Repeat the batch only for security, data and money code (auth, tenancy, permissions,
  migrations, payments): fix what was reported and run it again until it returns fewer.
- **Every other batch (CI, config, tests, docs, UI) gets one pass, never repeated.** The tool fills
  its quota, so a second pass always finds more; most of it is hardening, not bugs. Fix what is a
  real, verified defect. Anything else goes to a backlog note, not into the PR. Green CI, not the
  finding count, decides that the PR is done.
- Review with the `/code-review` skill itself, never with forked subagents told to "run the skill":
  they inherit the author's context and do not verify.
- Check every finding by running the code before changing anything. Some are false positives, and
  a fix without a test that fails first proves nothing.
- Read the riskiest code yourself (security, data, money, CI). The tool says where to look first,
  not that the rest is fine.
- The mechanical gates have no cap and run on every step: `tsc`, ESLint, the tests, Trivy and the
  integration suites. Run them with `--skip-nx-cache`, because a cached success hides a failure.
- At the end say which files were read in full, which were only run or tested, and how many files
  were touched.

---

## Quick reference: where things live

| Need                                                    | File                                                |
| ------------------------------------------------------- | --------------------------------------------------- |
| Event name                                              | `libs/core/domain/events/event-names.ts`                   |
| Cache key                                               | `libs/core/platform/cache/cache-keys.ts`                     |
| Permission                                              | `libs/core/domain/auth/permissions.ts`                     |
| Error code                                              | `libs/core/domain/errors/error-codes.ts`                   |
| HTTP status (`HttpStatusCodes`)                         | `libs/core/domain/errors/http-status-codes.ts`             |
| Not found / conflict / unauthorized answer              | `libs/core/domain/errors/error-factories.ts` (`resourceNotFound`, `resourceConflict`, `unauthorized`)|
| API route constant                                      | `libs/core/domain/api/api-routes.ts`                       |
| Status enum                                             | `libs/core/domain/status-enums.ts`                  |
| Shipping constant (carrier ids, capabilities, label formats) | `libs/core/domain/shipping-constants.ts`       |
| Store preference and its factory default                | `libs/core/platform/config/store-preferences.ts`             |
| Queue/job name                                          | `libs/core/platform/queues/queue-names.ts`                   |
| Realtime event                                          | `libs/core/domain/realtime/realtime-events.ts`             |
| Socket limit, presence timing, room name                | `libs/core/domain/realtime/` (`socket-limits.ts`, `presence-timing.ts`, `room-names.ts`) |
| Event the worker passes to the api, bridge channel      | `libs/core/domain/events/event-names.ts` (`BridgedEvents`, `EVENTS_BRIDGE_CHANNEL`) |
| Notification type                                       | `libs/core/domain/notifications/notification-constants.ts` |
| Audit action                                            | `libs/core/platform/audit/audit-actions.ts`                  |
| Cron schedule                                           | `libs/core/platform/queues/schedules.ts`                     |
| Metric name                                             | `libs/core/platform/metrics/metric-names.ts`                 |
| Staff role / permission (Phase 2, not built in the MVP) | `libs/core/admin/staff-constants.ts`                |
| TanStack query key                                      | `libs/api-client/src/query-keys.ts`                 |
| Which step draws a route, realtime event or channel capability | `scripts/frontend-coverage-map.ts`                  |
| Env variable (api/worker)                               | `libs/core/platform/config/env-schema.ts` (add to the Zod schema, then to `.env.example`) |
| Env variable (web, `NEXT_PUBLIC_*`)                     | `apps/web/lib/env-schema.ts` (add to the Zod schema, then to `apps/web/.env.example`) |
| New UI primitive (dialog, tabs, ...)                    | `apps/web/components/ui/`, copied by hand: the shadcn CLI is not installed (`apps/web/components/ui/README.md`) |

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
