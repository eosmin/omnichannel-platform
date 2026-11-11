import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addOwnerOfNewStore,
  addTransferReceiver,
  addTransferScenario,
  onHandOf,
  type TransferScenario
} from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const text = en.transfers
const warehouseText = en.warehouses
const PHONE = { width: 360, height: 740 }
const TRANSFER_URL = /\/org\/transfers\/[0-9a-f-]{36}$/

// Organization → Transfers, through the screens: the draft, the dispatch, a partial receipt on a phone by a person who
// only receives, the close with a shortage, a cancel of one on its way, and the refusals of the warehouses that say why.
// Its own organization: the stock the cases move belongs to nobody else.
test.describe('Organization → Transfers', () => {
  test.describe.configure({ mode: 'serial' })

  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-transfers-owner-${run}@example.com`
  const receiverEmail = `e2e-transfers-receiver-${run}@example.com`
  let storeId = ''
  let scenario: TransferScenario
  let removeReceiver: (() => Promise<void>) | null = null
  // The transfer the first cases build, found again by its address
  let firstTransferPath = ''

  test.beforeAll(async () => {
    storeId = await addOwnerOfNewStore(ownerEmail, `E2E Transfer Shop ${run}`)
    scenario = await addTransferScenario(storeId, run, 10)
    removeReceiver = await addTransferReceiver(storeId, receiverEmail)
  })

  test.afterAll(async () => {
    await removeReceiver?.()
  })

  const open = async (page: Page, email: string, path: string): Promise<void> => {
    await signIn(page, email)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(path)
  }

  const warehouseLabel = (warehouse: { code: string; name: string }): string =>
    `${warehouse.code} · ${warehouse.name}`

  // Makes a draft with one item and sends it; returns the address of the transfer
  const sendTransfer = async (page: Page, units: number): Promise<string> => {
    await page.goto(AppPaths.org.transfers)
    await page.getByRole('button', { name: text.new.open }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(text.new.from).selectOption({ label: warehouseLabel(scenario.from) })
    await dialog.getByLabel(text.new.to).selectOption({ label: warehouseLabel(scenario.to) })
    await dialog.getByRole('button', { name: text.new.submit }).click()
    await page.waitForURL(TRANSFER_URL)
    const path = new URL(page.url()).pathname

    await page.getByLabel(text.picker.search).fill(scenario.sku)
    await page.getByLabel(text.picker.units, { exact: true }).fill(String(units))
    await page.getByRole('button', { name: new RegExp(scenario.productName) }).click()
    await expect(
      page.getByLabel(text.draft.unitsOf.replace('{name}', scenario.productName))
    ).toHaveValue(String(units))
    await page.getByRole('button', { name: text.draft.save }).click()
    await expect(page.getByText(text.draft.saved).first()).toBeVisible()
    await page.getByRole('button', { name: text.draft.dispatch }).click()
    await expect(page.getByText(text.dispatched).first()).toBeVisible()
    await expect(page.getByText(text.status.in_transit, { exact: true })).toBeVisible()
    return path
  }

  test('an administrator drafts a transfer, adds an item and sends it: the units leave the origin', async ({
    page
  }) => {
    await open(page, ownerEmail, AppPaths.org.transfers)
    await expect(page.getByText(text.empty)).toBeVisible()

    // The same warehouse twice is refused before any request
    await page.getByRole('button', { name: text.new.open }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(text.new.from).selectOption({ label: warehouseLabel(scenario.from) })
    await dialog.getByLabel(text.new.to).selectOption({ label: warehouseLabel(scenario.from) })
    await expect(dialog.getByRole('alert').getByText(text.new.same)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    firstTransferPath = await sendTransfer(page, 4)
    // The ledger moved with the status: four units are on their way, six stay
    expect(await onHandOf(scenario.from.id, scenario.productName)).toBe(6)
    expect(await onHandOf(scenario.to.id, scenario.productName)).toBe(0)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('TR-')

    await page.goto(AppPaths.org.transfers)
    await expect(page.getByRole('link', { name: new RegExp(text.status.in_transit) })).toBeVisible()
  })

  test('a warehouse with a transfer on its way, or with stock, cannot be switched off, and says why', async ({
    page
  }) => {
    await open(page, ownerEmail, AppPaths.org.warehouses)
    const dialog = page.getByRole('dialog')

    await page.getByRole('button', { name: new RegExp(scenario.to.code) }).click()
    await dialog.getByRole('button', { name: warehouseText.state.switchOff }).click()
    await expect(
      dialog.getByRole('alert').getByText(warehouseText.stockBlock.openTransfer)
    ).toBeVisible()
  })

  test('a person who only receives sees the receipt, not the draft, and takes in part of it from a phone', async ({
    page
  }) => {
    await page.setViewportSize(PHONE)
    await open(page, receiverEmail, firstTransferPath)
    await expect(page.getByRole('form', { name: text.receive.formLabel })).toBeVisible()
    await expect(page.getByRole('form', { name: text.draft.formLabel })).toHaveCount(0)
    await expect(page.getByRole('button', { name: text.cancel.open })).toHaveCount(0)

    // The list opens for them from the navigation, and offers no way to make a draft
    await page.goto(AppPaths.org.transfers)
    await expect(page.getByRole('link', { name: text.title }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: text.new.open })).toHaveCount(0)
    await page.goto(firstTransferPath)

    // An unknown code says so; the SKU of the item adds one unit, and two taps add two more
    const code = page.getByLabel(text.receive.code)
    await code.fill('NOT-A-SKU')
    await code.press('Enter')
    await expect(page.getByRole('alert').getByText(text.receive.notInTransfer)).toBeVisible()
    await code.fill(scenario.sku.toLowerCase())
    await code.press('Enter')
    const units = page.getByLabel(text.receive.unitsOf.replace('{name}', scenario.productName))
    await expect(units).toHaveValue('1')
    const more = page.getByRole('button', {
      name: text.receive.moreOf.replace('{name}', scenario.productName)
    })
    await more.click()
    await more.click()
    await expect(units).toHaveValue('3')

    // More than what is pending is refused before any request
    await units.fill('5')
    await page.getByRole('button', { name: text.receive.submit, exact: true }).click()
    await expect(
      page.getByRole('alert').getByText(text.receive.wrongUnits.replace('{max}', '4'))
    ).toBeVisible()
    await units.fill('3')
    await page.getByRole('button', { name: text.receive.submit, exact: true }).click()
    await expect(page.getByText(text.receive.done).first()).toBeVisible()
    expect(await onHandOf(scenario.to.id, scenario.productName)).toBe(3)

    // The page fits the phone
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow).toBe(0)
  })

  test('the one unit that did not arrive is closed as a return to the origin', async ({ page }) => {
    await open(page, ownerEmail, firstTransferPath)
    await page.getByRole('button', { name: text.close.open }).click()
    const dialog = page.getByRole('dialog')
    // Nothing is closed until each short line has its answer
    await dialog.getByRole('button', { name: text.close.submit }).click()
    await expect(dialog.getByRole('alert').getByText(text.close.chooseAll)).toBeVisible()
    await dialog.getByLabel(text.close.actions.return_to_source.label).check()
    await dialog.getByRole('button', { name: text.close.submit }).click()
    await expect(dialog).toBeHidden()

    await expect(page.getByText(text.status.received, { exact: true })).toBeVisible()
    await expect(
      page.getByText(text.lines.progress.replace('{sent}', '4').replace('{received}', '3'))
    ).toBeVisible()
    await expect(page.getByText(/unit returned to the origin/)).toBeVisible()
    expect(await onHandOf(scenario.from.id, scenario.productName)).toBe(7)
    expect(await onHandOf(scenario.to.id, scenario.productName)).toBe(3)
  })

  test('a warehouse that holds stock is not switched off, and says so', async ({ page }) => {
    await open(page, ownerEmail, AppPaths.org.warehouses)
    const dialog = page.getByRole('dialog')
    await page.getByRole('button', { name: new RegExp(scenario.from.code) }).click()
    await dialog.getByRole('button', { name: warehouseText.state.switchOff }).click()
    await expect(
      dialog.getByRole('alert').getByText(warehouseText.stockBlock.deactivate)
    ).toBeVisible()
  })

  test('cancelling a transfer on its way returns the units to the origin', async ({ page }) => {
    await open(page, ownerEmail, AppPaths.org.transfers)
    const path = await sendTransfer(page, 2)
    expect(await onHandOf(scenario.from.id, scenario.productName)).toBe(5)

    await page.getByRole('button', { name: text.cancel.open }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog.getByText(/2 units that have not arrived go back to/)).toBeVisible()
    await dialog.getByRole('button', { name: text.cancel.confirm }).click()
    await expect(page.getByText(text.cancel.done).first()).toBeVisible()
    await expect(page.getByText(text.status.cancelled, { exact: true })).toBeVisible()
    expect(await onHandOf(scenario.from.id, scenario.productName)).toBe(7)

    // The list filters by status
    await page.goto(AppPaths.org.transfers)
    await page.getByLabel(text.filters.status).selectOption({ label: text.status.cancelled })
    await expect(page.locator(`a[href="${path}"]`)).toBeVisible()
    await expect(page.locator(`a[href="${firstTransferPath}"]`)).toHaveCount(0)
  })

  test('a product that is in a transfer cannot be deleted, and the refusal counts the transfer lines', async ({
    page
  }) => {
    await open(page, ownerEmail, AppPaths.store.products(storeId))
    await page.getByLabel(en.products.searchLabel).fill(scenario.productName)
    await page.getByRole('button', { name: scenario.productName, exact: true }).click()
    const sheet = page.getByRole('dialog', { name: en.products.sheet.editTitle })
    await sheet.getByRole('button', { name: en.products.form.delete }).click()
    await page.getByRole('button', { name: en.products.delete.confirm }).click()
    const refusal = page.getByRole('alertdialog', { name: en.products.delete.history.title })
    await expect(refusal).toContainText(/2 transfer lines/)
  })
})
