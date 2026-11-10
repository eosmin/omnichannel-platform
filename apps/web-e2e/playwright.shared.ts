import type { PlaywrightTestConfig } from '@playwright/test'

import { LOCALE_COOKIE } from '@platform/api-client'
import { API_PREFIX, ApiRoutes, InfraRoutes } from '@platform/core/api'
import { E2eMagicLinkLimit } from '@platform/core/auth'
import { Locales } from '@platform/core/i18n'

import {
  API_URL,
  databaseUrls,
  GRAPH_URL,
  declareRaisedMagicLinkLimit,
  reuseExistingServers,
  WEB_URL,
  WORKER_PORT
} from './support/env'
import { FAKE_APP_ID, FAKE_APP_SECRET } from './support/fake-graph'

const STARTUP_TIMEOUT_MS = 120_000
const ROOT = '../..'

// The three services run as they do where they are deployed: the bundles that `nx build` writes.
//
// A server that is already up is NOT reused unless E2E_REUSE_SERVERS=1: the one on a laptop is
// usually the owner's `pnpm dev`, connected to the development database, and the specs would write
// their fixtures and their stores to it through that server. With the flag set, the servers must have
// been started with the test database (`pnpm db:test:prepare`, TEST_DATABASE_NAME) and with
// META_GRAPH_ORIGIN pointing at the fake Graph of the templates spec (support/fake-graph.ts), with
// OUTBOUND_MULTI_FILE_ENABLED=true (the album cases), with E2E_TOY_PLUGIN=1 (the third-party toy channel of
// toy-plugin.spec.ts), and with the
// login with Facebook configured as the api below is (META_APP_ID, META_APP_SECRET, META_OAUTH_REDIRECT_URI):
// without it the dialog of a channel shows the token field at once and the specs of the login find no button.
//
// The api of the specs counts magic links per address with a higher limit than the real one (see `RAISED_LIMIT_FLAG`
// in support/env.ts); the performance run, which has no use for it, asks for the real one.
export function webServers(options: {
  raisedMagicLinkLimit: boolean
}): Extract<PlaywrightTestConfig['webServer'], unknown[]> {
  const raised = options.raisedMagicLinkLimit && !reuseExistingServers
  if (raised) declareRaisedMagicLinkLimit()
  return [
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
        META_GRAPH_ORIGIN: GRAPH_URL,
        ...(raised ? { E2E_MAGIC_LINK_LIMIT: String(E2eMagicLinkLimit.suite) } : {}),
        // A third-party channel plugin the repository does not know (`acme_chat`), registered only under
        // NODE_ENV=test: toy-plugin.spec.ts checks that the web draws it from its descriptor alone
        E2E_TOY_PLUGIN: '1',
        // Several files in one message: off in a deployment until a real test with each provider passes,
        // on here so that the composer and the thread are exercised with more than one
        OUTBOUND_MULTI_FILE_ENABLED: 'true',
        // "Connect with Facebook": the app, its secret and the callback of this api, as a deployment sets them
        META_APP_ID: FAKE_APP_ID,
        META_APP_SECRET: FAKE_APP_SECRET,
        META_OAUTH_REDIRECT_URI: `${API_URL}${API_PREFIX}${ApiRoutes.channels.oauthCallback}`
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
}

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
