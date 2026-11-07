import { type BrowserContext } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { AuthorType } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { englishLocaleCookie } from '../playwright.shared'
import { addMessageTo, newConversationIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// The hour the message was written, in UTC: the page must show it in the zone of the browser, not in the one
// of the web server (which is whatever the machine that runs it has)
const WRITTEN_AT = new Date(Date.UTC(2026, 5, 10, 12, 30))
const ZONES = ['America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Auckland']

// "12:30 PM" in the zone, as the bubble writes it (`messageTimeOptions`, English)
const hourIn = (zone: string): string =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour: 'numeric',
    minute: '2-digit'
  })
    .format(WRITTEN_AT)
    .replace(/\s/g, ' ')

// One sign in for the three zones: the magic link is limited for each address, and a refresh cookie is
// used by one context at a time, so each context takes the cookies of the one before
test('the hours of a message follow the time zone of the browser', async ({ browser }) => {
  test.setTimeout(120_000)
  const storeId = await storeIdNamed(FIRST_STORE)
  const conversationId = await newConversationIn(storeId)
  const text = `Zone check ${Date.now()}`
  await addMessageTo(storeId, conversationId, {
    content: text,
    authorType: AuthorType.CUSTOMER,
    createdAt: WRITTEN_AT
  })

  let state: Awaited<ReturnType<BrowserContext['storageState']>> | undefined
  for (const [at, timeZone] of ZONES.entries()) {
    const context = await browser.newContext({ timezoneId: timeZone, storageState: state })
    try {
      await reachServicesFromOwnAddress(context)
      await context.addCookies([englishLocaleCookie])
      const page = await context.newPage()
      if (at === 0) await signIn(page, 'admin4@test.com')
      await page.goto(AppPaths.store.conversation(storeId, conversationId))
      const thread = page.getByRole('list', { name: en.inbox.thread.label })
      const bubble = thread.getByRole('listitem').filter({ hasText: text })
      await expect(bubble).toBeVisible()
      await expect(bubble.locator('time')).toHaveText(hourIn(timeZone))
      state = await context.storageState()
    } finally {
      await context.close()
    }
  }
})
