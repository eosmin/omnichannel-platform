import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newConversationIn, statusOf, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'

const rowOf = (page: Page, storeId: string, conversationId: string) =>
  page.locator(`a[href^="${AppPaths.store.conversation(storeId, conversationId)}"]`)

// The conversation of the row that has the focus (null when the focus is elsewhere)
const focusedRow = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement
        ?.closest('[data-conversation-id]')
        ?.getAttribute('data-conversation-id') ?? null
  )

// One session for the cases: the magic link is limited for each address
test.describe.serial('keyboard shortcuts of the inbox', () => {
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

  test('opens the help sheet with ? and closes it with Escape', async () => {
    await page.goto(AppPaths.store.inbox(storeId))
    await expect(page.getByRole('list', { name: en.inbox.listLabel })).toBeVisible()

    await page.keyboard.press('?')
    const sheet = page.getByRole('dialog', { name: en.inbox.shortcuts.title })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByText(en.inbox.shortcuts.labels.list.NEXT_CONVERSATION)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
  })

  test('moves through the rows with j and k, ticks with x and resolves with e', async () => {
    const first = await newConversationIn(storeId)
    const second = await newConversationIn(storeId)

    await page.goto(AppPaths.store.inbox(storeId))
    await rowOf(page, storeId, first).focus()
    await expect.poll(() => focusedRow(page)).toBe(first)

    const order = await page
      .locator('[data-conversation-id]')
      .evaluateAll(rows => rows.map(row => row.getAttribute('data-conversation-id')))
    const at = order.indexOf(first)
    const next = order[at + 1]
    expect(next).toBeDefined()

    await page.keyboard.press('j')
    await expect.poll(() => focusedRow(page)).toBe(next)
    await page.keyboard.press('k')
    await expect.poll(() => focusedRow(page)).toBe(first)

    await page.keyboard.press('x')
    const bar = page.getByRole('region', { name: en.inbox.bulk.label })
    await expect(bar.getByRole('status')).toHaveText(/^1 selected/)

    // With a row ticked the keys act on the ticked rows, not on the others
    await page.keyboard.press('e')
    await expect.poll(() => statusOf(first)).toBe('RESOLVED')
    await expect(bar).toBeHidden()
    expect(await statusOf(second)).toBe('OPEN')
  })

  test('selects the loaded rows with * a and drops the selection with Escape', async () => {
    await newConversationIn(storeId)
    await page.goto(AppPaths.store.inbox(storeId))
    await expect(page.getByRole('list', { name: en.inbox.listLabel })).toBeVisible()

    await page.keyboard.press('*')
    await page.keyboard.press('a')
    const bar = page.getByRole('region', { name: en.inbox.bulk.label })
    await expect(bar).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(bar).toBeHidden()
  })

  test('works the open conversation: reply box, note, pending, snooze and close', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    await page.keyboard.press('Shift+N')
    await expect(page.getByRole('textbox', { name: en.inbox.composer.noteLabel })).toBeFocused()
    // Escape in the box leaves the conversation; the next keys need the page again
    await page.getByRole('heading', { level: 1 }).click()
    await page.keyboard.press('r')
    await expect(page.getByRole('textbox', { name: en.inbox.composer.replyLabel })).toBeFocused()

    await page.getByRole('heading', { level: 1 }).click()
    await page.keyboard.press('p')
    await expect.poll(() => statusOf(conversationId)).toBe('PENDING')

    await page.keyboard.press('s')
    await expect(page.getByRole('dialog', { name: en.inbox.snooze.title })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: en.inbox.snooze.title })).toBeHidden()

    await page.keyboard.press('Escape')
    await expect(page).toHaveURL(new RegExp(`${AppPaths.store.inbox(storeId)}$`))
    // The focus goes back to the row of the conversation that was left
    await expect.poll(() => focusedRow(page)).toBe(conversationId)
  })
})
