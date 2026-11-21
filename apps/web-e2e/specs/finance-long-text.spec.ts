import { randomUUID } from 'node:crypto'

import type { Locator, Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addOwnerOfNewStore } from '../support/database'
import { expectDialogHoldsItsContent } from '../support/dialog-fit'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const finance = en.finance
const purchases = en.finance.purchases

// A name typed by a person has no spaces to break at (Step 7.4 finding N-BR1-11): 150 letters in a row. It must wrap inside its card and its
// dialog, the buttons beside it stay on the screen, and the page does not grow a horizontal scroll bar.
const LONG = 'a'.repeat(150)

// The page is not wider than the window
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth
  }))
  expect(widths.scroll).toBeLessThanOrEqual(widths.client)
}

// A control sits inside the box of the row that holds it
async function expectInside(inner: Locator, outer: Locator): Promise<void> {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()])
  expect(a).not.toBeNull()
  expect(b).not.toBeNull()
  if (a === null || b === null) return
  expect(a.x).toBeGreaterThanOrEqual(b.x - 1)
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + b.width + 1)
}

test.describe('Finance → a long name with no spaces', () => {
  test.describe.configure({ mode: 'serial' })
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-finance-long-owner-${run}@example.com`

  test.beforeAll(async () => {
    await addOwnerOfNewStore(ownerEmail, `E2E Long ${run}`)
  })

  test('a supplier with a name of 150 letters stays in its card and in its detail, and the page does not scroll sideways', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.home)
    await expect(page.getByRole('heading', { name: finance.setup.title, level: 1 })).toBeVisible()
    await page.getByLabel(finance.setup.country, { exact: true }).selectOption({ index: 0 })
    await page.getByRole('button', { name: finance.setup.submit, exact: true }).click()
    await expect(
      page.getByRole('heading', { name: finance.accounts.title, level: 1 })
    ).toBeVisible()

    await page.goto(AppPaths.finance.suppliers)
    await page.getByRole('button', { name: purchases.suppliers.new, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: purchases.supplierDialog.createTitle })
    await dialog.getByLabel(purchases.supplierDialog.fields.name, { exact: true }).fill(LONG)
    await dialog
      .getByLabel(purchases.supplierDialog.fields.paymentTermsDays, { exact: true })
      .fill('30')
    await dialog.getByRole('button', { name: purchases.supplierDialog.create, exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const row = page.locator(`[data-testid="finance-supplier-row"][data-name="${LONG}"]`)
    await expect(row).toHaveCount(1)
    await expectNoSidewaysScroll(page)
    const details = row.getByRole('button', { name: purchases.suppliers.details, exact: true })
    const edit = row.getByRole('button', { name: purchases.suppliers.edit, exact: true })
    await expectInside(details, row)
    await expectInside(edit, row)

    // The detail wraps the name inside the box, on a phone and on a desktop
    await details.click()
    const detail = page.getByRole('dialog')
    await expect(detail).toContainText(LONG.slice(0, 20))
    await expectDialogHoldsItsContent(page, detail)
  })

  test('an account with a name of 150 letters stays in its row', async ({ page }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.accounts)
    await page.getByRole('button', { name: finance.accounts.new, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: finance.accounts.dialog.createTitle })
    await dialog.getByLabel(finance.accounts.fields.code, { exact: true }).fill(`L${run}`)
    await dialog.getByLabel(finance.accounts.fields.name, { exact: true }).fill(LONG)
    await dialog.getByRole('button', { name: finance.accounts.dialog.create, exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const row = page.locator(`[data-testid="finance-account-row"][data-code="L${run}"]`)
    await expect(row).toHaveCount(1)
    await expectNoSidewaysScroll(page)
    await expectInside(row.getByRole('button', { name: finance.accounts.edit, exact: true }), row)
  })

  test('the name of a month has no text transform that would raise every word', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.periods)
    await page.getByRole('button', { name: finance.periods.open.action, exact: true }).click()
    const month = page.getByRole('dialog', { name: finance.periods.open.title })
    await month.getByLabel(finance.periods.open.month, { exact: true }).fill('1')
    await month.getByLabel(finance.periods.open.year, { exact: true }).fill('2030')
    await month.getByRole('button', { name: finance.periods.open.submit, exact: true }).click()
    await expect(month).toHaveCount(0)

    // Only the first letter is raised, by the style of the first letter (the Spanish run is the month case of 4B.9b-5c): the label itself has no transform
    const label = page
      .locator('[data-testid="finance-period-row"][data-period="2030-01"]')
      .locator('span.font-medium')
    await expect(label).toBeVisible()
    expect(await label.evaluate(element => getComputedStyle(element).textTransform)).toBe('none')
  })
})
