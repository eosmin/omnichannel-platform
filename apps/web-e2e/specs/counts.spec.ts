import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds every permission, counting and applying included
const ADMIN = 'multi-store@test.com'
const COUNTS = en.counts
const PRODUCTS = en.products
// The dev fixtures give each of their 30 products 20 units in the default warehouse. Other specs use other products
// (and "Fixture product 7"): these three are this spec's own
const ITEM_A = 'Fixture product 11'
const ITEM_B = 'Fixture product 12'
const ITEM_C = 'Fixture product 13'

const uniqueNote = (): string => `Count e2e ${randomUUID().slice(0, 8)}`
const COUNT_URL = /\/org\/counts\/[0-9a-f-]{36}$/

// A count from a phone: a narrow touch screen, as in the aisle of a warehouse
test.describe('a physical count', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string

  const quantityOf = (name: string) =>
    page.getByLabel(COUNTS.sheet.quantityOf.replace('{name}', name), { exact: true })
  const cardOf = (name: string) => page.getByRole('listitem').filter({ hasText: name })
  const status = (text: string) => page.getByText(text, { exact: true }).first()
  const progress = () => page.getByRole('status').filter({ hasText: / of \d+ counted/ })
  const patchOfLines = (on: Page = page) =>
    on.waitForResponse(
      response =>
        /\/counts\/[0-9a-f-]{36}\/lines$/.test(response.url()) &&
        response.request().method() === 'PATCH' &&
        response.ok(),
      { timeout: 45_000 }
    )

  // Types a quantity and waits for the api to confirm it
  async function count(name: string, quantity: string): Promise<void> {
    const saved = patchOfLines()
    await quantityOf(name).fill(quantity)
    await saved
  }

  async function searchFor(text: string): Promise<void> {
    await page.getByLabel(COUNTS.sheet.search).fill(text)
  }

  async function createCount(note: string): Promise<void> {
    await page.goto(AppPaths.org.counts)
    await expect(page.getByRole('heading', { name: COUNTS.title })).toBeVisible()
    await page.getByRole('button', { name: COUNTS.new }).click()
    const dialog = page.getByRole('dialog', { name: COUNTS.create.title })
    await dialog
      .getByLabel(COUNTS.create.warehouse)
      .selectOption({ label: 'MAIN · Main warehouse' })
    await dialog.getByLabel(COUNTS.create.scope).selectOption({ label: FIRST_STORE })
    await dialog.getByLabel(COUNTS.create.note).fill(note)
    await dialog.getByRole('button', { name: COUNTS.create.submit }).click()
    await page.waitForURL(COUNT_URL)
  }

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({
      locale: 'en',
      viewport: { width: 390, height: 844 },
      hasTouch: true
    })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('makes a count of a warehouse limited to a store, as a draft, and starts it to take the snapshot', async () => {
    const note = uniqueNote()
    await createCount(note)
    await expect(page.getByRole('heading', { level: 1, name: /^CT-\d{4,}$/ })).toBeVisible()
    await expect(status(COUNTS.status.draft)).toBeVisible()
    await expect(page.getByText(COUNTS.draftNote)).toBeVisible()
    await expect(page.getByText(note)).toBeVisible()
    await expect(page.getByText(COUNTS.scopeStore.replace('{store}', FIRST_STORE))).toBeVisible()

    await page.getByRole('button', { name: COUNTS.actions.start }).click()
    await expect(status(COUNTS.status.counting)).toBeVisible()
    await expect(progress()).toContainText(/^0 of \d+ counted$/)
    // The quantity the warehouse should hold is not on the sheet: counting starts from what is on the shelf
    await expect(page.getByText(COUNTS.review.expected)).toHaveCount(0)
  })

  test('counts by searching, saves each quantity, and refuses a quantity that is not whole units', async () => {
    await searchFor(ITEM_A)
    await expect(cardOf(ITEM_A)).toHaveCount(1)
    await count(ITEM_A, '18')
    await searchFor(ITEM_B)
    await count(ITEM_B, '21')
    await expect(progress()).toContainText(/^2 of \d+ counted$/)

    await searchFor(ITEM_C)
    await quantityOf(ITEM_C).fill('abc')
    await expect(cardOf(ITEM_C).getByText(COUNTS.sheet.invalidQuantity)).toBeVisible()
    await expect(progress()).toContainText(/^2 of \d+ counted$/)
    // The filter of the lines still to count leaves out the ones already counted
    await searchFor('')
    await page.getByRole('button', { name: COUNTS.sheet.filters.uncounted, exact: true }).click()
    await expect(cardOf(ITEM_A)).toHaveCount(0)
    await page.getByRole('button', { name: COUNTS.sheet.filters.all, exact: true }).click()
  })

  test('keeps what was typed without a signal, and sends it when the signal is back', async () => {
    await searchFor(ITEM_C)
    await context.setOffline(true)
    await quantityOf(ITEM_C).fill('20')
    await expect(page.getByText(/waiting for a signal/)).toBeVisible({ timeout: 20_000 })
    // The sheet shows the line as counted even though the api has not heard of it yet
    await expect(progress()).toContainText(/^3 of \d+ counted$/)
    const saved = patchOfLines()
    await context.setOffline(false)
    await saved
    await expect(page.getByText(COUNTS.sheet.save.saved)).toBeVisible()
  })

  test('opens again with every quantity where it was left', async () => {
    await page.reload()
    await expect(progress()).toContainText(/^3 of \d+ counted$/)
    await searchFor(ITEM_A)
    await expect(quantityOf(ITEM_A)).toHaveValue('18')
  })

  test('sends the count to review, where the difference is against the snapshot and the lines not counted stay out', async () => {
    await page.getByRole('button', { name: COUNTS.actions.submit }).click()
    await expect(status(COUNTS.status.review)).toBeVisible()
    await expect(page.getByText(COUNTS.review.snapshotNote)).toBeVisible()
    // 18 counted against 20 held: two units less; 21 against 20: one more; 20 against 20 is not a difference
    await expect(cardOf(ITEM_A)).toContainText('-2')
    await expect(cardOf(ITEM_B)).toContainText('+1')
    await expect(cardOf(ITEM_C)).toHaveCount(0)
    await expect(page.getByText(/lines were not counted and stay as they are/)).toBeVisible()
  })

  test('sends the count back to counting to recount, and to review again', async () => {
    await page.getByRole('button', { name: COUNTS.actions.reopen }).click()
    await expect(status(COUNTS.status.counting)).toBeVisible()
    await expect(progress()).toContainText(/^3 of \d+ counted$/)
    await page.getByRole('button', { name: COUNTS.actions.submit }).click()
    await expect(status(COUNTS.status.review)).toBeVisible()
  })

  test('asks before applying, applies only the difference, and the stock of the product shows it', async () => {
    await page.getByRole('button', { name: COUNTS.actions.apply }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText(/Sales and transfers made while counting are not touched/)
    await dialog.getByRole('button', { name: COUNTS.apply.confirm }).click()
    await expect(status(COUNTS.status.applied)).toBeVisible()
    await expect(page.getByText(COUNTS.review.appliedNote)).toBeVisible()
    await expect(page.getByRole('button', { name: COUNTS.actions.apply })).toHaveCount(0)

    await page.goto(AppPaths.store.products(storeId))
    await page.getByLabel(PRODUCTS.searchLabel).fill(ITEM_A)
    await page.getByRole('button', { name: ITEM_A, exact: true }).click()
    const sheet = page.getByRole('dialog', { name: PRODUCTS.sheet.editTitle })
    await sheet.getByRole('tab', { name: PRODUCTS.sheet.tabs.stock }).click()
    await expect(sheet.getByRole('row').filter({ hasText: 'MAIN' })).toContainText('18')
  })

  test('discards a draft after asking', async () => {
    await createCount(uniqueNote())
    await page.getByRole('button', { name: COUNTS.actions.cancel }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toContainText(COUNTS.cancel.descriptionDraft)
    await dialog.getByRole('button', { name: COUNTS.cancel.confirm }).click()
    await expect(status(COUNTS.status.cancelled)).toBeVisible()
    await expect(page.getByText(COUNTS.cancelledNote)).toBeVisible()
    await expect(page.getByRole('button', { name: COUNTS.actions.start })).toHaveCount(0)
  })

  test('lists the counts, filters them by state and opens one', async () => {
    await page.goto(AppPaths.org.counts)
    await expect(page.getByRole('heading', { name: COUNTS.title })).toBeVisible()
    await page.getByLabel(COUNTS.filter).selectOption({ label: COUNTS.status.applied })
    const rows = page.getByRole('link').filter({ hasText: /^CT-/ })
    await expect(rows.first()).toBeVisible()
    await expect(rows.filter({ hasText: COUNTS.status.cancelled })).toHaveCount(0)
    await rows.first().click()
    await page.waitForURL(COUNT_URL)
    await expect(status(COUNTS.status.applied)).toBeVisible()
  })
})
