import { defineConfig, devices } from '@playwright/test'

import { englishLocale, webServer } from './playwright.shared'
import { E2E_MAGIC_LINK_LIMIT, isCi, shard, WEB_URL } from './support/env'

export default defineConfig({
  testDir: './specs',
  globalSetup: './support/global-setup.ts',
  outputDir: './test-results',
  // The specs share one database and one mailbox, and the rate limit of the magic link counts per address
  fullyParallel: false,
  workers: 1,
  retries: isCi ? 1 : 0,
  ...(shard === undefined ? {} : { shard }),
  reporter: isCi
    ? [
        ['github'],
        ['html', { open: 'never', outputFolder: './playwright-report' }],
        // The duration of every case and file, kept by the job even when the run is green: it is what decides how
        // to split the suite into shards and shows which cases need a retry (`.github/workflows/ci.yml`)
        ['json', { outputFile: './playwright-timing/results.json' }]
      ]
    : 'list',
  use: {
    baseURL: WEB_URL,
    // In CI a failed case keeps its trace, because a second try that passes would hide what failed. The trace
    // holds requests and bodies, which in these specs are only fake tokens (`e2e-...`); the CI job uploads it
    // for 7 days when the run fails, and the repository is public, so anyone who can open the run can read it:
    // a real token must never be typed into these specs
    trace: isCi ? 'retain-on-failure' : 'on-first-retry',
    storageState: englishLocale
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // The api of this suite counts magic links per address with a higher limit (env.ts says why); the performance run,
  // which shares these servers, does not get it
  webServer: webServer.map(server =>
    server.name === 'api'
      ? { ...server, env: { ...server.env, E2E_MAGIC_LINK_LIMIT: String(E2E_MAGIC_LINK_LIMIT) } }
      : server
  )
})
