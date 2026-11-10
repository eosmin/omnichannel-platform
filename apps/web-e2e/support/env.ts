import { resolve } from 'node:path'

import { config } from 'dotenv-flow'

import { connectionUrls, isCiRun } from '@platform/core/database-testing'

// The base is the one of the integration suites and of CI: the laptop's .env.local first, then
// .env.example for what is missing. A variable already set is never replaced, so the shell wins.
config({ path: resolve(import.meta.dirname, '../../..'), pattern: '.env.local', silent: true })
config({ path: resolve(import.meta.dirname, '../../..'), pattern: '.env.example', silent: true })

// The servers the specs start inherit this env: a replica of the development database must not reach them
delete process.env['DATABASE_REPLICA_URL']

export const isCi = isCiRun()

// The slice of the suite this run owns, `E2E_SHARD=2/4`: CI runs each slice in its own job, with its own database,
// mailbox and queues, so the specs never share state across slices. Not set, the whole suite runs. A malformed value
// stops the run instead of silently running everything (or nothing).
const shardMatch = /^(\d+)\/(\d+)$/.exec(process.env['E2E_SHARD'] ?? '')
if (
  process.env['E2E_SHARD'] !== undefined &&
  process.env['E2E_SHARD'] !== '' &&
  shardMatch === null
) {
  throw new Error(`E2E_SHARD must look like 2/4, got "${process.env['E2E_SHARD']}"`)
}
export const shard =
  shardMatch === null ? undefined : { current: Number(shardMatch[1]), total: Number(shardMatch[2]) }
if (shard !== undefined && (shard.total < 1 || shard.current < 1 || shard.current > shard.total)) {
  throw new Error(`E2E_SHARD must have 1 <= slice <= total, got "${process.env['E2E_SHARD']}"`)
}

// A server that is already listening on the ports of the specs is used only when the person says so:
// on a laptop it is usually `pnpm dev`, connected to the development database (playwright.shared.ts)
export const reuseExistingServers = !isCi && process.env['E2E_REUSE_SERVERS'] === '1'

// The addresses of .env.example: the web app must be at FRONTEND_URL and the api at API_URL, because
// the cookie of the session and the CORS list are built from them
export const WEB_URL = 'http://localhost:3000'
export const API_URL = 'http://localhost:8080'
export const WORKER_PORT = 8081
// The bucket the browser puts files on, from .env.example
export const STORAGE_URL = process.env['S3_ENDPOINT'] ?? 'http://localhost:8333'
export const MAILPIT_URL = 'http://localhost:8025'

// The file GitHub shows as the summary of a run; unset on a laptop
export const githubStepSummary = process.env['GITHUB_STEP_SUMMARY']

// Each service connects with its own role, as it does where it is deployed
export const databaseUrls = connectionUrls()

const encryptionKey = process.env['CREDENTIALS_ENCRYPTION_KEY']
if (encryptionKey === undefined || encryptionKey === '') {
  throw new Error('CREDENTIALS_ENCRYPTION_KEY is required to load the fixtures (see .env.example)')
}
export const credentialsEncryptionKey = encryptionKey

// The fake Graph API that the api and the worker call in place of graph.facebook.com
// (META_GRAPH_ORIGIN, set in playwright.shared.ts); the spec of the templates serves it
export const GRAPH_PORT = 8099
export const GRAPH_HOST = '127.0.0.1'
export const GRAPH_URL = `http://${GRAPH_HOST}:${GRAPH_PORT}`
