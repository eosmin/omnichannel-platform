import { randomUUID } from 'node:crypto'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addCodDeliveredGuide,
  addShippingScenario,
  removeRemittancesOf,
  type ShippingScenario,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds `remittances:view` and `remittances:manage`
const ADMIN = 'multi-store@test.com'
const IMPORT = en.remittances.import
const LINES = en.remittances.lines
const CONFIRM = en.remittances.confirm

// The import of a carrier's settlement file in the browser (TDD_17 §4.15, Step 4.14 PR F7b-2): paste the table, say which
// column is which, read the preview, save the mapping, make the draft and confirm it.
test.describe('importing a settlement file', () => {
  test.describe.configure({ mode: 'serial' })

  const run = randomUUID().slice(0, 6)
  let storeId: string
  let scenario: ShippingScenario
  let guide = ''
  const missing = `NOGUIDE-${run}`

  test.beforeAll(async () => {
    storeId = await storeIdNamed(FIRST_STORE)
    scenario = await addShippingScenario(storeId, run)
    guide = await addCodDeliveredGuide(storeId, scenario, 1550)
  })
  test.afterAll(async () => {
    await removeRemittancesOf(scenario.connection.id)
    await scenario.remove()
  })

  test('reads the pasted file with the column mapping, makes the draft and confirms it', async ({
    page
  }) => {
    await signIn(page, ADMIN)
    await page.goto(AppPaths.store.remittanceImport(storeId))
    await expect(page.getByRole('heading', { name: IMPORT.title })).toBeVisible()

    await page.getByLabel(IMPORT.connection, { exact: true }).selectOption({
      label: scenario.connection.name
    })
    await page
      .getByLabel(IMPORT.source.paste, { exact: true })
      .fill(`Guia,Monto\n${guide},15.50\n${missing},3.00`)
    await page.getByLabel(IMPORT.fields.guideNumber, { exact: true }).fill('Guia')
    await page.getByLabel(IMPORT.fields.amount, { exact: true }).fill('Monto')

    // The preview reads both rows and saves nothing
    const preview = page.getByRole('region', { name: IMPORT.preview.title })
    await expect(preview.getByRole('cell', { name: guide, exact: true })).toBeVisible()
    await expect(preview.getByRole('cell', { name: missing, exact: true })).toBeVisible()
    await expect(preview).toContainText('15.50')

    // The file is read with a saved mapping: the import waits for it
    await expect(page.getByText(IMPORT.action.saveFirst)).toBeVisible()
    await page.getByLabel(IMPORT.mapping.name, { exact: true }).fill(`Mapping ${run}`)
    await page.getByRole('button', { name: IMPORT.mapping.save, exact: true }).click()
    await expect(page.getByText(IMPORT.action.description)).toBeVisible()

    await page.getByRole('button', { name: IMPORT.action.import, exact: true }).click()
    await expect(page).toHaveURL(/\/remittances\/(?!import$)[^/]+$/)

    // The draft: the guide that matches and the one nobody knows
    await expect(page.getByText(en.remittances.status.draft, { exact: true }).first()).toBeVisible()
    const matched = page.getByRole('row').filter({ hasText: guide })
    await expect(matched.getByText(en.remittances.outcome.matched)).toBeVisible()
    const unknown = page.getByRole('row').filter({ hasText: missing })
    await expect(unknown.getByText(en.remittances.outcome.not_found)).toBeVisible()
    await expect(page.getByText(LINES.caption)).toBeAttached()

    // A line of a draft is corrected by hand, and the draft works its totals out again
    await unknown.getByRole('button', { name: LINES.editLine.replace('{guide}', missing) }).click()
    const edit = page.getByRole('form', { name: LINES.edit.label.replace('{guide}', missing) })
    await edit.getByLabel(LINES.edit.reported, { exact: true }).fill('4.00')
    await edit.getByRole('button', { name: LINES.edit.save, exact: true }).click()
    await expect(page.getByRole('row').filter({ hasText: missing })).toContainText('4.00')

    // Confirming asks twice, and marks the matched guide as remitted
    await page.getByRole('button', { name: CONFIRM.action, exact: true }).click()
    await page
      .getByRole('alertdialog', { name: CONFIRM.dialog.title })
      .getByRole('button', { name: CONFIRM.dialog.confirm, exact: true })
      .click()
    await expect(
      page.getByText(en.remittances.status.confirmed, { exact: true }).first()
    ).toBeVisible()

    // Voiding a confirmed remittance sends its shipments back to waiting for one
    await page.getByRole('button', { name: en.remittances.void.action, exact: true }).click()
    await page
      .getByRole('alertdialog', { name: /^Void remittance/ })
      .getByRole('button', { name: en.remittances.void.dialog.confirm, exact: true })
      .click()
    await expect(
      page.getByText(en.remittances.status.voided, { exact: true }).first()
    ).toBeVisible()
  })
})
