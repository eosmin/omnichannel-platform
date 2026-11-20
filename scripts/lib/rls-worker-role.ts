// The role the worker connects as, and the one thing that decides whether row security binds it: BYPASSRLS. Stage E of the RLS plan takes
// the attribute away so that the worker meets the same policies as the api. It is NOT a migration: a migration runs by itself in the
// deploy and would change what the worker sees in production without the owner. The owner changes it with `pnpm db:rls:worker-role`
// (scripts/rls-worker-role.ts) in the order of docs/RLS_ACTIVATION_RUNBOOK.md, and the CI applies it to the database of the job only.
export const WORKER_ROLE = 'platform_worker'

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
