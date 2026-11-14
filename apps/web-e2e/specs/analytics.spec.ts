import type { Browser } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import analytics from '../../web/messages/routes/analytics.en.json' with { type: 'json' }
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

// The viewer role holds analytics:view and the agent role does not: the dashboard, its entry in the navigation and the
// "View analytics" action follow that, and the My performance widget is the person's own whoever they are.
const VIEWER = 'viewer2@test.com'
const AGENT = 'agent3@test.com'

async function enter(browser: Browser, email: string) {
  const context = await browser.newContext()
  await reachServicesFromOwnAddress(context)
  const page = await context.newPage()
  await signIn(page, email)
  await expect(page).toHaveURL(/\/s\/([^/]+)\/inbox/)
  const storeId = /\/s\/([^/]+)\//.exec(new URL(page.url()).pathname)?.[1] ?? ''
  return { context, page, storeId }
}

test.describe('analytics', () => {
  test('who holds analytics:view reads the dashboard, and reaches it from the navigation and the inbox', async ({
    browser
  }) => {
    const { context, page, storeId } = await enter(browser, VIEWER)
    try {
      const sidebar = page.getByRole('complementary', { name: en.inbox.sidebar.label })
      await expect(
        sidebar.getByRole('heading', { name: en.inbox.sidebar.widgets.myPerformance })
      ).toBeVisible()
      await expect(sidebar.getByText(en.inbox.sidebar.performance.resolved)).toBeVisible()
      await expect(sidebar.getByText(en.inbox.sidebar.performance.open)).toBeVisible()
      await expect(sidebar.getByText(en.inbox.sidebar.performance.average)).toBeVisible()

      await sidebar.getByRole('link', { name: en.inbox.sidebar.quick.viewAnalytics }).click()
      await expect(page).toHaveURL(new RegExp(`${AppPaths.store.analytics(storeId)}$`))

      await expect(
        page.getByRole('heading', { level: 1, name: analytics.analytics.title })
      ).toBeVisible()
      for (const kpi of ['conversations', 'firstResponse', 'resolution', 'revenue'] as const) {
        await expect(
          page.getByRole('heading', { name: analytics.analytics.kpi[kpi].title })
        ).toBeVisible()
      }
      // The volume chart has its numbers in a table, and the breakdowns say what they hold or that they are empty
      await expect(
        page.getByRole('heading', { name: analytics.analytics.volume.title })
      ).toBeVisible()
      await expect(page.getByRole('img', { name: /Conversations that came in/ })).toBeVisible()
      await expect(
        page.getByRole('heading', { name: analytics.analytics.agents.title })
      ).toBeVisible()
      await expect(
        page.getByRole('heading', { name: analytics.analytics.channels.title })
      ).toBeVisible()

      // Another period is another read: the control is there and takes the choice
      const range = page.getByLabel(analytics.analytics.range.label)
      await range.selectOption('last_7_days')
      await expect(range).toHaveValue('last_7_days')
      // The new reads are done (no card says Loading) and none failed
      await expect(page.getByText(analytics.analytics.kpi.loading, { exact: true })).toHaveCount(0)
      // (The route announcer of Next is an alert too: the failures are looked for by their words)
      await expect(page.getByText(analytics.analytics.kpi.failed)).toHaveCount(0)
      await expect(page.getByText(analytics.analytics.panel.failed)).toHaveCount(0)

      const navigation = page.getByRole('navigation', { name: en.shell.nav.label })
      await expect(navigation.getByRole('link', { name: en.shell.nav.analytics })).toHaveAttribute(
        'aria-current',
        'page'
      )
    } finally {
      await context.close()
    }
  })

  test('an agent has no analytics page, and still sees their own day', async ({ browser }) => {
    const { context, page, storeId } = await enter(browser, AGENT)
    try {
      const sidebar = page.getByRole('complementary', { name: en.inbox.sidebar.label })
      await expect(sidebar.getByText(en.inbox.sidebar.performance.resolved)).toBeVisible()
      await expect(
        sidebar.getByRole('link', { name: en.inbox.sidebar.quick.viewAnalytics })
      ).toHaveCount(0)
      const navigation = page.getByRole('navigation', { name: en.shell.nav.label })
      await expect(navigation.getByRole('link', { name: en.shell.nav.analytics })).toHaveCount(0)

      await page.goto(AppPaths.store.analytics(storeId))
      await expect(page.getByText(en.emptyStates.permissionDenied.title)).toBeVisible()
    } finally {
      await context.close()
    }
  })
})
