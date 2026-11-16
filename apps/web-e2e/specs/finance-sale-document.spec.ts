import { randomUUID } from 'node:crypto'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addFinanceViewer, addOwnerOfNewStore, addShippedTaxedSale } from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const finance = en.finance
const fiscal = finance.fiscal
const detail = en.orders.detail

// Finance, a sale end to end (Step 4B.9b-5b): a shipped sale of 2 x $11.30 with 13 % in the price is delivered through the screens, and
// what follows is read through the screens too: the fiscal document the simulator accepts, the sale entry in the books, the statement, the
// VAT of the month, then the voiding of the document and its replacement. Its own organization. The cases run in order. The figures are
// the ones seeded: $22.60 in all, $2.60 of tax, $20.00 net.
test.describe('Finance → a sale, its fiscal document and its entry', () => {
  test.describe.configure({ mode: 'serial' })
  // The worker makes the document and the entry after the screen answers: each wait below is up to a minute
  test.setTimeout(180_000)
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-finance-sale-owner-${run}@example.com`
  const viewerEmail = `e2e-finance-sale-viewer-${run}@example.com`
  let storeId = ''
  let sale = { id: '', orderNumber: '', remove: (): Promise<void> => Promise.resolve() }
  let removeViewer: () => Promise<void> = () => Promise.resolve()

  test.beforeAll(async () => {
    storeId = await addOwnerOfNewStore(ownerEmail, `E2E Sale ${run}`)
    removeViewer = await addFinanceViewer(storeId, viewerEmail)
    sale = await addShippedTaxedSale(storeId)
  })

  test.afterAll(async () => {
    try {
      await removeViewer()
    } finally {
      await sale.remove()
    }
  })

  test('an owner sets the books and the issuer up', async ({ page }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.home)
    await expect(page.getByRole('heading', { name: finance.setup.title, level: 1 })).toBeVisible()
    await page.getByLabel(finance.setup.startsOn, { exact: true }).fill('2026-01-01')
    await page.getByLabel(finance.setup.country, { exact: true }).selectOption({ index: 0 })
    await page.getByRole('button', { name: finance.setup.submit, exact: true }).click()
    await expect(
      page.getByRole('heading', { name: finance.accounts.title, level: 1 })
    ).toBeVisible()

    await page.goto(AppPaths.finance.fiscalIssuer)
    const form = page.getByTestId('fiscal-issuer-form')
    const mark = fiscal.issuer.requiredMark
    await form
      .getByLabel(`${fiscal.issuer.legalName} ${mark}`, { exact: true })
      .fill(`E2E Shop ${run}`)
    await form
      .getByLabel(`${fiscal.issuer.taxId} ${mark}`, { exact: true })
      .fill('0614-010101-101-0')
    const row = form.getByTestId('fiscal-address-row').first()
    await row.getByLabel(fiscal.address.key, { exact: true }).fill('line1')
    await row.getByLabel(fiscal.address.value, { exact: true }).fill('1 Main Street')
    await form.getByLabel('signingKey', { exact: true }).fill(`key-${run}`)
    await form.getByRole('button', { name: fiscal.issuer.submit, exact: true }).click()
    await expect(form.getByTestId('fiscal-credentials-state')).toHaveText(
      fiscal.issuer.credentials.stored
    )
  })

  test('the payment is recorded and the sale is delivered through the order page', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.store.order(storeId, sale.id))
    await expect(
      page.getByRole('heading', { name: detail.heading.replace('{number}', sale.orderNumber) })
    ).toBeVisible()
    // The payment first: it posts the advance entry that the sale entry clears
    await page.getByRole('button', { name: detail.payment.record }).click()
    const payment = page.getByRole('dialog')
    await payment.getByLabel(detail.payment.recordStatus).selectOption('COMPLETED')
    await payment.getByRole('button', { name: detail.payment.recordConfirm }).click()
    await expect(page.getByText(detail.payment.done)).toBeVisible()
    const flows = page.getByRole('group', { name: detail.flows.groupLabel })
    await flows.getByRole('button', { name: detail.flows.deliver.button }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: detail.flows.deliver.confirm, exact: true })
      .click()
    await expect(page.getByText(en.orders.status.DELIVERED, { exact: true }).first()).toBeVisible()
  })

  test('its fiscal document is made and accepted, and the detail tells the figures', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.fiscal)
    // The listener makes the document and the worker sends it to the simulator: the page is read again until it is accepted
    const accepted = page.locator('[data-testid="fiscal-document-row"][data-status="accepted"]')
    await expect(async () => {
      await page.reload()
      await expect(accepted).toHaveCount(1, { timeout: 2_000 })
    }).toPass({ timeout: 60_000 })

    await accepted.click()
    const dialog = page.getByRole('dialog')
    const facts = dialog.getByTestId('fiscal-detail')
    await expect(facts).toContainText(/\$22\.60\b/)
    await expect(facts).toContainText(/\$2\.60\b/)
    // A sale to a customer with no fiscal data is a consumer document: no receiver is asked for
    await expect(facts).toContainText('Simulated consumer document')
    await expect(dialog.getByTestId('fiscal-receiver')).toBeVisible()
  })

  test('its entry is in the books: the trial balance balances and the statement reads $20.00 of sale', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.journal)
    const rows = page.getByTestId('finance-entries').getByTestId('finance-entry-row')
    // The worker posts the advance of the payment and then the sale: the page is read again until both entries are there
    await expect(async () => {
      await page.reload()
      await expect(rows).toHaveCount(2, { timeout: 2_000 })
    }).toPass({ timeout: 60_000 })

    await page.goto(AppPaths.finance.reports)
    const trial = page.getByTestId('finance-trial-balance')
    await expect(trial.getByTestId('finance-trial-balance-verdict')).toContainText(
      finance.reports.trialBalance.balanced
    )

    await page.goto(AppPaths.finance.statements)
    const form = page.getByRole('form', { name: finance.statementsCommon.formLabel })
    await form.getByLabel(finance.statementsCommon.from, { exact: true }).fill('2026-01-01')
    await form.getByLabel(finance.statementsCommon.to, { exact: true }).fill(todayIso())
    await form.getByRole('button', { name: finance.statementsCommon.show, exact: true }).click()
    await expect(
      page.getByTestId('finance-income-statement').getByTestId('finance-statement-net-result')
    ).toContainText(/\$20\.00\b/)
  })

  test('the VAT of the month holds the $2.60 of the sale', async ({ page }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.vat)
    await expect(page.getByRole('heading', { name: finance.vat.title, level: 1 })).toBeVisible()
    await expect(page.getByTestId('finance-vat')).toContainText(/\$2\.60\b/)
  })

  test('the accepted document is voided with its reason and made again', async ({ page }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.fiscal)
    const row = (status: string) =>
      page.locator(`[data-testid="fiscal-document-row"][data-status="${status}"]`)
    await row('accepted').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: fiscal.actions.void, exact: true }).click()
    await dialog.getByLabel(fiscal.void.reason, { exact: true }).fill('E2E wrong receiver')
    await dialog.getByRole('button', { name: fiscal.void.submit, exact: true }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: fiscal.void.confirm, exact: true })
      .click()
    await expect(async () => {
      await page.reload()
      await expect(row('voided')).toHaveCount(1, { timeout: 2_000 })
    }).toPass({ timeout: 60_000 })

    // A voided sale document can be made again: a new number, sent and accepted
    await row('voided').click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: fiscal.actions.replace, exact: true })
      .click()
    await page
      .getByTestId('fiscal-replace-confirm')
      .getByRole('button', { name: fiscal.actions.replaceConfirm, exact: true })
      .click()
    await expect(async () => {
      await page.reload()
      await expect(row('accepted')).toHaveCount(1, { timeout: 2_000 })
    }).toPass({ timeout: 60_000 })
    await expect(row('voided')).toHaveCount(1)
  })

  test('who may only read the books cannot open the pages of the other permissions', async ({
    page
  }) => {
    await signIn(page, viewerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.accounts)
    await expect(
      page.getByRole('heading', { name: finance.accounts.title, level: 1 })
    ).toBeVisible()
    for (const path of [
      AppPaths.finance.journal,
      AppPaths.finance.transactions,
      AppPaths.finance.statements,
      AppPaths.finance.books,
      AppPaths.finance.margin,
      AppPaths.finance.fiscal
    ]) {
      await page.goto(path)
      await expect(
        page.getByRole('heading', { name: en.emptyStates.permissionDenied.title, level: 1 }),
        path
      ).toBeVisible()
    }
  })
})

// The day the case runs, as the date field wants it
function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}
