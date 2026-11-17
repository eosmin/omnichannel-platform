import { randomUUID } from 'node:crypto'

import type { Locator, Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addFinanceViewer, addOwnerOfNewStore } from '../support/database'
import { expectDialogHoldsItsContent } from '../support/dialog-fit'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const finance = en.finance
const nav = en.settings.nav.finance

// A month that is over, so it can be closed whatever day the case runs
const MONTH = '2026-01'
const DAY = `${MONTH}-15`
const FIRST = `${MONTH}-01`
const LAST = `${MONTH}-31`

// Finance, the month end to end (Step 4B.9b-5): the books are set up, a month that has ended is opened, an expense is registered in it, the
// reports read it, the month is closed with its phrase, reopened with its reason and closed again. Its own organization, so what the cases
// post is nobody else's. The cases run in order. The figures are the ones typed: 11.30 out of the cash account and into the expense one.
test.describe('Finance → the month, from the first entry to the close', () => {
  test.describe.configure({ mode: 'serial' })
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-finance-month-owner-${run}@example.com`
  const viewerEmail = `e2e-finance-month-viewer-${run}@example.com`
  let removeViewer: () => Promise<void> = () => Promise.resolve()

  const periodRow = (page: Page): Locator =>
    page.locator(`[data-testid="finance-period-row"][data-period="${MONTH}"]`)

  test.beforeAll(async () => {
    const storeId = await addOwnerOfNewStore(ownerEmail, `E2E Month ${run}`)
    removeViewer = await addFinanceViewer(storeId, viewerEmail)
  })

  test.afterAll(async () => {
    await removeViewer()
  })

  test('an owner sets the books up, opens a month that is over and registers an expense in it', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.home)
    await expect(page.getByRole('heading', { name: finance.setup.title, level: 1 })).toBeVisible()
    // The books start on the first day of the tested month: the default is this month, and an earlier month cannot be opened
    await page.getByLabel(finance.setup.startsOn, { exact: true }).fill(FIRST)
    await page.getByLabel(finance.setup.country, { exact: true }).selectOption({ index: 0 })
    await page.getByRole('button', { name: finance.setup.submit, exact: true }).click()
    await expect(
      page.getByRole('heading', { name: finance.accounts.title, level: 1 })
    ).toBeVisible()

    await page.goto(AppPaths.finance.periods)
    await page.getByRole('button', { name: finance.periods.open.action, exact: true }).click()
    const open = page.getByRole('dialog', { name: finance.periods.open.title })
    await open.getByLabel(finance.periods.open.month, { exact: true }).fill('1')
    await open.getByLabel(finance.periods.open.year, { exact: true }).fill('2026')
    await open.getByRole('button', { name: finance.periods.open.submit, exact: true }).click()
    await expect(open).toHaveCount(0)
    await expect(periodRow(page)).toHaveCount(1)

    await page.goto(AppPaths.finance.transactions)
    await page.getByRole('button', { name: finance.transactions.new, exact: true }).click()
    const form = page.getByRole('dialog', { name: finance.transactions.form.createTitle })
    await form.getByLabel(finance.transactions.form.date, { exact: true }).fill(DAY)
    await form.getByLabel(finance.transactions.form.amount, { exact: true }).fill('11.30')
    await form
      .getByLabel(finance.transactions.form.expenseFrom, { exact: true })
      .selectOption({ index: 1 })
    await form
      .getByLabel(finance.transactions.form.expenseCategory, { exact: true })
      .selectOption({ index: 1 })
    await form.getByLabel(finance.transactions.form.memo, { exact: true }).fill('E2E month rent')
    await form.getByRole('button', { name: finance.transactions.form.submit, exact: true }).click()
    await expect(form).toHaveCount(0)
    const row = page.locator('[data-testid="finance-transaction-row"][data-kind="expense"]')
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('E2E month rent')
    await expect(row).toContainText('11.30')
  })

  test('the reports read the month: the trial balance balances and the statement shows the figure', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.reports)
    await expect(page.getByRole('heading', { name: finance.reports.title, level: 1 })).toBeVisible()
    const trial = page.getByTestId('finance-trial-balance')
    await trial
      .getByLabel(finance.reports.trialBalance.period, { exact: true })
      .selectOption({ label: MONTH })
    // Two accounts moved by the same amount, and the month says it balances
    await expect(trial.getByTestId('finance-trial-balance-row')).toHaveCount(2)
    await expect(trial.getByTestId('finance-trial-balance-debit').first()).toContainText('11.30')
    await expect(trial.getByTestId('finance-trial-balance-credit').first()).toContainText('11.30')
    await expect(trial.getByTestId('finance-trial-balance-verdict')).toContainText(
      finance.reports.trialBalance.balanced
    )

    await page.goto(AppPaths.finance.statements)
    const form = page.getByRole('form', { name: finance.statementsCommon.formLabel })
    await form.getByLabel(finance.statementsCommon.from, { exact: true }).fill(FIRST)
    await form.getByLabel(finance.statementsCommon.to, { exact: true }).fill(LAST)
    await form.getByRole('button', { name: finance.statementsCommon.show, exact: true }).click()
    await expect(
      page.getByTestId('finance-income-statement').getByTestId('finance-statement-net-result')
    ).toContainText('11.30')
  })

  test('the month is closed with its phrase, and the dialog holds its content on a phone', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.periods)
    await periodRow(page).getByTestId('finance-period-close').click()
    const dialog = page.getByRole('dialog', {
      name: finance.periods.close.title.replace('{month}', MONTH)
    })
    await expect(dialog.getByTestId('finance-close-effects')).toBeVisible()
    await expectDialogHoldsItsContent(page, dialog)

    // Nothing is sent until the phrase is typed exactly: the button stays off
    const submit = dialog.getByRole('button', { name: finance.periods.close.submit, exact: true })
    await expect(submit).toBeDisabled()
    const phrase = dialog.getByLabel(finance.periods.close.phraseLabel.replace('{phrase}', MONTH), {
      exact: true
    })
    await phrase.fill('2026-1')
    await expect(submit).toBeDisabled()
    await phrase.fill(MONTH)
    await submit.click()
    await expect(dialog).toHaveCount(0)

    const row = periodRow(page)
    await expect(row).toContainText(finance.periods.status.closed)
    await expect(row.getByTestId('finance-period-close')).toHaveCount(0)
    await expect(row.getByTestId('finance-period-reopen')).toBeVisible()
    await expect(page.getByTestId('finance-locked-through')).toBeVisible()
  })

  test('the month is reopened with its reason, which stays on the row, and closed again', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.periods)
    await periodRow(page).getByTestId('finance-period-reopen').click()
    const dialog = page.getByRole('dialog', {
      name: finance.periods.reopen.title.replace('{month}', MONTH)
    })
    await expect(dialog.getByTestId('finance-reopen-effects')).toBeVisible()
    await expectDialogHoldsItsContent(page, dialog)

    // The reason cannot be empty
    await dialog.getByRole('button', { name: finance.periods.reopen.submit, exact: true }).click()
    await expect(
      dialog.getByText(finance.periods.reopen.problems.empty, { exact: true })
    ).toBeVisible()
    await dialog.getByLabel(finance.periods.reopen.reason, { exact: true }).fill('E2E late receipt')
    await dialog.getByRole('button', { name: finance.periods.reopen.submit, exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const row = periodRow(page)
    await expect(row.getByTestId('finance-period-close')).toBeVisible()
    await expect(row.getByTestId('finance-period-reopen')).toHaveCount(0)
    await expect(row).toContainText(
      finance.periods.reopenReason.replace('{reason}', 'E2E late receipt')
    )

    // Closed again: the same phrase, and the books read the same as before
    await row.getByTestId('finance-period-close').click()
    const again = page.getByRole('dialog', {
      name: finance.periods.close.title.replace('{month}', MONTH)
    })
    await again
      .getByLabel(finance.periods.close.phraseLabel.replace('{phrase}', MONTH), { exact: true })
      .fill(MONTH)
    await again.getByRole('button', { name: finance.periods.close.submit, exact: true }).click()
    await expect(again).toHaveCount(0)
    await expect(periodRow(page).getByTestId('finance-period-reopen')).toBeVisible()
    await expect(periodRow(page).getByTestId('finance-period-close')).toHaveCount(0)

    // The books read the same after the second close
    await page.goto(AppPaths.finance.reports)
    const trial = page.getByTestId('finance-trial-balance')
    await trial
      .getByLabel(finance.reports.trialBalance.period, { exact: true })
      .selectOption({ label: MONTH })
    await expect(trial.getByTestId('finance-trial-balance-row')).toHaveCount(2)
    await expect(trial.getByTestId('finance-trial-balance-debit').first()).toContainText('11.30')
  })

  test('a transaction dated in the closed month is refused by the books and nothing is written', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.transactions)
    const list = page.getByTestId('finance-transactions')
    const rows = list.getByTestId('finance-transaction-row')
    await expect(rows).toHaveCount(1)

    await page.getByRole('button', { name: finance.transactions.new, exact: true }).click()
    const form = page.getByRole('dialog', { name: finance.transactions.form.createTitle })
    await form.getByLabel(finance.transactions.form.date, { exact: true }).fill(`${MONTH}-20`)
    await form.getByLabel(finance.transactions.form.amount, { exact: true }).fill('3.00')
    await form
      .getByLabel(finance.transactions.form.expenseFrom, { exact: true })
      .selectOption({ index: 1 })
    await form
      .getByLabel(finance.transactions.form.expenseCategory, { exact: true })
      .selectOption({ index: 1 })
    await form.getByRole('button', { name: finance.transactions.form.submit, exact: true }).click()

    // The api says the month is closed, the form stays open with what was written, and the list has the one transaction it had
    await expect(form.getByRole('alert').getByText(en.errors.FINANCE_PERIOD_CLOSED)).toBeVisible()
    await expect(form).toBeVisible()
    await form.getByRole('button', { name: finance.transactions.form.cancel, exact: true }).click()
    await expect(form).toHaveCount(0)
    await expect(rows).toHaveCount(1)
  })

  test('who may only read the books sees the month closed and has no button to change it', async ({
    page
  }) => {
    await signIn(page, viewerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.periods)
    await expect(page.getByRole('heading', { name: finance.periods.title, level: 1 })).toBeVisible()
    await expect(periodRow(page).getByTestId('finance-period-close')).toHaveCount(0)
    await expect(periodRow(page).getByTestId('finance-period-reopen')).toHaveCount(0)
    await expect(periodRow(page).getByTestId('finance-period-close')).toHaveCount(0)
    await expect(page.getByRole('link', { name: nav.periods, exact: true })).toBeVisible()
  })
})
