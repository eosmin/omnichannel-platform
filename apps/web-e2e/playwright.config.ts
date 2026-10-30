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
  use: { baseURL: WEB_URL, trace: 'on-first-retry', storageState: englishLocale },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer
})
