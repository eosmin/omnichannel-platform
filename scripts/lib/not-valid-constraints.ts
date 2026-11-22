import type { ClientBase } from 'pg'

import { DEVELOPMENT_DATABASE_NAME } from '@platform/core/database-testing'

// The CHECK constraints that migrations added NOT VALID on purpose (a migration is one transaction, and adding a CHECK takes the
// strongest lock of the table while it scans it) and that nothing validated afterwards: the person-or-plugin checks of
// `plugin_actor` (M1c), `order_plugin_actor` (E3b) and `stock_plugin_actor` (E4b-2), and the value check of the movements.
// `VALIDATE CONSTRAINT` is run on them by the owner (scripts/validate-not-valid-constraints.ts, docs/NOT_VALID_CONSTRAINTS_RUNBOOK.md),
// outside a transaction, because it takes a SHARE UPDATE EXCLUSIVE lock (reads and writes go on, DDL and VACUUM wait) and scans the
// table. A new constraint added NOT VALID goes here, or `not-valid-constraints.spec.ts` fails.
export interface ConstraintRef {
  readonly schema: string
  readonly table: string
  readonly name: string
}

const PUBLIC_SCHEMA = 'public'
const ref = (table: string, name: string): ConstraintRef => ({ schema: PUBLIC_SCHEMA, table, name })

export const NOT_VALID_CONSTRAINTS: readonly ConstraintRef[] = [
  // 20261215140000_plugin_actor
  ref('messages', 'messages_edited_actor_check'),
  ref('messages', 'messages_deleted_actor_check'),
  ref('message_revisions', 'message_revisions_actor_check'),
  // 20261216110000_order_plugin_actor
  ref('orders', 'orders_created_actor_check'),
  ref('orders', 'orders_confirmed_actor_check'),
  ref('orders', 'orders_cancelled_actor_check'),
  ref('orders', 'orders_price_requested_actor_check'),
  ref('orders', 'orders_price_approved_actor_check'),
  ref('inventory_movements', 'inventory_movements_actor_check'),
  ref('order_message_dispatches', 'order_message_dispatches_actor_check'),
  // 20261219100000_stock_plugin_actor
  ref('stock_transfers', 'stock_transfers_created_actor_check'),
  ref('stock_transfers', 'stock_transfers_dispatched_actor_check'),
  ref('stock_counts', 'stock_counts_created_actor_check'),
  ref('stock_counts', 'stock_counts_applied_actor_check'),
  ref('stock_transfers', 'chk_stock_transfers_dispatch'),
  ref('stock_counts', 'chk_stock_counts_applied_pair'),
  // 20270114100000_inventory_movement_value
  ref('inventory_movements', 'chk_inventory_movements_value')
]

// SQLSTATE of "check constraint is violated by some row" and of a lock that could not be had in time
const CHECK_VIOLATION = '23514'
const LOCK_NOT_AVAILABLE = '55P03'

// How long a statement waits for a lock before it gives up (a long transaction, a VACUUM, a DDL): the run fails visibly and
// can be repeated, it never queues behind them and blocks the table for everybody else
export const LOCK_TIMEOUT = '5s'

export type ConstraintState = 'valid' | 'not-valid' | 'missing'

export interface ConstraintStatus {
  readonly ref: ConstraintRef
  readonly state: ConstraintState
}

export type ValidationOutcome =
  | { readonly ref: ConstraintRef; readonly result: 'validated' | 'already-valid' | 'missing' }
  | { readonly ref: ConstraintRef; readonly result: 'violated'; readonly violatingRows: number }
  | { readonly ref: ConstraintRef; readonly result: 'lock-timeout' }

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

const qualified = (constraint: ConstraintRef): string =>
  `${quoteIdentifier(constraint.schema)}.${quoteIdentifier(constraint.table)}`

export function label(constraint: ConstraintRef): string {
  return `${constraint.table}.${constraint.name}`
}

export async function statusOf(
  client: ClientBase,
  constraint: ConstraintRef
): Promise<ConstraintStatus> {
  const { rows } = await client.query<{ convalidated: boolean }>(
    `SELECT c.convalidated FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2 AND c.conname = $3 AND c.contype = 'c'`,
    [constraint.schema, constraint.table, constraint.name]
  )
  const row = rows[0]
  if (row === undefined) return { ref: constraint, state: 'missing' }
  return { ref: constraint, state: row.convalidated ? 'valid' : 'not-valid' }
}

// How many rows break the check, counted with the expression the database itself holds (never a name typed by hand). Only a
// count: a row of these tables is customer data and the output of a script goes to a terminal and to logs.
async function countViolations(client: ClientBase, constraint: ConstraintRef): Promise<number> {
  const { rows } = await client.query<{ expression: string }>(
    `SELECT regexp_replace(pg_get_constraintdef(c.oid), '^CHECK ', '') AS expression
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2 AND c.conname = $3`,
    [constraint.schema, constraint.table, constraint.name]
  )
  const expression = rows[0]?.expression.replace(/ NOT VALID$/, '')
  if (expression === undefined) return 0
  const counted = await client.query<{ violating: string }>(
    `SELECT count(*)::text AS violating FROM ${qualified(constraint)} WHERE NOT COALESCE(${expression}, true)`
  )
  return Number(counted.rows[0]?.violating ?? 0)
}

// An error of the database may carry a DETAIL with the values of a row ("Failing row contains (...)", "Key (...)=(...)"), and the
// message of a thrown error goes to the terminal and to logs: what leaves this module names the constraint and the SQLSTATE only
export function safeError(constraint: ConstraintRef, error: unknown): Error {
  return new Error(
    `${label(constraint)}: the database refused with SQLSTATE ${codeOf(error) ?? 'unknown'}`
  )
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined
}

// One constraint per statement, outside any transaction of ours (autocommit): the lock is held for the scan of that table only, and
// a violation or a lock timeout of one constraint leaves the others validated. Safe to run again: a valid constraint is skipped.
export async function validateConstraint(
  client: ClientBase,
  constraint: ConstraintRef
): Promise<ValidationOutcome> {
  const before = await statusOf(client, constraint)
  if (before.state === 'missing') return { ref: constraint, result: 'missing' }
  if (before.state === 'valid') return { ref: constraint, result: 'already-valid' }
  await client.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`)
  // The scan of a big table may take longer than the statement timeout of the role; the owner chose the window
  await client.query('SET statement_timeout = 0')
  try {
    await client.query(
      `ALTER TABLE ${qualified(constraint)} VALIDATE CONSTRAINT ${quoteIdentifier(constraint.name)}`
    )
    return { ref: constraint, result: 'validated' }
  } catch (error) {
    const code = codeOf(error)
    if (code === LOCK_NOT_AVAILABLE) return { ref: constraint, result: 'lock-timeout' }
    if (code === CHECK_VIOLATION) {
      try {
        return {
          ref: constraint,
          result: 'violated',
          violatingRows: await countViolations(client, constraint)
        }
      } catch (countError) {
        throw safeError(constraint, countError)
      }
    }
    throw safeError(constraint, error)
  } finally {
    await client.query('RESET lock_timeout')
    await client.query('RESET statement_timeout')
  }
}

export async function validateConstraints(
  client: ClientBase,
  constraints: readonly ConstraintRef[]
): Promise<ValidationOutcome[]> {
  const outcomes: ValidationOutcome[] = []
  for (const constraint of constraints) outcomes.push(await validateConstraint(client, constraint))
  return outcomes
}

// The way back: a validated constraint cannot be marked not valid again, so it is dropped and added again with the same
// definition, NOT VALID, in one transaction (the ACCESS EXCLUSIVE lock lasts for the two statements, no scan). Writes are checked
// before, during and after. A constraint that is already NOT VALID is left alone.
export async function revertToNotValid(
  client: ClientBase,
  constraint: ConstraintRef
): Promise<'reverted' | 'already-not-valid' | 'missing' | 'lock-timeout'> {
  const before = await statusOf(client, constraint)
  if (before.state === 'missing') return 'missing'
  if (before.state === 'not-valid') return 'already-not-valid'
  const { rows } = await client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2 AND c.conname = $3`,
    [constraint.schema, constraint.table, constraint.name]
  )
  const definition = rows[0]?.definition
  if (definition === undefined) return 'missing'
  try {
    await client.query('BEGIN')
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
    await client.query(
      `ALTER TABLE ${qualified(constraint)} DROP CONSTRAINT ${quoteIdentifier(constraint.name)}`
    )
    await client.query(
      `ALTER TABLE ${qualified(constraint)} ADD CONSTRAINT ${quoteIdentifier(constraint.name)} ${definition} NOT VALID`
    )
    await client.query('COMMIT')
    return 'reverted'
  } catch (error) {
    await client.query('ROLLBACK')
    if (codeOf(error) === LOCK_NOT_AVAILABLE) return 'lock-timeout'
    throw safeError(constraint, error)
  }
}

const withoutComments = (sql: string): string => sql.replace(/--[^\n]*/g, '')

// What the text of a migration does to constraints, in order: added NOT VALID, validated, dropped. The guard of the list above
export function constraintEvents(
  migrationSql: string
): { kind: 'not-valid' | 'validate' | 'drop'; name: string }[] {
  const events: { kind: 'not-valid' | 'validate' | 'drop'; name: string; at: number }[] = []
  const sql = withoutComments(migrationSql)
  // One ALTER TABLE may add several constraints, separated by commas: each clause says for itself whether it is NOT VALID
  for (const statement of sql.matchAll(/[^;]*;/g)) {
    for (const clause of statement[0].split(/,(?=\s*ADD\s+CONSTRAINT)/)) {
      const added = /ADD\s+CONSTRAINT\s+"?(\w+)"?/.exec(clause)
      if (added?.[1] !== undefined && /\bNOT\s+VALID\s*;?\s*$/.test(clause)) {
        events.push({ kind: 'not-valid', name: added[1], at: statement.index + (added.index ?? 0) })
      }
    }
  }
  for (const match of sql.matchAll(/VALIDATE\s+CONSTRAINT\s+"?(\w+)"?/g)) {
    if (match[1] !== undefined) events.push({ kind: 'validate', name: match[1], at: match.index })
  }
  for (const match of sql.matchAll(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?/g)) {
    if (match[1] !== undefined) events.push({ kind: 'drop', name: match[1], at: match.index })
  }
  return events.sort((a, b) => a.at - b.at).map(({ kind, name }) => ({ kind, name }))
}

// The development database of the owner is never changed by this tool (a session must not: runbook of the owner)
export const PROTECTED_DATABASES: readonly string[] = [DEVELOPMENT_DATABASE_NAME]

// Why a run that CHANGES the database (`run`, `revert`) must not start, or null when it may: the database is not a protected
// one, and the person named it on the command line (`--confirm=<database>`), as `pnpm db:rls:worker-role` asks. Fails closed.
export function refusalToChange(databaseName: string, args: readonly string[]): string | null {
  if (PROTECTED_DATABASES.includes(databaseName)) {
    return `${databaseName} is a protected database: this tool does not change it`
  }
  if (!args.includes(`--confirm=${databaseName}`)) {
    return `to change ${databaseName} add --confirm=${databaseName}`
  }
  return null
}
