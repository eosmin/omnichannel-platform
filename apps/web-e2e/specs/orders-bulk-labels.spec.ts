import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { ShipmentStatus } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addShippableOrdersOfOneCustomer,
  addShippingScenario,
  type ShippableOrder,
  type ShippingScenario,
  shipmentStatusesOfOrders,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds `orders:confirm` and `shipping:manage`
const ADMIN = 'multi-store@test.com'
const ORDERS = en.orders.list
const BULK = en.orders.bulk

// The case of `TDD_17 §9`: tick several confirmed orders, make their labels in one run against the store's courier, read the
// report of each order, and print the labels of them all in one file
test.describe('the labels of many orders at once', () => {
  test.describe.configure({ mode: 'serial' })

  const run = randomUUID().slice(0, 6)
  const customerName = `Labels customer ${run}`
  let context: BrowserContext
  let page: Page
  let storeId: string
  let scenario: ShippingScenario
  let orders: ShippableOrder[] = []

  const row = (order: ShippableOrder) =>
    page.getByRole('row').filter({ hasText: order.orderNumber })
  const bar = () => page.getByRole('region', { name: BULK.label })

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
    scenario = await addShippingScenario(storeId, run)
    orders = await addShippableOrdersOfOneCustomer(storeId, scenario, 2, customerName)
  })
  test.afterAll(async () => {
    await scenario.remove()
    await context.close()
  })

  test('makes the labels of the ticked orders in one run and shows the guide of each', async () => {
    await page.goto(`${AppPaths.store.orders(storeId)}?q=${encodeURIComponent(customerName)}`)
    for (const order of orders) await expect(row(order)).toBeVisible()
    await page.getByLabel(ORDERS.selectAll).check()
    // The bar is up before its absence is read: no order has a label yet, so there is nothing to print
    await expect(bar().getByRole('button', { name: BULK.labels, exact: true })).toBeVisible()
    await expect(bar().getByRole('button', { name: BULK.print })).toHaveCount(0)

    await bar().getByRole('button', { name: BULK.labels, exact: true }).click()
    const report = page.getByRole('dialog', { name: BULK.report.title.labels })
    await expect(report).toBeVisible({ timeout: 60_000 })
    for (const order of orders) {
      const line = report.getByRole('row').filter({ hasText: order.orderNumber })
      await expect(line.getByText(BULK.report.outcome.done)).toBeVisible()
    }
    await expect(report.getByText(BULK.report.nothingLeftOut)).toBeVisible()
    await report.getByRole('button', { name: BULK.report.close, exact: true }).click()

    expect(await shipmentStatusesOfOrders(orders.map(order => order.id))).toEqual([
      [ShipmentStatus.LABEL_CREATED],
      [ShipmentStatus.LABEL_CREATED]
    ])
  })

  test('prints the labels of the orders that have one in a single file', async () => {
    await page.goto(`${AppPaths.store.orders(storeId)}?q=${encodeURIComponent(customerName)}`)
    for (const order of orders) await expect(row(order)).toBeVisible()
    await page.getByLabel(ORDERS.selectAll).check()
    await bar().getByRole('button', { name: BULK.print, exact: true }).click()

    const report = page.getByRole('dialog', { name: BULK.report.title.print })
    await expect(report).toBeVisible({ timeout: 60_000 })
    const file = report.getByRole('link', { name: /^Open / })
    await expect(file).toBeVisible()
    const href = (await file.getAttribute('href')) ?? ''
    const response = await page.request.get(href)
    expect(response.ok()).toBe(true)
    expect(response.headers()['content-type']).toContain('pdf')
  })
})
