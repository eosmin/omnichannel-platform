import type { Browser, BrowserContext, Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  connectWidget,
  setWidgetOrigins,
  setWidgetPreChat,
  signInByApi,
  type WidgetSite
} from '../support/api'
import { storeIdNamed, withOwner } from '../support/database'
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
  send: 'Send',
  name: 'Name',
  email: 'Email',
  startChat: 'Start the chat',
  invalidEmail: 'Check the email.',
  invalidPhone: 'Check the phone.',
  phone: 'Phone',
  attach: 'Attach a file',
  failed: 'Not sent.'
} as const

// The smallest PNG there is: a real image, so the type the browser declares is the one the api takes
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

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
    const visitorInput = visitor.page.getByRole('textbox', { name: WIDGET_TEXT.input })
    await visitorInput.fill('Is the blue one in stock?')
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
    // The room of the conversation is joined once the thread is on screen; a signal sent before
    // would be lost, and the widget sends one in two seconds at most
    await expect(
      agent
        .getByRole('list', { name: en.inbox.thread.label })
        .getByText('Is the blue one in stock?')
    ).toBeVisible()

    // The visitor types: the signal is not stored, so it can only arrive through the socket
    // One key at a time until the signal lands: the widget sends one in two seconds at most, and the
    // join may take longer than the first one
    await expect(async () => {
      await visitorInput.press('a')
      await expect(agent.getByText(en.inbox.thread.typing.customer)).toBeVisible({ timeout: 2500 })
    }).toPass({ timeout: 15_000 })

    // The agent types a reply: the visitor sees it before anything is sent
    const reply = agent.getByRole('textbox', { name: en.inbox.composer.replyLabel })
    await reply.pressSequentially('Yes, two left', { delay: 50 })
    await expect(visitor.page.getByText('The team is typing')).toBeVisible()
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
  test('asks for the contact data first when the store wants it, and the customer carries it', async ({
    browser
  }) => {
    await setWidgetOrigins(ownerToken, storeId, site.connectionId, [SITE_ORIGIN])
    await setWidgetPreChat(ownerToken, storeId, site.connectionId, true)
    const visitor = await visitorBrowser(browser)
    await openSite(visitor.page)
    await visitor.page.getByRole('button', { name: WIDGET_TEXT.open }).click()

    // The form comes before the conversation, and an address that cannot be right holds it back
    await expect(visitor.page.getByRole('textbox', { name: WIDGET_TEXT.input })).toBeHidden()
    await visitor.page.getByLabel(WIDGET_TEXT.name).fill('Lucia Prechat')
    await visitor.page.getByLabel(WIDGET_TEXT.email).fill('not an address')
    await visitor.page.getByRole('button', { name: WIDGET_TEXT.startChat }).click()
    await expect(visitor.page.getByText(WIDGET_TEXT.invalidEmail)).toBeVisible()
    await visitor.page.getByLabel(WIDGET_TEXT.email).fill('Lucia.Prechat@Example.com')
    await visitor.page.getByRole('button', { name: WIDGET_TEXT.startChat }).click()

    await visitor.page.getByRole('textbox', { name: WIDGET_TEXT.input }).fill('Do you ship abroad?')
    await visitor.page.getByRole('button', { name: WIDGET_TEXT.send }).click()
    await expect(visitor.page.getByRole('log').getByText('Do you ship abroad?')).toBeVisible()

    // The worker stores it with the first message: the customer has the name and the address
    await expect(async () => {
      const customer = await withOwner(owner =>
        owner.customer.findFirst({ where: { storeId, email: 'lucia.prechat@example.com' } })
      )
      expect(customer?.name).toBe('Lucia Prechat')
    }).toPass({ timeout: 15_000 })

    // Asked once: the same browser, a new visit, goes straight to the conversation
    await visitor.page.reload()
    await visitor.page.getByRole('button', { name: WIDGET_TEXT.open }).click()
    await expect(visitor.page.getByRole('textbox', { name: WIDGET_TEXT.input })).toBeVisible()
    await visitor.context.close()
    await setWidgetPreChat(ownerToken, storeId, site.connectionId, false)
  })
  test('a phone the api cannot read brings the form back, and the message goes once it is fixed', async ({
    browser
  }) => {
    await setWidgetPreChat(ownerToken, storeId, site.connectionId, true)
    const visitor = await visitorBrowser(browser)
    await openSite(visitor.page)
    await visitor.page.getByRole('button', { name: WIDGET_TEXT.open }).click()
    // Long enough to look like a number, but no country has one like it
    await visitor.page.getByLabel(WIDGET_TEXT.phone).fill('123456')
    await visitor.page.getByRole('button', { name: WIDGET_TEXT.startChat }).click()
    await visitor.page.getByRole('textbox', { name: WIDGET_TEXT.input }).fill('Is it available?')
    await visitor.page.getByRole('button', { name: WIDGET_TEXT.send }).click()

    // The api names the field: the form is back, with the message under the phone
    const phone = visitor.page.getByLabel(WIDGET_TEXT.phone)
    await expect(visitor.page.getByText(WIDGET_TEXT.invalidPhone)).toBeVisible()
    await expect(phone).toHaveAttribute('aria-invalid', 'true')
    await phone.fill('+52 55 1234 5678')
    await visitor.page.getByRole('button', { name: WIDGET_TEXT.startChat }).click()

    // The message that was held back goes with the corrected form
    const log = visitor.page.getByRole('log')
    await expect(log.getByText('Is it available?')).toBeVisible()
    await expect(log.locator('.msg--sent')).toHaveCount(1)
    await expect(log.getByText(WIDGET_TEXT.failed)).toHaveCount(0)
    await visitor.context.close()
    await setWidgetPreChat(ownerToken, storeId, site.connectionId, false)
  })

  test('a visitor attaches a file: it goes to the bucket under the strict policy and the message is sent', async ({
    browser
  }) => {
    const visitor = await visitorBrowser(browser)
    const violations: string[] = []
    visitor.page.on('console', message => {
      if (message.text().includes('Content Security Policy')) violations.push(message.text())
    })
    await openSite(visitor.page)
    await visitor.page.getByRole('button', { name: WIDGET_TEXT.open }).click()
    await visitor.page.getByRole('button', { name: WIDGET_TEXT.attach }).waitFor()

    await visitor.page
      .locator('input[type="file"]')
      .setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
    await expect(visitor.page.getByText('pixel.png')).toBeVisible()
    await visitor.page.getByRole('button', { name: WIDGET_TEXT.send }).click()

    // Up on the bucket, then named by the message: the line is sent, not failed
    const log = visitor.page.getByRole('log')
    await expect(log.getByText('pixel.png')).toBeVisible()
    await expect(log.locator('.msg--sent')).toHaveCount(1)
    await expect(log.getByText(WIDGET_TEXT.failed)).toHaveCount(0)
    expect(violations).toEqual([])
    await visitor.context.close()
  })
})
