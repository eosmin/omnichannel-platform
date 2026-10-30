import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { type BrowserContext, chromium, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import { englishLocaleCookie } from '../playwright.shared'
import { storeIdNamed } from '../support/database'
import { WEB_URL } from '../support/env'
import { measure, type PageMetrics } from '../support/lighthouse'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

import { Budgets, ScriptCeilingsKb } from './budgets'

const FIRST_STORE = 'Main Store'

// A port nobody holds: Lighthouse attaches to whatever answers on it, so it must be ours
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise(resolve => server.close(resolve))
  if (address === null || typeof address === 'string') throw new Error('no free port')
  return address.port
}

// The numbers go to the report of the run, so a budget that is close can be seen before it breaks
function expectWithinBudgets(metrics: PageMetrics, scriptCeilingKb: number): void {
  test.info().annotations.push({ type: 'metrics', description: JSON.stringify(metrics) })
  expect.soft(metrics.firstContentfulPaintMs).toBeLessThan(Budgets.FIRST_CONTENTFUL_PAINT_MS)
  expect.soft(metrics.largestContentfulPaintMs).toBeLessThan(Budgets.LARGEST_CONTENTFUL_PAINT_MS)
  expect.soft(metrics.timeToInteractiveMs).toBeLessThan(Budgets.TIME_TO_INTERACTIVE_MS)
  expect.soft(metrics.totalBlockingTimeMs).toBeLessThan(Budgets.TOTAL_BLOCKING_TIME_MS)
  expect.soft(metrics.cumulativeLayoutShift).toBeLessThan(Budgets.CUMULATIVE_LAYOUT_SHIFT)
  expect.soft(metrics.scriptTransferKb).toBeLessThan(scriptCeilingKb)
}

// Lighthouse drives the browser through its debugging port, so the browser is the one that holds
// the session of the person: a persistent context, which is Chrome's default one. Only one page is
// open, because Lighthouse takes the first it finds. The login is measured first, signed out.
test.describe('performance budgets', () => {
  let profileDir: string | undefined
  let debuggingPort: number
  let context: BrowserContext
  let page: Page

  test.beforeAll(async () => {
    profileDir = await mkdtemp(join(tmpdir(), 'lighthouse-'))
    debuggingPort = await freePort()
    context = await chromium.launchPersistentContext(profileDir, {
      baseURL: WEB_URL,
      args: [`--remote-debugging-port=${debuggingPort}`]
    })
    await context.addCookies([englishLocaleCookie])
    page = context.pages()[0] ?? (await context.newPage())
  })
  test.afterAll(async () => {
    // beforeAll may have failed before either exists
    try {
      await context?.close()
    } finally {
      // The profile holds the cookies of the session
      if (profileDir !== undefined) await rm(profileDir, { recursive: true, force: true })
    }
  })

  test('the login page', async () => {
    // Signed out, whatever test ran before
    async function signOut(): Promise<void> {
      await context.clearCookies()
      await context.addCookies([englishLocaleCookie])
    }
    expectWithinBudgets(
      await measure(`${WEB_URL}${AppPaths.login}`, debuggingPort, signOut),
      ScriptCeilingsKb.LOGIN
    )
  })

  test('the inbox', async () => {
    const storeId = await storeIdNamed(FIRST_STORE)
    // The routes that give the sign-in an address of its own pause every request, which would slow
    // the page that Lighthouse measures
    async function signInAfresh(): Promise<void> {
      await context.clearCookies()
      await context.addCookies([englishLocaleCookie])
      await reachServicesFromOwnAddress(context)
      try {
        await signIn(page, 'admin@test.com')
      } finally {
        await context.unrouteAll()
      }
      // No page of the app left running its own refresh before Lighthouse loads the session
      await page.goto('about:blank')
    }
    expectWithinBudgets(
      await measure(`${WEB_URL}${AppPaths.store.inbox(storeId)}`, debuggingPort, signInAfresh),
      ScriptCeilingsKb.INBOX
    )
  })
})
