// The three connections the integration suites use, built from the variables the CI job and
// .env.example already define. Read only here: the suites themselves never touch process.env.
//
// WHICH DATABASE. The suites write rows (and the sweeps of the worker touch rows of any store), so
// they must never share the database the owner uses by hand:
//   1. TEST_DATABASE_URL, the owner URL of a database of your choice, wins.
//   2. In CI (CI=true; see isCiRun) DIRECT_DATABASE_URL is used as it is: the job has its own.
//   3. Anywhere else, DIRECT_DATABASE_URL with its database replaced by TEST_DATABASE_NAME, which
//      `pnpm db:test:prepare` creates and migrates beside the development one.
//
// WHICH SERVER THE APP TALKS TO. The owner always connects straight to Postgres (it sets data up and
// is what migrations use). The api and the worker run as platform_app and platform_worker through
// PgBouncer in production, so TEST_POOLER_URL (for example postgresql://localhost:6432) sends their
// two URLs through it: the same suites then prove that the transaction-local settings, the row locks
// and the advisory locks hold in transaction pooling (TDD_08 section 2.6). Without it they connect
// directly, as before.
export const TEST_DATABASE_NAME = 'platform_test'
// The database docker-compose.yml creates and `.env.example` points at: the one a person works in
export const DEVELOPMENT_DATABASE_NAME = 'platform_dev'

// The roles of the api and of the worker, and the read only one of the replica (created by the raw SQL migrations)
export const DatabaseRoles = {
  APP: 'platform_app',
  WORKER: 'platform_worker',
  REPLICA: 'platform_replica_ro'
} as const

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

// The admin console of PgBouncer is a database of its own, and the monitoring role reads SHOW POOLS there
export const PoolerAdmin = { DATABASE: 'pgbouncer', USER: 'pgbouncer' } as const
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// The pooler the suites go through, or undefined for a direct connection. Only a local one: the
// suites write rows, and a variable left in a shell must not send them to a shared server
export function poolerUrl(): URL | undefined {
  const value = process.env['TEST_POOLER_URL']
  if (value === undefined || value === '') return undefined
  const parsed = new URL(value)
  // Without a port the app URLs would fall back to 5432 and go straight to Postgres while the suites say they use the pooler
  if (parsed.port === '')
    throw new Error(
      'TEST_POOLER_URL needs the port of PgBouncer (for example postgresql://localhost:6432)'
    )
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`TEST_POOLER_URL must be a local PgBouncer, not ${parsed.hostname}`)
  }
  return parsed
}

function throughPooler(url: string): string {
  const pooler = poolerUrl()
  if (pooler === undefined) return url
  const parsed = new URL(url)
  parsed.hostname = pooler.hostname
  parsed.port = pooler.port
  return parsed.toString()
}

// The admin console, for a test that reads SHOW POOLS. The password is the one of the auth_user that
// docker-compose.yml and .env.example name
export function poolerAdminUrl(): string {
  const pooler = poolerUrl()
  if (pooler === undefined) throw new Error('TEST_POOLER_URL is required to read the pooler')
  const admin = new URL(pooler.toString())
  admin.username = PoolerAdmin.USER
  admin.password = required('PGBOUNCER_AUTH_PASSWORD')
  admin.pathname = `/${PoolerAdmin.DATABASE}`
  return admin.toString()
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
    app: throughPooler(asRole(owner, DatabaseRoles.APP, required('DB_APP_PASSWORD'))),
    worker: throughPooler(asRole(owner, DatabaseRoles.WORKER, required('DB_WORKER_PASSWORD')))
  }
}

// The URL of the read only replica role (DATABASE_REPLICA_URL in a deployment), straight to Postgres. Needs DB_REPLICA_PASSWORD,
// which only the suites that prove the guarantee of the replica require
export function replicaConnectionUrl(): string {
  return asRole(testOwnerUrl(), DatabaseRoles.REPLICA, required('DB_REPLICA_PASSWORD'))
}
