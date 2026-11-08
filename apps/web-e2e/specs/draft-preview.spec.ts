import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newConversationIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const UNSENT = 'Remember to ask about <i>the invoice</i>'

// The unsent text of a conversation is shown in its row, in the list: typed in the box, kept when the agent moves to
// another conversation, gone when it is sent. It is the draft the composer keeps in this tab; nothing else is read.
test.describe.serial('the draft in the list of conversations', () => {
  let context: BrowserContext
  let page: Page
  let storeId: string

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext()
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, 'admin2@test.com')
    storeId = await storeIdNamed(FIRST_STORE)
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('shows what was typed and not sent, ignores spaces, and clears it on sending', async () => {
    const first = await newConversationIn(storeId)
    const second = await newConversationIn(storeId)
    await page.goto(AppPaths.store.conversation(storeId, first))
    const list = page.getByRole('list', { name: en.inbox.listLabel })
    const rowOf = (id: string) => list.locator(`a[href*="${id}"]`)
    const reply = page.getByRole('textbox', { name: en.inbox.composer.replyLabel })
    const shown = en.inbox.draft.replace('{text}', UNSENT)

    // Live, in the conversation that is open
    await reply.fill(UNSENT)
    await expect(rowOf(first).getByText(shown)).toBeVisible()
    // The text is shown as text: the tags in it are not drawn as tags
    await expect(rowOf(first).locator('i')).toHaveCount(0)

    // Kept when the agent goes to another conversation, whose row has none
    await rowOf(second).click()
    await expect(page).toHaveURL(new RegExp(second))
    await expect(rowOf(first).getByText(shown)).toBeVisible()
    await expect(rowOf(second).getByText(en.inbox.draft.split('{')[0] ?? 'Draft')).toHaveCount(0)

    // Only spaces: no draft
    await page.getByRole('textbox', { name: en.inbox.composer.replyLabel }).fill('   ')
    await expect(rowOf(second).getByText(en.inbox.draft.split('{')[0] ?? 'Draft')).toHaveCount(0)

    // Back to the first one and send: the row has no draft
    await rowOf(first).click()
    await expect(page).toHaveURL(new RegExp(first))
    const box = page.getByRole('textbox', { name: en.inbox.composer.replyLabel })
    await expect(box).toHaveValue(UNSENT)
    await box.press('Enter')
    await expect(rowOf(first).getByText(shown)).toHaveCount(0)
  })
})
