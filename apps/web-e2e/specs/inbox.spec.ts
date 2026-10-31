import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  newConversationIn,
  newTaggedConversationIn,
  statusOf,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const PHONE = { width: 390, height: 800 }

// The row in the list: the unassigned queue of the sidebar links to the same conversation
const rowOf = (page: Page, storeId: string, conversationId: string) =>
  page
    .getByRole('list', { name: en.inbox.listLabel })
    .locator(`a[href^="${AppPaths.store.conversation(storeId, conversationId)}"]`)

// The conversation of the row that has the focus (null when the focus is elsewhere)
const focusedRow = (page: Page) =>
  page.evaluate(
    () =>
      document.activeElement
        ?.closest('[data-conversation-id]')
        ?.getAttribute('data-conversation-id') ?? null
  )

// One session for the cases: the magic link is limited for each address, and the other specs
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

  test('ticks two rows, resolves them together and takes the change back', async () => {
    const first = await newConversationIn(storeId)
    const second = await newConversationIn(storeId)

    await page.goto(AppPaths.store.inbox(storeId))
    // The checkbox is a sibling of the row's link, over the avatar
    for (const id of [first, second]) {
      await rowOf(page, storeId, id).locator('xpath=following-sibling::label//input').check()
    }
    const bar = page.getByRole('region', { name: en.inbox.bulk.label })
    await expect(bar.getByRole('status')).toHaveText(/^2 selected/)

    await bar.getByRole('button', { name: en.inbox.bulk.status.label }).click()
    await page.getByRole('menuitem', { name: en.conversations.status.RESOLVED }).click()

    await expect(page.getByText('2 conversations updated')).toBeVisible()
    await expect.poll(() => statusOf(first)).toBe('RESOLVED')
    await expect.poll(() => statusOf(second)).toBe('RESOLVED')
    // The selection is gone once the action went through
    await expect(bar).toBeHidden()

    await page.getByRole('button', { name: en.inbox.bulk.result.undo }).click()
    await expect(page.getByText(en.inbox.bulk.result.undone)).toBeVisible()
    await expect.poll(() => statusOf(first)).toBe('OPEN')
    await expect.poll(() => statusOf(second)).toBe('OPEN')
  })

  test('shortcuts: opens the help sheet with ? and closes it with Escape', async () => {
    await page.goto(AppPaths.store.inbox(storeId))
    await expect(page.getByRole('list', { name: en.inbox.listLabel })).toBeVisible()

    await page.keyboard.press('?')
    const sheet = page.getByRole('dialog', { name: en.inbox.shortcuts.title })
    await expect(sheet).toBeVisible()
    await expect(sheet.getByText(en.inbox.shortcuts.labels.list.NEXT_CONVERSATION)).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
  })

  test('shortcuts: moves through the rows with j and k, ticks with x and resolves with e', async () => {
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

  test('shortcuts: selects the loaded rows with * a and drops the selection with Escape', async () => {
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

  test('shortcuts: works the open conversation: reply box, note, pending, snooze and close', async () => {
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

  test('shortcuts: e on a focused row asks the questions of the store before resolving', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.inbox(storeId))
    await rowOf(page, storeId, conversationId).focus()
    await expect.poll(() => focusedRow(page)).toBe(conversationId)

    await page.keyboard.press('e')
    const dialog = page.getByRole('dialog', { name: en.inbox.resolve.title })
    await expect(dialog).toBeVisible()
    // Nothing changed until the agent confirms
    expect(await statusOf(conversationId)).toBe('OPEN')

    await dialog.getByRole('button', { name: en.inbox.resolve.confirm }).click()
    await expect.poll(() => statusOf(conversationId)).toBe('RESOLVED')
    await expect(dialog).toBeHidden()
  })

  test('the sidebar: takes a conversation from the queue and keeps the order of its widgets', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.inbox(storeId))
    const sidebar = page.getByRole('complementary', { name: en.inbox.sidebar.label })
    const queued = sidebar.getByRole('listitem').filter({
      has: page.locator(`a[href^="${AppPaths.store.conversation(storeId, conversationId)}"]`)
    })
    await expect(queued).toBeVisible()

    await queued.getByRole('button', { name: /^Take the conversation with / }).click()
    await expect(queued).toBeHidden()

    const titles = () => sidebar.getByRole('heading', { level: 2 }).allTextContents()
    const before = await titles()
    expect(before).toEqual([
      en.inbox.sidebar.widgets.unassignedQueue,
      en.inbox.sidebar.widgets.teamStatus
    ])

    await sidebar
      .getByRole('button', {
        name: en.inbox.sidebar.moveUp.replace('{widget}', en.inbox.sidebar.widgets.teamStatus)
      })
      .click()
    await page.reload()
    await expect.poll(titles).toEqual([...before].reverse())

    // Put back for the other cases
    await sidebar
      .getByRole('button', {
        name: en.inbox.sidebar.moveDown.replace('{widget}', en.inbox.sidebar.widgets.teamStatus)
      })
      .click()
    await expect.poll(titles).toEqual(before)
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
