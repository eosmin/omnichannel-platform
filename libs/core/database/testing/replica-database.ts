import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import pg from 'pg'

import { connectionUrls } from './connection-urls'

const REPLICA_SUFFIX = '_replica'
const MAX_IDENTIFIER_BYTES = 63
const DUPLICATE_DATABASE = '42P04'
const ROOT = resolve(__dirname, '../../../..')

function inReplica(url: string, name: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${name}${REPLICA_SUFFIX}`
  return parsed.toString()
}

// A second database that plays the read replica of the suites: it is not fed by replication (the two are told apart on
// purpose, so that a test can tell which one answered), it only has the same schema and the same roles. It sits beside the
// test database and is named after it (`<test database>_replica`), so two runs on one server that use different test
// databases never share it.
export function replicaUrls(): { owner: string; app: string } {
  const urls = connectionUrls()
  const name = decodeURIComponent(new URL(urls.owner).pathname.slice(1))
  return { owner: inReplica(urls.owner, name), app: inReplica(urls.app, name) }
}

// Creates the replica database when it is missing and brings it to the schema of the migrations (a no-op when it is
// current). Safe to run again. The roles belong to the server, so platform_app signs in to it with the password it has.
export async function ensureReplicaDatabase(): Promise<{ owner: string; app: string }> {
  const urls = replicaUrls()
  const target = decodeURIComponent(new URL(urls.owner).pathname.slice(1))
  // Postgres cuts a longer name without a word, and the check below would then never find it again
  if (Buffer.byteLength(target) > MAX_IDENTIFIER_BYTES) {
    throw new Error(`${target} is too long for a database name: use a shorter TEST_DATABASE_URL`)
  }
  const maintenance = new URL(urls.owner)
  maintenance.pathname = '/postgres'
  const client = new pg.Client({ connectionString: maintenance.toString() })
  await client.connect()
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [target])
    if (existing.rowCount === 0) {
      // CREATE DATABASE takes no bind parameters: Postgres quotes the identifier itself
      const { rows } = await client.query<{ statement: string }>(
        "SELECT format('CREATE DATABASE %I', $1::text) AS statement",
        [target]
      )
      const statement = rows[0]?.statement
      if (statement === undefined) throw new Error('could not build the CREATE DATABASE statement')
      try {
        await client.query(statement)
      } catch (error) {
        // Another worker of the run created it between the check and here
        if ((error as { code?: string }).code !== DUPLICATE_DATABASE) throw error
      }
    }
  } finally {
    await client.end()
  }
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: ROOT,
    // Quiet when it works; when it fails, the error carries what prisma said
    stdio: 'pipe',
    env: { ...process.env, DIRECT_DATABASE_URL: urls.owner }
  })
  return urls
}
