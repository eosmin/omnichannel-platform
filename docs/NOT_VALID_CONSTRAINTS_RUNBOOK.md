# Runbook: validating the CHECK constraints added NOT VALID (owner only)

Seventeen CHECK constraints were added `NOT VALID` by migrations `plugin_actor`, `order_plugin_actor`, `stock_plugin_actor` and
`inventory_movement_value` (the list is `NOT_VALID_CONSTRAINTS` in `scripts/lib/not-valid-constraints.ts`; a spec fails if a migration
adds another one that is not on it). `NOT VALID` already enforces the check on EVERY new write; what it skips is the rows that existed
when the constraint was added. `VALIDATE CONSTRAINT` scans the table once and marks the constraint valid, so the planner and a reader of
the schema can trust it. Nothing is lost by leaving them as they are; the run is hygiene and it is the owner's call when to do it.

This is run by the OWNER, over `DIRECT_DATABASE_URL` (never the pooler, never `platform_app`). No migration does it, on purpose: a
migration is one transaction, so the locks of every table would be held together until the last scan ended, and a violation would fail the
deploy. The tool validates one constraint per statement, each its own transaction.

## Credential and guards

- `VALIDATE CONSTRAINT` and the `revert` need the OWNER of the tables, so the tool reads `DIRECT_DATABASE_URL` (the owner role over port
  5432, not `platform_app`, not the pooler). That URL holds a password: it lives only in the owner's shell or secret store, NEVER in the
  repository (it is public), in a log or in a PR.
- `status` changes nothing. `run` and `revert` refuse (exit 2, nothing changed) unless `--confirm=<database>` names the database of the URL,
  and always refuse `platform_dev` (the development database of the owner; sessions rehearse on their own `platform_test_<name>`).
- The output has constraint names, states and COUNTS of rows. Never row values and never ids; the queries below that name ids are run by
  the owner by hand.

## What the lock does

`ALTER TABLE ... VALIDATE CONSTRAINT` of a CHECK takes `SHARE UPDATE EXCLUSIVE` on the table: `SELECT`, `INSERT`, `UPDATE` and `DELETE`
go on (a spec holds an open writer while it runs: `tests/api/validate-not-valid-constraints.spec.ts`). What waits for it, and what it
waits for: DDL on the table, `VACUUM` / autovacuum of it, `CREATE INDEX` (not concurrent), another `VALIDATE` and `LOCK TABLE ... SHARE ROW
EXCLUSIVE`. The tool sets `lock_timeout = 5s` and `statement_timeout = 0`: if a long transaction or a vacuum holds the table the
constraint says `lock-timeout` and the run goes on with the next one (exit code 1 at the end); a queued lock request never blocks the table
for the others. The scan of the big tables (`messages`, `orders`, `inventory_movements`) takes a while and reads the whole table: run it
in a quiet hour (the "maintenance window" of the plan), not at the peak, and watch the replica lag if there is a replica.

## Before

- A backup of the database taken, and a window with someone watching the logs and the database.
- No migration running, no manual DDL, no long transaction on the tables of the list:
  `SELECT pid, now() - xact_start AS age, left(query, 80) FROM pg_stat_activity WHERE state <> 'idle' AND xact_start < now() - interval '1 minute';`
- `DIRECT_DATABASE_URL` is the owner of the database you mean to change (the tool prints the database name first).

## 1. Look

```
pnpm db:constraints:validate status
```

Changes nothing. Lists each constraint as `not-valid`, `valid` or `missing` (a `missing` one was dropped by a rollback or a later migration:
update the list in the same PR as that change).

## 2. Validate

```
pnpm db:constraints:validate run --confirm=<database>
```

Per constraint: `validated`, `already-valid` (run again is safe), `lock-timeout` (run again later; nothing changed), `missing`, or
`violated`. Exit code 1 if any is `violated` or `lock-timeout`. The others are validated whatever one of them did.

### If a constraint says `violated`

It cannot happen with data written by the application: every row that existed had a null in the new column, and every write since the
migration is checked. It means a row was changed by hand, or the constraint was dropped (a rollback) and the application wrote after it.
The tool prints only HOW MANY rows break the check (these tables hold customer data and the output goes to logs). Look at them by id, never
by content:

```sql
-- the check is in pg_get_constraintdef; for the person-or-plugin ones it is "both set"
SELECT id FROM messages WHERE edited_by_id IS NOT NULL AND edited_by_plugin_id IS NOT NULL;
```

Decide each row with the owner of the data (who really did it: the person or the plugin), set the OTHER column to null in a transaction
with the reason in the change log, and run step 2 again. Never delete a row to make the check pass, and never drop the constraint to get
a green run. A constraint that stays `violated` stays `NOT VALID`, which is as safe as it was.

## 3. Check

`pnpm db:constraints:validate status` says `17 of 17 constraints are valid`. The api and the worker log no `23514` (check violation) that
they did not have before.

## Way back

```
pnpm db:constraints:validate revert --confirm=<database>
```

Drops each validated constraint and adds it again, with the same definition, `NOT VALID`, in one transaction per constraint (the
`ACCESS EXCLUSIVE` lock lasts for the two statements and there is no scan, so it is fast). Writes are checked before, during and after.
Safe to run twice (`already-not-valid`). A validated constraint cannot be marked not valid in place; this is the only way. Nothing else
depends on the validated flag, so the way back is only ever needed if a validated constraint is to be changed.

## After a deploy that adds a constraint NOT VALID

Add it to `NOT_VALID_CONSTRAINTS`, and run steps 1 to 3 again in the next window.
