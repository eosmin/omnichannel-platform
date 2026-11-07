import { type BrowserContext, type Locator, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newConversationIn, storeIdNamed } from '../support/database'
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

  async function expectTouchable(control: Locator): Promise<void> {
    await expect(control.first()).toBeVisible()
    const count = await control.count()
    expect(count).toBeGreaterThan(0)
    for (let at = 0; at < count; at++) {
      const box = await control.nth(at).boundingBox()
      expect(box).not.toBeNull()
      expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(MIN_TOUCH)
    }
  }

  test('the list: the scope buttons and the filters', async () => {
    await page.goto(AppPaths.store.inbox(storeId))
    const filters = page.getByRole('group', { name: inbox.scopeLabel })
    await expect(filters).toBeVisible()
    await expectTouchable(filters.getByRole('button'))
    await expectTouchable(page.locator('select:visible'))
  })

  test('the conversation: back, actions and the reply and note tabs', async () => {
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
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
