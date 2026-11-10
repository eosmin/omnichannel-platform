import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newConversationIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
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
    await signIn(page, personOf('admin', import.meta.url))
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

    const draftWord = en.inbox.draft.split('{')[0] ?? 'Draft'
    const afterRender = (): Promise<void> =>
      page.evaluate(
        () =>
          new Promise<void>(resolve => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          })
      )

    // In the conversation that is open the text is in the box, in front of the agent: the row does not repeat it.
    // The draft is first kept (the same one that will show later) and the page is given time to draw it.
    await reply.fill(UNSENT)
    await expect
      .poll(() =>
        page.evaluate(
          text => Object.values<string>(window.sessionStorage).some(value => value.includes(text)),
          'Remember to ask about'
        )
      )
      .toBe(true)
    await afterRender()
    await expect(rowOf(first).getByText(draftWord)).toHaveCount(0)

    // When the agent goes to another conversation the row of the first one shows it, as text: the tags in it are
    // not drawn as tags, and the order of the list does not change
    const hrefs = (): Promise<(string | null)[]> =>
      list.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href')))
    const orderBefore = await hrefs()
    await rowOf(second).click()
    await expect(page).toHaveURL(new RegExp(second))
    await expect(rowOf(first).getByText(shown)).toBeVisible()
    await expect(rowOf(first).locator('i')).toHaveCount(0)
    expect(await hrefs()).toEqual(orderBefore)

    // Only spaces in the second, and the agent leaves it: that row shows no draft
    await page.getByRole('textbox', { name: en.inbox.composer.replyLabel }).fill('   ')
    await rowOf(first).click()
    await expect(page).toHaveURL(new RegExp(first))
    const box = page.getByRole('textbox', { name: en.inbox.composer.replyLabel })
    await expect(box).toHaveValue(UNSENT)
    await afterRender()
    await expect(rowOf(second).getByText(draftWord)).toHaveCount(0)

    // Sending takes it away: from the second one the row of the first has none
    await box.press('Enter')
    await expect(box).toHaveValue('')
    await rowOf(second).click()
    await expect(page).toHaveURL(new RegExp(second))
    await afterRender()
    await expect(rowOf(first).getByText(draftWord)).toHaveCount(0)
  })
})
