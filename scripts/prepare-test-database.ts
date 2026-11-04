import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import { config } from 'dotenv-flow'
import pg from 'pg'

import {
  DatabaseRoles,
  isCiRun,
  TEST_DATABASE_NAME,
  testOwnerUrl
} from '@platform/core/database-testing'

// Creates the database the integration, security and e2e suites write to, and migrates it. It sits
// in the same Postgres as the development one and never touches that one: the only statements are
// a CREATE DATABASE of the test database and the migrations run against it.
//
// The laptop's .env.local first, then .env.example for what is missing; a variable already set is
// never replaced. Safe to run again: it creates the database only when it is missing and
// `prisma migrate deploy` applies only the migrations that are pending.
const root = resolve(import.meta.dirname, '..')
config({ path: root, pattern: '.env.local', silent: true })
config({ path: root, pattern: '.env.example', silent: true })

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/

// CI starts from an empty database of its own and migrates it (`pnpm db:migrate`)
if (isCiRun()) throw new Error('db:test:prepare is for a laptop, not for CI')

const ownerUrl = testOwnerUrl()
const target = new URL(ownerUrl)
const databaseName = decodeURIComponent(target.pathname.slice(1))
const directUrl = process.env['DIRECT_DATABASE_URL']
const developmentName =
  directUrl === undefined || directUrl === ''
    ? undefined
    : decodeURIComponent(new URL(directUrl).pathname.slice(1))

if (!LOCAL_HOSTS.has(target.hostname)) {
  throw new Error(`db:test:prepare only runs against a local server, not ${target.hostname}`)
}
if (!DATABASE_NAME.test(databaseName)) {
  throw new Error(`"${databaseName}" is not a database name this script will create`)
}
// A test database that is the development one would be migrated and then written to by the suites
if (databaseName === developmentName) {
  throw new Error(
    `the test database (${databaseName}) is the one DIRECT_DATABASE_URL points at: ` +
      `use another name in TEST_DATABASE_URL, or leave it unset to get ${TEST_DATABASE_NAME}`
  )
}

// CREATE DATABASE cannot run inside the database it creates: connect to the maintenance one
const maintenance = new URL(ownerUrl)
maintenance.pathname = '/postgres'
const client = new pg.Client({ connectionString: maintenance.toString() })
await client.connect()
try {
  const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    databaseName
  ])
  if (existing.rowCount === 0) {
    // CREATE DATABASE takes no bind parameters: Postgres quotes the identifier itself
    const { rows } = await client.query<{ statement: string }>(
      "SELECT format('CREATE DATABASE %I', $1::text) AS statement",
      [databaseName]
    )
    const statement = rows[0]?.statement
    if (statement === undefined) throw new Error('could not build the CREATE DATABASE statement')
    await client.query(statement)
    console.log(`${databaseName}: created`)
  } else {
    console.log(`${databaseName}: already exists`)
  }

  // platform_app and platform_worker belong to the server, not to a database, and they get their
  // passwords from `pnpm db:migrate` on the development database: this script does not set them
  const roles = await client.query<{ rolname: string }>(
    'SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) AND rolcanlogin',
    [[DatabaseRoles.APP, DatabaseRoles.WORKER]]
  )
  const missing = [DatabaseRoles.APP, DatabaseRoles.WORKER].filter(
    name => !roles.rows.some(row => row.rolname === name)
  )
  if (missing.length > 0) {
    console.warn(
      `${missing.join(', ')} cannot log in yet: run \`pnpm db:migrate\` once for the development ` +
        'database (it gives the roles their passwords), then run this again'
    )
  }
} finally {
  await client.end()
}

console.log(`${databaseName}: applying migrations`)
execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, DIRECT_DATABASE_URL: ownerUrl }
})
console.log(`${databaseName}: ready`)
