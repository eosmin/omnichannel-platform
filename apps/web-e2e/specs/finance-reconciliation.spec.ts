import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import { AppPaths } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'

import en from '../../web/messages/en.json' with { type: 'json' }
import { financeCall, signInByApi } from '../support/api'
import { addFinanceViewer, addOwnerOfNewStore } from '../support/database'
import { expectDialogFitsThePhoneWidth } from '../support/dialog-fit'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const reconciliation = en.finance.reconciliation
const profiles = reconciliation.profiles
const imports = reconciliation.imports
const lines = reconciliation.lines
const nav = en.settings.nav.finance

// Finance → Bank reconciliation (Step 4B.9a-3): a profile read against a sample, a statement imported, the suggestions the rules make and
// what a person decides on them. Its own organization, so the books these cases make are nobody else's. The books are set up through the
// api (the accounts and the two expenses a statement is matched against); everything about the reconciliation is done on the screen.
// The cases run in order: the first one makes the profile and imports the statement the others decide on.
test.describe('Finance → bank reconciliation', () => {
  test.describe.configure({ mode: 'serial' })
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-bank-owner-${run}@example.com`
  const viewerEmail = `e2e-bank-viewer-${run}@example.com`
  const bankName = `E2E bank ${run}`
  const bankLabel = `E2B${run} ${bankName}`
  const profileName = `E2E profile ${run}`
  let storeId = ''
  let removeViewer: () => Promise<void> = () => Promise.resolve()

  // The books of this month (UTC), so the case does not depend on the day it runs
  const month = new Date().toISOString().slice(0, 7)
  const [year, monthNumber] = month.split('-')
  const day = (number: string): string => `${month}-${number}`
  const GOOD_CSV = [
    'Date,Description,Reference,Amount',
    `${day('03')},Fuel station,REF-FUEL-77,-15.00`,
    `${day('10')},Unknown charge,,-99.99`,
    `${day('05')},Office supplies,,-25.00`
  ].join('\n')
  const BAD_CSV = ['Date,Description,Reference,Amount', `${day('03')},Fuel station,REF,abc`].join(
    '\n'
  )

  test.beforeAll(async () => {
    storeId = await addOwnerOfNewStore(ownerEmail, `E2E Bank ${run}`)
    removeViewer = await addFinanceViewer(storeId, viewerEmail)
    const token = await signInByApi(ownerEmail)
    const state = z
      .object({ countries: z.array(z.string()) })
      .parse(await financeCall(token, storeId, ApiRoutes.finance.setup))
    const country = state.countries[0]
    if (country === undefined) throw new Error('there is no chart of accounts to start from')
    await financeCall(token, storeId, ApiRoutes.finance.setup, {
      method: 'POST',
      body: { countryCode: country, accountingStartDate: day('01') }
    })
    const account = async (body: Record<string, unknown>): Promise<string> =>
      z.object({ id: z.string() }).parse(
        await financeCall(token, storeId, ApiRoutes.finance.accounts.create, {
          method: 'POST',
          body
        })
      ).id
    const bank = await account({
      code: `E2B${run}`,
      name: bankName,
      type: 'asset',
      cashKind: 'bank',
      isPostable: true
    })
    const expense = await account({
      code: `E2X${run}`,
      name: `E2E expense ${run}`,
      type: 'expense',
      isPostable: true
    })
    const spend = (day: string, cents: number, memo: string, documentNumber?: string) =>
      financeCall(token, storeId, ApiRoutes.finance.transactions.record, {
        method: 'POST',
        body: {
          idempotencyKey: `e2e-${run}-${day}-${String(cents)}`,
          kind: 'expense',
          occurredOn: day,
          amountCents: cents,
          fromAccountId: bank,
          categoryAccountId: expense,
          memo,
          ...(documentNumber === undefined ? {} : { documentNumber })
        }
      })
    // The same day and the same reference as the first line of the statement, and a day apart for the third
    await spend(day('03'), 1500, 'Fuel', 'REF-FUEL-77')
    await spend(day('04'), 2500, 'Office supplies')
  })

  test.afterAll(async () => {
    await removeViewer()
  })

  test('an owner makes a profile from a sample, then imports a statement and sees its lines', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.reconciliation)
    await expect(page.getByRole('heading', { name: reconciliation.title, level: 1 })).toBeVisible()
    await page
      .getByTestId('bank-account-picker')
      .getByLabel(reconciliation.account, { exact: true })
      .selectOption({ label: bankLabel })

    // A profile: an empty form is refused first, and the dialog fits a phone
    await page.getByRole('button', { name: profiles.new, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: profiles.dialog.createTitle })
    await dialog.getByRole('button', { name: profiles.dialog.create, exact: true }).click()
    await expect(dialog.getByRole('alert').first()).toBeVisible()
    await expectDialogFitsThePhoneWidth(page, dialog)
    await dialog.getByLabel(profiles.dialog.fields.name, { exact: true }).fill(profileName)
    await dialog.getByLabel(profiles.dialog.fields.date, { exact: true }).fill('Date')
    await dialog.getByLabel(profiles.dialog.fields.amount, { exact: true }).fill('Amount')
    await dialog.getByLabel(profiles.dialog.fields.description, { exact: true }).fill('Description')
    await dialog.getByLabel(profiles.dialog.fields.reference, { exact: true }).fill('Reference')

    // The mapper reads a sample and shows what it would import, and the api's reason for a row it cannot read
    await dialog.getByLabel(profiles.dialog.sample.label, { exact: true }).setInputFiles({
      name: 'sample.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(GOOD_CSV)
    })
    await expect(dialog.getByTestId('bank-sample-headers')).toContainText('Amount')
    await dialog.getByRole('button', { name: profiles.dialog.sample.preview, exact: true }).click()
    await expect(dialog.getByTestId('bank-preview')).toBeVisible()
    await expect(dialog.getByTestId('bank-preview').getByRole('row')).toHaveCount(4)
    await dialog.getByRole('button', { name: profiles.dialog.create, exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(
      page.locator(`[data-testid="bank-profile-row"][data-name="${profileName}"]`)
    ).toHaveCount(1)

    // A statement with a row that cannot be read is refused whole, with its row and its reason
    await page.getByTestId('bank-import-open').click()
    const importing = page.getByRole('dialog', { name: imports.dialog.title })
    // No profile chosen (N-BR1-14): the screen asks for one, and the api is never asked about a profile that was not named
    await importing.getByLabel(imports.dialog.file, { exact: true }).setInputFiles({
      name: 'no-profile.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(GOOD_CSV)
    })
    await importing.getByRole('button', { name: imports.dialog.submit, exact: true }).click()
    await expect(
      importing.getByRole('alert').getByText(imports.dialog.problems.profile)
    ).toBeVisible()
    await importing
      .getByLabel(imports.dialog.profile, { exact: true })
      .selectOption({ label: profileName })
    await importing.getByLabel(imports.dialog.file, { exact: true }).setInputFiles({
      name: 'bad.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(BAD_CSV)
    })
    await importing.getByRole('button', { name: imports.dialog.submit, exact: true }).click()
    await expect(importing.getByTestId('bank-row-errors')).toContainText('Row 2')
    await expectDialogFitsThePhoneWidth(page, importing)

    // The good one, with the balance it ends with: a balance with no day is refused first
    await importing.getByLabel(imports.dialog.file, { exact: true }).setInputFiles({
      name: 'statement.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(GOOD_CSV)
    })
    await importing.getByLabel(imports.dialog.closingBalance, { exact: true }).fill('500.00')
    await importing.getByRole('button', { name: imports.dialog.submit, exact: true }).click()
    await expect(
      importing.getByRole('alert').getByText(imports.dialog.problems.closingOn)
    ).toBeVisible()
    await importing.getByLabel(imports.dialog.closingOn, { exact: true }).fill(day('28'))
    await importing.getByRole('button', { name: imports.dialog.submit, exact: true }).click()
    await expect(importing).toHaveCount(0)

    // The statement opens with its three lines: two have a suggestion, one has none (all three are open), and the books are compared
    // with the balance
    const statement = page.getByTestId('bank-statement')
    await expect(statement).toBeVisible()
    await expect(statement.getByTestId('bank-line-row')).toHaveCount(3)
    await expect(statement.getByTestId('bank-difference')).toBeVisible()
    await expect(statement.getByTestId('bank-filter-suggested')).toContainText('(2)')
    await expect(statement.getByTestId('bank-filter-unmatched')).toContainText('(3)')
  })

  test('a person confirms one suggestion, takes it back, rejects another and sees the line nobody explains', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.reconciliation)
    await page
      .getByTestId('bank-account-picker')
      .getByLabel(reconciliation.account, { exact: true })
      .selectOption({ label: bankLabel })
    await page
      .getByTestId('bank-import-row')
      .first()
      .getByRole('button', { name: imports.open, exact: true })
      .click()
    const statement = page.getByTestId('bank-statement')
    // The api numbers the rows of the file, and the header is row 1: the first line of data is 2
    const row = (position: number) =>
      statement.locator(`[data-testid="bank-line-row"][data-line-no="${String(position + 1)}"]`)

    // The first line: the same amount to the cent, the same day and the same reference, so it is an exact suggestion
    const first = row(1)
    await expect(first).toHaveAttribute('data-state', 'suggested')
    const reasons = first.getByTestId('bank-suggestion').getByTestId('bank-reasons')
    await expect(reasons.locator('[data-reason="sameAmount"]')).toHaveCount(1)
    await expect(reasons.locator('[data-reason="sameDay"]')).toHaveCount(1)
    await expect(reasons.locator('[data-reason="reference"]')).toHaveCount(1)
    await expect(reasons.locator('[data-reason="exact"]')).toHaveCount(1)
    await first.getByTestId('bank-suggestion-confirm').click()
    await expect(first).toHaveAttribute('data-state', 'matched')
    await expect(first.getByTestId('bank-line-match')).toBeVisible()
    await first.getByTestId('bank-line-undo').click()
    await expect(first).toHaveAttribute('data-state', 'suggested')

    // The third line is a day apart and has no reference: a suggestion that is not exact. Rejecting asks first and can be cancelled
    const third = row(3)
    await expect(third.getByTestId('bank-suggestion')).toHaveAttribute('data-exact', 'false')
    await expect(third.locator('[data-reason="daysApart"]')).toHaveCount(1)
    await third.getByTestId('bank-suggestion-reject').click()
    const asking = page.getByRole('alertdialog')
    await expectDialogFitsThePhoneWidth(page, asking)
    await asking.getByRole('button', { name: reconciliation.cancel, exact: true }).click()
    await expect(asking).toHaveCount(0)
    await expect(third).toHaveAttribute('data-state', 'suggested')
    await third.getByTestId('bank-suggestion-reject').click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: lines.reject, exact: true })
      .click()
    await expect(third).toHaveAttribute('data-state', 'unmatched')

    // The line nothing explains offers to show how it would be recorded, and records nothing
    const second = row(2)
    await expect(second).toHaveAttribute('data-state', 'unmatched')
    await second.getByTestId('bank-line-register').click()
    const draft = page.getByTestId('bank-draft-dialog')
    await expect(draft.getByTestId('bank-draft')).toBeVisible()
    await expectDialogFitsThePhoneWidth(page, draft)
    await draft.getByRole('button', { name: reconciliation.draft.close, exact: true }).click()
    await expect(draft).toHaveCount(0)
  })

  test('the exact matches are confirmed in bulk only after the person says yes', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.reconciliation)
    await page
      .getByTestId('bank-account-picker')
      .getByLabel(reconciliation.account, { exact: true })
      .selectOption({ label: bankLabel })
    await page
      .getByTestId('bank-import-row')
      .first()
      .getByRole('button', { name: imports.open, exact: true })
      .click()
    const statement = page.getByTestId('bank-statement')
    const first = statement.locator('[data-testid="bank-line-row"][data-line-no="2"]')
    await expect(first).toHaveAttribute('data-state', 'suggested')

    await statement.getByTestId('bank-confirm-exact').click()
    const asking = page.getByRole('alertdialog')
    await expectDialogFitsThePhoneWidth(page, asking)
    // Cancelling decides nothing
    await asking.getByRole('button', { name: reconciliation.cancel, exact: true }).click()
    await expect(asking).toHaveCount(0)
    await expect(first).toHaveAttribute('data-state', 'suggested')

    await statement.getByTestId('bank-confirm-exact').click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: reconciliation.statement.confirmExactAction, exact: true })
      .click()
    await expect(first).toHaveAttribute('data-state', 'matched')
    await statement.getByTestId('bank-filter-matched').click()
    await expect(statement.getByTestId('bank-line-row')).toHaveCount(1)

    // The month is not reconciled yet: lines of the books and of the statement are still open
    await page.getByLabel(reconciliation.status.month, { exact: true }).fill(monthNumber ?? '')
    await page.getByLabel(reconciliation.status.year, { exact: true }).fill(year ?? '')
    await expect(page.getByTestId('bank-status')).toHaveAttribute('data-reconciled', 'false')
  })

  test('a person who may read the books but not reconcile them has no link and no page', async ({
    page
  }) => {
    await signIn(page, viewerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.accounts)
    await expect(
      page.getByRole('heading', { name: en.finance.accounts.title, level: 1 })
    ).toBeVisible()
    await expect(page.getByRole('link', { name: nav.reconciliation, exact: true })).toHaveCount(0)
    await page.goto(AppPaths.finance.reconciliation)
    await expect(
      page.getByRole('heading', { name: en.emptyStates.permissionDenied.title, level: 1 })
    ).toBeVisible()
  })
})
