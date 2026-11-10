import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds every permission, the cost included
const ADMIN = 'multi-store@test.com'
// A viewer of the first store: it reads products and stock, adjusts nothing and does not see costs
const VIEWER = 'viewer@test.com'
const PRODUCTS = en.products
const STOCK = PRODUCTS.stock
// The dev fixtures give each of their 30 products 20 units in the default warehouse, at a cost of their own
const FIXTURE = 'Fixture product 7'

const uniqueName = (label: string): string => `${label} ${randomUUID().slice(0, 8)}`

test.describe('the stock of a product', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string
  const name = uniqueName('Stock shoe')

  const sheet = () => page.getByRole('dialog', { name: PRODUCTS.sheet.editTitle, exact: true })
  const adjustDialog = () => page.getByRole('dialog', { name: STOCK.dialog.title })

  async function openProducts(on: Page = page): Promise<void> {
    await on.goto(AppPaths.store.products(storeId))
    await expect(on.getByRole('heading', { name: PRODUCTS.title })).toBeVisible()
  }

  // Finds the product by its name in the search box, which asks the api from two characters
  async function openProduct(productName: string, on: Page = page): Promise<void> {
    await openProducts(on)
    await on.getByLabel(PRODUCTS.searchLabel).fill(productName)
    await on.getByRole('button', { name: productName, exact: true }).click()
    await expect(on.getByRole('dialog', { name: PRODUCTS.sheet.editTitle })).toBeVisible()
  }

  async function openStock(on: Page = page): Promise<void> {
    await on
      .getByRole('dialog', { name: PRODUCTS.sheet.editTitle })
      .getByRole('tab', { name: PRODUCTS.sheet.tabs.stock })
      .click()
    await expect(on.getByRole('heading', { name: STOCK.heading })).toBeVisible()
  }

  async function adjust(options: {
    action: string
    units: string
    reason?: string
  }): Promise<void> {
    await page.getByRole('button', { name: STOCK.adjust }).first().click()
    const dialog = adjustDialog()
    await expect(dialog).toBeVisible()
    // The button of the panel header has no row to start from, and the store has two warehouses
    await dialog.getByLabel(STOCK.dialog.warehouse).selectOption({ label: 'MAIN · Main warehouse' })
    await dialog.getByLabel(STOCK.dialog.action).selectOption({ label: options.action })
    if (options.reason !== undefined) {
      await dialog.getByLabel(STOCK.dialog.reason).selectOption({ label: options.reason })
    }
    await dialog.getByLabel(STOCK.dialog.quantity).fill(options.units)
    await dialog.getByRole('button', { name: STOCK.dialog.submit }).click()
  }

  // The kardex of the product row of the MAIN warehouse (the panel has other regions: its own section is one)
  const kardexRegion = () =>
    sheet().getByRole('region', {
      name: STOCK.movementsOf.replace('{item}', STOCK.productRow).replace('{warehouse}', 'MAIN')
    })
  const totals = () => page.locator('dl').filter({ hasText: STOCK.totals.available })

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('shows what the list says is available, and the levels by warehouse with their cost for who may see it', async () => {
    await openProducts()
    await page.getByLabel(PRODUCTS.searchLabel).fill(FIXTURE)
    const row = page.getByRole('row').filter({ hasText: FIXTURE })
    await expect(row).toContainText('20 available')
    await expect(page.getByRole('columnheader', { name: PRODUCTS.columns.stock })).toBeVisible()

    await row.getByRole('button', { name: FIXTURE, exact: true }).click()
    await openStock()
    const level = sheet().getByRole('row').filter({ hasText: 'MAIN' })
    await expect(level).toContainText('20')
    for (const [label, units] of [
      [STOCK.totals.onHand, '20'],
      [STOCK.totals.reserved, '0'],
      [STOCK.totals.available, '20']
    ] as const) {
      await expect(
        totals()
          .locator('div')
          .filter({ has: page.getByText(label, { exact: true }) })
      ).toContainText(units)
    }
    // The administrator holds products:view_cost: the value of the units and their average cost are columns
    await expect(
      sheet().getByRole('columnheader', { name: STOCK.columns.averageCost })
    ).toBeVisible()
    await expect(level).toContainText('$23.00')
  })

  test('receives stock for a new product, and the kardex shows the movement with what is on hand after it', async () => {
    await openProducts()
    await page.getByRole('button', { name: PRODUCTS.newProduct }).click()
    const creating = page.getByRole('dialog', { name: PRODUCTS.sheet.newTitle })
    await creating.getByLabel(PRODUCTS.form.name, { exact: true }).fill(name)
    await creating.getByLabel(PRODUCTS.form.price).fill('15')
    await creating.getByRole('button', { name: PRODUCTS.form.create }).click()
    await expect(sheet()).toBeVisible()
    await openStock()
    await expect(sheet().getByText(STOCK.empty)).toBeVisible()

    // Nothing is sent for a number that is not whole units
    await page.getByRole('button', { name: STOCK.adjust }).first().click()
    await adjustDialog()
      .getByLabel(STOCK.dialog.warehouse)
      .selectOption({ label: 'MAIN · Main warehouse' })
    await adjustDialog().getByLabel(STOCK.dialog.quantity).fill('2.5')
    await adjustDialog().getByRole('button', { name: STOCK.dialog.submit }).click()
    await expect(adjustDialog().getByText(STOCK.dialog.errors.quantity)).toBeVisible()
    await adjustDialog().getByLabel(STOCK.dialog.quantity).fill('12')
    await adjustDialog().getByRole('button', { name: STOCK.dialog.submit }).click()
    await expect(page.getByText(STOCK.dialog.saved)).toBeVisible()

    await expect(sheet().getByRole('row').filter({ hasText: 'MAIN' })).toContainText('12')
    await sheet().getByRole('button', { name: STOCK.movements }).click()
    const kardex = kardexRegion()
    const receipt = kardex.getByRole('row').filter({ hasText: STOCK.types.receipt })
    await expect(receipt).toContainText('+12')
    await expect(receipt).toContainText(STOCK.reasons.opening_stock)
  })

  test('takes units out for a reason, refuses more than there is in words, and keeps the kardex in order', async () => {
    await openProduct(name)
    await openStock()

    await adjust({ action: STOCK.dialog.actions.remove, units: '5', reason: STOCK.reasons.lost })
    await expect(page.getByText(STOCK.dialog.saved)).toBeVisible()
    await expect(sheet().getByRole('row').filter({ hasText: 'MAIN' })).toContainText('7')

    // More than is on hand: the api says so and the dialog shows it, with what was typed still there
    await adjust({ action: STOCK.dialog.actions.remove, units: '50', reason: STOCK.reasons.lost })
    await expect(adjustDialog().getByText(en.errors.INSUFFICIENT_INVENTORY)).toBeVisible()
    await expect(adjustDialog().getByLabel(STOCK.dialog.quantity)).toHaveValue('50')
    await adjustDialog().getByRole('button', { name: STOCK.dialog.cancel }).click()

    await sheet().getByRole('button', { name: STOCK.movements }).click()
    const rows = kardexRegion().getByRole('row')
    // Header, then newest first: the removal (on hand 7), then the receipt (12)
    await expect(rows.nth(1)).toContainText(STOCK.types.adjustment_out)
    await expect(rows.nth(1)).toContainText(/[-\u2212]5/)
    await expect(rows.nth(2)).toContainText(STOCK.types.receipt)
  })

  test('warns in the panel and in the list when the available stock is at the alert threshold, and stops when it recovers', async () => {
    await openProduct(name)
    await sheet().getByLabel(PRODUCTS.form.lowStockThreshold).fill('8')
    await sheet().getByRole('button', { name: PRODUCTS.form.save }).click()
    await expect(page.getByText(PRODUCTS.form.saved)).toBeVisible()
    await openStock()
    // 7 available, alert at 8
    await expect(sheet().getByText(STOCK.low, { exact: false }).first()).toBeVisible()
    await expect(sheet().getByText('7 available, alert at 8.')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText(STOCK.list.low)

    await openProduct(name)
    await openStock()
    await adjust({ action: STOCK.dialog.actions.receive, units: '10', reason: STOCK.reasons.other })
    await expect(page.getByText(STOCK.dialog.saved)).toBeVisible()
    await expect(sheet().getByText('7 available, alert at 8.')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('row').filter({ hasText: name })).not.toContainText(STOCK.list.low)
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText('17 available')
  })

  test('does not offer the adjustment or the cost to a member who may only read stock', async ({
    browser
  }) => {
    const viewerContext = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(viewerContext)
    try {
      const viewerPage = await viewerContext.newPage()
      await signIn(viewerPage, VIEWER)
      await openProduct(FIXTURE, viewerPage)
      await openStock(viewerPage)

      const dialog = viewerPage.getByRole('dialog', { name: PRODUCTS.sheet.editTitle })
      await expect(dialog.getByRole('row').filter({ hasText: 'MAIN' })).toContainText('20')
      await expect(dialog.getByRole('button', { name: STOCK.adjust })).toHaveCount(0)
      await expect(
        dialog.getByRole('columnheader', { name: STOCK.columns.averageCost })
      ).toHaveCount(0)
      await expect(dialog.getByRole('columnheader', { name: STOCK.columns.value })).toHaveCount(0)
      // The movements are readable, and carry no cost column either
      await dialog.getByRole('button', { name: STOCK.movements }).click()
      await expect(
        dialog.getByRole('columnheader', { name: STOCK.kardex.columns.cost })
      ).toHaveCount(0)
      await expect(dialog.getByRole('row').filter({ hasText: STOCK.types.receipt })).toBeVisible()
    } finally {
      await viewerContext.close()
    }
  })

  test('refuses to delete a product that has stock, and says it is part of the history of the store', async () => {
    await openProduct(FIXTURE)
    await sheet().getByRole('button', { name: PRODUCTS.form.delete }).click()
    await page.getByRole('button', { name: PRODUCTS.delete.confirm }).click()

    const refused = page.getByRole('alertdialog', { name: PRODUCTS.delete.history.title })
    await expect(refused).toBeVisible()
    // The product is still there, and the answer offers to archive it
    await expect(
      refused.getByRole('button', { name: PRODUCTS.delete.history.archive })
    ).toBeVisible()
    await page.keyboard.press('Escape')
    await openProducts()
    await page.getByLabel(PRODUCTS.searchLabel).fill(FIXTURE)
    await expect(page.getByRole('row').filter({ hasText: FIXTURE })).toBeVisible()
  })
})
