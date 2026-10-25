import { resolve } from 'node:path'

import { config } from 'dotenv-flow'

import { connectionUrls } from '@platform/core/database-testing'

// Runs before any suite (jest setupFiles), because the app reads its env when it is imported.
//
// The base is the same as the integration suites and the images of CI use: the laptop's .env.local
// first, then .env.example for what is missing. A variable that is already set is never replaced,
// so the shell, and CI, win over both.
config({ path: resolve(__dirname, '../..'), pattern: '.env.local', silent: true })
config({ path: resolve(__dirname, '../..'), pattern: '.env.example', silent: true })

// The app under test connects as platform_app, the role the api runs with, and directly to
// Postgres (no PgBouncer). It must not be able to do more than the real api can.
process.env['NODE_ENV'] = 'test'
process.env['DATABASE_URL'] = connectionUrls().app
delete process.env['DATABASE_REPLICA_URL']
// One proxy in front, so that each request can come from an address of its own: the rate limit is
// counted in a Redis that every run shares
process.env['TRUST_PROXY_HOPS'] = '1'

// The suites write as the owner of the database. A DIRECT_DATABASE_URL left in the shell that points
// at a shared or production server must stop the run, not receive its rows.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const databaseHost = new URL(connectionUrls().owner).hostname
if (!LOCAL_HOSTS.has(databaseHost)) {
  throw new Error(`the security suite only runs against a local database, not ${databaseHost}`)
}
