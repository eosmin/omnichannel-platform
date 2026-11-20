import { execFileSync } from 'node:child_process'

import { repositoryRoot } from './repository-root'

// Whether the suites run with Row-Level Security enforced (TEST_RLS_ENFORCE=1; CI sets it in the job that runs the whole suite as
// platform_app, and `pnpm db:test:prepare` honors it). The policies themselves arrive with the migrations; this is the switch the
// owner turns (`pnpm db:rls:enforce`, scripts/rls-enforce.ts). Read here, like the other variables of the suites.
export function rlsEnforcementRequested(): boolean {
  const value = process.env['TEST_RLS_ENFORCE']
  return value !== undefined && ['1', 'true', 'on'].includes(value.toLowerCase())
}

// Whether the run binds the worker like the api (WORKER_RLS_CONTEXT=true, stage E): the role platform_worker has no BYPASSRLS and the
// jobs open their contexts. The role is changed by `pnpm db:rls:worker-role nobypass`, never from here: a role belongs to the whole
// server (not to one database), and `db:test:prepare` shares its server with platform_dev, whose worker would lose its bypass too. In CI
// the step of the enforced jobs changes it on the server of the job; on a laptop the person runs it by hand, knowing that. The
// enforced run sets this flag together with TEST_RLS_ENFORCE; the role specs read it from here
export function workerRoleBoundInSuites(): boolean {
  return process.env['WORKER_RLS_CONTEXT'] === 'true'
}

// Puts the database of `ownerUrl` in the state the run asked for: enforced with TEST_RLS_ENFORCE, not enforced without it, so that a
// database a previous run left enforced does not stay so while the log says it is not. The script refuses `on` when platform_app OR
// platform_worker could skip row security (the script exits 1, and its message says to run `pnpm db:rls:worker-role nobypass`, which
// changes a role of the whole server: on a laptop the person decides that by hand), so a database where the suites would prove nothing is an error and not a green run.
// Its own output is shown: it says which table it could not switch.
export function applyRlsEnforcement(ownerUrl: string): 'on' | 'off' {
  const mode = rlsEnforcementRequested() ? 'on' : 'off'
  execFileSync('pnpm', ['exec', 'tsx', 'scripts/rls-enforce.ts', mode], {
    cwd: repositoryRoot(),
    stdio: 'inherit',
    env: { ...process.env, DIRECT_DATABASE_URL: ownerUrl }
  })
  return mode
}
