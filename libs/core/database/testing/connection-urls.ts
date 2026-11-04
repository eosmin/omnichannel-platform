// The three connections the integration suites use, built from the variables the CI job and
// .env.example already define. Read only here: the suites themselves never touch process.env.
//
// WHICH DATABASE. The suites write rows (and the sweeps of the worker touch rows of any store), so
// they must never share the database the owner uses by hand:
//   1. TEST_DATABASE_URL, the owner URL of a database of your choice, wins.
//   2. In CI (CI=true; see isCiRun) DIRECT_DATABASE_URL is used as it is: the job has its own.
//   3. Anywhere else, DIRECT_DATABASE_URL with its database replaced by TEST_DATABASE_NAME, which
//      `pnpm db:test:prepare` creates and migrates beside the development one.
export const TEST_DATABASE_NAME = 'platform_test'
// The database docker-compose.yml creates and `.env.example` points at: the one a person works in
export const DEVELOPMENT_DATABASE_NAME = 'platform_dev'

// The roles of the api and of the worker (created by the raw SQL migration)
export const DatabaseRoles = { APP: 'platform_app', WORKER: 'platform_worker' } as const

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is required for the integration tests (see .env.example)`)
  }
  return value
}

function asRole(url: string, role: string, password: string): string {
  const parsed = new URL(url)
  parsed.username = role
  parsed.password = password
  return parsed.toString()
}

function inTestDatabase(url: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${TEST_DATABASE_NAME}`
  return parsed.toString()
}

// CI sets CI=true. An empty value or "false"/"0" (a laptop that exports CI=false) is not a CI run, and
// taking it for one would point the suites at the development database
export function isCiRun(): boolean {
  const value = process.env['CI']
  return value !== undefined && !['', '0', 'false'].includes(value.toLowerCase())
}

function resolveOwnerUrl(): string {
  const explicit = process.env['TEST_DATABASE_URL']
  if (explicit !== undefined && explicit !== '') return explicit
  const direct = required('DIRECT_DATABASE_URL')
  return isCiRun() ? direct : inTestDatabase(direct)
}

// Fails closed: whatever the rules above produced, a suite never writes to the database a person works
// in. It catches CI=true exported on a laptop, which the rules take for a CI run.
export function testOwnerUrl(): string {
  const url = resolveOwnerUrl()
  if (decodeURIComponent(new URL(url).pathname.slice(1)) === DEVELOPMENT_DATABASE_NAME) {
    throw new Error(
      `the suites would write to ${DEVELOPMENT_DATABASE_NAME}, the development database: unset CI ` +
        `or TEST_DATABASE_URL, and run pnpm db:test:prepare to get ${TEST_DATABASE_NAME}`
    )
  }
  return url
}

export function connectionUrls(): { owner: string; app: string; worker: string } {
  const owner = testOwnerUrl()
  return {
    owner,
    app: asRole(owner, DatabaseRoles.APP, required('DB_APP_PASSWORD')),
    worker: asRole(owner, DatabaseRoles.WORKER, required('DB_WORKER_PASSWORD'))
  }
}
