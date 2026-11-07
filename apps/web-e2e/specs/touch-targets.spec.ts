import { type BrowserContext, type Locator, type Page } from '@playwright/test'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newConversationIn, storeIdNamed, withWhatsAppChannel } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const MIN_TOUCH = 40
const inbox = en.inbox

// On a phone (a coarse pointer) every control outside the top bar has a touch area of at least 40 px on each
// side, as the owner chose and checked on a real phone. The sizes are real boxes, not a pseudo-element, so the
// bounding box tells the truth. One session for the cases: the magic link is limited for each address.
test.describe.serial('touch targets on a phone', () => {
  let context: BrowserContext
  let page: Page
  let storeId: string
  let conversationId: string

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true
    })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, 'admin4@test.com')
    storeId = await storeIdNamed(FIRST_STORE)
    conversationId = await newConversationIn(storeId)
  })
  test.afterAll(async () => {
    await context.close()
  })

  // Each control is measured until it is settled: a control that React replaces while the page loads (the back link
  // of the header moves from the loading header to the loaded one) has no box for a moment, and a measure taken in
  // that moment says nothing about its size. The size asked for is the same; only the wait is longer.
  async function expectTouchable(control: Locator): Promise<void> {
    await expect(control.first()).toBeVisible()
    const count = await control.count()
    expect(count).toBeGreaterThan(0)
    for (let at = 0; at < count; at++) {
      await expect
        .poll(async () => {
          const box = await control.nth(at).boundingBox()
          return box === null ? 0 : Math.min(box.width, box.height)
        })
        .toBeGreaterThanOrEqual(MIN_TOUCH)
    }
  }

  test('the list: the scope buttons and the filters', async () => {
    await page.goto(AppPaths.store.inbox(storeId))
    const filters = page.getByRole('group', { name: inbox.scopeLabel })
    await expect(filters).toBeVisible()
    await expectTouchable(filters.getByRole('button'))
    await expectTouchable(page.locator('select:visible'))
  })

  test('a row of the list: its snooze button and the area of its checkbox', async () => {
    await page.goto(AppPaths.store.inbox(storeId))
    const row = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('link') })
      .first()
    await expect(row).toBeVisible()
    await expectTouchable(
      row.getByRole('button', {
        name: new RegExp(`^${en.inbox.actions.snoozeRow.split('{')[0] ?? ''}`)
      })
    )
    // The checkbox glyph is drawn small on purpose; the control a finger hits is the label around it (40 px)
    await expectTouchable(row.locator('label:has(input[type="checkbox"])'))
  })

  test('the toggle of the message templates of a connection', async () => {
    await withWhatsAppChannel(storeId)
    await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.CHANNELS))
    await expectTouchable(page.getByRole('button', { name: en.settings.channels.templates.toggle }))
  })

  test('the conversation: back, actions and the reply and note tabs', async () => {
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    // The header with the name of the customer is the loaded one: the one that stays
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expectTouchable(page.getByRole('link', { name: inbox.backToList }))
    await expectTouchable(page.getByRole('button', { name: inbox.actions.snooze, exact: true }))
    await expectTouchable(page.getByRole('button', { name: inbox.actions.resolve, exact: true }))
    await expectTouchable(page.getByRole('tab'))
  })

  test('the customers page and the settings navigation', async () => {
    await page.goto(AppPaths.store.customers(storeId))
    await expect(page.getByRole('main')).toBeVisible()
    await expectTouchable(
      page.getByRole('main').getByRole('button', { name: en.customers.list.export })
    )
    await page.goto(AppPaths.store.settings(storeId))
    await expectTouchable(
      page.getByRole('navigation', { name: en.settings.nav.store.label }).getByRole('link')
    )
  })
})
