import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addGuidedOrdersTo, addOrdersTo, type SeededOrder, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds every permission of the orders and of shipping
const ADMIN = 'multi-store@test.com'
const ORDERS = en.orders.list
const BULK = en.orders.bulk

// The actions over the ticked rows of the orders page and the guide columns and filters (Step 4.14), against the rows a
// `local` courier holds
test.describe('the bulk actions of the orders page', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string
  const customerName = `Bulk customer ${randomUUID().slice(0, 8)}`
  const removals: (() => Promise<void>)[] = []
  let seeded: SeededOrder[] = []
  let guideNumber = ''
  let connectionName = ''

  const row = (order: SeededOrder) => page.getByRole('row').filter({ hasText: order.orderNumber })

  async function openOrders(): Promise<void> {
    await page.goto(`${AppPaths.store.orders(storeId)}?q=${encodeURIComponent(customerName)}`)
    await expect(page.getByRole('heading', { name: ORDERS.title })).toBeVisible()
    for (const order of seeded) await expect(row(order)).toBeVisible()
  }

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
    const made = await addOrdersTo(storeId, customerName, [
      { status: 'PENDING_CONFIRMATION' },
      { status: 'PENDING_CONFIRMATION' }
    ])
    const guided = await addGuidedOrdersTo(storeId, made.customerId, 1)
    const withGuide = guided.orders[0] as SeededOrder & { guideNumber: string }
    seeded = [...made.orders, withGuide]
    guideNumber = withGuide.guideNumber
    connectionName = guided.connectionName
    // The guided order goes first: a customer is removed after its orders
    removals.push(made.remove, guided.remove)
  })
  test.afterAll(async () => {
    for (const remove of removals.toReversed()) await remove()
    await context.close()
  })

  test('shows the carrier, the guide and the shipment of an order and filters by the guide', async () => {
    await openOrders()
    const withGuide = row(seeded[2] as SeededOrder)
    await expect(withGuide.getByText(connectionName)).toBeVisible()
    await expect(withGuide.getByText(guideNumber)).toBeVisible()
    await expect(withGuide.getByText(en.orders.bulk.shipmentStatus.label_created)).toBeVisible()
    await expect(row(seeded[0] as SeededOrder).getByText(ORDERS.noGuide)).toBeVisible()

    await page.getByLabel(ORDERS.filters.guide, { exact: true }).selectOption('with_guide')
    await expect(page).toHaveURL(/guide=with_guide/)
    await expect(row(seeded[2] as SeededOrder)).toBeVisible()
    await expect(row(seeded[0] as SeededOrder)).toBeHidden()

    await page.getByLabel(ORDERS.filters.guide, { exact: true }).selectOption('without_guide')
    await expect(row(seeded[0] as SeededOrder)).toBeVisible()
    await expect(row(seeded[2] as SeededOrder)).toBeHidden()
  })

  test('confirms the ticked orders, reports the one left out with its reason and shows every final state', async () => {
    await openOrders()
    await page.getByLabel(ORDERS.selectAll).check()
    const bar = page.getByRole('region', { name: BULK.label })
    await expect(bar).toBeVisible()
    // The actions of shipping show for who holds the permission; "print" waits for a guide with a stored label
    await expect(bar.getByRole('button', { name: BULK.labels })).toBeVisible()
    await expect(bar.getByRole('button', { name: BULK.print })).toHaveCount(0)

    await bar.getByRole('button', { name: BULK.confirm.button }).click()
    const dialog = page.getByRole('dialog', { name: BULK.confirm.title })
    await dialog.getByLabel(BULK.confirm.viaLabel).selectOption('call')
    await dialog.getByRole('button', { name: BULK.confirm.submit }).click()

    const report = page.getByRole('dialog', { name: BULK.report.title.confirm })
    await expect(report).toBeVisible()
    await expect(report.getByText(BULK.report.rules.not_pending_confirmation)).toBeVisible()
    const confirmed = report
      .getByRole('row')
      .filter({ hasText: (seeded[0] as SeededOrder).orderNumber })
    await expect(confirmed.getByText(BULK.report.outcome.done)).toBeVisible()
    await expect(confirmed.getByText(en.orders.status.CONFIRMED)).toBeVisible()
    const left = report.getByRole('row').filter({ hasText: (seeded[2] as SeededOrder).orderNumber })
    await expect(left.getByText(BULK.report.outcome.skipped)).toBeVisible()
    await expect(left.getByText(BULK.shipmentStatus.label_created)).toBeVisible()
  })
})
