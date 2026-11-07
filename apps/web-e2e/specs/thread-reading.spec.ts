import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { AuthorType } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addMessageTo, newConversationIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const DAY_MS = 24 * 60 * 60_000

// The day of the top of the view floats while the reader scrolls a long thread (W3c). The pill of new
// messages needs a message to arrive while the reader is above the end, which the database alone cannot
// make (the realtime event comes from the api): its rules are unit tests and the QA script covers it.
test.describe('reading a long thread', () => {
  let context: BrowserContext
  let page: Page

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext()
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, 'admin@test.com')
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('shows the day of the top of the view while the reader scrolls up, and lets it go', async () => {
    await page.setViewportSize({ width: 1280, height: 600 })
    const storeId = await storeIdNamed('Main Store')
    const conversationId = await newConversationIn(storeId)
    // Three days of messages, enough to scroll
    for (let day = 3; day >= 1; day -= 1) {
      for (let index = 0; index < 8; index += 1) {
        await addMessageTo(storeId, conversationId, {
          content: `Message ${day}-${index}`,
          authorType: index % 2 === 0 ? AuthorType.CUSTOMER : AuthorType.AGENT,
          createdAt: new Date(Date.now() - day * DAY_MS + index * 60_000)
        })
      }
    }
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const list = page.getByRole('list', { name: en.inbox.thread.label })
    await expect(list).toBeVisible()

    // Nothing floats while the reader is at the end and has not scrolled
    const floating = page.locator('[aria-hidden="true"] > time[datetime]')
    await expect(floating).toHaveCount(0)

    // Up to the middle of the second day: the floating day is that of the top of the view
    await list.evaluate(element => {
      const scroller = element.closest('.overflow-y-auto')
      const second = element.querySelectorAll('li[id^="day-"]')[1]
      if (scroller instanceof HTMLElement && second instanceof HTMLElement) {
        scroller.scrollTop = second.offsetTop + 40
      }
    })
    await expect(floating).toBeVisible()
    const expected = await list
      .locator('li[id^="day-"]')
      .nth(1)
      .locator('time')
      .getAttribute('datetime')
    await expect(floating).toHaveAttribute('datetime', expected ?? '')

    // And it goes away a moment after the reader stops
    await expect(floating).toHaveCount(0, { timeout: 5_000 })
  })
})
