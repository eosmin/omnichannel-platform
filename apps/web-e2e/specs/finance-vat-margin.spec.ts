import { randomUUID } from 'node:crypto'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addFinanceReportsViewer, addFinanceViewer, addOwnerOfNewStore } from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const finance = en.finance
const nav = en.settings.nav.finance

// Finance → VAT and Margin, and the notice of the weekly check of the chain (Step 4B.9b-4a): read from a set of books that has no entry
// yet, so what the screens must say is true by itself (no activity, no incident). Its own organization. The figures with data are the
// end-to-end case of the month (4B.9b-5). The cases run in order: the first one sets the books up.
test.describe('Finance → VAT and margin', () => {
  test.describe.configure({ mode: 'serial' })
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-finance-vat-owner-${run}@example.com`
  const readerEmail = `e2e-finance-vat-reader-${run}@example.com`
  const noExportEmail = `e2e-finance-vat-noexport-${run}@example.com`
  let removeReader: () => Promise<void> = () => Promise.resolve()
  let removeNoExport: () => Promise<void> = () => Promise.resolve()

  test.beforeAll(async () => {
    const storeId = await addOwnerOfNewStore(ownerEmail, `E2E VAT ${run}`)
    removeReader = await addFinanceViewer(storeId, readerEmail)
    removeNoExport = await addFinanceReportsViewer(storeId, noExportEmail, false)
  })

  test.afterAll(async () => {
    await removeReader()
    await removeNoExport()
  })

  test('an owner sets the books up', async ({ page }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.home)
    await expect(page.getByRole('heading', { name: finance.setup.title, level: 1 })).toBeVisible()
    await page.getByLabel(finance.setup.country, { exact: true }).selectOption({ index: 0 })
    await page.getByRole('button', { name: finance.setup.submit, exact: true }).click()
    await expect(
      page.getByRole('heading', { name: finance.accounts.title, level: 1 })
    ).toBeVisible()
  })

  test('an owner reads the VAT of the empty books and a range that is too long is refused first', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.vat)
    await expect(page.getByRole('heading', { name: finance.vat.title, level: 1 })).toBeVisible()

    const vat = page.getByTestId('finance-vat')
    const form = vat.getByRole('form', { name: finance.statementsCommon.formLabel })
    await form.getByLabel(finance.statementsCommon.from, { exact: true }).fill('2020-01-01')
    await form.getByLabel(finance.statementsCommon.to, { exact: true }).fill('2026-12-31')
    await form.getByRole('button', { name: finance.statementsCommon.show, exact: true }).click()
    await expect(
      page
        .getByRole('alert')
        .getByText(finance.statementsCommon.problems.tooLong.replace('{days}', '366'), {
          exact: true
        })
    ).toBeVisible()

    await form.getByLabel(finance.statementsCommon.from, { exact: true }).fill('2026-01-01')
    await form.getByLabel(finance.statementsCommon.to, { exact: true }).fill('2026-01-31')
    await form.getByRole('button', { name: finance.statementsCommon.show, exact: true }).click()
    await expect(vat.getByTestId('finance-vat-none')).toBeVisible()
    await expect(vat.getByTestId('finance-vat-basis')).toBeVisible()
    // The owner may take the file
    await expect(vat.getByTestId('finance-report-csv')).toBeVisible()
  })

  test('an owner reads the margin of the empty books next to the ledger', async ({ page }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.margin)
    await expect(page.getByRole('heading', { name: finance.margin.title, level: 1 })).toBeVisible()

    const margin = page.getByTestId('finance-margin')
    const form = margin.getByRole('form', { name: finance.statementsCommon.formLabel })
    await form.getByLabel(finance.statementsCommon.from, { exact: true }).fill('2026-01-01')
    await form.getByLabel(finance.statementsCommon.to, { exact: true }).fill('2026-01-31')
    await form.getByRole('button', { name: finance.statementsCommon.show, exact: true }).click()
    await expect(margin.getByTestId('finance-margin-none')).toBeVisible()
    await expect(margin.getByTestId('finance-margin-ledger')).toBeVisible()
    await expect(
      margin.getByTestId('finance-margin-ledger').locator('[data-line="revenue"]')
    ).toBeVisible()
  })

  test('with no incident of the weekly check, the periods and the reports show no notice', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.periods)
    await expect(page.getByRole('heading', { name: finance.periods.title, level: 1 })).toBeVisible()
    await expect(page.getByTestId('finance-chain-incident')).toHaveCount(0)
    await page.goto(AppPaths.finance.reports)
    await expect(page.getByRole('heading', { name: finance.reports.title, level: 1 })).toBeVisible()
    await expect(page.getByTestId('finance-chain-incident')).toHaveCount(0)
  })

  test('who may read the books but not the reports sees the VAT and has no margin', async ({
    page
  }) => {
    await signIn(page, readerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.accounts)
    await expect(page.getByRole('link', { name: nav.vat, exact: true })).toHaveCount(1)
    await expect(page.getByRole('link', { name: nav.margin, exact: true })).toHaveCount(0)
    await page.goto(AppPaths.finance.margin)
    await expect(
      page.getByRole('heading', { name: en.emptyStates.permissionDenied.title, level: 1 })
    ).toBeVisible()
    // The VAT is read with finance:view; the file asks for finance:export besides
    await page.goto(AppPaths.finance.vat)
    const vat = page.getByTestId('finance-vat')
    await vat
      .getByRole('form', { name: finance.statementsCommon.formLabel })
      .getByRole('button', { name: finance.statementsCommon.show, exact: true })
      .click()
    await expect(vat.getByTestId('finance-vat-none')).toBeVisible()
    await expect(vat.getByTestId('finance-report-csv')).toHaveCount(0)
  })

  test('who may read the reports but not take a file sees the margin without the file', async ({
    page
  }) => {
    await signIn(page, noExportEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.margin)
    const margin = page.getByTestId('finance-margin')
    await margin
      .getByRole('form', { name: finance.statementsCommon.formLabel })
      .getByRole('button', { name: finance.statementsCommon.show, exact: true })
      .click()
    await expect(margin.getByTestId('finance-margin-none')).toBeVisible()
    await expect(margin.getByTestId('finance-report-csv')).toHaveCount(0)
  })
})
