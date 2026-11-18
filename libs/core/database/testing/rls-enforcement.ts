import { execFileSync } from 'node:child_process'

import { repositoryRoot } from './repository-root'

// Whether the suites run with Row-Level Security enforced (TEST_RLS_ENFORCE=1; CI sets it in the job that runs the whole suite as
// platform_app, and `pnpm db:test:prepare` honors it). The policies themselves arrive with the migrations; this is the switch the
// owner turns (`pnpm db:rls:enforce`, scripts/rls-enforce.ts). Read here, like the other variables of the suites.
export function rlsEnforcementRequested(): boolean {
  const value = process.env['TEST_RLS_ENFORCE']
  return value !== undefined && ['1', 'true', 'on'].includes(value.toLowerCase())
}

// Puts the database of `ownerUrl` in the state the run asked for: enforced with TEST_RLS_ENFORCE, not enforced without it, so that a
// database a previous run left enforced does not stay so while the log says it is not. The script refuses `on` when platform_app
// could skip row security (the script exits 1), so a database where the suites would prove nothing is an error and not a green run.
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
