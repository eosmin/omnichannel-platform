import { defineConfig } from '@playwright/test'

import { webServer } from './playwright.shared'
import { isCi } from './support/env'

// The performance budgets of TDD_08 §4.4, over the built app (the `lighthouse` job of CI). Apart
// from the specs because it measures the machine: nothing else may run beside it.
export default defineConfig({
  testDir: './lighthouse',
  globalSetup: './support/global-setup.ts',
  outputDir: './lighthouse-results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Three runs of two pages, each one a navigation of several seconds
  timeout: 180_000,
  reporter: isCi
    ? [['github'], ['html', { open: 'never', outputFolder: './lighthouse-report' }]]
    : 'list',
  // Never a server that was already up: a dev server or an old build would be what gets measured
  webServer: webServer.map(server => ({ ...server, reuseExistingServer: false }))
})
