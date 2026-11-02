import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { profileOf, signInByApi, writeNote } from '../support/api'
import { newConversationIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const START_SCREEN = /\/s\/[^/]+\/inbox$/
const bell = en.shell.notifications

test.describe('the notification center', () => {
  test('a mention reaches the bell with no reload and clicking it marks it read and opens the conversation', async ({
    page
  }) => {
    const storeId = await storeIdNamed('Main Store')
    const conversationId = await newConversationIn(storeId)
    const adminToken = await signInByApi('admin@test.com')
    const agent = await profileOf(await signInByApi('agent@test.com'))

    await signIn(page, 'agent@test.com')
    await page.waitForURL(START_SCREEN)
    await expect(page.getByRole('button', { name: bell.open })).toBeVisible()

    await writeNote(adminToken, storeId, conversationId, 'can you check this?', [agent.id])

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

  test('marks everything read from the panel', async ({ page }) => {
    const storeId = await storeIdNamed('Main Store')
    const conversationId = await newConversationIn(storeId)
    const adminToken = await signInByApi('admin@test.com')
    const agent = await profileOf(await signInByApi('agent@test.com'))
    await writeNote(adminToken, storeId, conversationId, 'one more', [agent.id])

    await signIn(page, 'agent@test.com')
    await page.waitForURL(START_SCREEN)
    await page.getByRole('button', { name: /Notifications, \d+ unread/ }).click()

    await page.getByRole('button', { name: bell.markAllRead }).click()
    await page.getByRole('tab', { name: bell.tabs.unread }).click()

    await expect(page.getByText(bell.empty.unread)).toBeVisible()
  })
})
