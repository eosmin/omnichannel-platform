import { type BrowserContext, type Page, type Request } from '@playwright/test'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { AuthorType, DeliveryStatus } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addMessageTo,
  newConversationIn,
  newTaggedConversationIn,
  statusOf,
  storeIdNamed
} from '../support/database'
import { pinAccountToUtc, seedAnchor } from '../support/day-anchor'
import { expectDialogFitsThePhoneWidth } from '../support/dialog-fit'
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
  let newAddress: () => void
  let restoreZone: () => Promise<void> = () => Promise.resolve()

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext()
    newAddress = await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    // The days the page draws are the days of UTC, whatever the machine of the browser is in
    restoreZone = await pinAccountToUtc('admin@test.com')
    await signIn(page, 'admin@test.com')
    storeId = await storeIdNamed(FIRST_STORE)
  })
  test.afterAll(async () => {
    // The zone goes back even when the browser does not close well
    try {
      await context.close()
    } finally {
      await restoreZone()
    }
  })
  // The cases share one session but not one minute of the limit of the api: GET /conversations was called
  // 97 times of the 100 a minute by the cases together, and one more list request in a slow run was
  // "Too many attempts" in a case that had nothing to do with it
  test.beforeEach(() => {
    newAddress()
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

  test('ticks two rows and queues their conversations as a CSV in the exports center', async () => {
    const first = await newConversationIn(storeId)
    const second = await newConversationIn(storeId)

    await page.goto(AppPaths.store.inbox(storeId))
    for (const id of [first, second]) {
      await rowOf(page, storeId, id).locator('xpath=following-sibling::label//input').check()
    }
    const bar = page.getByRole('region', { name: en.inbox.bulk.label })
    await bar.getByRole('button', { name: en.inbox.bulk.more.label }).click()
    await page.getByRole('menuitem', { name: en.inbox.bulk.more.exportCsv }).click()

    await expect(page.getByText(/The file of 2 conversations is being prepared/)).toBeVisible()
    // A file changes nothing, so there is no Undo and the conversations stay as they were
    await expect(page.getByRole('button', { name: en.inbox.bulk.result.undo })).toHaveCount(0)
    await page.getByRole('button', { name: en.inbox.bulk.result.viewExports }).click()
    await expect(page).toHaveURL(new RegExp(`/s/${storeId}/exports$`))
    await expect(
      page.getByRole('cell', { name: en.exports.types.conversations }).first()
    ).toBeVisible()
  })

  test('shortcuts: opens the help sheet with ? and closes it with Escape', async () => {
    await page.goto(AppPaths.store.inbox(storeId))
    await expect(page.getByRole('list', { name: en.inbox.listLabel })).toBeVisible()

    await page.keyboard.press('?')
    const sheet = page.getByRole('dialog', { name: en.inbox.shortcuts.title })
    await expect(sheet).toBeVisible()
    await expectDialogFitsThePhoneWidth(page, sheet)
    await expect(sheet.getByText(en.inbox.shortcuts.labels.list.NEXT_CONVERSATION)).toBeVisible()
    // The binding of the search is listed, with the words of what it does today
    await expect(sheet.getByText(en.inbox.shortcuts.labels.global.COMMAND_PALETTE)).toBeVisible()
    // With no conversation open the keys of a conversation do nothing, so the sheet does not list them
    const groups = en.inbox.shortcuts.groups
    await expect(sheet.getByRole('heading', { name: groups.list })).toBeVisible()
    await expect(sheet.getByRole('heading', { name: groups.global })).toBeVisible()
    await expect(sheet.getByRole('heading', { name: groups.conversation })).toHaveCount(0)

    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
  })

  test('shortcuts: g c goes to the customers without taking the cursor, so g i comes back', async () => {
    await page.goto(AppPaths.store.inbox(storeId))
    await expect(page.getByRole('list', { name: en.inbox.listLabel })).toBeVisible()

    await page.keyboard.press('g')
    await page.keyboard.press('c')
    await expect(page).toHaveURL(new RegExp(`${AppPaths.store.customers(storeId)}$`))
    const search = page.getByRole('searchbox', { name: en.customers.list.searchLabel })
    await expect(search).toBeVisible()
    await expect(search).not.toBeFocused()

    // With the cursor out of a text field the shortcuts still work: a keyboard user is not trapped
    await page.keyboard.press('g')
    await page.keyboard.press('i')
    await expect(page).toHaveURL(new RegExp(`${AppPaths.store.inbox(storeId)}`))
  })

  test('shortcuts: the help sheet lists the keys of the open conversation too', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    await page.keyboard.press('?')
    const sheet = page.getByRole('dialog', { name: en.inbox.shortcuts.title })
    // The list stays beside the conversation on a wide screen: all three groups work
    for (const group of Object.values(en.inbox.shortcuts.groups)) {
      await expect(sheet.getByRole('heading', { name: group })).toBeVisible()
    }
    await page.keyboard.press('Escape')
    await expect(sheet).toBeHidden()
  })

  // The browser of the suite reports Windows to the app, so `Mod` is Ctrl here
  test('shortcuts: Cmd/Ctrl+K goes to the search of customers and puts the cursor in it', async () => {
    await page.goto(AppPaths.store.inbox(storeId))
    await expect(page.getByRole('list', { name: en.inbox.listLabel })).toBeVisible()

    await page.keyboard.press('Control+k')
    await expect(page).toHaveURL(new RegExp(`${AppPaths.store.customers(storeId)}$`))
    const search = page.getByRole('searchbox', { name: en.customers.list.searchLabel })
    await expect(search).toBeFocused()

    // On that page the same keys bring the cursor back to the box, and a letter typed in it stays text
    await page.getByRole('heading', { name: en.customers.list.title }).click()
    await expect(search).not.toBeFocused()
    await page.keyboard.press('Control+k')
    await expect(search).toBeFocused()
    await page.keyboard.type('k')
    await expect(search).toHaveValue('k')
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

  test('the reply box keeps its draft: Escape does not leave, coming back restores it, sending clears it', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const box = page.getByRole('textbox', { name: en.inbox.composer.replyLabel })
    await box.fill('Still writing this')

    // With text, Escape leaves the box and stays in the conversation
    await page.keyboard.press('Escape')
    await expect(box).not.toBeFocused()
    await expect(page).toHaveURL(new RegExp(`/inbox/${conversationId}`))
    await expect(box).toHaveValue('Still writing this')

    // Out to the list and back in by the app's own links: few requests, since the api limits them
    await page.keyboard.press('g')
    await page.keyboard.press('i')
    await expect(page).toHaveURL(new RegExp(`${AppPaths.store.inbox(storeId)}$`))
    await rowOf(page, storeId, conversationId).click()
    const restored = page.getByRole('textbox', { name: en.inbox.composer.replyLabel })
    await expect(restored).toHaveValue('Still writing this')

    // Sending empties the box and keeps the keyboard in it: the next letters are text, never a shortcut
    await restored.focus()
    await page.keyboard.press('Enter')
    await expect(restored).toHaveValue('')
    await expect(restored).toBeFocused()
    await page.keyboard.type('er')
    await expect(restored).toHaveValue('er')
    expect(await statusOf(conversationId)).toBe('OPEN')

    // A click on Send keeps it too (the button turns off with the box empty and would drop the focus)
    await page.getByRole('button', { name: en.inbox.composer.send }).click()
    await expect(restored).toHaveValue('')
    await expect(restored).toBeFocused()
  })

  test('opening a conversation does not make the page scroll: the thread has its own scroll (W2)', async () => {
    const conversationId = await newConversationIn(storeId)
    // Sent replies carry a hidden text each ("Sent", `sr-only`, absolute): they must stay inside the thread
    // One reading of the clock, and a window that does not cross midnight
    const anchor = seedAnchor(14 * 60_000)
    for (let index = 0; index < 14; index += 1) {
      await addMessageTo(storeId, conversationId, {
        content: `Reply number ${index + 1}`,
        authorType: AuthorType.AGENT,
        deliveryStatus: DeliveryStatus.SENT,
        createdAt: new Date(anchor - (14 - index) * 60_000)
      })
    }
    const measure = (): Promise<{
      scrollHeight: number
      clientHeight: number
      scrollTop: number
    }> =>
      page.evaluate(() => {
        const root = document.scrollingElement ?? document.documentElement
        return {
          scrollHeight: root.scrollHeight,
          clientHeight: root.clientHeight,
          scrollTop: root.scrollTop
        }
      })
    try {
      // The conversation is opened once and the window is resized under it: the api limits what a
      // person asks for in a minute, and the layout answers to the width without a new load
      await page.setViewportSize({ width: 1536, height: 800 })
      await page.goto(AppPaths.store.conversation(storeId, conversationId))
      const box = page.getByRole('textbox', { name: en.inbox.composer.replyLabel })
      await expect(box).toBeVisible()
      for (const width of [1536, 1280, 485, 390]) {
        await page.setViewportSize({ width, height: 800 })
        await expect(box).toBeVisible()
        // The page is as tall as the window and stays at the top: no gap under the thread, no header lost
        const opened = await measure()
        expect(opened.scrollHeight, `at ${width} px`).toBe(opened.clientHeight)
        expect(opened.scrollTop, `at ${width} px`).toBe(0)
        // The wheel to the end of the thread, and past it, does not go on to the page
        await page.mouse.move(width / 2, 300)
        await page.mouse.wheel(0, 5000)
        await page.mouse.wheel(0, 5000)
        const afterWheel = await measure()
        expect(afterWheel.scrollTop, `after the wheel at ${width} px`).toBe(0)
        expect(afterWheel.scrollHeight, `after the wheel at ${width} px`).toBe(
          afterWheel.clientHeight
        )
        // And nothing is cut off: the top bar, the box to write in, and every control of the top bar that
        // the page clips if it overflows (the store and the account menus) are inside the window
        await expect(page.getByRole('banner')).toBeInViewport()
        await expect(box).toBeInViewport({ ratio: 1 })
        for (const name of [en.shell.switchStore, en.shell.accountMenu]) {
          const control = await page.getByRole('button', { name }).boundingBox()
          expect(control, `${name} at ${width} px`).not.toBeNull()
          expect(
            (control?.x ?? 0) + (control?.width ?? 0),
            `${name} at ${width} px`
          ).toBeLessThanOrEqual(width)
          expect(control?.x ?? -1, `${name} at ${width} px`).toBeGreaterThanOrEqual(0)
        }
        // The name of the customer can be read (it was 12 px wide at 390 px), and the store switcher shows
        // more than a letter of the name of the store
        const customerName = await page.getByRole('heading', { level: 1 }).boundingBox()
        expect(customerName?.width ?? 0, `customer name at ${width} px`).toBeGreaterThanOrEqual(120)
        const store = await page.getByRole('button', { name: en.shell.switchStore }).boundingBox()
        expect(store?.width ?? 0, `store switcher at ${width} px`).toBeGreaterThanOrEqual(110)
      }
      // The page of customers had the same header and overflowed sideways at 485 px (by the app's own link)
      await page.setViewportSize({ width: 485, height: 800 })
      await page.getByRole('link', { name: en.shell.nav.customers }).click()
      await expect(page).toHaveURL(new RegExp(`${AppPaths.store.customers(storeId)}`))
      const sideways = await page.evaluate(() => {
        const root = document.scrollingElement ?? document.documentElement
        return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth }
      })
      expect(sideways.scrollWidth, 'customers at 485 px').toBeLessThanOrEqual(sideways.clientWidth)
    } finally {
      await page.setViewportSize({ width: 1280, height: 720 })
    }
  })

  test('a dialog opens right after Escape closed one, and the browser Back closes it', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // Only the open one: the closed dialog stays in the page while it animates out
    const snooze = page
      .getByRole('dialog', { name: en.inbox.snooze.title })
      .and(page.locator('[data-state="open"]'))

    await page.keyboard.press('s')
    await expect(snooze).toBeVisible()
    await page.keyboard.press('Escape')
    // No wait for the animation
    await page.keyboard.press('s')
    await expect(snooze).toBeVisible()

    // Back to an entry of the same page, so only the dialog can react to it
    await page.evaluate(() => window.history.pushState(null, '', `${window.location.href}#back`))
    await page.goBack()
    await expect(snooze).toBeHidden()
  })

  test('shortcuts: e on a focused row asks the questions of the store before resolving', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.inbox(storeId))
    await rowOf(page, storeId, conversationId).focus()
    await expect.poll(() => focusedRow(page)).toBe(conversationId)

    await page.keyboard.press('e')
    const dialog = page.getByRole('dialog', { name: en.inbox.resolve.title })
    await expect(dialog).toBeVisible()
    await expectDialogFitsThePhoneWidth(page, dialog)
    // Nothing changed until the agent confirms
    expect(await statusOf(conversationId)).toBe('OPEN')

    await dialog.getByRole('button', { name: en.inbox.resolve.confirm }).click()
    await expect.poll(() => statusOf(conversationId)).toBe('RESOLVED')
    await expect(dialog).toBeHidden()
  })

  test('two Ctrl+Enter in the same instant resolve the conversation once (ATA-12)', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.inbox(storeId))
    await rowOf(page, storeId, conversationId).focus()
    await expect.poll(() => focusedRow(page)).toBe(conversationId)
    await page.keyboard.press('e')
    const dialog = page.getByRole('dialog', { name: en.inbox.resolve.title })
    await expect(dialog).toBeVisible()

    const statusRequests: string[] = []
    const countStatusRequest = (request: Request): void => {
      if (request.method() === 'PATCH' && /\/conversations\/[^/]+\/status/.test(request.url())) {
        statusRequests.push(request.url())
      }
    }
    page.on('request', countStatusRequest)
    try {
      // Both key presses in one task: the form has not re-rendered between them
      await dialog.getByLabel(en.inbox.resolve.reason).evaluate(field => {
        for (let press = 0; press < 2; press += 1) {
          field.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
          )
        }
      })
      await expect.poll(() => statusOf(conversationId)).toBe('RESOLVED')
      await expect(dialog).toBeHidden()
    } finally {
      page.off('request', countStatusRequest)
    }
    expect(statusRequests).toHaveLength(1)
  })

  test('resolving from the dialog offers the Undo, and it reopens the conversation', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.inbox(storeId))
    await rowOf(page, storeId, conversationId).focus()
    await expect.poll(() => focusedRow(page)).toBe(conversationId)
    await page.keyboard.press('e')
    const dialog = page.getByRole('dialog', { name: en.inbox.resolve.title })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: en.inbox.resolve.confirm }).click()
    await expect.poll(() => statusOf(conversationId)).toBe('RESOLVED')

    await page.getByRole('button', { name: en.common.undo }).click()
    await expect.poll(() => statusOf(conversationId)).toBe('OPEN')
  })

  test('a tag with a long name without spaces does not widen the page at 390 px (TRX-04)', async () => {
    const tagName = `Long${'x'.repeat(56)}${Date.now()}`
    const { tagId } = await newTaggedConversationIn(storeId, tagName)
    expect(tagId).not.toBe('')
    try {
      await page.setViewportSize({ width: 390, height: 800 })
      await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.TAGS))
      await expect(page.getByRole('heading', { name: tagName })).toBeVisible()
      const sideways = await page.evaluate(() => {
        const root = document.scrollingElement ?? document.documentElement
        return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth }
      })
      expect(sideways.scrollWidth).toBeLessThanOrEqual(sideways.clientWidth)
    } finally {
      await page.setViewportSize({ width: 1280, height: 720 })
    }
  })

  test('shortcuts: e pressed before the settings of the store arrive is not lost', async () => {
    const conversationId = await newConversationIn(storeId)
    // The settings that the resolve flow needs are held until the key was pressed
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    await page.route('**/settings/inbox/behavior', async route => {
      await held
      await route.fallback()
    })
    try {
      await page.goto(AppPaths.store.conversation(storeId, conversationId))
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await page.keyboard.press('e')
      await expect(page.getByRole('dialog', { name: en.inbox.resolve.title })).toHaveCount(0)
      release()
      await expect(page.getByRole('dialog', { name: en.inbox.resolve.title })).toBeVisible()
    } finally {
      release()
      await page.unroute('**/settings/inbox/behavior')
    }
  })

  test('shortcuts: e opens the options of Resolve and Cmd/Ctrl+Enter confirms from the box of the reason', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.inbox(storeId))
    await rowOf(page, storeId, conversationId).focus()
    await expect.poll(() => focusedRow(page)).toBe(conversationId)

    await page.keyboard.press('e')
    const dialog = page.getByRole('dialog', { name: en.inbox.resolve.title })
    await expect(dialog).toBeVisible()
    // The focus starts on a field of the form, not on a button: no Tab is spent getting to the choices
    await expect(dialog.locator('input:focus, select:focus, textarea:focus')).toHaveCount(1)
    await expect(dialog.getByRole('button', { name: en.common.cancel })).not.toBeFocused()
    const confirm = dialog.getByRole('button', { name: en.inbox.resolve.confirm })
    await expect(confirm).toHaveAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter')

    // A plain Enter in the box of the reason is a line break and resolves nothing
    const reason = dialog.getByLabel(en.inbox.resolve.reason)
    await reason.fill('Paid')
    await reason.press('Enter')
    expect(await statusOf(conversationId)).toBe('OPEN')
    await expect(dialog).toBeVisible()

    // On Cancel the same keys decide nothing
    const cancel = dialog.getByRole('button', { name: en.common.cancel })
    await cancel.focus()
    await cancel.press('Control+Enter')
    expect(await statusOf(conversationId)).toBe('OPEN')
    await expect(dialog).toBeVisible()

    // The suite's browser reports Windows to the app, so `Mod` is Ctrl here
    await reason.press('Control+Enter')
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
      en.inbox.sidebar.widgets.myPerformance,
      en.inbox.sidebar.widgets.quickActions,
      en.inbox.sidebar.widgets.unassignedQueue,
      en.inbox.sidebar.widgets.teamStatus
    ])

    await sidebar
      .getByRole('button', {
        name: en.inbox.sidebar.moveUp.replace('{widget}', en.inbox.sidebar.widgets.teamStatus)
      })
      .click()
    await page.reload()
    // Team status moved above the queue; the two widgets on top stay first
    await expect.poll(titles).toEqual([before[0], before[1], before[3], before[2]])

    // Put back for the other cases
    await sidebar
      .getByRole('button', {
        name: en.inbox.sidebar.moveDown.replace('{widget}', en.inbox.sidebar.widgets.teamStatus)
      })
      .click()
    await expect.poll(titles).toEqual(before)
  })

  test('shows the customer of the conversation in the sidebar and opens the profile with Shift+C', async () => {
    const conversationId = await newConversationIn(storeId)

    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const sidebar = page.getByRole('complementary', { name: en.inbox.sidebar.label })
    await expect(sidebar.getByRole('heading', { name: en.customers.panel.title })).toBeVisible()
    await expect(sidebar.getByText(en.customers.profile.stats.conversations)).toBeVisible()

    // The shortcut waits for the thread to be loaded: it works where the button would be offered
    await expect(page.getByRole('button', { name: en.inbox.openCustomer })).toBeVisible()
    await page.keyboard.press('Shift+C')
    const drawer = page.getByRole('dialog', { name: en.customers.profile.title })
    await expect(drawer).toBeVisible()
    await expect(
      drawer.getByRole('tab', { name: en.customers.timeline.filters.note })
    ).toBeVisible()
    // The conversation itself is the first entry of the activity
    await expect(
      drawer.getByRole('link', { name: en.customers.timeline.openConversation })
    ).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()

    // The same drawer opens from the button, for the widths with no sidebar
    await page.getByRole('button', { name: en.inbox.openCustomer }).click()
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
  })

  test('finds a customer from the sidebar, edits the profile and jumps back with g i', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const sidebar = page.getByRole('complementary', { name: en.inbox.sidebar.label })
    await sidebar.getByRole('link', { name: en.inbox.sidebar.quick.findCustomer }).click()
    await expect(page).toHaveURL(new RegExp(`${AppPaths.store.customers(storeId)}$`))
    await expect(page.getByRole('searchbox', { name: en.customers.list.searchLabel })).toBeFocused()

    // Any customer: the first row opens the drawer, where the name is changed
    const table = page.getByRole('table', { name: en.customers.list.title })
    await table.getByRole('button').first().click()
    const drawer = page.getByRole('dialog', { name: en.customers.profile.title })
    await drawer.getByRole('button', { name: en.customers.edit.editProfile }).click()
    const name = `Edited ${Date.now()}`
    await drawer.getByLabel(en.customers.edit.name).fill(name)
    await drawer.getByRole('button', { name: en.customers.edit.save }).click()
    await expect(drawer.getByText(name)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()

    // The shortcut of the page goes back to the inbox
    await page.locator('body').click()
    await page.keyboard.press('g')
    await page.keyboard.press('i')
    await expect(page).toHaveURL(new RegExp(`${AppPaths.store.inbox(storeId)}`))
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
