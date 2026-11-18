import { execFileSync } from 'node:child_process'

import { repositoryRoot } from './repository-root'

// Whether the suites run with Row-Level Security enforced (TEST_RLS_ENFORCE=1; CI sets it in the job that runs the whole suite as
// platform_app, and `pnpm db:test:prepare` and the replica honor it). The policies themselves arrive with the migrations; this
// is the switch the owner turns (`pnpm db:rls:enforce on`, scripts/rls-enforce.ts), and it is off unless asked for so that a
// laptop database keeps working while the phases land. Read here, like the other variables of the suites.
export function rlsEnforcementRequested(): boolean {
  const value = process.env['TEST_RLS_ENFORCE']
  return value !== undefined && ['1', 'true', 'on'].includes(value.toLowerCase())
}

// Turns enforcement on for the database of `ownerUrl` when it was asked for. It refuses to continue (the script exits 1) if
// platform_app could skip row security, so a database where the suites would prove nothing is an error and not a green run.
export function enforceRlsIfRequested(ownerUrl: string): boolean {
  if (!rlsEnforcementRequested()) return false
  execFileSync('pnpm', ['exec', 'tsx', 'scripts/rls-enforce.ts', 'on'], {
    cwd: repositoryRoot(),
    stdio: 'pipe',
    env: { ...process.env, DIRECT_DATABASE_URL: ownerUrl }
  })
  return true
}
