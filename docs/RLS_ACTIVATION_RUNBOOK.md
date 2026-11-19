# Runbook: turning row level security on (owner only)

This is run by the OWNER, never by a session or by the CI. It turns on, in this order, the guards of the code (`RLS_CONTEXT`,
`WORKER_RLS_CONTEXT`) and the policies of the database (`pnpm db:rls:enforce on`). Design: `TDD_01 §3.2`, Step 7.1 of
`IMPLEMENTATION_PLAN.md`. Every step has a command, a check and a way back. Do not go to the next step until the check passes.

`RLS_CONTEXT=true` is NOT harmless even while the policies are off: the api opens one transaction per request, rolls it back on a
4xx answer and stops it after 15 seconds. Run steps 2 and 3 with someone watching.

## Preconditions

- Phase 5 (the worker loses `BYPASSRLS`), F6-3, F6-4 and F6-5 of the plan are merged, and so is E (the worker switch).
- `rls-enforced-tests` is green on `main` and is a required check of the ruleset of `main` (the owner adds it, after a green run on
  GitHub: Settings, Rules, the ruleset of `main`, Require status checks, `rls-enforced-tests`).
- A backup of the database taken and restored once somewhere else. A window with someone watching the logs.
- `DATABASE_REPLICA_URL`, when it is set, names `platform_replica_ro` (the api refuses to start if the role can write on a server
  that is not a standby, or skips row level security; `libs/core/database/src/replica-role.ts`).
- Never use real customer data to rehearse: staging with synthetic data.

## 1. Deploy with both flags off

- Do: deploy the code with `RLS_CONTEXT=false` and `WORKER_RLS_CONTEXT=false`, run `pnpm db:migrate` (it brings
  `NOBYPASSRLS` for the worker and `platform_replica_ro`), restart the api and the workers.
- Check: `/health` answers. `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('platform_app','platform_worker','platform_replica_ro')`
  gives `false` for the three. The worker log has no start error (with the flag off it only warns).
- Back: revert the deploy. If the worker cannot work, `ALTER ROLE platform_worker BYPASSRLS` and restart the workers.

## 2. Staging or a copy with synthetic data

- Do: `RLS_CONTEXT=true`, `WORKER_RLS_CONTEXT=true`, then `pnpm db:rls:enforce on`.
- Check by hand: login, the inbox, a 4xx after a write (the write must not be lost where it matters), an upload and a download, an
  export (a large one: watch the pool), a route with outside I/O (a shipment with a carrier, a channel), the widget, the sockets, and
  one manual run of each family of crons. `pnpm db:rls:enforce status` shows every table with a policy as enabled and forced. Zero
  `RLS_CONTEXT_REQUIRED` and zero `42501` in the logs that you did not expect; watch one whole cycle of the crons.
- Back: `pnpm db:rls:enforce off`, both flags to `false`.

## 3. Production, the flags first

- Do: `RLS_CONTEXT=true` on the api and `WORKER_RLS_CONTEXT=true` on the workers; restart. The policies are still off, so the loud
  guard shows every access without a context and harms no data.
- Check: one hour of traffic and one cycle of the crons. Zero `RLS_CONTEXT_REQUIRED`; 5xx and the p95 latency as in the baseline; a 4xx
  after a write behaves as it did in staging. Alert on the counter `worker_job_subject_missing_total` (a worker job that ran without the
  store or the organization it needed): any value above zero is a job that found nothing to do.
- Back: both flags to `false` and restart.

## 4. Turn the policies on

- Do: `pnpm db:rls:enforce on` (ENABLE and FORCE, one statement per table, about one second, safe to repeat; if it stops on a lock
  timeout, run it again).
- Check: `pnpm db:rls:enforce status` shows every table enabled and forced, and `SELECT * FROM rls_status WHERE NOT (enabled AND forced)`
  returns no row. Repeat the walk of step 2.
- Back: `pnpm db:rls:enforce off` (one command, about one second, no data lost).

## 5. Watch

For one hour and one cycle of the crons: `42501` errors and `RLS_CONTEXT_REQUIRED`; unexpected zeros in the crons (the sweeps stop
instead of deleting when they see nothing); the latency of the search and of the inbox against the baseline; the use of the
connection pool. After EVERY deploy that brings migrations: `pnpm db:rls:enforce on` again (a new table with a policy is enabled only
when it runs) and, if a migration with an old timestamp brought policies, `SELECT rls_extend_policies_to_replica()`.

## 6. Way back, complete, in this order

1. `pnpm db:rls:enforce off` (or `SELECT rls_set_enforcement(false, ARRAY[]::text[])` as the owner of the database).
2. Both flags to `false` and restart.
3. Only if the problem is the worker: `ALTER ROLE platform_worker BYPASSRLS` and restart the workers (with `WORKER_RLS_CONTEXT=false`
   the worker starts with a warning, not in a crash loop).

Check after each step: `status` shows OFF, and the walk of step 2 passes.

## Notes for the owner

- The migration `20270122600000_rls_search_order_customers` and the customers one build `idx_customers_name_trgm` inside their
  transaction: deploy at a quiet hour.
- The validators that guard the code (`validate:rls-worker`, `validate:replica`, `validate:definer`) are a net, not a proof: the
  proof is the job `rls-enforced` of the CI and the walk of step 2.
