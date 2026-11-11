import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addOrdersTo,
  addUserWithoutOrders,
  type SeededOrder,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds every permission of the orders
const ADMIN = 'multi-store@test.com'
const DETAIL = en.orders.detail

const uniqueName = (label: string): string => `${label} ${randomUUID().slice(0, 8)}`

test.describe('the order detail page', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string
  const customerName = uniqueName('Detail customer')
  const packing = `Wrap the glass ${randomUUID().slice(0, 6)}`
  const customerNote = `Leave at the gate ${randomUUID().slice(0, 6)}`
  const internalNote = `Called twice ${randomUUID().slice(0, 6)}`
  const removals: (() => Promise<void>)[] = []
  let seeded: SeededOrder[] = []

  const heading = (order: SeededOrder) =>
    page.getByRole('heading', { name: DETAIL.heading.replace('{number}', order.orderNumber) })
  const status = (label: string) => page.getByText(label, { exact: true }).first()

  async function open(order: SeededOrder): Promise<void> {
    await page.goto(AppPaths.store.order(storeId, order.id))
    await expect(heading(order)).toBeVisible()
  }

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
    const made = await addOrdersTo(storeId, customerName, [
      {
        status: 'PENDING_CONFIRMATION',
        packingNotes: packing,
        customerNotes: customerNote,
        internalNotes: internalNote
      },
      { status: 'PENDING_CONFIRMATION' },
      { status: 'SHIPPED' }
    ])
    seeded = made.orders
    removals.push(made.remove)
  })
  test.afterAll(async () => {
    for (const remove of removals) await remove()
    await context.close()
  })

  test('opens from the list and shows the order with its three notes, the packing note in its own band', async () => {
    const order = seeded[0] as SeededOrder
    await page.goto(`${AppPaths.store.orders(storeId)}?q=${encodeURIComponent(order.orderNumber)}`)
    await page.getByRole('link', { name: `#${order.orderNumber}` }).click()

    await expect(heading(order)).toBeVisible()
    await expect(status(en.orders.status.PENDING_CONFIRMATION)).toBeVisible()
    const band = page.getByRole('region', { name: DETAIL.notes.packingNotes.label })
    await expect(band).toContainText(packing)
    await expect(page.getByText(customerNote)).toBeVisible()
    await expect(page.getByText(internalNote)).toBeVisible()
    // A pending order offers to confirm and to cancel, and nothing that skips a step
    const flows = page.getByRole('group', { name: DETAIL.flows.groupLabel })
    await expect(flows.getByRole('button', { name: DETAIL.flows.confirm.button })).toBeVisible()
    await expect(flows.getByRole('button', { name: DETAIL.flows.cancel.button })).toBeVisible()
    await expect(flows.getByRole('button', { name: DETAIL.flows.ship.button })).toBeHidden()
  })

  test('edits the packing note and keeps it after a reload', async () => {
    const order = seeded[0] as SeededOrder
    await open(order)
    const band = page.getByRole('region', { name: DETAIL.notes.packingNotes.label })
    await band.getByRole('button', { name: DETAIL.edit }).click()
    const next = `${packing} twice`
    await band.getByRole('textbox').fill(next)
    await band.getByRole('button', { name: en.common.save }).click()
    await expect(page.getByText(DETAIL.saved)).toBeVisible()
    await expect(band).toContainText(next)

    await page.reload()
    await expect(page.getByRole('region', { name: DETAIL.notes.packingNotes.label })).toContainText(
      next
    )
  })

  test('prints the packing list with the packing note and without the customer care note', async () => {
    const order = seeded[0] as SeededOrder
    await open(order)
    // The dialog of the browser cannot be driven: print() is replaced by a function that reads the sheet the page drew
    await page.evaluate(() => {
      const target = window as unknown as { __sheet: string | null }
      target.__sheet = null
      window.print = () => {
        target.__sheet = document.querySelector('[data-print-sheet]')?.textContent ?? ''
        window.dispatchEvent(new Event('afterprint'))
      }
    })
    await page.getByRole('button', { name: DETAIL.print.packing_slip.button }).click()
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __sheet: string | null }).__sheet))
      .toContain(packing)
    const sheet = await page.evaluate(() => (window as unknown as { __sheet: string }).__sheet)
    expect(sheet).toContain(customerNote)
    expect(sheet).not.toContain(internalNote)
    // The sheet is only in the page while it prints
    await expect(page.locator('[data-print-sheet]')).toHaveCount(0)
  })

  test('records a payment by hand and the order shows it paid', async () => {
    const order = seeded[1] as SeededOrder
    await open(order)
    await page.getByRole('button', { name: DETAIL.payment.record }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(DETAIL.payment.recordStatus).selectOption('COMPLETED')
    await dialog.getByLabel(DETAIL.payment.recordReference).fill('REF-123')
    await dialog.getByRole('button', { name: DETAIL.payment.recordConfirm }).click()

    await expect(page.getByText(DETAIL.payment.done)).toBeVisible()
    await expect(page.getByText('REF-123')).toBeVisible()
    await expect(page.getByText(en.orders.paymentStatus.COMPLETED, { exact: true })).toBeVisible()
  })

  test('confirms an order and then offers the next steps', async () => {
    const order = seeded[1] as SeededOrder
    await open(order)
    await page.getByRole('button', { name: DETAIL.flows.confirm.button }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(DETAIL.flows.confirm.viaLabel).selectOption('call')
    await dialog.getByRole('button', { name: DETAIL.flows.confirm.confirm }).click()

    await expect(status(en.orders.status.CONFIRMED)).toBeVisible()
    const flows = page.getByRole('group', { name: DETAIL.flows.groupLabel })
    await expect(flows.getByRole('button', { name: DETAIL.flows.prepare.button })).toBeVisible()
    await expect(flows.getByRole('button', { name: DETAIL.flows.confirm.button })).toBeHidden()
  })

  test('cancels an order with a reason and leaves nothing to edit or to move', async () => {
    const order = seeded[1] as SeededOrder
    await open(order)
    await page.getByRole('button', { name: DETAIL.flows.cancel.button }).click()
    const dialog = page.getByRole('dialog')
    await dialog
      .getByLabel(DETAIL.flows.cancel.reasonLabel)
      .selectOption({ label: en.orders.cancellationReason.outOfStock })
    await dialog.getByRole('button', { name: DETAIL.flows.cancel.confirm }).click()

    await expect(status(en.orders.status.CANCELLED)).toBeVisible()
    await expect(page.getByText(en.orders.cancellationReason.outOfStock)).toBeVisible()
    await expect(page.getByRole('group', { name: DETAIL.flows.groupLabel })).toBeHidden()
    await expect(page.getByRole('button', { name: DETAIL.edit })).toHaveCount(0)
  })

  test('a shipped order offers delivery and return, never the notes of the warehouse', async () => {
    const order = seeded[2] as SeededOrder
    await open(order)
    const flows = page.getByRole('group', { name: DETAIL.flows.groupLabel })
    await expect(flows.getByRole('button', { name: DETAIL.flows.deliver.button })).toBeVisible()
    await expect(flows.getByRole('button', { name: DETAIL.flows.return.button })).toBeVisible()
    await expect(flows.getByRole('button', { name: DETAIL.flows.cancel.button })).toBeHidden()
    // The warehouse is done with a shipped order: its packing note is not editable
    await expect(
      page
        .getByRole('region', { name: DETAIL.notes.packingNotes.label })
        .getByRole('button', { name: DETAIL.edit })
    ).toBeHidden()
  })

  test('an order that does not exist in the store says so', async () => {
    await page.goto(AppPaths.store.order(storeId, randomUUID()))
    await expect(page.getByText(DETAIL.notFound)).toBeVisible()
  })

  test('a person without orders:view gets a refusal and no data', async ({ browser }) => {
    const email = `no-orders-${randomUUID().slice(0, 8)}@test.com`
    const remove = await addUserWithoutOrders(storeId, email)
    const other = await browser.newContext({ locale: 'en' })
    try {
      await reachServicesFromOwnAddress(other)
      const otherPage = await other.newPage()
      await signIn(otherPage, email)
      await otherPage.goto(AppPaths.store.order(storeId, (seeded[0] as SeededOrder).id))
      await expect(otherPage.getByText(DETAIL.noAccess)).toBeVisible()
      await expect(otherPage.getByText(packing)).toBeHidden()
    } finally {
      await other.close()
      await remove()
    }
  })
})
