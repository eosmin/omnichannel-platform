import { resolve } from 'node:path'

import { config } from 'dotenv-flow'

import { connectionUrls } from '@platform/core/database-testing'

// The base is the one of the integration suites and of CI: the laptop's .env.local first, then
// .env.example for what is missing. A variable already set is never replaced, so the shell wins.
config({ path: resolve(import.meta.dirname, '../../..'), pattern: '.env.local', silent: true })
config({ path: resolve(import.meta.dirname, '../../..'), pattern: '.env.example', silent: true })

export const isCi = process.env['CI'] !== undefined

// The addresses of .env.example: the web app must be at FRONTEND_URL and the api at API_URL, because
// the cookie of the session and the CORS list are built from them
export const WEB_URL = 'http://localhost:3000'
export const API_URL = 'http://localhost:8080'
export const WORKER_PORT = 8081
// The bucket the browser puts files on, from .env.example
export const STORAGE_URL = process.env['S3_ENDPOINT'] ?? 'http://localhost:8333'
export const MAILPIT_URL = 'http://localhost:8025'

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
