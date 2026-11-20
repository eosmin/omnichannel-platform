# Runbook: turning row level security on (owner only)

This is run by the OWNER, never by a session or by the CI. It turns on, in this order, the guards of the code (`RLS_CONTEXT`,
`WORKER_RLS_CONTEXT`) and the policies of the database (`pnpm db:rls:enforce on`). Design: `TDD_01 §3.2`, Step 7.1 of
`IMPLEMENTATION_PLAN.md`. Every step has a command, a check and a way back. Do not go to the next step until the check passes.

`RLS_CONTEXT=true` is NOT harmless even while the policies are off: the api opens one transaction per request, rolls it back on a
4xx answer and stops it after 15 seconds. Run steps 2 and 3 with someone watching.

## Preconditions

- F6-3, F6-4 and F6-5 of the plan are merged, and so is stage E-2 (`pnpm db:rls:worker-role`, the owner's script that takes `BYPASSRLS` from
  the worker; no migration does it).
- `rls-enforced-tests` is green on `main` and is a required check of the ruleset of `main` (the owner adds it, after a green run on
  GitHub: Settings, Rules, the ruleset of `main`, Require status checks, `rls-enforced-tests`).
- A superuser connection URL ready for the two commands that change `BYPASSRLS` (step 3b and the way back of section 6), kept outside the files of the app.
- A backup of the database taken and restored once somewhere else. A window with someone watching the logs.
- `DATABASE_REPLICA_URL`, when it is set, names `platform_replica_ro` (the api refuses to start if the role can write on a server
  that is not a standby, or skips row level security; `libs/core/database/src/replica-role.ts`).
- Never use real customer data to rehearse: staging with synthetic data.

## 1. Deploy with both flags off

- Do, in this order (the order matters: the jobs already queued in `heavy-processing` and `exports` carry no `storeId`/`userId` and fail
  for good, and the old worker calls the `rls_store_of_*` functions that migration `20270121850000` drops):
  1. Deploy the api first (it already sends `storeId`) with `RLS_CONTEXT=false`.
  2. Stop the old workers and let `heavy-processing`, `exports` and the scheduled reports drain (or accept that the orphan cleaner
     requeues the pending files, which now carry their owner).
  3. Run `pnpm db:migrate`, with `DB_REPLICA_PASSWORD` set in its environment. The migration creates `platform_replica_ro` (NOLOGIN) and
     leaves `platform_worker` as it was (it still skips row security until step 3b); `db:migrate` then runs `scripts/set-db-role-passwords.ts`, which gives the role its login.
  4. Only now set `DATABASE_REPLICA_URL` to `platform_replica_ro` if the api reads a replica (before the migration the role does not
     exist, and an api whose url names a role that cannot log in does not start).
  5. Start the new workers with `WORKER_RLS_CONTEXT=false`, and restart the api.
- Check: `/health` answers. `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('platform_app','platform_worker','platform_replica_ro')`
  gives `false` for `platform_app` and `platform_replica_ro` and, until step 3b, `true` for `platform_worker`. The worker log has no start error (with the flag off it only warns).
- Back: revert the deploy; the rollback of `20270121850000` recreates the `rls_store_of_*` functions, but the old jobs that already failed are
  lost. The worker still skips row security here, so there is nothing to give back.

## 2. Staging or a copy with synthetic data

- WARNING: the worker role belongs to the whole Postgres server. Rehearse on a server of its own; on a copy that shares the production server the
  switch changes the production workers too (read the list of databases that `worker-role` prints before you confirm).
- Do: `RLS_CONTEXT=true`, `WORKER_RLS_CONTEXT=true`, the worker role switch of step 3b (stop the workers, `nobypass`, start them with the
  flag on), then `pnpm db:rls:enforce on`.
- Check by hand: login, the inbox, a 4xx after a write (the write must not be lost where it matters), an upload and a download, an
  export (a large one: watch the pool), a route with outside I/O (a shipment with a carrier, a channel), the widget, the sockets, and
  one manual run of each family of crons. `pnpm db:rls:enforce status` shows every table with a policy as enabled and forced. Zero
  `RLS_CONTEXT_REQUIRED` and zero `42501` in the logs that you did not expect; watch one whole cycle of the crons.
- Back: `pnpm db:rls:enforce off`, both flags to `false` and restart, and only then `pnpm db:rls:worker-role bypass --confirm=<database>`.

## 3. Production, the flags first

- Do: `RLS_CONTEXT=true` on the api (the workers keep `WORKER_RLS_CONTEXT=false` until step 3b, because a worker with the flag on refuses to
  start while its role skips row security); restart. The policies are still off, so the loud
  guard shows every access without a context and the policies cannot hide a row. It is still a change of behavior: a request that
  writes and then answers 4xx loses its write (the transaction rolls back), so go in only after staging passed.
- Check: one hour of traffic and one cycle of the crons. Zero `RLS_CONTEXT_REQUIRED`; 5xx and the p95 latency as in the baseline; a 4xx
  after a write behaves as it did in staging. Alert on the counter `worker_job_subject_missing_total` (a worker job that ran without the
  store or the organization it needed): any value above zero is a job that found nothing to do.
- Back: the flag to `false` and restart (a write lost to a 4xx rollback is not recovered: tell the person who made it).

## 3b. Take `BYPASSRLS` from the worker (owner only, not a migration)

`pnpm db:rls:worker-role` runs over `DIRECT_DATABASE_URL`, never from a migration, `db:migrate`, a deploy step or the CI of production.
PostgreSQL lets only a superuser change `BYPASSRLS`, so this one command needs a SUPERUSER connection (give it in the environment of that
single run, not in the file of the app); with an owner that is not one the statement is refused with SQLSTATE `42501` and nothing
changes. Do not make the application's owner a superuser to get around the refusal. The superuser is the owner of the server or the provider's own
superuser role (with its own name on a managed Postgres, and some providers let nobody change `BYPASSRLS`): pass its URL only in the
environment of that one run (`DIRECT_DATABASE_URL=... pnpm db:rls:worker-role ...` in the shell of the owner; dotenv-flow does not override
a variable already set), never in `.env`, `.env.local`, the repository or a CI secret of production, and close the shell or revoke the
credential afterwards. Try `nobypass` and `bypass` in staging first (a provider that refuses gives the same SQLSTATE `42501`), before
planning production. A role belongs to the whole server: the command lists the databases where `platform_worker` can connect
before it changes anything, and the change reaches all of them. A mode that changes the role runs only with `--confirm=<the database the
URL points at>` (compared with `current_database()`); `status` is the default and changes nothing.

- Do, in this order (the order is the safety):
  1. `pnpm db:rls:worker-role status`: read the role and the databases the change reaches.
  2. Stop the workers and let their queues drain. A job that runs with no store in its context reads no row once the role is bound.
  3. `pnpm db:rls:worker-role nobypass --confirm=<database>`.
  4. Start the workers with `WORKER_RLS_CONTEXT=true`. A worker with the flag on and a role that still skips row security refuses to
     start, and, once section 4 (`enforce on`) has the policies on, a worker with the flag off and the role bound finds nothing to do: the flag and the role change together.
- Check: `status` says `bypassrls=false superuser=false (row security binds it)`; the worker log has no start error; the gauge
  `platform_worker_role_bypasses_rls` (the worker's own check of its role at start) is `0`; `worker_job_subject_missing_total` stays at zero over one cycle
  of the crons. After EVERY restart of a worker read the flag in its environment and the gauge together: gauge `0` with the flag `false` is the
  unsafe pair once section 4 has the policies on. `pnpm db:rls:enforce on` refuses to run while the worker still skips row security, so
  section 4 cannot be reached by mistake.
- Back, ONLY while the policies are still off (before section 4, `enforce on`): set `WORKER_RLS_CONTEXT=false`, restart the workers, and only then `pnpm db:rls:worker-role bypass
  --confirm=<database>`. once section 4 is done, start at section 6 step 1 (`enforce off`) instead. **NEVER give `BYPASS` back with the flag still on**, and never take it away with the flag off and the policies
  on: the worker would read no row (while the policies are still off a bound role sees every row, but keep the same order so the way back is one habit). A worker started with the flag off and the role bound starts WITHOUT any warning (the start check only complains about a role that skips row security), so after every restart read the two together: the flag in the environment of the worker and the gauge `platform_worker_role_bypasses_rls`; `0` with the flag off is the unsafe pair once the policies are on.

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
3. Only if the problem is the worker, in this order: the flag is already `false` and the workers restarted (step 2), then
   `pnpm db:rls:worker-role bypass --confirm=<database>` over the superuser URL of the preconditions (a non-superuser owner is refused with 42501 and the role stays bound) and restart the workers once more. Never `bypass` while the flag is on.

Check after each step: `status` shows OFF, and the walk of step 2 passes.

## Notes for the owner

- The check of the replica role runs only when the api starts: a standby promoted later while the url still names `platform_app` is writable.
  The runbook asks for `platform_replica_ro` always; this limit is accepted.
- The migration `20270122600000_rls_search_order_customers` and the customers one build `idx_customers_name_trgm` inside their
  transaction: deploy at a quiet hour.
- The validators that guard the code (`validate:rls-worker`, `validate:replica`, `validate:definer`) are a net, not a proof: the
  proof is the check `rls-enforced-tests` of the CI (it waits for `rls-enforced-integration` and the `rls-enforced-security` shards)
  and the walk of step 2.
