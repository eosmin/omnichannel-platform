import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addCatalogUserWithoutCost,
  markMediaClean,
  productNamed,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds every permission of the catalog
const ADMIN = 'multi-store@test.com'
const PRODUCTS = en.products

// 1x1 transparent PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

// A name no other run has used: the database keeps what a case writes
const uniqueName = (label: string): string => `${label} ${randomUUID().slice(0, 8)}`

test.describe('the catalog of products', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string
  // The product the cases build on, one after the other
  const name = uniqueName('Catalog shoe')
  const sku = `E2E-${randomUUID().slice(0, 8)}`

  const sheet = (title: string) => page.getByRole('dialog', { name: title })

  async function openProducts(): Promise<void> {
    await page.goto(AppPaths.store.products(storeId))
    await expect(page.getByRole('heading', { name: PRODUCTS.title })).toBeVisible()
  }

  async function openProduct(productName: string): Promise<void> {
    await openProducts()
    await page.getByRole('button', { name: productName }).click()
    await expect(sheet(PRODUCTS.sheet.editTitle)).toBeVisible()
  }

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

  test('creates a product from the page, and the list shows it with its price in dollars', async () => {
    await openProducts()
    await page.getByRole('button', { name: PRODUCTS.newProduct }).click()
    const dialog = sheet(PRODUCTS.sheet.newTitle)
    await expect(dialog).toBeVisible()

    // A price that is not money is refused on the spot, naming the field
    await dialog.getByLabel(PRODUCTS.form.name, { exact: true }).fill(name)
    await dialog.getByLabel(PRODUCTS.form.price).fill('19.999')
    await dialog.getByRole('button', { name: PRODUCTS.form.create }).click()
    await expect(dialog.getByText(PRODUCTS.form.errors.price)).toBeVisible()

    await dialog.getByLabel(PRODUCTS.form.price).fill('19.99')
    await dialog.getByLabel(PRODUCTS.form.sku, { exact: true }).fill(sku)
    await dialog.getByRole('button', { name: PRODUCTS.form.create }).click()

    // The sheet becomes the product's: now it has its tabs
    await expect(
      sheet(PRODUCTS.sheet.editTitle).getByRole('tab', { name: PRODUCTS.sheet.tabs.images })
    ).toBeVisible()
    const stored = await productNamed(name)
    expect(stored?.priceCents).toBe(1999)

    await page.keyboard.press('Escape')
    const row = page.getByRole('row').filter({ hasText: name })
    await expect(row).toContainText('$19.99')
    await expect(row).toContainText(sku)
  })

  test('refuses a second product with the same SKU, in words', async () => {
    await openProducts()
    await page.getByRole('button', { name: PRODUCTS.newProduct }).click()
    const dialog = sheet(PRODUCTS.sheet.newTitle)
    await dialog.getByLabel(PRODUCTS.form.name, { exact: true }).fill(uniqueName('Same sku'))
    await dialog.getByLabel(PRODUCTS.form.price).fill('5')
    await dialog.getByLabel(PRODUCTS.form.sku, { exact: true }).fill(sku)
    await dialog.getByRole('button', { name: PRODUCTS.form.create }).click()
    await expect(dialog.getByText(PRODUCTS.conflicts.sku_in_use)).toBeVisible()
  })

  test('edits the price and keeps what was not touched', async () => {
    await openProduct(name)
    const dialog = sheet(PRODUCTS.sheet.editTitle)
    await dialog.getByLabel(PRODUCTS.form.price).fill('24.50')
    await dialog.getByRole('button', { name: PRODUCTS.form.save }).click()
    await expect(page.getByText(PRODUCTS.form.saved)).toBeVisible()

    const stored = await productNamed(name)
    expect(stored?.priceCents).toBe(2450)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('row').filter({ hasText: name })).toContainText('$24.50')
  })

  test('adds variants, edits one, and says why a repeated name is refused', async () => {
    await openProduct(name)
    const dialog = sheet(PRODUCTS.sheet.editTitle)
    await dialog.getByRole('tab', { name: PRODUCTS.sheet.tabs.variants }).click()
    await expect(dialog.getByText(PRODUCTS.variants.empty)).toBeVisible()

    await dialog.getByRole('button', { name: PRODUCTS.variants.add }).click()
    await dialog.getByLabel(PRODUCTS.variants.name).fill('Size 42')
    await dialog.getByRole('button', { name: PRODUCTS.variants.save }).click()
    // No price of its own: it sells at the price of the product
    await expect(dialog.getByRole('row').filter({ hasText: 'Size 42' })).toContainText(
      PRODUCTS.variants.usesProduct
    )

    await dialog.getByRole('button', { name: PRODUCTS.variants.add }).click()
    await dialog.getByLabel(PRODUCTS.variants.name).fill('Size 42')
    await dialog.getByRole('button', { name: PRODUCTS.variants.save }).click()
    await expect(dialog.getByText(PRODUCTS.conflicts.variant_name_in_use)).toBeVisible()
    await dialog.getByRole('button', { name: en.common.cancel }).click()

    await dialog
      .getByRole('row')
      .filter({ hasText: 'Size 42' })
      .getByRole('button', { name: PRODUCTS.variants.edit })
      .click()
    // The details form stays mounted behind this tab, so the field is asked of the table
    await dialog.getByRole('table').getByLabel(PRODUCTS.variants.columns.price).fill('30')
    await dialog.getByRole('button', { name: PRODUCTS.variants.save }).click()
    await expect(dialog.getByRole('row').filter({ hasText: 'Size 42' })).toContainText('$30.00')

    const stored = await productNamed(name)
    expect(stored?.variants).toEqual([{ name: 'Size 42', priceCents: 3000, costCents: null }])
  })

  test('finds the product by its name and by the name of one of its variants', async () => {
    await openProducts()
    const box = page.getByLabel(PRODUCTS.searchLabel)

    // One character is not a search: the list stays as it is, with no error
    await box.fill('C')
    await expect(page.getByText(PRODUCTS.failed)).toHaveCount(0)
    // ... and the list is what it was: the product made above is still in it
    await expect(page.getByRole('button', { name })).toBeVisible()

    await box.fill(name.slice(0, name.length - 3))
    await expect(page.getByRole('button', { name })).toBeVisible()

    // A variant answers for its product, and the row says which variant matched
    await box.fill('Size 42')
    const row = page.getByRole('row').filter({ hasText: name })
    await expect(row).toBeVisible()
    await expect(row).toContainText('Size 42')

    await box.fill(`${name} nothing like it`)
    await expect(page.getByText(PRODUCTS.noMatches)).toBeVisible()
  })

  test('uploads a picture for the product and makes it the cover once it is clean', async () => {
    await openProduct(name)
    const dialog = sheet(PRODUCTS.sheet.editTitle)
    await dialog.getByRole('tab', { name: PRODUCTS.sheet.tabs.images }).click()
    await expect(dialog.getByText(PRODUCTS.images.empty)).toBeVisible()

    await dialog.getByLabel(PRODUCTS.images.upload).setInputFiles({
      name: 'front.png',
      mimeType: 'image/png',
      buffer: PNG
    })
    await expect(dialog.getByText('front.png', { exact: true })).toBeVisible()

    const stored = await productNamed(name)
    expect(stored?.media).toHaveLength(1)
    expect(stored?.media[0]).toMatchObject({ purpose: 'product' })
    const mediaId = stored?.media[0]?.id ?? ''

    // A file the scan has not cleared cannot be the cover: the button waits for the verdict
    await expect(dialog.getByRole('button', { name: PRODUCTS.images.setCover })).toHaveCount(0)
    await markMediaClean(mediaId)
    await page.reload()
    await page.getByRole('button', { name: name }).click()
    await sheet(PRODUCTS.sheet.editTitle)
      .getByRole('tab', { name: PRODUCTS.sheet.tabs.images })
      .click()
    await sheet(PRODUCTS.sheet.editTitle)
      .getByRole('button', { name: PRODUCTS.images.setCover })
      .click()
    await expect(
      sheet(PRODUCTS.sheet.editTitle).getByText(PRODUCTS.images.cover, { exact: true })
    ).toBeVisible()

    expect((await productNamed(name))?.imageMediaId).toBe(mediaId)
  })

  test('refuses a file that is not a still picture before it is uploaded', async () => {
    await openProduct(name)
    const dialog = sheet(PRODUCTS.sheet.editTitle)
    await dialog.getByRole('tab', { name: PRODUCTS.sheet.tabs.images }).click()
    await dialog.getByLabel(PRODUCTS.images.upload).setInputFiles({
      name: 'notes.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4')
    })
    await expect(
      dialog.getByRole('alert').filter({ hasText: en.errors.FILE_TYPE_NOT_ALLOWED })
    ).toBeVisible()
    expect((await productNamed(name))?.media).toHaveLength(1)
  })

  test('does not delete a product with history: it says what holds it and offers to archive it', async () => {
    await openProduct(name)
    const dialog = sheet(PRODUCTS.sheet.editTitle)
    await dialog.getByRole('button', { name: PRODUCTS.form.delete }).click()
    await page.getByRole('button', { name: PRODUCTS.delete.confirm }).click()

    const alert = page.getByRole('alertdialog', { name: PRODUCTS.delete.history.title })
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('1 picture')
    expect(await productNamed(name)).not.toBeNull()

    await alert.getByRole('button', { name: PRODUCTS.delete.history.archive }).click()
    await expect(page.getByText(PRODUCTS.form.archived)).toBeVisible()
    expect((await productNamed(name))?.active).toBe(false)
  })

  test('shows the archived product under the Archived filter and not under Active', async () => {
    await openProducts()
    await page.getByLabel(PRODUCTS.filter.label).selectOption('archived')
    await expect(page.getByRole('button', { name })).toBeVisible()
    // The search finds it there too, and not under Active (the api is asked to leave archived products out)
    await page.getByLabel(PRODUCTS.searchLabel).fill(name)
    await expect(page.getByRole('button', { name })).toBeVisible()
    await page.getByLabel(PRODUCTS.filter.label).selectOption('active')
    await expect(page.getByText(PRODUCTS.noMatches)).toBeVisible()
    await page.getByLabel(PRODUCTS.searchLabel).fill('')
    await page.getByLabel(PRODUCTS.filter.label).selectOption('archived')
    await page.getByLabel(PRODUCTS.filter.label).selectOption('active')
    await expect(page.getByRole('button', { name })).toHaveCount(0)
  })

  test('deletes a product that nothing refers to', async () => {
    const lonely = uniqueName('Lonely')
    await openProducts()
    await page.getByRole('button', { name: PRODUCTS.newProduct }).click()
    const dialog = sheet(PRODUCTS.sheet.newTitle)
    await dialog.getByLabel(PRODUCTS.form.name, { exact: true }).fill(lonely)
    await dialog.getByLabel(PRODUCTS.form.price).fill('1')
    await dialog.getByRole('button', { name: PRODUCTS.form.create }).click()
    await expect(sheet(PRODUCTS.sheet.editTitle)).toBeVisible()

    await sheet(PRODUCTS.sheet.editTitle)
      .getByRole('button', { name: PRODUCTS.form.delete })
      .click()
    await page.getByRole('button', { name: PRODUCTS.delete.confirm }).click()
    await expect(page.getByText(PRODUCTS.delete.deleted)).toBeVisible()
    expect(await productNamed(lonely)).toBeNull()
  })
})

test.describe('the cost of a product', () => {
  test.describe.configure({ mode: 'serial' })

  const NO_COST = `no-cost-${randomUUID().slice(0, 8)}@test.com`
  const name = uniqueName('Costed boot')
  let storeId: string
  let removeUser: () => Promise<void>
  let adminContext: BrowserContext
  let admin: Page

  test.beforeAll(async ({ browser }) => {
    storeId = await storeIdNamed(FIRST_STORE)
    removeUser = await addCatalogUserWithoutCost(storeId, NO_COST)
    adminContext = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(adminContext)
    admin = await adminContext.newPage()
    await signIn(admin, ADMIN)
  })
  test.afterAll(async () => {
    await adminContext.close()
    await removeUser()
  })

  const sheetOf = (page: Page) => page.getByRole('dialog', { name: PRODUCTS.sheet.editTitle })

  async function open(page: Page): Promise<void> {
    await page.goto(AppPaths.store.products(storeId))
    await expect(page.getByRole('heading', { name: PRODUCTS.title })).toBeVisible()
    await page.getByRole('button', { name }).click()
    await expect(sheetOf(page)).toBeVisible()
  }

  test('who holds the permission sees the cost of the product and of its variants and sets it', async () => {
    await admin.goto(AppPaths.store.products(storeId))
    await admin.getByRole('button', { name: PRODUCTS.newProduct }).click()
    const dialog = admin.getByRole('dialog', { name: PRODUCTS.sheet.newTitle })
    await dialog.getByLabel(PRODUCTS.form.name, { exact: true }).fill(name)
    await dialog.getByLabel(PRODUCTS.form.price).fill('30')
    await dialog.getByLabel(PRODUCTS.form.cost).fill('12.50')
    await dialog.getByRole('button', { name: PRODUCTS.form.create }).click()
    await expect(sheetOf(admin)).toBeVisible()
    expect((await productNamed(name))?.costCents).toBe(1250)

    const edit = sheetOf(admin)
    await edit.getByRole('tab', { name: PRODUCTS.sheet.tabs.variants }).click()
    await expect(
      edit.getByRole('columnheader', { name: PRODUCTS.variants.columns.cost })
    ).toBeVisible()
    await edit.getByRole('button', { name: PRODUCTS.variants.add }).click()
    await edit.getByLabel(PRODUCTS.variants.name).fill('Size 9')
    await edit.getByRole('table').getByLabel(PRODUCTS.variants.columns.cost).fill('11')
    await edit.getByRole('button', { name: PRODUCTS.variants.save }).click()
    await expect(edit.getByRole('row').filter({ hasText: 'Size 9' })).toContainText('$11.00')
    expect((await productNamed(name))?.variants).toEqual([
      { name: 'Size 9', priceCents: null, costCents: 1100 }
    ])
  })

  test('who does not hold it sees no cost anywhere and changing the price leaves the cost as it was', async ({
    browser
  }) => {
    const context = await browser.newContext({ locale: 'en' })
    try {
      await reachServicesFromOwnAddress(context)
      const page = await context.newPage()
      await signIn(page, NO_COST)
      await open(page)
      const dialog = sheetOf(page)

      // The details form has the price and no cost (nor the help text of the cost)
      await expect(dialog.getByLabel(PRODUCTS.form.price)).toBeVisible()
      await expect(dialog.getByLabel(PRODUCTS.form.cost)).toHaveCount(0)
      await expect(dialog.getByText(PRODUCTS.form.costHelp)).toHaveCount(0)

      await dialog.getByLabel(PRODUCTS.form.price).fill('31')
      await dialog.getByRole('button', { name: PRODUCTS.form.save }).click()
      await expect(page.getByText(PRODUCTS.form.saved)).toBeVisible()

      // The variants table has no cost column and no cost to type, and a new variant carries none
      await dialog.getByRole('tab', { name: PRODUCTS.sheet.tabs.variants }).click()
      await expect(
        dialog.getByRole('columnheader', { name: PRODUCTS.variants.columns.price })
      ).toBeVisible()
      await expect(
        dialog.getByRole('columnheader', { name: PRODUCTS.variants.columns.cost })
      ).toHaveCount(0)
      await expect(dialog.getByText('$11.00')).toHaveCount(0)
      await dialog.getByRole('button', { name: PRODUCTS.variants.add }).click()
      await expect(
        dialog.getByRole('table').getByLabel(PRODUCTS.variants.columns.cost)
      ).toHaveCount(0)
      await dialog.getByLabel(PRODUCTS.variants.name).fill('Size 10')
      await dialog.getByRole('button', { name: PRODUCTS.variants.save }).click()
      await expect(dialog.getByRole('row').filter({ hasText: 'Size 10' })).toBeVisible()

      // What the person could not see was not overwritten
      const stored = await productNamed(name)
      expect(stored?.priceCents).toBe(3100)
      expect(stored?.costCents).toBe(1250)
      expect(stored?.variants).toEqual([
        { name: 'Size 9', priceCents: null, costCents: 1100 },
        { name: 'Size 10', priceCents: null, costCents: null }
      ])
    } finally {
      await context.close()
    }
  })
})
