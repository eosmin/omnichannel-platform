import { AppPaths } from '@platform/api-client'
import { ConversationStatus } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newConversationIn, setResolveBehavior, statusOf, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const AGENT = 'agent2@test.com'

const startsWith = (template: string): RegExp => new RegExp(`^${template.split('{')[0] ?? ''}`)

// Its own session and address: the api limits the requests of each address
test('the resolve button of a row resolves that conversation without opening it, and its arrow offers both ways', async ({
  browser
}) => {
  const context = await browser.newContext()
  const storeId = await storeIdNamed(FIRST_STORE)
  try {
    await reachServicesFromOwnAddress(context)
    const page = await context.newPage()
    await signIn(page, AGENT)
    await setResolveBehavior(storeId, { showOptions: false, closingSnippetId: null })
    const first = await newConversationIn(storeId)
    await page.goto(AppPaths.store.inbox(storeId))
    const row = page.locator(`[data-conversation-id="${first}"]`)
    await expect(row).toBeVisible()
    const resolveButton = row.getByRole('button', { name: startsWith(en.inbox.actions.resolveRow) })
    const arrow = row.getByRole('button', { name: startsWith(en.inbox.actions.resolveRowMore) })

    // The arrow lists both ways and marks the one the store chose; the options one opens the dialog
    await row.hover()
    await arrow.click()
    await expect(
      page.getByRole('menuitem', { name: new RegExp(en.inbox.actions.resolveNow) })
    ).toContainText(en.inbox.actions.resolveDefault)
    await page
      .getByRole('menuitem', {
        name: new RegExp(en.inbox.actions.resolveWithOptions.replace('…', ''))
      })
      .click()
    const dialog = page.getByRole('dialog', { name: en.inbox.resolve.title })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: en.common.cancel }).click()
    await expect(dialog).toHaveCount(0)
    expect(await statusOf(first)).toBe(ConversationStatus.OPEN)

    // The button resolves at once, with the toast to undo, and the page stays on the list
    await row.hover()
    await resolveButton.click()
    await expect.poll(() => statusOf(first)).toBe(ConversationStatus.RESOLVED)
    await expect(page.getByRole('button', { name: en.common.undo })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe(AppPaths.store.inbox(storeId))
  } finally {
    await setResolveBehavior(storeId, { showOptions: true, closingSnippetId: null })
    await context.close()
  }
})
