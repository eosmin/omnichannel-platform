import { defineConfig, devices } from '@playwright/test'

import { englishLocale, webServer } from './playwright.shared'
import { isCi, WEB_URL } from './support/env'

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
    // In CI a failed case keeps its trace, because a second try that passes would hide what failed. The trace
    // holds requests and bodies, which in these specs are only fake tokens (`e2e-...`); the CI job uploads it
    // for 7 days when the run fails, and the repository is public, so anyone who can open the run can read it:
    // a real token must never be typed into these specs
    trace: isCi ? 'retain-on-failure' : 'on-first-retry',
    storageState: englishLocale
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer
})
