import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page, type Route } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { ShipmentStatus } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import routes from '../../web/messages/routes/order-detail.en.json' with { type: 'json' }
import {
  addPlacesCarrier,
  addShippableOrder,
  addShippingScenario,
  type AskingCarrier,
  type ShippableOrder,
  type ShippingScenario,
  shipmentStatusesOf,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds every permission of the orders and of shipping
const ADMIN = 'multi-store@test.com'
const DETAIL = routes.orders.detail
const SHIPPING = DETAIL.shipping
const GUIDE = DETAIL.guide
const PLACES = GUIDE.locations

// What the carrier lists: two departments, and the municipalities under each. The real carrier is never called: the browser is
// answered here, so the case proves what the dialog draws and what it sends, not a carrier.
const DEPARTMENTS = [
  { id: '5', name: 'Alta', parentId: null },
  { id: '7', name: 'Baja', parentId: null }
]
const MUNICIPALITIES: Record<string, { id: string; name: string; parentId: string }[]> = {
  '5': [{ id: '51', name: 'Alta Uno', parentId: '5' }],
  '7': [
    { id: '71', name: 'Baja Uno', parentId: '7' },
    { id: '72', name: 'Baja Dos', parentId: '7' }
  ]
}

// A carrier that asks for the ids of the places and cannot be asked to cancel: the dialog draws its selectors, and the panel offers
// what the api accepts for its guides (the cancel that parks the guide, then the manual void of a cancel that failed).
test.describe('a carrier that asks for the places and cannot cancel', () => {
  test.describe.configure({ mode: 'serial' })

  const run = randomUUID().slice(0, 6)
  let context: BrowserContext
  let page: Page
  let storeId: string
  let scenario: ShippingScenario
  let order: ShippableOrder
  let carrier: AskingCarrier

  const shipping = () => page.getByRole('region', { name: SHIPPING.heading, exact: true })
  const dialog = (name: string) => page.getByRole('dialog', { name })

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
    scenario = await addShippingScenario(storeId, run)
    order = await addShippableOrder(storeId, scenario, 'CONFIRMED')
    carrier = await addPlacesCarrier(storeId, run)
  })
  test.afterAll(async () => {
    await carrier.remove()
    await scenario.remove()
    await context.close()
  })

  async function open(target: { id: string; orderNumber: string }): Promise<void> {
    await page.goto(AppPaths.store.order(storeId, target.id))
    await expect(
      page.getByRole('heading', {
        name: en.orders.detail.heading.replace('{number}', target.orderNumber)
      })
    ).toBeVisible()
  }

  test('draws department and municipality, waits for both and sends their ids', async () => {
    const places = (route: Route): Promise<void> => {
      const parent = new URL(route.request().url()).searchParams.get('parentId')
      return route.fulfill({
        json: parent === null ? DEPARTMENTS : (MUNICIPALITIES[parent] ?? [])
      })
    }
    await page.route('**/carriers/*/locations*', places)
    // The guide is not made at a carrier: the request is read and refused, so nothing is created
    let sent: unknown = null
    const made = (route: Route): Promise<void> => {
      if (route.request().method() !== 'POST') return route.fallback()
      sent = route.request().postDataJSON()
      return route.fulfill({ status: 500, json: { code: 'INTERNAL_ERROR' } })
    }
    await page.route('**/orders/*/shipments', made)

    await open(order)
    await shipping().getByRole('button', { name: SHIPPING.makeGuide }).click()
    const make = dialog(GUIDE.title.replace('{number}', order.orderNumber))
    const confirm = make.getByRole('button', { name: GUIDE.confirm, exact: true })

    // The courier of the store asks for no places
    await expect(make.getByText(PLACES.legend, { exact: true })).toHaveCount(0)
    await make.getByLabel(GUIDE.connectionLabel).selectOption({ label: carrier.connection.name })
    await expect(make.getByText(PLACES.legend, { exact: true })).toBeVisible()
    await expect(confirm).toBeDisabled()

    const department = make.getByLabel(PLACES.department)
    const municipality = make.getByLabel(PLACES.municipality)
    await expect(municipality).toBeDisabled()
    await department.selectOption({ label: 'Baja' })
    await expect(municipality.getByRole('option', { name: 'Baja Dos' })).toBeAttached()
    await expect(confirm).toBeDisabled()

    // Changing the department drops a municipality that belonged to the other one
    await municipality.selectOption({ label: 'Baja Dos' })
    await expect(confirm).toBeEnabled()
    await department.selectOption({ label: 'Alta' })
    await expect(municipality).toHaveValue('')
    await expect(confirm).toBeDisabled()
    await department.selectOption({ label: 'Baja' })
    await municipality.selectOption({ label: 'Baja Dos' })

    await confirm.click()
    await expect.poll(() => sent).not.toBeNull()
    expect(sent).toMatchObject({
      connectionId: carrier.connection.id,
      locationIds: { departmentId: '7', municipalityId: '72' }
    })
    expect(await shipmentStatusesOf(order.id)).toEqual([])
    // The answers are for this case only: the next ones go to the api
    await page.unroute('**/carriers/*/locations*', places)
    await page.unroute('**/orders/*/shipments', made)
  })

  test('offers the cancel, and not the manual void, on a made guide, says what follows and then offers the void', async () => {
    await open(carrier.made)
    await expect(shipping().getByText(SHIPPING.status.label_created, { exact: true })).toBeVisible()
    await expect(shipping().getByRole('button', { name: SHIPPING.action.mark_voided })).toHaveCount(
      0
    )
    await shipping().getByRole('button', { name: SHIPPING.action.cancel }).click()
    const move = dialog(SHIPPING.move.cancel.title)
    // The text after the guide number: the number itself is the api's
    const afterGuide = SHIPPING.move.cancel.descriptionManual.split('{guide}')[1] ?? ''
    await expect(move.getByText(afterGuide.slice(0, 40))).toBeVisible()
    await move.getByRole('button', { name: SHIPPING.move.cancel.confirm, exact: true }).click()

    // The api accepts it: nobody can be asked, so the guide waits for a hand as "cancelling" (TDD_17 §4.10), it is not refused
    await expect
      .poll(async () => (await shipmentStatusesOf(carrier.made.id))[0])
      .toBe(ShipmentStatus.CANCEL_PENDING)
    // ...and the panel offers the manual void right there, with no retry (nobody would be asked), as the dialog said it would
    await expect(
      shipping().getByText(SHIPPING.status.cancel_pending, { exact: true })
    ).toBeVisible()
    await expect(shipping().getByRole('button', { name: SHIPPING.action.cancel })).toHaveCount(0)
    await shipping().getByRole('button', { name: SHIPPING.action.mark_voided }).click()
    await dialog(SHIPPING.move.mark_voided.title)
      .getByRole('button', { name: SHIPPING.move.mark_voided.confirm, exact: true })
      .click()
    await expect(shipping().getByText(SHIPPING.status.cancelled, { exact: true })).toBeVisible()
    expect(await shipmentStatusesOf(carrier.made.id)).toEqual([ShipmentStatus.CANCELLED])
  })

  test('offers only the manual void of a cancel that failed here, and the api accepts it', async () => {
    await open(carrier.cancelFailed)
    await expect(shipping().getByText(SHIPPING.status.cancel_failed, { exact: true })).toBeVisible()
    await expect(shipping().getByRole('button', { name: SHIPPING.action.cancel })).toHaveCount(0)
    await shipping().getByRole('button', { name: SHIPPING.action.mark_voided }).click()
    await dialog(SHIPPING.move.mark_voided.title)
      .getByRole('button', { name: SHIPPING.move.mark_voided.confirm, exact: true })
      .click()
    await expect(shipping().getByText(SHIPPING.status.cancelled, { exact: true })).toBeVisible()
    expect(await shipmentStatusesOf(carrier.cancelFailed.id)).toEqual([ShipmentStatus.CANCELLED])
  })
})
