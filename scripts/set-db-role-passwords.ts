import 'dotenv-flow/config'
import pg from 'pg'

import { loadDbRoleEnv } from './db-role-env'

// Gives platform_app and platform_worker (created NOLOGIN by the raw SQL migration) LOGIN and
// their passwords. Run after `prisma migrate deploy`; safe to run again. Passwords are never in a
// migration.
const env = loadDbRoleEnv()
const roles = [
  { name: 'platform_app', password: env.DB_APP_PASSWORD },
  { name: 'platform_worker', password: env.DB_WORKER_PASSWORD }
] as const

const client = new pg.Client({ connectionString: env.DIRECT_DATABASE_URL })
await client.connect()
try {
  for (const { name, password } of roles) {
    // ALTER ROLE takes no bind parameters: Postgres quotes the identifier and the literal itself
    const { rows } = await client.query<{ statement: string }>(
      "SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS statement",
      [name, password]
    )
    const statement = rows[0]?.statement
    if (statement === undefined) throw new Error(`could not build the statement for ${name}`)
    await client.query(statement)
    console.log(`${name}: LOGIN enabled`)
  }
} finally {
  await client.end()
}
