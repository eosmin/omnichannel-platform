import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addOwnerOfNewStore,
  addTransferScenario,
  storeIdNamed,
  type TransferScenario
} from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const SCREEN = en.stock
const STOCK = en.products.stock
const FIRST_STORE = 'Main Store'
// A viewer of the first store: it reads stock, adjusts nothing and edits no product
const VIEWER = 'viewer@test.com'
const PHONE = { width: 390, height: 844 }

// The stock screen of the store (`/s/[storeId]/inventory`), through the screen: search, the alert threshold, the
// low-stock list the notice links to, the adjustment and the movements of an item, on a phone and with no way to
// change anything for a person who may only read. Its own store: the stock the cases change is nobody else's.
test.describe('Inventory of the store', () => {
  test.describe.configure({ mode: 'serial' })

  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-store-stock-${run}@example.com`
  let context: BrowserContext
  let page: Page
  let storeId = ''
  let scenario: TransferScenario

  const card = (on: Page = page) =>
    on
      .getByRole('listitem')
      .filter({ has: on.getByRole('heading', { name: scenario.productName }) })

  test.beforeAll(async ({ browser }) => {
    storeId = await addOwnerOfNewStore(ownerEmail, `E2E Store Stock ${run}`)
    scenario = await addTransferScenario(storeId, run, 10)
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('is in the navigation, lists the items with their numbers, and searches by name', async () => {
    await page.goto(AppPaths.store.inbox(storeId))
    await page
      .getByRole('navigation', { name: en.shell.nav.label })
      .getByRole('link', { name: en.shell.nav.inventory })
      .click()
    await expect(page).toHaveURL(AppPaths.store.inventory(storeId))
    await expect(page.getByRole('heading', { level: 1, name: SCREEN.title })).toBeVisible()

    await expect(card()).toContainText(scenario.from.code)
    for (const [label, units] of [
      [STOCK.columns.onHand, '10'],
      [STOCK.columns.reserved, '0'],
      [STOCK.columns.available, '10']
    ] as const) {
      await expect(
        card()
          .locator('div')
          .filter({ has: page.getByText(label, { exact: true }) })
          .first()
      ).toContainText(units)
    }
    await expect(card()).toContainText(SCREEN.card.noThreshold)

    await page.getByLabel(SCREEN.searchLabel).fill(`nothing called ${run}`)
    await expect(page.getByText(SCREEN.noMatches)).toBeVisible()
    await expect(page).toHaveURL(/[?&]q=/)
    await page.getByRole('button', { name: SCREEN.filter.clear }).click()
    await expect(card()).toBeVisible()
    await expect(page).not.toHaveURL(/[?&]q=/)
    await page.getByLabel(SCREEN.searchLabel).fill(scenario.productName.toUpperCase())
    await expect(card()).toBeVisible()
  })

  test('sets the alert threshold, and the low-stock list the notice links to shows the item until it recovers', async () => {
    await page.goto(AppPaths.store.inventory(storeId))
    await card()
      .getByRole('button', { name: /Change the alert threshold/ })
      .click()
    const dialog = page.getByRole('dialog', {
      name: SCREEN.threshold.title.replace('{product}', scenario.productName)
    })
    // Nothing is sent for a number that is not whole
    await dialog.getByLabel(SCREEN.threshold.label).fill('abc')
    await dialog.getByRole('button', { name: SCREEN.threshold.submit }).click()
    await expect(dialog.getByText(SCREEN.threshold.invalid)).toBeVisible()
    await dialog.getByLabel(SCREEN.threshold.label).fill('20')
    await dialog.getByRole('button', { name: SCREEN.threshold.submit }).click()
    await expect(page.getByText(SCREEN.threshold.saved)).toBeVisible()
    await expect(card()).toContainText('Alert at 20 units')

    // The link of the notice opens the list already narrowed to what is low
    await page.goto(AppPaths.store.inventoryLow(storeId))
    await expect(page.getByLabel(SCREEN.filter.lowStock)).toBeChecked()
    await expect(card()).toContainText(STOCK.low)

    // 10 available against an alert at 5: no longer low
    await card()
      .getByRole('button', { name: /Change the alert threshold/ })
      .click()
    await page.getByRole('dialog').getByLabel(SCREEN.threshold.label).fill('5')
    await page.getByRole('dialog').getByRole('button', { name: SCREEN.threshold.submit }).click()
    await expect(page.getByText(SCREEN.emptyLow)).toBeVisible()
    await expect(card()).toHaveCount(0)
  })

  test('receives stock from an item, and its movements show the receipt with what is on hand after it', async () => {
    await page.goto(AppPaths.store.inventory(storeId))
    await card()
      .getByRole('button', { name: /^Adjust stock of / })
      .click()
    const dialog = page.getByRole('dialog', { name: STOCK.dialog.title })
    await expect(dialog).toBeVisible()
    // The warehouse of the row is where the form starts
    await expect(dialog.getByLabel(STOCK.dialog.warehouse)).toHaveValue(scenario.from.id)
    await dialog
      .getByLabel(STOCK.dialog.action)
      .selectOption({ label: STOCK.dialog.actions.receive })
    await dialog.getByLabel(STOCK.dialog.reason).selectOption({ label: STOCK.reasons.other })
    await dialog.getByLabel(STOCK.dialog.quantity).fill('3')
    await dialog.getByRole('button', { name: STOCK.dialog.submit }).click()
    await expect(page.getByText(STOCK.dialog.saved)).toBeVisible()
    await expect(
      card()
        .locator('div')
        .filter({ has: page.getByText(STOCK.columns.onHand, { exact: true }) })
        .first()
    ).toContainText('13')

    await card()
      .getByRole('button', { name: /^Movements of / })
      .click()
    const region = card().getByRole('region')
    const receipt = region.getByRole('row').filter({ hasText: STOCK.types.receipt }).first()
    await expect(receipt).toContainText('+3')
    await expect(receipt).toContainText('13')
  })

  test('fits a phone without scrolling sideways, with the buttons at the top of each card', async ({
    browser
  }) => {
    const phone = await browser.newContext({
      locale: 'en',
      viewport: PHONE,
      hasTouch: true,
      isMobile: true
    })
    await reachServicesFromOwnAddress(phone)
    const phonePage = await phone.newPage()
    try {
      await signIn(phonePage, ownerEmail)
      await phonePage.waitForURL(/\/s\/[^/]+\//)
      await phonePage.goto(AppPaths.store.inventory(storeId))
      await expect(card(phonePage)).toBeVisible()
      const sideways = await phonePage.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth
      )
      expect(sideways).toBe(false)
      // Every button of the card is on the screen of a phone, with a touch area of at least 40 px
      for (const button of await card(phonePage).getByRole('button').all()) {
        const box = await button.boundingBox()
        expect(box).not.toBeNull()
        expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(PHONE.width)
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(40)
      }
    } finally {
      await phone.close()
    }
  })

  test('shows a member who may only read the stock, with no way to change it', async ({
    browser
  }) => {
    const viewerContext = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(viewerContext)
    const viewer = await viewerContext.newPage()
    try {
      await signIn(viewer, VIEWER)
      const firstStore = await storeIdNamed(FIRST_STORE)
      await viewer.goto(AppPaths.store.inventory(firstStore))
      await expect(viewer.getByRole('heading', { level: 1, name: SCREEN.title })).toBeVisible()
      const list = viewer.getByRole('list', { name: SCREEN.listLabel })
      await expect(list.getByRole('listitem').first()).toBeVisible()
      await expect(viewer.getByRole('button', { name: /^Movements of / }).first()).toBeVisible()
      await expect(viewer.getByRole('button', { name: /^Adjust stock of / })).toHaveCount(0)
      await expect(viewer.getByRole('button', { name: /Change the alert threshold/ })).toHaveCount(
        0
      )
    } finally {
      await viewerContext.close()
    }
  })
})
