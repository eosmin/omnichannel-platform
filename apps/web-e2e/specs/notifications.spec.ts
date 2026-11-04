import type { Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { profileOf, signInByApi, writeNote } from '../support/api'
import { newConversationIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const START_SCREEN = /\/s\/[^/]+\/inbox$/
const bell = en.shell.notifications

// One link per person for the whole file: the api allows a few per minute per address, and the
// specs that run after this one sign in with the same addresses
let adminToken = ''
let agentId = ''

test.beforeAll(async () => {
  adminToken = await signInByApi('admin@test.com')
  agentId = (await profileOf(await signInByApi('agent@test.com'))).id
})

test.describe('the notification center', () => {
  test('a mention reaches the bell with no reload and clicking it marks it read and opens the conversation', async ({
    page
  }) => {
    const storeId = await storeIdNamed('Main Store')
    const conversationId = await newConversationIn(storeId)

    await signIn(page, 'agent@test.com')
    await page.waitForURL(START_SCREEN)
    await expect(page.getByRole('button', { name: bell.open })).toBeVisible()

    await writeNote(adminToken, storeId, conversationId, 'can you check this?', [agentId])

    // The event of the socket refreshes the count: the label of the bell now says how many
    const withCount = page.getByRole('button', { name: /Notifications, \d+ unread/ })
    await expect(withCount).toBeVisible()
    await withCount.click()

    const panel = page.getByRole('dialog', { name: bell.title })
    const item = panel.getByRole('button', {
      name: new RegExp(en.notifications.conversation.mentioned.title)
    })
    await expect(item.first()).toBeVisible()

    await item.first().click()

    await expect(page).toHaveURL(AppPaths.store.conversation(storeId, conversationId))
  })

  test('marks everything read from the panel, and its link opens the preferences', async ({
    page
  }) => {
    const storeId = await storeIdNamed('Main Store')
    const conversationId = await newConversationIn(storeId)
    await writeNote(adminToken, storeId, conversationId, 'one more', [agentId])

    await signIn(page, 'agent@test.com')
    await page.waitForURL(START_SCREEN)
    await page.getByRole('button', { name: /Notifications, \d+ unread/ }).click()

    await page.getByRole('button', { name: bell.markAllRead }).click()
    await page.getByRole('tab', { name: bell.tabs.unread }).click()

    await expect(page.getByText(bell.empty.unread)).toBeVisible()

    // The panel is still open: its link leads to the preferences, and a choice survives a reload
    await checkPreferences(page)

    // Still on the account page, with no navigation to a store: the bell must keep counting
    await checkBellIsLiveOnAccountPage(page, storeId)
  })

  // Not a test of its own either, for the same budget. The account pages belong to no store, but
  // their bell counts the last store's notifications, so they open that store's socket too
  async function checkBellIsLiveOnAccountPage(page: Page, storeId: string): Promise<void> {
    await expect(page).toHaveURL(AppPaths.account.notifications)
    // Everything was marked read above, so the bell shows no count yet
    await expect(page.getByRole('button', { name: bell.open })).toBeVisible()
    const conversationId = await newConversationIn(storeId)
    // The page was just reloaded and nothing says when its socket has joined the store: a note
    // written before that is missed, so it is written again until the count shows
    await expect(async () => {
      await writeNote(adminToken, storeId, conversationId, 'while on the account page', [agentId])
      await expect(page.getByRole('button', { name: /Notifications, \d+ unread/ })).toBeVisible({
        timeout: 2_000
      })
    }).toPass({ timeout: 20_000 })
  }

  // Not a test of its own on purpose: another sign-in of the agent would use the magic-link budget
  // (5 a minute per address) that the specs after this file need
  async function checkPreferences(page: Page): Promise<void> {
    const prefs = en.account.notifications
    await page.getByRole('link', { name: bell.settings }).click()
    await expect(page).toHaveURL(AppPaths.account.notifications)

    // Email of "Mentioned in a note": flipped from whatever the last run left, then put back
    const cell = (): ReturnType<typeof page.getByRole> =>
      page.getByRole('checkbox', {
        name: `${prefs.types.conversation.mentioned}: ${prefs.channels.email}`
      })
    await expect(cell()).toBeVisible()
    const before = await cell().isChecked()

    // A click and not `setChecked`: the box follows the answer of the api, not the click itself
    try {
      await cell().click()
      await expect(cell()).toHaveJSProperty('checked', !before)
      await page.reload()
      await expect(cell()).toHaveJSProperty('checked', !before)
    } finally {
      // The preference lives in the shared dev database: put it back even when an assertion failed
      if ((await cell().isChecked()) !== before) await cell().click()
    }
    await expect(cell()).toHaveJSProperty('checked', before)
  }
})
