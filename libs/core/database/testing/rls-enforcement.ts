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
// jobs open their contexts. The enforced run sets it together with TEST_RLS_ENFORCE; the role specs read it from here
export function workerRoleBoundInSuites(): boolean {
  return process.env['WORKER_RLS_CONTEXT'] === 'true'
}

// The worker role goes with the enforcement on the database of a suite (`pnpm db:rls:worker-role`, scripts/rls-worker-role.ts): bound when
// enforced, as it was created when not. A database of the suites only (the suites refuse a host that is not local); the owner never
// runs this on a real one, where the runbook changes the role by hand
function applyWorkerRole(ownerUrl: string, mode: 'nobypass' | 'bypass'): void {
  const database = decodeURIComponent(new URL(ownerUrl).pathname.slice(1))
  execFileSync(
    'pnpm',
    ['exec', 'tsx', 'scripts/rls-worker-role.ts', mode, `--confirm=${database}`],
    {
      cwd: repositoryRoot(),
      stdio: 'inherit',
      env: { ...process.env, DIRECT_DATABASE_URL: ownerUrl }
    }
  )
}

// Puts the database of `ownerUrl` in the state the run asked for: enforced with TEST_RLS_ENFORCE, not enforced without it, so that a
// database a previous run left enforced does not stay so while the log says it is not. The script refuses `on` when platform_app
// could skip row security (the script exits 1), so a database where the suites would prove nothing is an error and not a green run.
// Its own output is shown: it says which table it could not switch.
export function applyRlsEnforcement(ownerUrl: string): 'on' | 'off' {
  const mode = rlsEnforcementRequested() ? 'on' : 'off'
  // `on` refuses while the worker can skip row security, so the worker is bound first; `off` gives it back after
  if (mode === 'on') applyWorkerRole(ownerUrl, 'nobypass')
  execFileSync('pnpm', ['exec', 'tsx', 'scripts/rls-enforce.ts', mode], {
    cwd: repositoryRoot(),
    stdio: 'inherit',
    env: { ...process.env, DIRECT_DATABASE_URL: ownerUrl }
  })
  if (mode === 'off') applyWorkerRole(ownerUrl, 'bypass')
  return mode
}
