import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { OrderReturnCondition, type OrderReturnReasonKey } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import detail from '../../web/messages/routes/order-detail.en.json' with { type: 'json' }
import returnsRoute from '../../web/messages/routes/returns.en.json' with { type: 'json' }
import {
  addComingBackPackage,
  addShippingScenario,
  clearOpenReceptionBatches,
  type ComingBackPackage,
  customerOfOrderIsCaution,
  overstateUnitsOfScannedPackage,
  returnsOfOrder,
  type ShippingScenario,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds `returns:manage` and `customers:flag_caution`
const ADMIN = 'multi-store@test.com'
const PHONE = { width: 390, height: 844 }
const REC = returnsRoute.returns.reception
const CONDITION = detail.orders.detail.returns.condition
const REASON = en.orders.return.reason
const DEFECTIVE: OrderReturnReasonKey = 'DEFECTIVE'

// The reception of returned packages by scanner (TDD_17 §4.16, Step 4.14 PR F7a-2b), on a phone: scan, edit the reason and the
// condition, an unknown code, a guide that says delivered, one package that fails at closing without undoing the others, and what
// the closing leaves behind (the returns, the stock, the flag).
test.describe('the reception of returned packages by scanner', () => {
  test.describe.configure({ mode: 'serial' })

  const run = randomUUID().slice(0, 6)
  let context: BrowserContext
  let page: Page
  let storeId: string
  let scenario: ShippingScenario
  let good: ComingBackPackage
  let bad: ComingBackPackage
  let delivered: ComingBackPackage
  let extra: ComingBackPackage

  const card = (pack: ComingBackPackage) =>
    page.getByRole('listitem', { name: REC.item.label.replace('{order}', pack.orderNumber) })
  const scanForm = () => page.getByRole('form', { name: REC.scan.formLabel })
  async function scan(code: string): Promise<void> {
    await scanForm().getByLabel(REC.scan.label).fill(code)
    await scanForm().getByRole('button', { name: REC.scan.button, exact: true }).click()
  }

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en', viewport: PHONE })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
    await clearOpenReceptionBatches(storeId)
    scenario = await addShippingScenario(storeId, run)
    good = await addComingBackPackage(storeId, scenario)
    bad = await addComingBackPackage(storeId, scenario)
    delivered = await addComingBackPackage(storeId, scenario, { delivered: true })
    extra = await addComingBackPackage(storeId, scenario)
  })
  test.afterAll(async () => {
    await scenario.remove()
    await context.close()
  })

  test('opens a batch, refuses an unknown code and adds a package by its guide number', async () => {
    await page.goto(AppPaths.store.returnsReception(storeId))
    await expect(page.getByRole('heading', { name: REC.pageTitle })).toBeVisible()
    const start = page.getByRole('button', { name: REC.start.button, exact: true })
    await start.click()
    await expect(scanForm()).toBeVisible()

    const unknown = `NOPE-${run}`
    await scan(unknown)
    await expect(scanForm().getByRole('alert')).toContainText(
      REC.scan.notFound.replace('{code}', unknown)
    )

    await scan(good.guideNumber)
    await expect(scanForm().getByRole('status')).toContainText(
      REC.scan.added.replace('{order}', good.orderNumber)
    )
    await expect(card(good)).toBeVisible()
    await expect(card(good)).toContainText(REC.item.guide.replace('{number}', good.guideNumber))
  })

  test('edits the reason and the condition of a package and plans to flag its customer', async () => {
    await card(good).getByRole('button', { name: REC.item.edit, exact: true }).click()
    const editor = page.getByRole('form', {
      name: REC.editor.formLabel.replace('{order}', good.orderNumber)
    })
    await editor
      .getByLabel(REC.editor.reason, { exact: true })
      .selectOption({ label: REASON[DEFECTIVE] })
    await editor
      .getByLabel(REC.editor.condition, { exact: true })
      .selectOption({ label: CONDITION.resellable })
    await editor.getByLabel(REC.editor.flag).check()
    await editor.getByLabel(REC.editor.flagReason).fill('Refused two packages in a row')
    await editor.getByRole('button', { name: REC.editor.save, exact: true }).click()

    await expect(card(good)).toContainText(`${REASON[DEFECTIVE]} · ${CONDITION.resellable}`)
    await expect(card(good)).toContainText(REC.item.flagPlanned)
  })

  test('asks before taking a package whose guide says delivered', async () => {
    await scan(delivered.guideNumber)
    const ask = page.getByRole('dialog', { name: REC.confirmDelivered.title })
    await expect(ask).toBeVisible()
    await ask.getByRole('button', { name: REC.confirmDelivered.confirm, exact: true }).click()
    await expect(card(delivered)).toContainText(REC.item.confirmedDelivered)
  })

  test('a package scanned twice is refused and a package can be removed from the batch', async () => {
    await scan(good.guideNumber)
    await expect(
      page.getByRole('alert').filter({ hasText: en.errors.RECEPTION_DUPLICATE_SCAN })
    ).toBeVisible()

    await scan(extra.guideNumber)
    await expect(card(extra)).toBeVisible()
    await card(extra)
      .getByRole('button', { name: REC.item.remove.replace('{order}', extra.orderNumber) })
      .click()
    await expect(card(extra)).toHaveCount(0)
  })

  test('closes the batch: one package fails and the others are received, with their returns, the stock and the flag', async () => {
    await scan(bad.guideNumber)
    await expect(card(bad)).toBeVisible()
    // The screen cannot ask for more units than were sent: the api refuses them at closing, which is what is shown
    await overstateUnitsOfScannedPackage(bad.guideNumber, bad.orderItemId)

    await page.getByRole('button', { name: REC.complete.button, exact: true }).click()
    await page
      .getByRole('dialog', { name: REC.complete.title })
      .getByRole('button', { name: REC.complete.confirm, exact: true })
      .click()

    await expect(page.getByText(/3 packages in the batch, 2 received, 1 failed\./)).toBeVisible()
    await expect(card(good)).toContainText(REC.item.state.received)
    await expect(card(delivered)).toContainText(REC.item.state.received)
    await expect(card(bad)).toContainText(REC.item.state.failed)
    await expect(card(bad).getByRole('alert')).toContainText(
      en.errors.RETURN_QUANTITY_EXCEEDS_DELIVERED
    )

    // The received ones made their returns; the failed one made none and can be closed again
    await expect
      .poll(async () => (await returnsOfOrder(good.orderId)).map(row => row.conditions))
      .toEqual([[OrderReturnCondition.RESELLABLE]])
    expect((await returnsOfOrder(good.orderId))[0]?.reason).toBe(DEFECTIVE)
    expect(await returnsOfOrder(delivered.orderId)).toHaveLength(1)
    expect(await returnsOfOrder(bad.orderId)).toHaveLength(0)
    await expect.poll(() => customerOfOrderIsCaution(good.orderId)).toBe(true)
    await expect.poll(() => customerOfOrderIsCaution(delivered.orderId)).toBe(false)
    await expect(page.getByRole('button', { name: REC.complete.retry, exact: true })).toBeVisible()
  })
})
