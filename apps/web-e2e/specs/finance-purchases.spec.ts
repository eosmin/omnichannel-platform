import { randomUUID } from 'node:crypto'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addFinanceViewer, addOwnerOfNewStore, addTransferScenario } from '../support/database'
import { expectDialogFitsThePhoneWidth } from '../support/dialog-fit'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const finance = en.finance
const purchases = en.finance.purchases
const nav = en.settings.nav.finance

// Finance → purchases (Step 4B.9a-4): a supplier, a purchase order from its draft to its receipt, and the bill paid from the payables,
// through the screens. Its own organization, so the books these cases make are nobody else's. The cases run in order: the first one
// sets the books up and makes the supplier, the next ones buy from it.
test.describe('Finance → suppliers, purchases and payables', () => {
  test.describe.configure({ mode: 'serial' })
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-purchases-owner-${run}@example.com`
  const viewerEmail = `e2e-purchases-viewer-${run}@example.com`
  const supplierName = `E2E Supplier ${run}`
  const documentNumber = `FAC-${run}`
  let storeId = ''
  let warehouseName = ''
  let productName = ''
  let removeViewer: () => Promise<void> = () => Promise.resolve()

  test.beforeAll(async () => {
    storeId = await addOwnerOfNewStore(ownerEmail, `E2E Purchases ${run}`)
    // A warehouse linked to the store and a stocked product to buy
    const scenario = await addTransferScenario(storeId, run, 1)
    warehouseName = scenario.from.name
    productName = scenario.productName
    removeViewer = await addFinanceViewer(storeId, viewerEmail)
  })

  test.afterAll(async () => {
    await removeViewer()
  })

  test('an owner sets the books up and makes a supplier, which can then be found and edited', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.home)
    await expect(page.getByRole('heading', { name: finance.setup.title, level: 1 })).toBeVisible()
    await page.getByLabel(finance.setup.country, { exact: true }).selectOption({ index: 0 })
    await page.getByRole('button', { name: finance.setup.submit, exact: true }).click()
    await expect(
      page.getByRole('heading', { name: finance.accounts.title, level: 1 })
    ).toBeVisible()

    // The suppliers page is in the navigation of the area
    await page.getByRole('link', { name: nav.suppliers, exact: true }).click()
    await expect(
      page.getByRole('heading', { name: purchases.suppliers.title, level: 1 })
    ).toBeVisible()

    // An empty form is refused first, and the dialog fits a phone
    await page.getByRole('button', { name: purchases.suppliers.new, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: purchases.supplierDialog.createTitle })
    await dialog.getByRole('button', { name: purchases.supplierDialog.create, exact: true }).click()
    await expect(dialog.getByRole('alert').first()).toBeVisible()
    await expectDialogFitsThePhoneWidth(page, dialog)
    await dialog
      .getByLabel(purchases.supplierDialog.fields.name, { exact: true })
      .fill(supplierName)
    await dialog
      .getByLabel(purchases.supplierDialog.fields.taxId, { exact: true })
      .fill('0614-010101-101-0')
    await dialog
      .getByLabel(purchases.supplierDialog.fields.paymentTermsDays, { exact: true })
      .fill('30')
    await dialog.getByRole('button', { name: purchases.supplierDialog.create, exact: true }).click()
    await expect(dialog).toHaveCount(0)

    const row = page
      .getByTestId('finance-suppliers')
      .locator(`[data-testid="finance-supplier-row"][data-name="${supplierName}"]`)
    await expect(row).toHaveCount(1)

    // Search by name finds it and a name that matches nothing says so
    await page.getByLabel(purchases.suppliers.search, { exact: true }).fill(`zzz-${run}`)
    await expect(page.getByText(purchases.suppliers.noMatch)).toBeVisible()
    await page.getByLabel(purchases.suppliers.search, { exact: true }).fill(supplierName)
    await expect(row).toHaveCount(1)

    // Edit: the form opens with what is saved, and a change is saved
    await row.getByRole('button', { name: purchases.suppliers.edit, exact: true }).click()
    const edit = page.getByRole('dialog', { name: purchases.supplierDialog.editTitle })
    await expect(
      edit.getByLabel(purchases.supplierDialog.fields.name, { exact: true })
    ).toHaveValue(supplierName)
    await edit.getByLabel(purchases.supplierDialog.fields.phone, { exact: true }).fill('2222-0000')
    await edit.getByRole('button', { name: purchases.supplierDialog.save, exact: true }).click()
    await expect(edit).toHaveCount(0)
  })

  test('a purchase order goes from a draft to a receipt, and its bill is paid from the payables', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.purchases)
    await expect(
      page.getByRole('heading', { name: purchases.orders.title, level: 1 })
    ).toBeVisible()

    // A draft: it needs a supplier and a warehouse
    await page.getByRole('button', { name: purchases.orders.new, exact: true }).click()
    const start = page.getByRole('dialog', { name: purchases.newOrder.title })
    await start.getByRole('button', { name: purchases.newOrder.create, exact: true }).click()
    await expect(start.getByRole('alert').first()).toBeVisible()
    await expectDialogFitsThePhoneWidth(page, start)
    await start
      .getByLabel(purchases.newOrder.fields.supplier, { exact: true })
      .selectOption({ label: supplierName })
    await start
      .getByLabel(purchases.newOrder.fields.warehouse, { exact: true })
      .selectOption({ label: warehouseName })
    await start.getByRole('button', { name: purchases.newOrder.create, exact: true }).click()

    // The page of the order: a draft, where the lines are chosen
    await expect(page.getByTestId('purchase-number')).toBeVisible()
    await expect(page.getByTestId('purchase-status')).toHaveAttribute('data-status', 'draft')
    const picker = page.getByTestId('purchase-item-picker')
    await picker.getByLabel(purchases.picker.search, { exact: true }).fill(productName)
    await picker.getByRole('button', { name: productName }).click()
    const line = page.getByTestId('order-line-draft')
    await expect(line).toHaveCount(1)
    // A line with no cost is refused, then a cost of one unit is typed as dollars
    await page.getByRole('button', { name: purchases.lines.save, exact: true }).click()
    await expect(line.getByRole('alert').getByText(purchases.lines.wrongCost)).toBeVisible()
    await line.getByLabel(purchases.lines.quantity, { exact: true }).fill('4')
    await line.getByLabel(purchases.lines.unitCost, { exact: true }).fill('12.50')
    await expect(
      page.getByTestId('order-lines-totals').getByText('$50.00', { exact: true }).first()
    ).toBeVisible()
    await page.getByRole('button', { name: purchases.lines.save, exact: true }).click()
    await expect(page.getByText(purchases.lines.saved, { exact: true })).toBeVisible()

    // Ordered, then received in full with the supplier's document
    await page.getByRole('button', { name: purchases.order.markOrdered, exact: true }).click()
    await expect(page.getByTestId('purchase-status')).toHaveAttribute('data-status', 'ordered')
    await page.getByRole('button', { name: purchases.order.receive, exact: true }).click()
    const receive = page.getByRole('dialog')
    await expectDialogFitsThePhoneWidth(page, receive)
    await expect(receive.getByTestId('receive-line').getByRole('textbox')).toHaveValue('4')
    // More than what is pending is refused before anything is sent
    await receive.getByTestId('receive-line').getByRole('textbox').fill('5')
    await receive.getByRole('button', { name: purchases.receive.submit, exact: true }).click()
    await expect(
      receive
        .getByRole('alert')
        .getByText(purchases.receive.problems.quantity.replace('{max}', '4'))
    ).toBeVisible()
    await receive.getByTestId('receive-line').getByRole('textbox').fill('4')
    await receive
      .getByLabel(purchases.receive.fields.document, { exact: true })
      .fill(documentNumber)
    await receive.getByRole('button', { name: purchases.receive.submit, exact: true }).click()
    await expect(receive).toHaveCount(0)
    await expect(page.getByTestId('purchase-status')).toHaveAttribute('data-status', 'received')
    const bill = page.getByTestId('order-bill').filter({ hasText: documentNumber })
    await expect(bill).toHaveCount(1)

    // The bill is open in the payables, with its due day, and is paid there
    await page.getByRole('link', { name: nav.payables, exact: true }).click()
    await expect(
      page.getByRole('heading', { name: purchases.payables.title, level: 1 })
    ).toBeVisible()
    const open = page.getByTestId('payables-bill').filter({ hasText: documentNumber })
    await expect(open).toHaveCount(1)
    await open.getByRole('button', { name: purchases.payables.pay, exact: true }).click()
    const pay = page.getByRole('dialog', { name: purchases.payment.title })
    await expectDialogFitsThePhoneWidth(page, pay)
    // An account is needed, and the amount is the whole of what is open
    await pay.getByRole('button', { name: purchases.payment.submit, exact: true }).click()
    await expect(pay.getByRole('alert').first()).toBeVisible()
    await expect(pay.getByLabel(purchases.payment.fields.amount, { exact: true })).toHaveValue(
      '50.00'
    )
    await pay
      .getByLabel(purchases.payment.fields.account, { exact: true })
      .selectOption({ index: 1 })
    await pay.getByRole('button', { name: purchases.payment.submit, exact: true }).click()
    await expect(pay).toHaveCount(0)
    await expect(page.getByTestId('payables-bill').filter({ hasText: documentNumber })).toHaveCount(
      0
    )
  })

  test('a person who may only read the books cannot open the purchases', async ({ page }) => {
    await signIn(page, viewerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.suppliers)
    await expect(
      page.getByRole('heading', { name: en.emptyStates.permissionDenied.title, level: 1 })
    ).toBeVisible()
    await expect(
      page.getByRole('button', { name: purchases.suppliers.new, exact: true })
    ).toHaveCount(0)
    // And the navigation of the area does not offer them
    await expect(page.getByRole('link', { name: nav.suppliers, exact: true })).toHaveCount(0)
  })
})
