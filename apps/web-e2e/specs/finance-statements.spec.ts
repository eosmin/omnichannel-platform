import { randomUUID } from 'node:crypto'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addFinanceReportsViewer, addFinanceViewer, addOwnerOfNewStore } from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const finance = en.finance
const nav = en.settings.nav.finance

// Finance → Statements, Aging and Legal books (Step 4B.9b-3): read from a set of books that has no entry yet, so every number is zero and
// what the screens must say is true by itself. Its own organization. The cases run in order: the first one sets the books up and opens a
// month. **[ACCOUNTANT]** The legal books are drafts until an accountant confirms the layout: the notice is the thing that must show.
test.describe('Finance → statements, aging and legal books', () => {
  test.describe.configure({ mode: 'serial' })
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-finance-stmt-owner-${run}@example.com`
  const readerEmail = `e2e-finance-stmt-reader-${run}@example.com`
  const noExportEmail = `e2e-finance-stmt-noexport-${run}@example.com`
  let removeReader: () => Promise<void> = () => Promise.resolve()
  let removeNoExport: () => Promise<void> = () => Promise.resolve()

  test.beforeAll(async () => {
    const storeId = await addOwnerOfNewStore(ownerEmail, `E2E Statements ${run}`)
    removeReader = await addFinanceViewer(storeId, readerEmail)
    removeNoExport = await addFinanceReportsViewer(storeId, noExportEmail, false)
  })

  test.afterAll(async () => {
    await removeReader()
    await removeNoExport()
  })

  test('an owner sets the books up and opens a month', async ({ page }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.home)
    await expect(page.getByRole('heading', { name: finance.setup.title, level: 1 })).toBeVisible()
    await page.getByLabel(finance.setup.country, { exact: true }).selectOption({ index: 0 })
    await page.getByRole('button', { name: finance.setup.submit, exact: true }).click()
    await expect(
      page.getByRole('heading', { name: finance.accounts.title, level: 1 })
    ).toBeVisible()

    await page.getByRole('link', { name: nav.periods, exact: true }).click()
    await expect(page.getByRole('heading', { name: finance.periods.title, level: 1 })).toBeVisible()
    await page.getByRole('button', { name: finance.periods.open.action, exact: true }).click()
    const month = page.getByRole('dialog', { name: finance.periods.open.title })
    await month.getByLabel(finance.periods.open.month, { exact: true }).fill('1')
    await month.getByLabel(finance.periods.open.year, { exact: true }).fill('2030')
    await month.getByRole('button', { name: finance.periods.open.submit, exact: true }).click()
    await expect(
      page.getByTestId('finance-period-row').and(page.locator('[data-period="2030-01"]'))
    ).toHaveCount(1)
  })

  test('an owner reads the income statement, the balance sheet and the cash flow of the empty books', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.statements)
    await expect(
      page.getByRole('heading', { name: finance.statements.title, level: 1 })
    ).toBeVisible()

    // A range that ends before it starts is refused before the api is asked. (A day that is not on the calendar cannot be typed into a
    // date field, so that rule is proved by the unit spec of `statement-form` and by the contract spec against the schema of the api)
    const form = page.getByRole('form', { name: finance.statementsCommon.formLabel })
    await form.getByLabel(finance.statementsCommon.from, { exact: true }).fill('2026-02-10')
    await form.getByLabel(finance.statementsCommon.to, { exact: true }).fill('2026-02-01')
    await form.getByRole('button', { name: finance.statementsCommon.show, exact: true }).click()
    await expect(
      page.getByRole('alert').getByText(finance.statementsCommon.problems.order, { exact: true })
    ).toBeVisible()
    await form.getByLabel(finance.statementsCommon.from, { exact: true }).fill('2026-01-01')
    await form.getByLabel(finance.statementsCommon.to, { exact: true }).fill('2026-01-31')
    await form.getByRole('button', { name: finance.statementsCommon.show, exact: true }).click()

    const income = page.getByTestId('finance-income-statement')
    await expect(income.getByTestId('finance-statement-net-result')).toContainText('$0.00')
    await expect(income.getByTestId('finance-statement-gross-margin')).toContainText('$0.00')
    // A statement that cannot be whole says so above the numbers
    await expect(income.getByTestId('finance-report-warnings')).toBeVisible()

    await page.getByTestId('finance-statement-tab-balance').click()
    const balance = page.getByTestId('finance-balance-sheet')
    await balance.getByRole('button', { name: finance.statementsCommon.show, exact: true }).click()
    await expect(balance.getByTestId('finance-statement-equity-with-result')).toContainText('$0.00')

    await page.getByTestId('finance-statement-tab-cash').click()
    const cash = page.getByTestId('finance-cash-flow')
    await cash.getByRole('button', { name: finance.statementsCommon.show, exact: true }).click()
    await expect(cash.getByTestId('finance-cash-closing')).toContainText('$0.00')
  })

  test('an owner reads the lists with age', async ({ page }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.aging)
    await expect(page.getByRole('heading', { name: finance.aging.title, level: 1 })).toBeVisible()
    const aging = page.getByTestId('finance-aging')
    await aging.getByLabel(finance.aging.kind, { exact: true }).selectOption('payables')
    await aging.getByRole('button', { name: finance.statementsCommon.show, exact: true }).click()
    await expect(aging.getByText(finance.aging.none, { exact: true })).toBeVisible()
  })

  test('the legal books say they are a draft until the accountant confirms them', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.books)
    await expect(page.getByRole('heading', { name: finance.books.title, level: 1 })).toBeVisible()
    const filters = page.getByTestId('finance-book-filters')
    await filters.getByLabel(finance.books.kind, { exact: true }).selectOption('purchases')
    await filters.getByLabel(finance.books.period, { exact: true }).selectOption({ index: 1 })

    const book = page.getByTestId('finance-book')
    await expect(book).toBeVisible()
    // The proposal ships with the code and nobody has validated it
    await expect(book.getByTestId('finance-book-unvalidated')).toContainText(
      finance.books.unvalidated.title
    )
    await expect(book.getByTestId('finance-book-open')).toBeVisible()
    await expect(book.getByTestId('finance-book-empty')).toBeVisible()
    // The file says it is a draft too
    await expect(
      page.getByRole('button', { name: finance.books.downloadDraft, exact: true })
    ).toBeVisible()
    await expect(page.getByTestId('finance-frozen-books')).toBeVisible()
  })

  test('who may read the books but not their statements has no link and is told so', async ({
    page
  }) => {
    await signIn(page, readerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.accounts)
    await expect(page.getByRole('link', { name: nav.statements, exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: nav.aging, exact: true })).toHaveCount(0)
    await expect(page.getByRole('link', { name: nav.books, exact: true })).toHaveCount(0)
    await page.goto(AppPaths.finance.statements)
    await expect(
      page.getByRole('heading', { name: en.emptyStates.permissionDenied.title, level: 1 })
    ).toBeVisible()
  })

  test('who may read the statements but not take a file sees them without the file, and no legal book', async ({
    page
  }) => {
    await signIn(page, noExportEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.statements)
    const form = page.getByRole('form', { name: finance.statementsCommon.formLabel })
    await form.getByRole('button', { name: finance.statementsCommon.show, exact: true }).click()
    await expect(page.getByTestId('finance-statement-net-result')).toBeVisible()
    await expect(page.getByTestId('finance-report-csv')).toHaveCount(0)
    // A book lists supplier names and tax ids: the api asks for the file permission to read it, so the page does too
    await page.goto(AppPaths.finance.books)
    await expect(
      page.getByRole('heading', { name: en.emptyStates.permissionDenied.title, level: 1 })
    ).toBeVisible()
  })
})
