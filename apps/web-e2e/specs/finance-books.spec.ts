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

// Finance (Steps 4B.9a-1 and 4B.9a-2): the setup of the books, the chart, the tax rates, the months, the settings, the transactions and the
// journal, through the screens. Its own
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

  test('an owner registers an expense, finds it in the transactions and voids it', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.transactions)
    await expect(
      page.getByRole('heading', { name: finance.transactions.title, level: 1 })
    ).toBeVisible()
    const list = page.getByTestId('finance-transactions')
    await expect(list).toHaveCount(0)

    // An empty form is refused first, and the dialog fits a phone
    await page.getByRole('button', { name: finance.transactions.new, exact: true }).click()
    const form = page.getByRole('dialog', {
      name: finance.transactions.form.createTitle,
      exact: true
    })
    await form.getByRole('button', { name: finance.transactions.form.submit, exact: true }).click()
    await expect(form.getByRole('alert').first()).toBeVisible()
    await expectDialogFitsThePhoneWidth(page, form)

    // An expense paid from a cash account, classified under an expense account
    await form.getByLabel(finance.transactions.form.amount, { exact: true }).fill('11.30')
    await form
      .getByLabel(finance.transactions.form.expenseFrom, { exact: true })
      .selectOption({ index: 1 })
    await form
      .getByLabel(finance.transactions.form.expenseCategory, { exact: true })
      .selectOption({ index: 1 })
    await form.getByLabel(finance.transactions.form.memo, { exact: true }).fill('E2E rent')
    await form.getByRole('button', { name: finance.transactions.form.submit, exact: true }).click()
    await expect(form).toHaveCount(0)
    const row = list.locator('[data-testid="finance-transaction-row"][data-kind="expense"]')
    await expect(row).toHaveCount(1)
    await expect(row).toHaveAttribute('data-voided', 'false')
    await expect(row).toContainText('E2E rent')
    await expect(row).toContainText('11.30')

    // Its detail shows the entry it posted; a void asks for the reason and then for the confirmation
    await row.click()
    const detail = page.getByRole('dialog', {
      name: finance.transactions.detail.title,
      exact: true
    })
    await expect(detail.getByTestId('finance-transaction-detail')).toBeVisible()
    // The entry it posted carries the amount typed
    await expect(detail.getByTestId('finance-entry-lines')).toContainText('11.30')
    await detail
      .getByRole('button', { name: finance.transactions.void.action, exact: true })
      .click()
    await detail
      .getByRole('button', { name: finance.transactions.void.submit, exact: true })
      .click()
    await expect(detail.getByRole('alert').first()).toBeVisible()
    await detail
      .getByLabel(finance.transactions.void.reason, { exact: true })
      .fill('E2E typed twice')
    await detail
      .getByRole('button', { name: finance.transactions.void.submit, exact: true })
      .click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: finance.transactions.void.confirm, exact: true })
      .click()
    await expect(detail).toHaveCount(0)

    // A voided transaction leaves the list, and comes back when asked for
    await expect(page.getByText(finance.transactions.empty)).toBeVisible()
    await page
      .getByLabel(finance.transactions.filters.includeVoided, { exact: true })
      .setChecked(true)
    await expect(
      page.locator('[data-testid="finance-transaction-row"][data-voided="true"]')
    ).toHaveCount(1)
  })

  test('an owner writes an entry by hand, which must balance, and finds it in the journal', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.journal)
    await expect(page.getByRole('heading', { name: finance.journal.title, level: 1 })).toBeVisible()
    // The expense and the reversal of the void are already in it
    const rows = page.getByTestId('finance-entries').getByTestId('finance-entry-row')
    await expect(rows).toHaveCount(2)

    await page.getByRole('button', { name: finance.journal.new, exact: true }).click()
    const form = page.getByRole('dialog', { name: finance.manual.title, exact: true })
    await expectDialogFitsThePhoneWidth(page, form)
    await form.getByLabel(finance.manual.memo, { exact: true }).fill('E2E opening')
    await form
      .getByLabel(finance.manual.account.replace('{number}', '1'), { exact: true })
      .selectOption({ index: 1 })
    await form.getByLabel(finance.manual.debit.replace('{number}', '1'), { exact: true }).fill('5')
    await form
      .getByLabel(finance.manual.account.replace('{number}', '2'), { exact: true })
      .selectOption({ index: 2 })
    await form.getByLabel(finance.manual.credit.replace('{number}', '2'), { exact: true }).fill('4')
    await form.getByRole('button', { name: finance.manual.submit, exact: true }).click()
    await expect(form.getByRole('alert').getByText(finance.manual.problems.balance)).toBeVisible()
    await form.getByLabel(finance.manual.credit.replace('{number}', '2'), { exact: true }).fill('5')
    await form.getByRole('button', { name: finance.manual.submit, exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: finance.manual.confirm, exact: true })
      .click()
    await expect(form).toHaveCount(0)
    await expect(rows).toHaveCount(3)

    // The new entry is the one with the description typed; its lines, and the way to reverse it
    const mine = rows.filter({ hasText: 'E2E opening' })
    await expect(mine).toHaveCount(1)
    const number = await mine.getAttribute('data-number')
    await mine.click()
    const detail = page.getByRole('dialog', {
      name: finance.entry.title.replace('{number}', number ?? ''),
      exact: true
    })
    await expect(detail.getByTestId('finance-entry-line')).toHaveCount(2)
    await expect(detail.getByTestId('finance-entry-lines')).toContainText('5.00')
    await expect(
      detail.getByRole('button', { name: finance.entry.reverse.action, exact: true })
    ).toBeVisible()
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
    // The journal is another permission: it has no entry in the navigation of who only reads the books
    await expect(page.getByRole('link', { name: nav.accounts, exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: nav.journal, exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: nav.transactions, exact: true })).toHaveCount(0)
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
