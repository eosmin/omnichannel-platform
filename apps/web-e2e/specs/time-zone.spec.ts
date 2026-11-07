import { type BrowserContext } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { AuthorType } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { englishLocaleCookie } from '../playwright.shared'
import {
  addMessageTo,
  newConversationIn,
  setStoreTimezone,
  setUserTimezone,
  storeIdNamed
} from '../support/database'
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
// used by one context at a time, so each context takes the cookies of the one before. The browser stays in
// one zone and the account changes: the hours follow the account, not the machine.
test('the hours of a message follow the time zone of the account', async ({ browser }) => {
  test.setTimeout(120_000)
  const email = 'admin4@test.com'
  const storeId = await storeIdNamed(FIRST_STORE)
  const conversationId = await newConversationIn(storeId)
  const text = `Zone check ${Date.now()}`
  await addMessageTo(storeId, conversationId, {
    content: text,
    authorType: AuthorType.CUSTOMER,
    createdAt: WRITTEN_AT
  })
  const userBefore = await setUserTimezone(email, null)

  let state: Awaited<ReturnType<BrowserContext['storageState']>> | undefined
  try {
    for (const [at, timeZone] of ZONES.entries()) {
      await setUserTimezone(email, timeZone)
      const context = await browser.newContext({
        timezoneId: 'Europe/London',
        storageState: state
      })
      try {
        await reachServicesFromOwnAddress(context)
        await context.addCookies([englishLocaleCookie])
        const page = await context.newPage()
        if (at === 0) await signIn(page, email)
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
  } finally {
    await setUserTimezone(email, userBefore)
  }
})

// The bug of the owner: the zone of the store was the only one the snooze followed. The hours of the bubble
// and of the day separator follow the account first, then the store, then the browser.
test('the hours of a message follow the zone of the account, else the one of the store', async ({
  browser
}) => {
  test.setTimeout(120_000)
  const email = 'admin4@test.com'
  const storeId = await storeIdNamed(FIRST_STORE)
  const conversationId = await newConversationIn(storeId)
  const text = `Store zone check ${Date.now()}`
  await addMessageTo(storeId, conversationId, {
    content: text,
    authorType: AuthorType.CUSTOMER,
    createdAt: WRITTEN_AT
  })
  const storeBefore = await setStoreTimezone(storeId, 'Asia/Tokyo')
  let userBefore: string | null = null
  const context = await browser.newContext({ timezoneId: 'America/Los_Angeles' })
  try {
    userBefore = await setUserTimezone(email, null)
    await reachServicesFromOwnAddress(context)
    await context.addCookies([englishLocaleCookie])
    const page = await context.newPage()
    await signIn(page, email)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const bubble = page
      .getByRole('list', { name: en.inbox.thread.label })
      .getByRole('listitem')
      .filter({ hasText: text })
    // The account chose none: the zone of the store, not the one of the browser (Los Angeles)
    await expect(bubble.locator('time')).toHaveText(hourIn('Asia/Tokyo'))

    // The account chooses one: it wins over the store
    await setUserTimezone(email, 'Pacific/Auckland')
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await expect(bubble.locator('time')).toHaveText(hourIn('Pacific/Auckland'))
  } finally {
    await context.close()
    await setUserTimezone(email, userBefore)
    await setStoreTimezone(storeId, storeBefore)
  }
})
