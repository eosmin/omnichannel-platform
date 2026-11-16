import { randomUUID } from 'node:crypto'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addFinanceViewer,
  addOrdersViewerWithoutShipping,
  addOwnerOfNewStore
} from '../support/database'
import { expectDialogFitsThePhoneWidth } from '../support/dialog-fit'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const finance = en.finance
const nav = en.settings.nav.finance

// Finance (Step 4B.9a-1): the setup of the books, the chart, the tax rates, the months and the settings, through the screens. Its own
// organization, so the books that the cases make are nobody else's. The cases run in order: the first one sets the books up.
test.describe('Finance → the books of the organization', () => {
  test.describe.configure({ mode: 'serial' })
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-finance-owner-${run}@example.com`
  const viewerEmail = `e2e-finance-viewer-${run}@example.com`
  const outsiderEmail = `e2e-finance-outsider-${run}@example.com`
  let storeId = ''
  let removeViewer: () => Promise<void> = () => Promise.resolve()
  let removeOutsider: () => Promise<void> = () => Promise.resolve()

  test.beforeAll(async () => {
    storeId = await addOwnerOfNewStore(ownerEmail, `E2E Finance ${run}`)
    removeViewer = await addFinanceViewer(storeId, viewerEmail)
    removeOutsider = await addOrdersViewerWithoutShipping(storeId, outsiderEmail)
  })

  test.afterAll(async () => {
    await removeViewer()
    await removeOutsider()
  })

  test('an owner sets the books up, then makes an account, a tax rate and a month', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.home)

    // The books are not set up: the wizard, which refuses a date that does not exist
    await expect(page.getByRole('heading', { name: finance.setup.title, level: 1 })).toBeVisible()
    await page.getByLabel(finance.setup.startsOn, { exact: true }).fill('2026-02-30')
    await page.getByRole('button', { name: finance.setup.submit, exact: true }).click()
    await expect(page.getByRole('alert').getByText(finance.setup.startsOnProblem)).toBeVisible()
    await page.getByLabel(finance.setup.startsOn, { exact: true }).fill('')
    await page.getByLabel(finance.setup.country, { exact: true }).selectOption({ index: 0 })
    await page.getByRole('button', { name: finance.setup.submit, exact: true }).click()

    // The chart of the country is there
    await expect(
      page.getByRole('heading', { name: finance.accounts.title, level: 1 })
    ).toBeVisible()
    const rows = page.getByTestId('finance-accounts').getByTestId('finance-account-row')
    await expect(rows.first()).toBeVisible()

    // A new account: an empty form is refused first, and the dialog fits a phone
    await page.getByRole('button', { name: finance.accounts.new, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: finance.accounts.dialog.createTitle })
    await dialog.getByRole('button', { name: finance.accounts.dialog.create, exact: true }).click()
    await expect(dialog.getByRole('alert').first()).toBeVisible()
    await expectDialogFitsThePhoneWidth(page, dialog)
    await dialog.getByLabel(finance.accounts.fields.code, { exact: true }).fill(`E2E${run}`)
    await dialog.getByLabel(finance.accounts.fields.name, { exact: true }).fill('E2E petty cash')
    await dialog.getByRole('button', { name: finance.accounts.dialog.create, exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(rows.and(page.locator(`[data-code="E2E${run}"]`))).toHaveCount(1)

    // A tax rate on two accounts of the chart
    await page.getByRole('link', { name: nav.taxes, exact: true }).click()
    await expect(page.getByRole('heading', { name: finance.taxes.title, level: 1 })).toBeVisible()
    await page.getByRole('button', { name: finance.taxes.new, exact: true }).click()
    const rate = page.getByRole('dialog', { name: finance.taxes.dialog.createTitle })
    await rate.getByRole('button', { name: finance.taxes.dialog.create, exact: true }).click()
    await expect(rate.getByRole('alert').first()).toBeVisible()
    await expectDialogFitsThePhoneWidth(page, rate)
    await rate.getByLabel(finance.taxes.fields.code, { exact: true }).fill(`T${run}`)
    await rate.getByLabel(finance.taxes.fields.name, { exact: true }).fill('E2E tax')
    await rate.getByLabel(finance.taxes.fields.percent, { exact: true }).fill('7.5')
    await rate
      .getByLabel(finance.taxes.fields.outputAccount, { exact: true })
      .selectOption({ index: 1 })
    await rate
      .getByLabel(finance.taxes.fields.inputAccount, { exact: true })
      .selectOption({ index: 1 })
    await rate.getByRole('button', { name: finance.taxes.dialog.create, exact: true }).click()
    await expect(rate).toHaveCount(0)
    const created = page.locator(`[data-testid="finance-tax-rate-row"][data-code="T${run}"]`)
    await expect(created.getByTestId('finance-tax-rate-percent')).toHaveText('7.5 %')

    // A month opened ahead of time
    await page.getByRole('link', { name: nav.periods, exact: true }).click()
    await expect(page.getByRole('heading', { name: finance.periods.title, level: 1 })).toBeVisible()
    await page.getByRole('button', { name: finance.periods.open.action, exact: true }).click()
    const month = page.getByRole('dialog', { name: finance.periods.open.title })
    await month.getByLabel(finance.periods.open.month, { exact: true }).fill('13')
    await month.getByRole('button', { name: finance.periods.open.submit, exact: true }).click()
    await expect(
      month.getByRole('alert').getByText(finance.periods.open.problems.month)
    ).toBeVisible()
    await expectDialogFitsThePhoneWidth(page, month)
    await month.getByLabel(finance.periods.open.month, { exact: true }).fill('1')
    await month.getByLabel(finance.periods.open.year, { exact: true }).fill('2030')
    await month.getByRole('button', { name: finance.periods.open.submit, exact: true }).click()
    await expect(month).toHaveCount(0)
    await expect(
      page.locator('[data-testid="finance-period-row"][data-period="2030-01"]')
    ).toHaveCount(1)
  })

  test('a posting setting survives a reload', async ({ page }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.settings)
    const shipping = page.getByRole('checkbox', {
      name: finance.settings.posting.shippingTaxed,
      exact: false
    })
    await expect(shipping).toBeVisible()
    const before = await shipping.isChecked()
    await shipping.setChecked(!before)
    await page.getByRole('button', { name: finance.settings.posting.save, exact: true }).click()
    await page.reload()
    await expect(
      page.getByRole('checkbox', { name: finance.settings.posting.shippingTaxed, exact: false })
    ).toBeChecked({ checked: !before })
  })

  test('a person who may only read the books sees them and cannot change them', async ({
    page
  }) => {
    await signIn(page, viewerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.accounts)
    await expect(
      page.getByRole('heading', { name: finance.accounts.title, level: 1 })
    ).toBeVisible()
    await expect(
      page.getByTestId('finance-accounts').getByTestId('finance-account-row').first()
    ).toBeVisible()
    await expect(page.getByRole('button', { name: finance.accounts.new, exact: true })).toHaveCount(
      0
    )
    await expect(
      page.getByRole('button', { name: finance.accounts.edit, exact: true })
    ).toHaveCount(0)
  })

  test('a person with no finance permission has no Finance link and is sent away from the page', async ({
    page
  }) => {
    await signIn(page, outsiderEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await expect(
      page
        .getByRole('navigation', { name: en.shell.nav.label })
        .getByRole('link', { name: en.shell.nav.finance, exact: true })
    ).toHaveCount(0)
    await page.goto(AppPaths.finance.accounts)
    await expect(page).toHaveURL(new RegExp(AppPaths.noAccess))
  })
})
