import type { PlaywrightTestConfig } from '@playwright/test'

import { LOCALE_COOKIE } from '@platform/api-client'
import { InfraRoutes } from '@platform/core/api'
import { Locales } from '@platform/core/i18n'

import {
  API_URL,
  databaseUrls,
  GRAPH_URL,
  reuseExistingServers,
  WEB_URL,
  WORKER_PORT
} from './support/env'

const STARTUP_TIMEOUT_MS = 120_000
const ROOT = '../..'

// The three services run as they do where they are deployed: the bundles that `nx build` writes.
//
// A server that is already up is NOT reused unless E2E_REUSE_SERVERS=1: the one on a laptop is
// usually the owner's `pnpm dev`, connected to the development database, and the specs would write
// their fixtures and their stores to it through that server. With the flag set, the servers must have
// been started with the test database (`pnpm db:test:prepare`, TEST_DATABASE_NAME) and with
// META_GRAPH_ORIGIN pointing at the fake Graph of the templates spec (support/fake-graph.ts).
export const webServer: Extract<PlaywrightTestConfig['webServer'], unknown[]> = [
  {
    name: 'api',
    command: 'node dist/apps/api/main.js',
    cwd: ROOT,
    url: `${API_URL}${InfraRoutes.healthLive}`,
    timeout: STARTUP_TIMEOUT_MS,
    reuseExistingServer: reuseExistingServers,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrls.app,
      TRUST_PROXY_HOPS: '1',
      META_GRAPH_ORIGIN: GRAPH_URL
    }
  },
  {
    name: 'worker',
    command: 'node dist/apps/worker/main.js',
    cwd: ROOT,
    url: `http://localhost:${WORKER_PORT}${InfraRoutes.healthLive}`,
    timeout: STARTUP_TIMEOUT_MS,
    reuseExistingServer: reuseExistingServers,
    env: {
      NODE_ENV: 'test',
      APP_ROLE: 'worker',
      PORT: String(WORKER_PORT),
      DATABASE_URL: databaseUrls.worker,
      META_GRAPH_ORIGIN: GRAPH_URL
    }
  },
  {
    name: 'web',
    command: 'pnpm exec next start --port 3000',
    cwd: `${ROOT}/apps/web`,
    url: WEB_URL,
    timeout: STARTUP_TIMEOUT_MS,
    reuseExistingServer: reuseExistingServers,
    env: { NODE_ENV: 'production' }
  }
]

// The default locale of the app is Spanish; the specs read the English messages
export const englishLocaleCookie = {
  name: LOCALE_COOKIE,
  value: Locales.EN,
  domain: new URL(WEB_URL).hostname,
  path: '/',
  expires: -1,
  httpOnly: false,
  secure: false,
  sameSite: 'Lax' as const
}

export const englishLocale = { cookies: [englishLocaleCookie], origins: [] }
