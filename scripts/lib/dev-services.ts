import { DatabaseRoles } from '../../libs/core/database/testing/connection-urls'
import { AppRoles } from '../../libs/core/platform/config/env-schema'

// What `pnpm dev` changes in the env of each service. The api and the worker share one .env.local on
// a laptop (the file says so), so the worker must be told what makes it a worker.
export const DevService = { API: 'api', WORKER: 'worker' } as const
export type DevServiceName = (typeof DevService)[keyof typeof DevService]

export const WORKER_DEV_PORT = '8081'

type Env = Readonly<Record<string, string | undefined>>

function required(env: Env, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is required to start the worker (see .env.example)`)
  }
  return value
}

// The same database and pooler as the api, connected as the role of the worker
function workerDatabaseUrl(env: Env): string {
  const base = required(env, 'DATABASE_URL')
  const password = required(env, 'DB_WORKER_PASSWORD')
  let parsed: URL
  try {
    parsed = new URL(base)
  } catch {
    // The URL itself is not echoed: it carries a password
    throw new Error('DATABASE_URL is not a valid URL')
  }
  parsed.username = DatabaseRoles.WORKER
  parsed.password = password
  return parsed.toString()
}

// An empty WORKER_PORT (a line `WORKER_PORT=` in the env file) is unset, as every other variable here
function workerPort(env: Env): string {
  const port = env['WORKER_PORT']
  return port === undefined || port === '' ? WORKER_DEV_PORT : port
}

export function devServiceEnv(service: DevServiceName, env: Env): Record<string, string> {
  if (service === DevService.API) return {}
  return {
    APP_ROLE: AppRoles.WORKER,
    PORT: workerPort(env),
    DATABASE_URL: workerDatabaseUrl(env)
  }
}
