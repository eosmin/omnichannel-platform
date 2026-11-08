import { AppPaths } from '@platform/api-client'
import { ConversationStatus } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newConversationIn, setResolveBehavior, statusOf, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const AGENT = 'agent2@test.com'

// Its own session and its own address: the api limits the requests of each address, and the long run of
// the thread cases already uses the whole budget of its own
test.describe('the split button of Resolve', () => {
  test('lists both ways, marks the one the button takes, and Shift+E takes the other', async ({
    browser
  }) => {
    const context = await browser.newContext()
    try {
      await reachServicesFromOwnAddress(context)
      const page = await context.newPage()
      await signIn(page, AGENT)
      const storeId = await storeIdNamed(FIRST_STORE)
      const conversationId = await newConversationIn(storeId)
      await page.goto(AppPaths.store.conversation(storeId, conversationId))
      const arrow = page.getByRole('button', { name: en.inbox.actions.resolveMore, exact: true })
      const now = page.getByRole('menuitem', { name: new RegExp(en.inbox.actions.resolveNow) })
      const withOptions = page.getByRole('menuitem', {
        name: new RegExp(en.inbox.actions.resolveWithOptions.replace('…', ''))
      })
      try {
        // The store asks first: the button opens the dialog, the arrow offers "now"
        await setResolveBehavior(storeId, { showOptions: true, closingSnippetId: null })
        await page.reload()
        await arrow.click()
        await expect(withOptions).toContainText(en.inbox.actions.resolveDefault)
        await expect(now).not.toContainText(en.inbox.actions.resolveDefault)
        await now.click()
        await expect.poll(() => statusOf(conversationId)).toBe(ConversationStatus.RESOLVED)
        await page.getByRole('button', { name: en.common.undo }).click()
        await expect.poll(() => statusOf(conversationId)).toBe(ConversationStatus.OPEN)

        // The store resolves at once: the button does, the arrow offers the dialog, and Shift+E opens it
        await setResolveBehavior(storeId, { showOptions: false, closingSnippetId: null })
        await page.reload()
        await arrow.click()
        await expect(now).toContainText(en.inbox.actions.resolveDefault)
        await withOptions.click()
        const dialog = page.getByRole('dialog', { name: en.inbox.resolve.title })
        await expect(dialog).toBeVisible()
        await dialog.getByRole('button', { name: en.common.cancel }).click()
        await expect(dialog).toHaveCount(0)
        await page.keyboard.press('Shift+E')
        await expect(dialog).toBeVisible()
        await dialog.getByRole('button', { name: en.common.cancel }).click()
        expect(await statusOf(conversationId)).toBe(ConversationStatus.OPEN)
      } finally {
        await setResolveBehavior(storeId, { showOptions: true, closingSnippetId: null })
      }
    } finally {
      await context.close()
    }
  })
})
