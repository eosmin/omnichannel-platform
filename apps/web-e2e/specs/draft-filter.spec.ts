import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newConversationIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const UNSENT = 'Ask about the refund'

// The view "With draft": only the conversations that have an unsent draft of this person, in this tab. The drafts
// are the ones the composer keeps in the tab; nothing of the view goes to the api. A spec of its own, with a few
// requests: two conversations, one sign in.
test.describe.serial('the view of the conversations with a draft', () => {
  let context: BrowserContext
  let page: Page
  let storeId: string

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext()
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, personOf('admin', import.meta.url))
    storeId = await storeIdNamed(FIRST_STORE)
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('lists only the conversations with a draft, by keyboard, and follows the drafts', async () => {
    const withDraft = await newConversationIn(storeId)
    const without = await newConversationIn(storeId)
    await page.goto(AppPaths.store.conversation(storeId, withDraft))
    const list = page.getByRole('list', { name: en.inbox.listLabel })
    const rowOf = (id: string) => list.locator(`a[href*="${id}"]`)
    const toggle = page.getByRole('button', { name: new RegExp(`^${en.inbox.draftFilter}`) })

    // A draft in the first conversation, kept in the tab, and the agent moves to the other
    await page.getByRole('textbox', { name: en.inbox.composer.replyLabel }).fill(UNSENT)
    await expect
      .poll(() =>
        page.evaluate(
          text => Object.values<string>(window.sessionStorage).some(value => value.includes(text)),
          UNSENT
        )
      )
      .toBe(true)
    await rowOf(without).click()
    await expect(page).toHaveURL(new RegExp(without))
    await expect(rowOf(withDraft)).toBeVisible()
    await expect(rowOf(without)).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')

    // By keyboard: the button is reached and pressed like any other, and the list narrows to the one
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await expect(rowOf(withDraft)).toBeVisible()
    await expect(rowOf(without)).toHaveCount(0)
    // It is in the address (a reload keeps the view) and on the links to a conversation, and not sent to the api
    await expect(page).toHaveURL(/draft=1/)
    expect(await rowOf(withDraft).getAttribute('href')).toContain('draft=1')
    // The row shows the text, and the button counts the drafts
    await expect(rowOf(withDraft).getByText(en.inbox.draft.replace('{text}', UNSENT))).toBeVisible()
    await expect(toggle).toContainText(/\(\d+\)/)

    // Sending the draft takes the conversation out of the view
    await rowOf(withDraft).click()
    await expect(page).toHaveURL(new RegExp(withDraft))
    const box = page.getByRole('textbox', { name: en.inbox.composer.replyLabel })
    await expect(box).toHaveValue(UNSENT)
    await box.fill('')
    await expect(rowOf(withDraft)).toHaveCount(0)
    await expect(page.getByText(en.inbox.noDrafts.title)).toBeVisible()

    // Off again with the button that clears the view: everything is back
    await page.getByRole('button', { name: en.inbox.clearFilters }).click()
    await expect(page).not.toHaveURL(/draft=1/)
    await expect(rowOf(without)).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  })
})
