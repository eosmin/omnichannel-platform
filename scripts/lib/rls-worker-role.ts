import { DatabaseRoles } from '@platform/core/database-testing'

// The role the worker connects as, and the one thing that decides whether row security binds it: BYPASSRLS. Stage E of the RLS plan takes
// the attribute away so that the worker meets the same policies as the api. It is NOT a migration: a migration runs by itself in the
// deploy and would change what the worker sees in production without the owner. The owner changes it with `pnpm db:rls:worker-role`
// (scripts/rls-worker-role.ts) in the order of docs/RLS_ACTIVATION_RUNBOOK.md, and the CI applies it to the database of the job only.
export const WORKER_ROLE = DatabaseRoles.WORKER

export const WORKER_ROLE_MODES = ['status', 'nobypass', 'bypass'] as const
export type WorkerRoleMode = (typeof WORKER_ROLE_MODES)[number]

// The statement of a mode, or null for the one that only reads. `bypass` is the way back of `nobypass`
export function workerRoleStatement(mode: WorkerRoleMode): string | null {
  if (mode === 'nobypass') return `ALTER ROLE ${WORKER_ROLE} NOBYPASSRLS`
  if (mode === 'bypass') return `ALTER ROLE ${WORKER_ROLE} BYPASSRLS`
  return null
}

export interface WorkerRoleRow {
  rolsuper: boolean
  rolbypassrls: boolean
  rolcanlogin?: boolean
}

// Why row security would not bind the worker: what `rls-enforce on` checks before it enforces. A superuser skips it too, whatever the
// attribute says. Undefined when the role is bound
export function workerRoleProblem(row: WorkerRoleRow | undefined): string | undefined {
  if (row === undefined) return `the role ${WORKER_ROLE} is missing`
  const reasons: string[] = []
  if (row.rolbypassrls) reasons.push('has BYPASSRLS')
  if (row.rolsuper) reasons.push('is a superuser')
  return reasons.length === 0 ? undefined : `${WORKER_ROLE} ${reasons.join(' and ')}`
}

// `--confirm=<name of the database>` anywhere in the arguments
export function confirmationOf(args: readonly string[]): string | undefined {
  const flag = args.find(arg => arg.startsWith('--confirm='))
  const value = flag?.slice('--confirm='.length)
  return value === undefined || value === '' ? undefined : value
}

// A mode that changes the role runs only when the person typed the name of the database it is connected to: a command pointed at the
// wrong database (production from a shell that had its URL) stops here. Undefined when it may go on; `status` never needs it
export function confirmProblem(
  mode: WorkerRoleMode,
  confirm: string | undefined,
  database: string
): string | undefined {
  if (workerRoleStatement(mode) === null) return undefined
  if (confirm === undefined) {
    // The name is NOT printed ready to paste: the person reads the host and the databases above and types the name on purpose
    return `${mode} changes the role ${WORKER_ROLE}, which belongs to the whole server: run it again with --confirm=<the name of the database printed above>`
  }
  if (confirm !== database) {
    return `--confirm=${confirm} is not the database this command is connected to ("${database}")`
  }
  return undefined
}

// `bypass` is the way back and only valid once the workers run with the flag off: with WORKER_RLS_CONTEXT=true in the environment of the
// command (the person copied the environment of the workers) it stops, because a worker with the flag ON refuses to start while its role
// skips RLS (a crash loop on the next restart). The runbook order stays the real guard: flag off, restart, then `bypass`
export function flagProblem(
  mode: WorkerRoleMode,
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  if (mode === 'bypass' && env['WORKER_RLS_CONTEXT'] === 'true') {
    return `bypass with WORKER_RLS_CONTEXT=true: the workers would not start. Turn the flag off and restart them first`
  }
  return undefined
}

// True when the role already is as the mode asks: the command says so and changes nothing
export function alreadyAsRequested(mode: WorkerRoleMode, row: WorkerRoleRow): boolean {
  if (mode === 'nobypass') return !row.rolbypassrls
  if (mode === 'bypass') return row.rolbypassrls
  return false
}

// What the owner reads before a mode that changes the role: the role belongs to the whole server, so the change reaches every database
// where it has the CONNECT privilege (the role may not even log in: `rolcanlogin` is printed with the result), not only the one the command is pointed at
export function reachedDatabasesWarning(databases: readonly string[], current: string): string {
  const others = databases.filter(name => name !== current)
  const reach =
    others.length === 0
      ? 'no other database'
      : `${others.length} other database${others.length === 1 ? '' : 's'}: ${others.join(', ')}`
  return `ALTER ROLE ${WORKER_ROLE} affects ALL the databases of this server where it could connect (${databases.length}: ${databases.join(', ') || 'none'}); besides "${current}" it reaches ${reach}`
}

// The sessions of the role, per database of the server (pg_stat_activity is the view of the whole cluster). `visible` is false when the
// role that runs the command may not see the sessions of other roles (only a superuser or a member of pg_read_all_stats does): the
// view then shows them with no name, a count of zero would be a guess and is never read as "no workers"
export interface WorkerConnectionFacts {
  visible: boolean
  connections: { datname: string; count: number }[]
}

interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

const CONNECTIONS_VISIBLE_SQL = `SELECT (rolsuper OR pg_has_role(current_user, 'pg_read_all_stats', 'usage')) AS visible
   FROM pg_roles WHERE rolname = current_user`
// Not its own session, and client sessions only: the autovacuum and replication workers are not the worker of the application
const CONNECTIONS_SQL = `SELECT datname, count(*)::text AS total FROM pg_stat_activity
  WHERE usename = $1 AND pid <> pg_backend_pid() AND backend_type = 'client backend'
  GROUP BY datname ORDER BY datname`

export async function readWorkerConnections(db: Queryable): Promise<WorkerConnectionFacts> {
  const visible = await db.query(CONNECTIONS_VISIBLE_SQL)
  const rows = await db.query(CONNECTIONS_SQL, [WORKER_ROLE])
  return {
    visible: visible.rows[0]?.['visible'] === true,
    connections: rows.rows.map(row => ({
      datname: typeof row['datname'] === 'string' ? row['datname'] : '?',
      count: Number(row['total'])
    }))
  }
}

function totalOf(facts: WorkerConnectionFacts): number {
  return facts.connections.reduce((sum, row) => sum + row.count, 0)
}

function connectionsLine(facts: WorkerConnectionFacts): string {
  const total = totalOf(facts)
  const where = facts.connections.map(row => `${row.datname} (${row.count})`).join(', ')
  return `${total} connection${total === 1 ? '' : 's'}${total === 0 ? '' : `: ${where}`}`
}

// What `status` and every mode print: how many sessions of the role are open right now, so the owner sees whether the workers are stopped
export function connectionsSummary(facts: WorkerConnectionFacts): string {
  if (!facts.visible) {
    return `${WORKER_ROLE} sessions cannot be seen with this role (it is neither a superuser nor a member of pg_read_all_stats)`
  }
  return `${WORKER_ROLE} sessions open now: ${connectionsLine(facts)}`
}

export const FORCE_CONNECTED_FLAG = '--force-connected'

// Only the flag typed out: for the rehearsal in staging, where the workers of another stack may stay connected
export function forceConnectedOf(args: readonly string[]): boolean {
  return args.includes(FORCE_CONNECTED_FLAG)
}

// `nobypass` is the one mode that changes what the running workers see: a worker started with WORKER_RLS_CONTEXT off has no guard, and
// once the role is bound it reads no row and says nothing. So it runs only when no session of the role is open, and when the sessions
// cannot be seen it does not take zero for an answer. Undefined when it may go on
export function connectionsProblem(
  mode: WorkerRoleMode,
  facts: WorkerConnectionFacts,
  force: boolean
): string | undefined {
  if (mode !== 'nobypass' || force) return undefined
  if (!facts.visible) {
    return `the sessions of ${WORKER_ROLE} cannot be seen: run it with a superuser or a member of pg_read_all_stats, or stop the workers, check by hand and use ${FORCE_CONNECTED_FLAG}`
  }
  if (totalOf(facts) === 0) return undefined
  return `${connectionsLine(facts)} of ${WORKER_ROLE} are open: stop the workers and let their queues drain, then run it again (${FORCE_CONNECTED_FLAG} only to rehearse)`
}

const LOCAL_NAMES: ReadonlySet<string> = new Set(['localhost', '::1', '[::1]'])
const LOOPBACK_V4 = /^127(\.\d{1,3}){3}$/

// A host that is this machine: empty (the default socket), a unix socket directory, localhost, or a loopback address. Case and a final
// dot do not change the name
export function isLocalHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/\.$/, '')
  return name === '' || name.startsWith('/') || LOCAL_NAMES.has(name) || LOOPBACK_V4.test(name)
}

export const ALLOW_HOST_FLAG = '--allow-host='

// `--allow-host=<host>` anywhere in the arguments
export function allowedHostOf(args: readonly string[]): string | undefined {
  const flag = args.find(arg => arg.startsWith(ALLOW_HOST_FLAG))
  const value = flag?.slice(ALLOW_HOST_FLAG.length)
  return value === undefined || value === '' ? undefined : value
}

// A mode that changes the role runs against a host that is not this machine only when the person typed that host out: `--confirm` names
// a database, and a database of the same name exists in staging and in production. Undefined when it may go on
export function hostProblem(
  mode: WorkerRoleMode,
  host: string,
  allowed: string | undefined
): string | undefined {
  if (workerRoleStatement(mode) === null || isLocalHost(host)) return undefined
  if (allowed === undefined) {
    return `the host ${host} is not this machine: run it again with ${ALLOW_HOST_FLAG}<the host printed above> after reading it`
  }
  if (allowed !== host)
    return `${ALLOW_HOST_FLAG}${allowed} is not the host this command is connected to ("${host}")`
  return undefined
}

// The databases of the server where the role has the CONNECT privilege (what `ALTER ROLE` reaches); the script and its integration spec
// run this same query
export async function readReachedDatabases(db: Queryable): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT datname FROM pg_database
      WHERE NOT datistemplate AND has_database_privilege($1, oid, 'CONNECT') ORDER BY datname`,
    [WORKER_ROLE]
  )
  return rows.map(row => String(row['datname']))
}
