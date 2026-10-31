import type { Browser, BrowserContext, Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'

import en from '../../web/messages/en.json' with { type: 'json' }
import { connectWidget, signInByApi, type WidgetSite, setWidgetOrigins } from '../support/api'
import { storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'
import { openSite, SITE_ORIGIN, startSite, STRICT_CSP } from '../support/widget-site'

const FIRST_STORE = 'Main Store'
// An administrator connects the widget and an agent answers. The magic link is limited for each
// address, so each person is one that the other specs spend the least.
const OWNER = 'multi-store@test.com'
const AGENT = 'agent@test.com'
const OTHER_SITE = 'https://other.example.com'
const WIDGET_TEXT = {
  open: 'Open the chat',
  input: 'Write a message',
  send: 'Send'
} as const

// A visitor's browser, which reaches the api from an address of its own
async function visitorBrowser(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  await reachServicesFromOwnAddress(context)
  return { context, page: await context.newPage() }
}

test.describe.serial('the web widget on a site with a strict policy', () => {
  let storeId: string
  let ownerToken: string
  let site: WidgetSite
  let stopSite: () => Promise<void>

  test.beforeAll(async () => {
    storeId = await storeIdNamed(FIRST_STORE)
    ownerToken = await signInByApi(OWNER)
    site = await connectWidget(ownerToken, storeId, [SITE_ORIGIN])
    stopSite = await startSite(site.snippet)
  })
  test.afterAll(async () => {
    await stopSite()
  })

  test('a visitor writes, an agent answers from the inbox and the visitor sees it', async ({
    browser
  }) => {
    const visitor = await visitorBrowser(browser)
    const violations: string[] = []
    visitor.page.on('console', message => {
      if (message.text().includes('Content Security Policy')) violations.push(message.text())
    })
    const page = await openSite(visitor.page)
    expect(page?.headers()['content-security-policy']).toBe(STRICT_CSP)

    // The launcher is drawn in a shadow root that the script attaches to the page
    await visitor.page.getByRole('button', { name: WIDGET_TEXT.open }).click()
    await visitor.page
      .getByRole('textbox', { name: WIDGET_TEXT.input })
      .fill('Is the blue one in stock?')
    await visitor.page.getByRole('button', { name: WIDGET_TEXT.send }).click()
    await expect(visitor.page.getByRole('log').getByText('Is the blue one in stock?')).toBeVisible()

    // A second browser: the agent finds the conversation in the inbox, without a reload
    const agentContext = await browser.newContext()
    await reachServicesFromOwnAddress(agentContext)
    const agent = await agentContext.newPage()
    await signIn(agent, AGENT)
    await agent.goto(AppPaths.store.inbox(storeId))
    await agent
      .getByRole('list', { name: en.inbox.listLabel })
      .getByText('Is the blue one in stock?')
      .first()
      .click()
    await agent.getByRole('textbox', { name: en.inbox.composer.replyLabel }).fill('Yes, two left')
    await agent.getByRole('button', { name: en.inbox.composer.send }).click()

    // The reply reaches the visitor through the socket
    await expect(visitor.page.getByRole('log').getByText('Yes, two left')).toBeVisible()
    expect(violations).toEqual([])

    await agentContext.close()
    await visitor.context.close()
  })

  test('after the site is removed, the same page gets no new session', async ({ browser }) => {
    await setWidgetOrigins(ownerToken, storeId, site.connectionId, [OTHER_SITE])
    const visitor = await visitorBrowser(browser)
    // The api answers 403 with no CORS grant, so the browser reports the request as failed
    const isBootstrap = (url: string) => url.endsWith(ApiRoutes.widget.bootstrap)
    const refused = visitor.page.waitForEvent('requestfailed', request =>
      isBootstrap(request.url())
    )
    await openSite(visitor.page)
    await refused

    await expect(visitor.page.getByRole('button', { name: WIDGET_TEXT.open })).toHaveCount(0)
    await visitor.context.close()
  })
})
