import 'dotenv-flow/config'
import { argv, exit } from 'node:process'

import pg from 'pg'

import { loadOwnerDatabaseUrl } from './db-role-env'
import { WORKER_ROLE } from './lib/rls-worker-role'

// Turns Row-Level Security enforcement on or off for every table that has its policy (rls_set_enforcement, migration
// 20270119100000_rls_foundation). Run by the OWNER of the database, over DIRECT_DATABASE_URL: the application roles cannot
// execute it. Idempotent and safe to run again, which is also what finishes a run that stopped on a lock timeout.
//
//   pnpm db:rls:enforce status   what is protected right now (default)
//   pnpm db:rls:enforce on       ENABLE and FORCE row security on every table with a policy; refuses to run when
//                                platform_app or platform_worker could skip it (BYPASSRLS or superuser): the worker loses its
//                                bypass first, with `pnpm db:rls:worker-role nobypass`
//   pnpm db:rls:enforce off      the way back: NO FORCE and DISABLE on all of them (one statement per table, about a second)
//
// Order of a rollout: CI database first (the job that runs the whole suite as platform_app), production when the owner decides.
// A new table gets its policy in a migration; run `on` again after the deploy so that the table is enabled too.
const MODES = ['status', 'on', 'off'] as const
type Mode = (typeof MODES)[number]

const requested = argv[2] ?? 'status'
const mode = MODES.find(candidate => candidate === requested)
if (mode === undefined) {
  console.error(`unknown mode "${requested}": use ${MODES.join(', ')}`)
  exit(2)
}

const url = loadOwnerDatabaseUrl()
if (url === undefined) {
  console.error('DIRECT_DATABASE_URL (the owner of the database) is required and must be a URL')
  exit(2)
}

interface StatusRow {
  table_name: string
  enabled: boolean
  forced: boolean
  policies: number
}

// Why a role ($1) could skip row security even though its own row says it cannot: it owns a table (the owner is never bound
// without FORCE, and the _owner policy opens it), or it is a member of a role that is a superuser or has BYPASSRLS. Asked for the api
// (platform_app) and for the worker (platform_worker, stage E: the worker meets the same policies once they are enforced)
const BYPASS_PROBLEMS = `
  SELECT 'role' AS kind, r.rolname AS name, (r.rolsuper OR r.rolbypassrls) AS bad
    FROM pg_roles r WHERE r.rolname = $1
  UNION ALL
  SELECT 'member of', g.rolname, true
    FROM pg_roles me
    JOIN pg_auth_members m ON m.member = me.oid
    JOIN pg_roles g ON g.oid = m.roleid
    WHERE me.rolname = $1 AND (g.rolsuper OR g.rolbypassrls)
  UNION ALL
  SELECT 'owns table', c.relname, true
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = $1`
const BOUND_ROLES = ['platform_app', WORKER_ROLE] as const

// One call per table, each its own transaction: a table that times out on its lock rolls back alone and the tables before it
// stay as they are, with no lock held while the next one waits. A table that fails is retried at the end, and the run fails
// (exit code 1) if any is still not done.
async function switchTables(client: pg.Client, on: boolean): Promise<number> {
  const { rows } = await client.query<{ table_name: string; enabled: boolean; forced: boolean }>(
    'SELECT table_name, enabled, forced FROM rls_status ORDER BY table_name'
  )
  const todo = rows.filter(row => (on ? !(row.enabled && row.forced) : row.enabled || row.forced))
  let changed = 0
  let failed: string[] = todo.map(row => row.table_name)
  for (let attempt = 0; attempt < 3 && failed.length > 0; attempt += 1) {
    const stillFailing: string[] = []
    for (const table of failed) {
      try {
        await client.query('SELECT rls_set_enforcement($1::boolean, ARRAY[$2]::text[])', [
          on,
          table
        ])
        changed += 1
      } catch (error) {
        console.error(`${table}: ${error instanceof Error ? error.message : String(error)}`)
        stillFailing.push(table)
      }
    }
    failed = stillFailing
  }
  if (failed.length > 0) {
    console.error(`not switched (run it again): ${failed.join(', ')}`)
    process.exitCode = 1
  }
  return changed
}

async function run(selected: Mode): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const target = new URL(url ?? '')
    console.log(`database ${decodeURIComponent(target.pathname.slice(1))} on ${target.hostname}`)
    if (selected === 'on') {
      for (const role of BOUND_ROLES) {
        const { rows } = await client.query<{ kind: string; name: string; bad: boolean }>(
          BYPASS_PROBLEMS,
          [role]
        )
        const problems = rows.filter(row => row.bad)
        if (!rows.some(row => row.kind === 'role') || problems.length > 0) {
          const fix =
            role === WORKER_ROLE && rows.some(row => row.kind === 'role')
              ? ' Take its bypass away first (the role belongs to the whole server): pnpm db:rls:worker-role nobypass --confirm=<database>.'
              : ''
          console.error(
            `row security would not bind ${role} (${
              problems.map(row => `${row.kind} ${row.name}`).join(', ') || 'the role is missing'
            }). Nothing changed.${fix}`
          )
          process.exitCode = 1
          return
        }
      }
    }
    if (selected !== 'status') {
      console.log(`${selected}: ${await switchTables(client, selected === 'on')} tables changed`)
    }
    const { rows } = await client.query<StatusRow>(
      'SELECT table_name, enabled, forced, policies FROM rls_status ORDER BY table_name'
    )
    const enforced = rows.filter(row => row.enabled && row.forced).length
    for (const row of rows.filter(entry => !(entry.enabled && entry.forced))) {
      console.log(`not enforced: ${row.table_name} (enabled=${row.enabled}, forced=${row.forced})`)
    }
    console.log(`${enforced} of ${rows.length} tables with a policy are enforced`)
  } finally {
    await client.end()
  }
}

await run(mode)
