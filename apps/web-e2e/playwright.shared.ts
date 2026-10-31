import type { PlaywrightTestConfig } from '@playwright/test'

import { LOCALE_COOKIE } from '@platform/api-client'
import { InfraRoutes } from '@platform/core/api'
import { Locales } from '@platform/core/i18n'

import { API_URL, databaseUrls, GRAPH_URL, isCi, WEB_URL, WORKER_PORT } from './support/env'

const STARTUP_TIMEOUT_MS = 120_000
const ROOT = '../..'

// The three services run as they do where they are deployed: the bundles that `nx build` writes. A
// laptop that already has them up (reuseExistingServer) is used as it is, so the database it points
// at must hold the fixtures of `pnpm db:fixtures`, and must have been started with META_GRAPH_ORIGIN
// pointing at the fake Graph of the templates spec (support/fake-graph.ts).
export const webServer: Extract<PlaywrightTestConfig['webServer'], unknown[]> = [
  {
    name: 'api',
    command: 'node dist/apps/api/main.js',
    cwd: ROOT,
    url: `${API_URL}${InfraRoutes.healthLive}`,
    timeout: STARTUP_TIMEOUT_MS,
    reuseExistingServer: !isCi,
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
    reuseExistingServer: !isCi,
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
    reuseExistingServer: !isCi,
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
