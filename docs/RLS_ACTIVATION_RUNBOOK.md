# Runbook: turning row level security on (owner only)

This is run by the OWNER, never by a session or by the CI. It turns on, in this order, the guards of the code (`RLS_CONTEXT`,
`WORKER_RLS_CONTEXT`) and the policies of the database (`pnpm db:rls:enforce on`). Design: `TDD_01 §3.2`, Step 7.1 of
`IMPLEMENTATION_PLAN.md`. Every step has a command, a check and a way back. Do not go to the next step until the check passes.

`RLS_CONTEXT=true` is NOT harmless even while the policies are off: the api opens one transaction per request, rolls it back on a
4xx answer and stops it after 15 seconds. Run steps 2 and 3 with someone watching.

## Preconditions

- Phase 5, F6-3, F6-4 and F6-5 of the plan are merged, and so is E-2 (the owner script `pnpm db:rls:worker-role`). No migration changes the role of the worker: only step 3b does, by hand.
- `rls-enforced-tests` is green on `main` and is a required check of the ruleset of `main` (the owner adds it, after a green run on
  GitHub: Settings, Rules, the ruleset of `main`, Require status checks, `rls-enforced-tests`).
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
  3. Run `pnpm db:migrate`, with `DB_REPLICA_PASSWORD` set in its environment. The migration creates `platform_replica_ro` (NOLOGIN); it
     does NOT touch `BYPASSRLS` of the worker (that is step 3b); `db:migrate` then runs `scripts/set-db-role-passwords.ts`, which gives the role its login.
  4. Only now set `DATABASE_REPLICA_URL` to `platform_replica_ro` if the api reads a replica (before the migration the role does not
     exist, and an api whose url names a role that cannot log in does not start).
  5. Start the new workers with `WORKER_RLS_CONTEXT=false`, and restart the api.
- **The window between 1.1 and 1.3 (new api, old schema).** The new api calls the functions of the new migrations EVEN with both flags off: `lookup_plugin_status_of_key` (`20270122800000`; `PluginApiKeyGuard` asks for it on EVERY plugin-api request), `rls_list_remote_channel_plugins` (`20270122900000`; `RemoteChannelSync.refresh`), `rls_list_pickups_pending_stale` and `rls_list_pickups_count_behind` (`20270122700000`), `rls_transfer_line_store_ids` (`20270123000000`) and `rls_plugin_foreign_owner` (`20270123100000`). Until `pnpm db:migrate` has run, the plugin-api answers 5xx to the plugins and the sync of remote channels fails in the log. The order stays (the api goes first because the jobs it queues already carry `storeId`, and `20270121850000` drops the `rls_store_of_*` functions that the old workers use, so the migration waits until they are stopped). So:
  - Run `pnpm db:migrate` AS SOON AS the old workers are stopped (1.2): do not wait for the other queues to drain; the jobs left in the queues are taken by the new workers (1.5).
  - Tell the plugins and pause their calls for that window (minutes; one store).
  - The window is closed when ALL six functions exist, not only the first (the migrations apply one by one, in order, so a `db:migrate` that stops half way leaves the last ones absent): `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname IN ('lookup_plugin_status_of_key', 'rls_list_remote_channel_plugins', 'rls_list_pickups_pending_stale', 'rls_list_pickups_count_behind', 'rls_transfer_line_store_ids', 'rls_plugin_foreign_owner')` gives `6`, and `SELECT finished_at IS NOT NULL FROM _prisma_migrations WHERE migration_name = '20270123100000_rls_plugin_foreign_owner'` gives `true` and a plugin-api request answers 200 again, with no 5xx and no failure of the remote channel sync in the log of the api.
- Check: `/health` answers. `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('platform_app','platform_worker','platform_replica_ro')`
  gives `false` for `platform_app` and `platform_replica_ro`, and `true` for `platform_worker` (it keeps the bypass until step 3b). The
  worker log has no start error (with the flag off it only warns).
- Back: revert the deploy; the rollback of `20270121850000` recreates the `rls_store_of_*` functions, but the old jobs that already failed are
  lost. If the worker cannot work, see the way back of step 3b.

## 2. Staging or a copy with synthetic data

- Do: `RLS_CONTEXT=true`, then step 3b (the worker role and `WORKER_RLS_CONTEXT=true`), then `pnpm db:rls:enforce on`.
- Check by hand: login, the inbox, a 4xx after a write (the write must not be lost where it matters), an upload and a download, an
  export (a large one: watch the pool), a route with outside I/O (a shipment with a carrier, a channel), the widget, the sockets, and
  one manual run of each family of crons. `pnpm db:rls:enforce status` shows every table with a policy as enabled and forced. Zero
  `RLS_CONTEXT_REQUIRED` and zero `42501` in the logs that you did not expect; watch one whole cycle of the crons.
- Back: `pnpm db:rls:enforce off`, then the way back of step 3b, and `RLS_CONTEXT=false`.

## 3. Production, the flags first

- Do: `RLS_CONTEXT=true` on the api; restart. The worker flag waits for step 3b, because the worker refuses to start with it ON while its role
  skips RLS. The policies are still off, so the loud guard shows every access without a context and the policies cannot hide a row. It is still a change of behavior: a request that
  writes and then answers 4xx loses its write (the transaction rolls back), so go in only after staging passed.
- Check: one hour of traffic and one cycle of the crons. Zero `RLS_CONTEXT_REQUIRED`; 5xx and the p95 latency as in the baseline; a 4xx
  after a write behaves as it did in staging. Alert on the counter `worker_job_subject_missing_total` (after 3b) (a worker job that ran without the
  store or the organization it needed): any value above zero is a job that found nothing to do.
- Back: `RLS_CONTEXT=false` and restart (a write lost to a 4xx rollback is not recovered: tell the person who made it).

## 3b. Take `BYPASSRLS` from the worker (owner only, by hand, never by a migration or the CI of the real database)

`platform_worker` is created with `BYPASSRLS` and keeps it. `WORKER_RLS_CONTEXT` stays `false` in every step above until here (#786: the
worker refuses to start with the flag ON while its role still skips RLS; with the flag off it only warns, so a rollback does not crash-loop).
The order is exact. The actions below are lettered (a to e) so that they are not mixed with the numbered sections of this runbook:

(a) `pnpm db:rls:worker-role status` (reads only; shows host, database, the role, the databases of the server it reaches and how many sessions of `platform_worker` are open right now). Rehearse the whole of 3b first in STAGING: some managed
   providers do not let you change `BYPASSRLS` (error `42501`), and you need to know it before production.
(b) Stop the workers and let the queues drain.
(c) `pnpm db:rls:worker-role nobypass --confirm=<database name>` (plus `--allow-host=<host>` when the host is not this machine: read the host it prints
   and type it out). The script prints the host, the database and the role before it acts, and it is idempotent. It REFUSES while any session of
   `platform_worker` is open in any database of the server (the workers are not stopped: one that runs with the flag off has no guard and
   would read no row, in silence), and when the role that runs it cannot see other sessions (it needs a superuser or `pg_read_all_stats`:
   zero would be a guess). `--force-connected` skips that check and is only for the rehearsal in staging. The check is a snapshot: keep the workers
   stopped until the command ends. A local host (`localhost`, `127.x`, a socket) never asks for `--allow-host`: an SSH tunnel to production looks local, so use the real host name or distrust a tunnel, `--confirm` is the only guard there. A pooler keeps idle sessions open: they count as connections and the refusal is then too strict (safe).
(d) Start the workers with `WORKER_RLS_CONTEXT=true`.
(e) Check: the gauge `platform_worker_role_bypasses_rls` is `0`; `status` shows `rolbypassrls = false`; the worker log has no start error.

A ROLE belongs to the whole SERVER, not to one database: the change reaches EVERY database of that server where `platform_worker` can
connect. The script lists them (a query to `pg_database`) before it acts and in the refusal; read the list, and if it names a database that
is not yours, stop.
The credential that can run it (a superuser or a role with `CREATEROLE` admin on the role) is held by the owner or the provider. Put it only in the environment of
that one run: never in `.env` or `.env.local`, never in the repository, never in a secret of the CI. `pnpm db:rls:enforce on` refuses to
run while the worker still skips RLS, so this step comes before section 4 (enforce on).

Back (in this order): `WORKER_RLS_CONTEXT=false`, restart the workers, then `pnpm db:rls:worker-role bypass --confirm=<database name>` (plus `--allow-host=<host>` when the host is not this machine, as for `nobypass`).
NEVER run `bypass` while the flag is ON: the worker would refuse to start (the only state the check rejects).

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
3. Only if the problem is the worker: the way back of step 3b (`WORKER_RLS_CONTEXT=false`, restart, then
   `pnpm db:rls:worker-role bypass --confirm=<database name>` (plus `--allow-host=<host>` when the host is not this machine, as for `nobypass`); never `bypass` with the flag ON). With the flag off the worker starts with
   a warning, not in a crash loop.

Check after each step: `status` shows OFF, and the walk of step 2 passes.

## Notes for the owner

- The check of the replica role runs only when the api starts: a standby promoted later while the url still names `platform_app` is writable.
  The runbook asks for `platform_replica_ro` always; this limit is accepted.
- The migration `20270122600000_rls_search_order_customers` and the customers one build `idx_customers_name_trgm` inside their
  transaction: deploy at a quiet hour.
- The validators that guard the code (`validate:rls-worker`, `validate:replica`, `validate:definer`) are a net, not a proof: the
  proof is the check `rls-enforced-tests` of the CI (it waits for `rls-enforced-integration` and every shard of the `rls-enforced-security` matrix)
  and the walk of step 2.
