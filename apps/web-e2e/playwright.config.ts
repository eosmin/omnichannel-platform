import { defineConfig, devices } from '@playwright/test'

import { LOCALE_COOKIE } from '@platform/api-client'
import { InfraRoutes } from '@platform/core/api'
import { Locales } from '@platform/core/i18n'

import { API_URL, databaseUrls, isCi, WEB_URL, WORKER_PORT } from './support/env'

const STARTUP_TIMEOUT_MS = 120_000
const ROOT = '../..'

// The three services run as they do where they are deployed: the bundles that `nx build` writes. A
// laptop that already has them up (reuseExistingServer) is used as it is, so the database it points
// at must hold the fixtures of `pnpm db:fixtures`.
export default defineConfig({
  testDir: './specs',
  globalSetup: './support/global-setup.ts',
  outputDir: './test-results',
  // The specs share one database and one mailbox, and the rate limit of the magic link counts per address
  fullyParallel: false,
  workers: 1,
  retries: isCi ? 1 : 0,
  reporter: isCi
    ? [['github'], ['html', { open: 'never', outputFolder: './playwright-report' }]]
    : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'on-first-retry',
    // The default locale of the app is Spanish; the specs read the English messages
    storageState: {
      cookies: [
        {
          name: LOCALE_COOKIE,
          value: Locales.EN,
          domain: new URL(WEB_URL).hostname,
          path: '/',
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax'
        }
      ],
      origins: []
    }
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      name: 'api',
      command: 'node dist/apps/api/main.js',
      cwd: ROOT,
      url: `${API_URL}${InfraRoutes.healthLive}`,
      timeout: STARTUP_TIMEOUT_MS,
      reuseExistingServer: !isCi,
      env: { NODE_ENV: 'test', DATABASE_URL: databaseUrls.app, TRUST_PROXY_HOPS: '1' }
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
        DATABASE_URL: databaseUrls.worker
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
})
