import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addOwnerOfNewStore,
  addWidgetPlugin,
  newConversationIn,
  removeWidgetPlugin
} from '../support/database'
import { expectDialogFitsThePhoneWidth } from '../support/dialog-fit'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const SCREEN = en.inbox.pluginWidgets
const SETTINGS = en.settings.plugins.widgets

// The page of a plugin's widget, as the plugin would serve it from its own origin. It is the frame side of the port
// protocol of TDD_10 §7: it takes the port from the INIT, says READY, hears the session over the port, asks the platform
// for its conversation through it and draws what came back. It also reports what it can reach that it must not: the
// platform's own storage and any key.
const WIDGET_PAGE = `<!doctype html><html><body><p id="state">waiting</p><script>
  window.addEventListener('message', function (event) {
    if (!event.data || event.data.type !== 'platform.widget.init') return
    var port = event.ports[0]
    var conversationId = null
    port.onmessage = function (message) {
      var data = message.data
      if (data.type === 'platform.widget.session') {
        conversationId = data.conversationId
        port.postMessage({ type: 'platform.widget.request', id: 'r1', operation: 'conversation.get' })
        port.postMessage({ type: 'platform.widget.request', id: 'r2', operation: 'customer.get' })
        document.getElementById('state').textContent = 'session for ' + data.conversationId +
          '; url token: ' + (location.search.indexOf('token') >= 0) +
          '; api key: ' + (typeof window.apiKey)
      }
      if (data.type === 'platform.widget.response') {
        var line = document.createElement('p')
        line.className = 'answer'
        line.textContent = data.id + ':' + data.ok + ':' + (data.ok ? Object.keys(data.data).sort().join(',') : data.failure)
        document.body.appendChild(line)
      }
    }
    port.postMessage({ type: 'platform.widget.ready' })
  })
</script></body></html>`

// A widget whose frame never takes the port: the page must say so instead of leaving an empty box
const SILENT_PAGE = '<!doctype html><html><body><p>silent</p></body></html>'

const ORIGIN = 'https://widgets.e2e-acme.example'

test.describe('Plugin widgets in the agent sidebar', () => {
  test.describe.configure({ mode: 'serial' })

  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-widgets-${run}@example.com`
  const pluginId = `e2e-widget-${run}`
  let context: BrowserContext
  let page: Page
  let storeId = ''
  let conversationId = ''
  let pageHtml = WIDGET_PAGE

  test.beforeAll(async ({ browser }) => {
    storeId = await addOwnerOfNewStore(ownerEmail, `E2E Widgets ${run}`)
    await addWidgetPlugin(storeId, { pluginId, widgetUrl: `${ORIGIN}/panel` })
    conversationId = await newConversationIn(storeId)
    context = await browser.newContext({ locale: 'en', viewport: { width: 1600, height: 1000 } })
    await reachServicesFromOwnAddress(context)
    // The plugin's origin is not a real host: its page is answered here, for the frame and for nothing else
    await context.route(`${ORIGIN}/**`, route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml })
    )
    page = await context.newPage()
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
  })
  test.afterAll(async () => {
    await context.close()
    await removeWidgetPlugin(pluginId)
  })

  const frame = () => page.frameLocator('iframe[sandbox]')

  test('draws the panel in the sidebar, in a sandbox, and the frame is handed its session over the port only', async () => {
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    // The first load learns the origin and reloads once so that the policy allows the frame; then it loads
    const iframe = page.locator('iframe[sandbox]')
    await expect(iframe).toBeVisible({ timeout: 30_000 })
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin')
    await expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer')
    const src = new URL((await iframe.getAttribute('src')) ?? '')
    expect(src.origin).toBe(ORIGIN)
    expect([...src.searchParams.keys()].sort()).toEqual(['conversationId', 'widgetId'])
    expect(src.searchParams.get('conversationId')).toBe(conversationId)

    await expect(frame().locator('#state')).toContainText(`session for ${conversationId}`)
    // No token in its url and no key of the plugin in its window
    await expect(frame().locator('#state')).toContainText('url token: false')
    await expect(frame().locator('#state')).toContainText('api key: undefined')
    // Both things it asked through the port were answered, with the minimum fields only. The two answers cross the port
    // in no promised order, so each is found by its id instead of by position
    await expect(frame().locator('.answer')).toHaveCount(2)
    await expect(frame().locator('.answer').filter({ hasText: /^r1:/ })).toHaveText(
      'r1:true:channelType,createdAt,id,lastInboundAt,status,tags'
    )
    await expect(frame().locator('.answer').filter({ hasText: /^r2:/ })).toHaveText(
      'r2:true:email,id,locale,name,phone'
    )
  })

  test('is allowed by the policy of this store only: another store reads none of it', async () => {
    const response = await page.goto(AppPaths.store.conversation(storeId, conversationId))
    expect(response?.headers()['content-security-policy']).toContain(`frame-src ${ORIGIN}`)
    // Every full load rotates the refresh token, and the answer that carries the new one arrives after the load event.
    // Leaving a page before it settles loses that answer; three such leaves in a row spend the grace window of the token
    // and the login is revoked. So each page is waited for, signed in, before the next goto.
    await expect(page.getByRole('complementary')).toBeVisible()
    const other = await page.goto(AppPaths.account.profile)
    expect(other?.headers()['content-security-policy']).toContain("frame-src 'none'")
    await expect(page.getByTestId('avatar-input')).toBeAttached()
  })

  test('can be hidden in Settings, and the panel leaves the sidebar', async () => {
    await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.PLUGINS))
    const row = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Info panel' }) })
    await expect(row).toContainText(SETTINGS.visible)
    await row.getByRole('button', { name: SETTINGS.hide }).click()
    await expect(row).toContainText(SETTINGS.notVisible)

    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await expect(page.getByRole('complementary')).toBeVisible()
    await expect(page.locator('iframe[sandbox]')).toHaveCount(0)

    await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.PLUGINS))
    await row.getByRole('button', { name: SETTINGS.show }).click()
    await expect(row).toContainText(SETTINGS.visible)
  })

  test('says so when the frame never answers the page', async () => {
    pageHtml = SILENT_PAGE
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await expect(page.getByRole('alert').filter({ hasText: SCREEN.unresponsive })).toBeVisible({
      timeout: 30_000
    })
    await expect(
      page.getByRole('alert').getByRole('button', { name: en.common.tryAgain })
    ).toBeVisible()
  })

  test('a long widget name does not widen the Plugins page on a phone', async () => {
    const longPlugin = `e2e-long-${run}`
    const longName = 'W'.repeat(60)
    await addWidgetPlugin(storeId, {
      pluginId: longPlugin,
      widgetUrl: `${ORIGIN}/panel`,
      widgetName: longName
    })
    const before = page.viewportSize() ?? { width: 1600, height: 1000 }
    try {
      await page.setViewportSize({ width: 390, height: 844 })
      await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.PLUGINS))
      const widgetRow = page
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: longName, level: 3 }) })
      await expect(widgetRow).toBeVisible()
      // The name wraps inside its card, and the page does not scroll sideways
      const inside = await widgetRow.evaluate(row => {
        const name = row.querySelector('h3')?.getBoundingClientRect()
        const card = row.getBoundingClientRect()
        return name !== undefined && name.right <= card.right + 1
      })
      expect(inside).toBe(true)
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth
          )
        )
        .toBeLessThanOrEqual(0)
      await page
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: longPlugin, level: 2 }) })
        .getByRole('button', { name: new RegExp(en.settings.plugins.detail.action) })
        .click()
      await expectDialogFitsThePhoneWidth(page, page.getByRole('dialog'))
    } finally {
      await page.setViewportSize(before)
      await removeWidgetPlugin(longPlugin)
    }
  })
})
