import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addOwnerOfNewStore,
  addTransferScenario,
  onHandOf,
  type TransferScenario
} from '../support/database'
import { expectDialogFitsThePhoneWidth } from '../support/dialog-fit'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const PRODUCTS = en.products
const STOCK = PRODUCTS.stock
const TRANSFERS = en.transfers
const COUNTS = en.counts
const PHONE = { width: 390, height: 844 }
const MIN_TOUCH = 40
const TRANSFER_URL = /\/org\/transfers\/[0-9a-f-]{36}$/
const COUNT_URL = /\/org\/counts\/[0-9a-f-]{36}$/

// Step 4.7 "Done when": the owner runs a whole cycle from a phone. One organization of its own (the units the cases
// move belong to nobody else), one product with 10 units in the origin warehouse, and the cycle:
//   adjust (+5 at the origin: 15) -> send 6 to the destination (origin 9) -> receive 4 (destination 4)
//   -> close the shortage of 2 back to the origin (origin 11) -> count the destination (5 on the shelf: +1)
//   -> apply the count (destination 5) -> the stock tab and its kardex tell the whole story.
// Every wait is for the answer of the api or for what the screen shows once it has it, never for a pause.
test.describe('the inventory cycle on a phone', () => {
  test.describe.configure({ mode: 'serial' })

  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-cycle-owner-${run}@example.com`
  const storeName = `E2E Cycle Shop ${run}`
  let context: BrowserContext
  let page: Page
  let storeId = ''
  let scenario: TransferScenario
  let transferPath = ''

  const warehouseLabel = (warehouse: { code: string; name: string }): string =>
    `${warehouse.code} · ${warehouse.name}`

  // Nothing of the page is wider than the screen: a person on a phone never has to scroll sideways the page itself
  async function expectNoSideScroll(): Promise<void> {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow, 'the page does not scroll sideways').toBe(0)
  }

  // A control a finger has to hit is at least 40 px on each side
  async function expectTouchable(control: ReturnType<Page['getByRole']>): Promise<void> {
    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(MIN_TOUCH)
  }

  // A control is fully inside the screen where it is, not clipped by a table that scrolls sideways
  async function expectInView(control: ReturnType<Page['getByRole']>): Promise<void> {
    await expect(control).toBeInViewport({ ratio: 1 })
  }

  const sheet = () => page.getByRole('dialog', { name: PRODUCTS.sheet.editTitle, exact: true })
  const adjustDialog = () => page.getByRole('dialog', { name: STOCK.dialog.title })
  const levelRow = (warehouse: { code: string }) =>
    sheet().getByRole('row').filter({ hasText: warehouse.code })

  async function openStock(): Promise<void> {
    await page.goto(AppPaths.store.products(storeId))
    await page.getByLabel(PRODUCTS.searchLabel).fill(scenario.productName)
    await page.getByRole('button', { name: scenario.productName, exact: true }).click()
    await expect(sheet()).toBeVisible()
    await sheet().getByRole('tab', { name: PRODUCTS.sheet.tabs.stock }).click()
    await expect(page.getByRole('heading', { name: STOCK.heading })).toBeVisible()
  }

  const status = (text: string) => page.getByText(text, { exact: true }).first()
  const quantityOf = (name: string) =>
    page.getByLabel(COUNTS.sheet.quantityOf.replace('{name}', name), { exact: true })
  const patchOfLines = () =>
    page.waitForResponse(
      response =>
        /\/counts\/[0-9a-f-]{36}\/lines$/.test(response.url()) &&
        response.request().method() === 'PATCH' &&
        response.ok(),
      { timeout: 45_000 }
    )

  test.beforeAll(async ({ browser }) => {
    storeId = await addOwnerOfNewStore(ownerEmail, storeName)
    scenario = await addTransferScenario(storeId, run, 10)
    context = await browser.newContext({
      locale: 'en',
      viewport: PHONE,
      hasTouch: true,
      isMobile: true
    })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('adjusts the stock from the product: the actions are in view, the dialog fits, the units are added', async () => {
    await openStock()
    await expect(levelRow(scenario.from)).toContainText('10')

    // The buttons of a level are not at the end of a table that scrolls sideways
    await expectInView(
      levelRow(scenario.from).getByRole('button', {
        name: STOCK.adjustFor
          .replace('{item}', STOCK.productRow)
          .replace('{warehouse}', scenario.from.code)
      })
    )
    await expectInView(
      levelRow(scenario.from).getByRole('button', {
        name: STOCK.movementsOf
          .replace('{item}', STOCK.productRow)
          .replace('{warehouse}', scenario.from.code)
      })
    )

    await expectTouchable(
      levelRow(scenario.from).getByRole('button', {
        name: STOCK.adjustFor
          .replace('{item}', STOCK.productRow)
          .replace('{warehouse}', scenario.from.code)
      })
    )
    await sheet().getByRole('button', { name: STOCK.adjust, exact: true }).click()
    const dialog = adjustDialog()
    await expect(dialog).toBeVisible()
    await expectDialogFitsThePhoneWidth(page, dialog)
    await dialog.getByLabel(STOCK.dialog.warehouse).selectOption({
      label: warehouseLabel(scenario.from)
    })
    await dialog
      .getByLabel(STOCK.dialog.action)
      .selectOption({ label: STOCK.dialog.actions.receive })
    await dialog.getByLabel(STOCK.dialog.reason).selectOption({ label: STOCK.reasons.other })
    await dialog.getByLabel(STOCK.dialog.quantity).fill('5')
    await expectTouchable(dialog.getByRole('button', { name: STOCK.dialog.submit }))
    await dialog.getByRole('button', { name: STOCK.dialog.submit }).click()
    await expect(page.getByText(STOCK.dialog.saved)).toBeVisible()

    await expect(levelRow(scenario.from)).toContainText('15')
    expect(await onHandOf(scenario.from.id, scenario.productName)).toBe(15)
  })

  test('drafts a transfer, adds the item by its SKU and sends it: six units leave the origin', async () => {
    await page.goto(AppPaths.org.transfers)
    await page.getByRole('button', { name: TRANSFERS.new.open }).click()
    const dialog = page.getByRole('dialog')
    await dialog
      .getByLabel(TRANSFERS.new.from)
      .selectOption({ label: warehouseLabel(scenario.from) })
    await dialog.getByLabel(TRANSFERS.new.to).selectOption({ label: warehouseLabel(scenario.to) })
    await dialog.getByRole('button', { name: TRANSFERS.new.submit }).click()
    await page.waitForURL(TRANSFER_URL)
    transferPath = new URL(page.url()).pathname

    await page.getByLabel(TRANSFERS.picker.search).fill(scenario.sku)
    await page.getByLabel(TRANSFERS.picker.units, { exact: true }).fill('6')
    await page.getByRole('button', { name: new RegExp(scenario.productName) }).click()
    await expect(
      page.getByLabel(TRANSFERS.draft.unitsOf.replace('{name}', scenario.productName))
    ).toHaveValue('6')
    await expectNoSideScroll()

    const save = page.getByRole('button', { name: TRANSFERS.draft.save })
    const send = page.getByRole('button', { name: TRANSFERS.draft.dispatch })
    await expectTouchable(save)
    await expectTouchable(send)
    await save.click()
    await expect(page.getByText(TRANSFERS.draft.saved).first()).toBeVisible()
    await send.click()
    await expect(page.getByText(TRANSFERS.dispatched).first()).toBeVisible()
    await expect(page.getByText(TRANSFERS.status.in_transit, { exact: true })).toBeVisible()

    expect(await onHandOf(scenario.from.id, scenario.productName)).toBe(9)
    expect(await onHandOf(scenario.to.id, scenario.productName)).toBe(0)
  })

  test('receives four of the six with taps on a phone', async () => {
    await page.goto(transferPath)
    await expect(page.getByRole('form', { name: TRANSFERS.receive.formLabel })).toBeVisible()
    const units = page.getByLabel(TRANSFERS.receive.unitsOf.replace('{name}', scenario.productName))
    const more = page.getByRole('button', {
      name: TRANSFERS.receive.moreOf.replace('{name}', scenario.productName)
    })
    await expectTouchable(more)
    // The SKU adds one unit (what a scanner that types does), three taps add the others
    const code = page.getByLabel(TRANSFERS.receive.code)
    await code.fill(scenario.sku)
    await code.press('Enter')
    await expect(units).toHaveValue('1')
    for (const total of ['2', '3', '4']) {
      await more.click()
      await expect(units).toHaveValue(total)
    }
    const receive = page.getByRole('button', { name: TRANSFERS.receive.submit, exact: true })
    await expectTouchable(receive)
    await expectInView(receive)
    await receive.click()
    await expect(page.getByText(TRANSFERS.receive.done).first()).toBeVisible()
    await expectNoSideScroll()

    expect(await onHandOf(scenario.to.id, scenario.productName)).toBe(4)
    expect(await onHandOf(scenario.from.id, scenario.productName)).toBe(9)
  })

  test('closes the two units that did not arrive as a return: the origin holds eleven', async () => {
    await page.goto(transferPath)
    await page.getByRole('button', { name: TRANSFERS.close.open }).click()
    const dialog = page.getByRole('dialog')
    await expectDialogFitsThePhoneWidth(page, dialog)
    await dialog.getByLabel(TRANSFERS.close.actions.return_to_source.label).check()
    await dialog.getByRole('button', { name: TRANSFERS.close.submit }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByText(TRANSFERS.status.received, { exact: true })).toBeVisible()
    await expect(
      page.getByText(TRANSFERS.lines.progress.replace('{sent}', '6').replace('{received}', '4'))
    ).toBeVisible()

    expect(await onHandOf(scenario.from.id, scenario.productName)).toBe(11)
    expect(await onHandOf(scenario.to.id, scenario.productName)).toBe(4)
  })

  test('counts the destination: five on the shelf against four held, sent for review', async () => {
    await page.goto(AppPaths.org.counts)
    await page.getByRole('button', { name: COUNTS.new }).click()
    const dialog = page.getByRole('dialog', { name: COUNTS.create.title })
    await expectDialogFitsThePhoneWidth(page, dialog)
    await dialog.getByLabel(COUNTS.create.warehouse).selectOption({
      label: warehouseLabel(scenario.to)
    })
    await dialog.getByLabel(COUNTS.create.scope).selectOption({ label: storeName })
    await dialog.getByRole('button', { name: COUNTS.create.submit }).click()
    await page.waitForURL(COUNT_URL)

    await page.getByRole('button', { name: COUNTS.actions.start }).click()
    await expect(status(COUNTS.status.counting)).toBeVisible()
    const saved = patchOfLines()
    await quantityOf(scenario.productName).fill('5')
    await saved
    await expect(
      page.getByRole('status').filter({
        hasText: new RegExp(
          `^${COUNTS.sheet.progress.replace('{counted}', '1').replace('{total}', '1')}$`
        )
      })
    ).toBeVisible()
    await expectNoSideScroll()

    const submit = page.getByRole('button', { name: COUNTS.actions.submit })
    await expectTouchable(submit)
    await submit.click()
    await expect(status(COUNTS.status.review)).toBeVisible()
    await expect(
      page.getByRole('listitem').filter({ hasText: scenario.productName })
    ).toContainText('+1')
  })

  test('applies the count after asking: the destination holds five', async () => {
    await page.getByRole('button', { name: COUNTS.actions.apply }).click()
    const dialog = page.getByRole('alertdialog')
    await expectDialogFitsThePhoneWidth(page, dialog)
    await dialog.getByRole('button', { name: COUNTS.apply.confirm }).click()
    await expect(status(COUNTS.status.applied)).toBeVisible()
    await expect(page.getByRole('button', { name: COUNTS.actions.apply })).toHaveCount(0)

    expect(await onHandOf(scenario.to.id, scenario.productName)).toBe(5)
    expect(await onHandOf(scenario.from.id, scenario.productName)).toBe(11)
  })

  test('the stock tab shows the final levels and the kardex tells the whole story of the destination', async () => {
    await openStock()
    await expect(levelRow(scenario.from)).toContainText('11')
    await expect(levelRow(scenario.to)).toContainText('5')

    const movements = levelRow(scenario.to).getByRole('button', {
      name: STOCK.movementsOf
        .replace('{item}', STOCK.productRow)
        .replace('{warehouse}', scenario.to.code)
    })
    await expectInView(movements)
    await movements.click()
    const kardex = sheet().getByRole('region', {
      name: STOCK.movementsOf
        .replace('{item}', STOCK.productRow)
        .replace('{warehouse}', scenario.to.code)
    })
    // Newest first: the count's surplus (on hand 5), then the units that came in with the transfer (4)
    const surplus = kardex.getByRole('row').filter({ hasText: STOCK.types.count_in })
    const arrival = kardex.getByRole('row').filter({ hasText: STOCK.types.transfer_in })
    await expect(surplus).toContainText('+1')
    await expect(arrival).toContainText('+4')
    // The surplus is the newer one: the table is newest first
    const surplusAt = await surplus.evaluate(row => (row as HTMLTableRowElement).rowIndex)
    const arrivalAt = await arrival.evaluate(row => (row as HTMLTableRowElement).rowIndex)
    expect(surplusAt).toBeLessThan(arrivalAt)
  })
})
