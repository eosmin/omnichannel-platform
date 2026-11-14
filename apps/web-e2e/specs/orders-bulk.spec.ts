import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page, type Route } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addGuidedOrdersTo,
  addOrdersTo,
  addPlacesCarrier,
  type AskingCarrier,
  type SeededOrder,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds every permission of the orders and of shipping
const ADMIN = 'multi-store@test.com'
const ORDERS = en.orders.list
const BULK = en.orders.bulk
const PLACES = BULK.places

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

  // A carrier that declares that it needs the places (the official one the registry holds with that capability; the case never
  // reaches it: the browser answers its lists and the run request is read and refused, so no guide is made)
  test('asks the places once for the batch when the carrier needs them, and sends them in the one request', async () => {
    const run = randomUUID().slice(0, 6)
    const places: AskingCarrier = await addPlacesCarrier(storeId, run)
    const made = await addOrdersTo(storeId, `${customerName} places`, [
      { status: 'CONFIRMED' },
      { status: 'CONFIRMED' }
    ])
    const lists = (route: Route): Promise<void> => {
      const parent = new URL(route.request().url()).searchParams.get('parentId')
      return route.fulfill({
        json:
          parent === null
            ? [
                { id: '5', name: 'Alta', parentId: null },
                { id: '7', name: 'Baja', parentId: null }
              ]
            : [{ id: `${parent}2`, name: `Baja Dos ${parent}`, parentId: parent }]
      })
    }
    let sent: unknown = null
    const started = (route: Route): Promise<void> => {
      if (route.request().method() !== 'POST') return route.fallback()
      sent = route.request().postDataJSON()
      return route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR' } })
    }
    await page.route('**/carriers/*/locations*', lists)
    await page.route('**/shipments/bulk', started)
    try {
      await page.goto(
        `${AppPaths.store.orders(storeId)}?q=${encodeURIComponent(`${customerName} places`)}`
      )
      for (const order of made.orders) await expect(row(order)).toBeVisible()
      await page.getByLabel(ORDERS.selectAll).check()
      const bar = page.getByRole('region', { name: BULK.label })
      const labels = bar.getByRole('button', { name: BULK.labels })

      // Each order follows its planned carrier: no places can be right for all of them
      await expect(bar.getByText(PLACES.legend, { exact: true })).toHaveCount(0)
      await bar.getByLabel(BULK.carrierLabel).selectOption({ label: places.connection.name })
      await expect(bar.getByText(PLACES.legend, { exact: true })).toBeVisible()
      await expect(labels).toBeDisabled()

      await bar.getByLabel(PLACES.department).selectOption({ label: 'Baja' })
      await expect(labels).toBeDisabled()
      await bar.getByLabel(PLACES.municipality).selectOption({ label: 'Baja Dos 7' })
      await expect(labels).toBeEnabled()
      await labels.click()

      await expect.poll(() => sent).not.toBeNull()
      expect(sent).toMatchObject({
        orderIds: expect.arrayContaining(made.orders.map(order => order.id)),
        connectionId: places.connection.id,
        locationIds: { departmentId: '7', municipalityId: '72' }
      })

      // The refused request opens the report of an action that could not run, which holds the page until it is closed
      const failed = page.getByRole('dialog', { name: BULK.report.failedTitle })
      await expect(failed).toBeVisible()
      await failed.getByRole('button', { name: BULK.report.close, exact: true }).click()
      await expect(failed).toBeHidden()

      // Going back to the planned carriers takes the selectors away
      await bar.getByLabel(BULK.carrierLabel).selectOption({ label: BULK.plannedCarrier })
      await expect(bar.getByText(PLACES.legend, { exact: true })).toHaveCount(0)
    } finally {
      await page.unroute('**/carriers/*/locations*', lists)
      await page.unroute('**/shipments/bulk', started)
      await made.remove()
      await places.remove()
    }
  })

  // The default of the panel is each order's planned carrier, and the only real carrier asks for places: the selectors must be there
  // without choosing it (QA FUNC-H8). The case never reaches the carrier, as the one above.
  test('asks the places of the planned carrier in the default mode, and nothing for a batch that needs none', async () => {
    const run = randomUUID().slice(0, 6)
    const places: AskingCarrier = await addPlacesCarrier(storeId, run)
    const name = `${customerName} planned`
    const made = await addOrdersTo(storeId, name, [
      { status: 'CONFIRMED', carrierConnectionId: places.connection.id },
      { status: 'CONFIRMED', carrierConnectionId: places.connection.id }
    ])
    const plain = await addOrdersTo(storeId, `${name} plain`, [{ status: 'CONFIRMED' }])
    const lists = (route: Route): Promise<void> => {
      const parent = new URL(route.request().url()).searchParams.get('parentId')
      return route.fulfill({
        json:
          parent === null
            ? [{ id: '7', name: 'Baja', parentId: null }]
            : [{ id: `${parent}2`, name: `Baja Dos ${parent}`, parentId: parent }]
      })
    }
    let sent: unknown = null
    const started = (route: Route): Promise<void> => {
      if (route.request().method() !== 'POST') return route.fallback()
      sent = route.request().postDataJSON()
      return route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR' } })
    }
    await page.route('**/carriers/*/locations*', lists)
    await page.route('**/shipments/bulk', started)
    try {
      // A batch whose orders are planned for no carrier that asks for places shows no selectors and no wait
      await page.goto(`${AppPaths.store.orders(storeId)}?q=${encodeURIComponent(`${name} plain`)}`)
      for (const order of plain.orders) await expect(row(order)).toBeVisible()
      await page.getByLabel(ORDERS.selectAll).check()
      const bar = page.getByRole('region', { name: BULK.label })
      await expect(bar.getByRole('button', { name: BULK.labels })).toBeEnabled()
      await expect(bar.getByText(PLACES.legend, { exact: true })).toHaveCount(0)

      await page.goto(`${AppPaths.store.orders(storeId)}?q=${encodeURIComponent(name)}`)
      for (const order of made.orders) await expect(row(order)).toBeVisible()
      await page.getByLabel(ORDERS.selectAll).check()
      const labels = page.getByRole('region', { name: BULK.label }).getByRole('button', {
        name: BULK.labels
      })
      const barOf = page.getByRole('region', { name: BULK.label })
      // Nothing was chosen: the default is the planned carrier, and it asks for the places
      await expect(barOf.getByLabel(BULK.carrierLabel)).toHaveValue('')
      await expect(barOf.getByText(PLACES.legend, { exact: true })).toBeVisible()
      await expect(labels).toBeDisabled()
      await barOf.getByLabel(PLACES.department).selectOption({ label: 'Baja' })
      await expect(labels).toBeDisabled()
      await barOf.getByLabel(PLACES.municipality).selectOption({ label: 'Baja Dos 7' })
      await expect(labels).toBeEnabled()
      await labels.click()

      await expect.poll(() => sent).not.toBeNull()
      expect(sent).toMatchObject({
        orderIds: expect.arrayContaining(made.orders.map(order => order.id)),
        locationsByConnection: {
          [places.connection.id]: { departmentId: '7', municipalityId: '72' }
        }
      })
      expect(sent).not.toHaveProperty('connectionId')
      const failed = page.getByRole('dialog', { name: BULK.report.failedTitle })
      await expect(failed).toBeVisible()
      await failed.getByRole('button', { name: BULK.report.close, exact: true }).click()
      await expect(failed).toBeHidden()
    } finally {
      await page.unroute('**/carriers/*/locations*', lists)
      await page.unroute('**/shipments/bulk', started)
      await plain.remove()
      await made.remove()
      await places.remove()
    }
  })
})
