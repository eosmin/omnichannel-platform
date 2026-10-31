import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newConversationIn, newTaggedConversationIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const PHONE = { width: 390, height: 800 }

const rowOf = (page: Page, storeId: string, conversationId: string) =>
  page.locator(`a[href^="${AppPaths.store.conversation(storeId, conversationId)}"]`)

// One session for the three cases: the magic link is limited for each address, and the other specs
// sign in with the same one
test.describe.serial('the inbox list', () => {
  let context: BrowserContext
  let page: Page
  let storeId: string

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext()
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, 'admin@test.com')
    storeId = await storeIdNamed(FIRST_STORE)
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('lists a conversation and opens it with its filters kept in the address', async () => {
    const conversationId = await newConversationIn(storeId)

    await page.goto(AppPaths.store.inbox(storeId))
    await page.getByRole('button', { name: new RegExp(`^${en.inbox.scope.unassigned}`) }).click()
    await expect(page).toHaveURL(/assigned=unassigned/)

    const row = rowOf(page, storeId, conversationId)
    await expect(row).toBeVisible()
    await row.click()

    await expect(page).toHaveURL(new RegExp(`/inbox/${conversationId}\\?assigned=unassigned`))
    await expect(row).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  })

  test('narrows to the conversations of the person and says when none match', async () => {
    const conversationId = await newConversationIn(storeId)

    // Nobody holds the new conversation, so "mine" does not list it. The row is absent while the list
    // loads too, so the answer of the api is awaited before looking.
    const answered = page.waitForResponse(
      response =>
        response.url().includes('/conversations?') && response.url().includes('assigned=me')
    )
    await page.goto(`${AppPaths.store.inbox(storeId)}?assigned=me`)
    await answered
    await expect(page.getByText(en.inbox.loadingList)).toBeHidden()
    await expect(rowOf(page, storeId, conversationId)).toHaveCount(0)

    await page.getByRole('button', { name: en.inbox.clearFilters }).click()
    await expect(page).not.toHaveURL(/assigned=/)
    await expect(rowOf(page, storeId, conversationId)).toBeVisible()
  })

  test('filters by a tag, keeps it in the address, and draws the tag on the row', async () => {
    const tagName = `vip-${crypto.randomUUID().slice(0, 8)}`
    const { conversationId, tagId } = await newTaggedConversationIn(storeId, tagName)
    const untagged = await newConversationIn(storeId)

    await page.goto(AppPaths.store.inbox(storeId))
    await expect(rowOf(page, storeId, conversationId)).toBeVisible()
    await expect(rowOf(page, storeId, conversationId).getByText(tagName)).toBeVisible()

    await page.getByRole('combobox', { name: en.inbox.tagFilter }).selectOption({ label: tagName })
    await expect(page).toHaveURL(new RegExp(`tagId=${tagId}`))
    await expect(rowOf(page, storeId, conversationId)).toBeVisible()
    await expect(rowOf(page, storeId, untagged)).toHaveCount(0)

    await page.getByRole('button', { name: en.inbox.clearFilters }).click()
    await expect(page).not.toHaveURL(/tagId=/)
    await expect(rowOf(page, storeId, untagged)).toBeVisible()
  })

  test('shows the list alone on a phone, and the conversation alone once one is open', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.setViewportSize(PHONE)

    await page.goto(AppPaths.store.inbox(storeId))
    await expect(page.getByRole('list', { name: en.inbox.listLabel })).toBeVisible()
    await expect(page.getByText(en.inbox.select.title)).toBeHidden()

    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await expect(page.getByRole('link', { name: en.inbox.backToList })).toBeVisible()
    await expect(page.getByRole('list', { name: en.inbox.listLabel })).toBeHidden()
  })
})
