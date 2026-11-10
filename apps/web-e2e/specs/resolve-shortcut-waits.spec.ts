import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newConversationIn, setResolveBehavior, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const AGENT = personOf('agent', import.meta.url)
const SETTINGS_DELAY_MS = 2_000

// Its own session and address: the api limits the requests of each address
test('Shift+E pressed before the settings of the store arrive is not lost: the options open when they do', async ({
  browser
}) => {
  const context = await browser.newContext()
  const storeId = await storeIdNamed(FIRST_STORE)
  try {
    await reachServicesFromOwnAddress(context)
    const page = await context.newPage()
    await signIn(page, AGENT)
    // The store resolves at once, so the other way is the dialog
    await setResolveBehavior(storeId, { showOptions: false, closingSnippetId: null })
    const conversationId = await newConversationIn(storeId)
    // The settings are slow: the flow of resolving is not ready (its buttons are off) when the key is pressed
    await page.route('**/settings/inbox/behavior', async route => {
      await new Promise(resolve => setTimeout(resolve, SETTINGS_DELAY_MS))
      await route.continue()
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const arrow = page.getByRole('button', { name: en.inbox.actions.resolveMore, exact: true })
    await expect(arrow).toBeVisible()
    await expect(arrow).toBeDisabled()
    await page.keyboard.press('Shift+E')

    const dialog = page.getByRole('dialog', { name: en.inbox.resolve.title })
    // Nothing opens while the settings are on their way, and the key is kept until they arrive
    await expect(dialog).toHaveCount(0)
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  } finally {
    await setResolveBehavior(storeId, { showOptions: true, closingSnippetId: null })
    await context.close()
  }
})
