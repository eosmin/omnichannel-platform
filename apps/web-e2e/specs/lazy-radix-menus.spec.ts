import { type Browser, type Page, type Route } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newConversationIn, setResolveBehavior, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const AGENT = 'agent2@test.com'
const shell = en.shell

const startsWith = (template: string): RegExp => new RegExp(`^${template.split('{')[0] ?? ''}`)

// The menus, the panel of notifications and the dialog of resolving are downloaded when the person reaches for
// their button (they are not part of the first load of the inbox: apps/web-e2e/lighthouse/budgets.ts). What
// the person sees and does must be what a menu of Radix always gave: opens on the press and on the keyboard,
// moves the focus in, closes with Escape and gives the focus back to the button.
async function inboxPage(browser: Browser): Promise<{ page: Page; storeId: string }> {
  const context = await browser.newContext()
  await reachServicesFromOwnAddress(context)
  const page = await context.newPage()
  await signIn(page, AGENT)
  const storeId = await storeIdNamed(FIRST_STORE)
  await page.goto(AppPaths.store.inbox(storeId))
  return { page, storeId }
}

// Its own session and address: the api limits the requests of each address
test('the account menu and the store switcher open with the pointer and with the keyboard, and give the focus back', async ({
  browser
}) => {
  const { page } = await inboxPage(browser)
  try {
    const button = page.getByRole('button', { name: shell.accountMenu })
    await expect(button).toHaveAttribute('aria-haspopup', 'menu')
    await expect(button).toHaveAttribute('aria-expanded', 'false')

    // A slow network: the press is not lost. The code takes a second and a half; the plain button waits, and the
    // menu opens by itself when the code is here
    const slow = async (route: Route): Promise<void> => {
      await new Promise(resolve => setTimeout(resolve, 1_500))
      await route.continue()
    }
    await page.route('**/_next/static/chunks/*.js', slow)
    await button.click()
    await expect(page.getByRole('menuitem', { name: shell.account })).toBeVisible({
      timeout: 15_000
    })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await page.unroute('**/_next/static/chunks/*.js', slow)

    // The pointer: the first press opens it as soon as the code is here, and the focus goes into the menu
    await button.click()
    const account = page.getByRole('menuitem', { name: shell.account })
    await expect(account).toBeVisible()
    await expect(page.getByRole('menu')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(account).toHaveCount(0)
    await expect(button).toBeFocused()

    // The keyboard: Enter and the arrow down on the button
    await page.keyboard.press('Enter')
    await expect(account).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(account).toHaveCount(0)
    await expect(button).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(account).toBeVisible()
    // The arrows move through the items, and the sign-out one is the last
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: en.common.signOut })).toBeFocused()
    await page.keyboard.press('Escape')

    // The store switcher, the same way
    const switcher = page.getByRole('button', { name: shell.switchStore })
    await expect(switcher).toHaveAttribute('aria-haspopup', 'menu')
    await switcher.focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('menuitem', { name: new RegExp(FIRST_STORE) })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(switcher).toBeFocused()
    await switcher.click()
    await expect(page.getByRole('menu')).toBeVisible()
  } finally {
    await page.context().close()
  }
})

test('the bell opens the notifications panel as a dialog, closes with Escape and gets the focus back', async ({
  browser
}) => {
  const { page } = await inboxPage(browser)
  try {
    const bell = page.getByRole('button', { name: startsWith(shell.notifications.open) })
    await expect(bell).toHaveAttribute('aria-haspopup', 'dialog')
    await expect(bell).toHaveAttribute('aria-expanded', 'false')
    await bell.click()
    const panel = page.getByRole('dialog', { name: shell.notifications.title })
    await expect(panel).toBeVisible()
    // The page behind a dialog is hidden from the accessibility tree: read the button by its attribute
    await expect(page.locator('[aria-haspopup=dialog][aria-expanded=true]')).toHaveCount(1)
    // The focus is trapped in the panel: Tab does not leave it
    for (let step = 0; step < 6; step += 1) await page.keyboard.press('Tab')
    expect(await panel.evaluate(element => element.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await expect(bell).toBeFocused()
    // And again, from the keyboard
    await page.keyboard.press('Enter')
    await expect(panel).toBeVisible()
  } finally {
    await page.context().close()
  }
})

test('the arrow of a row opens its menu from the keyboard, and Shift+E opens the options of resolving', async ({
  browser
}) => {
  const { page, storeId } = await inboxPage(browser)
  try {
    await setResolveBehavior(storeId, { showOptions: false, closingSnippetId: null })
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.inbox(storeId))
    const row = page.locator(`[data-conversation-id="${conversationId}"]`)
    await expect(row).toBeVisible()
    const arrow = row.getByRole('button', { name: startsWith(en.inbox.actions.resolveRowMore) })
    await arrow.focus()
    await expect(arrow).toHaveAttribute('aria-haspopup', 'menu')
    await page.keyboard.press('Enter')
    const options = page.getByRole('menuitem', {
      name: new RegExp(en.inbox.actions.resolveWithOptions.replace('…', ''))
    })
    await expect(options).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(options).toHaveCount(0)
    await expect(arrow).toBeFocused()

    // The key of the other way, with the conversation open: the dialog is downloaded the first time
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const dialog = page.getByRole('dialog', { name: en.inbox.resolve.title })
    await expect(
      page.getByRole('button', { name: en.inbox.actions.resolveMore, exact: true })
    ).toBeVisible()
    await page.keyboard.press('Shift+E')
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  } finally {
    await setResolveBehavior(storeId, { showOptions: true, closingSnippetId: null })
    await page.context().close()
  }
})
