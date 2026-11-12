import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { ShipmentStatus } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import routes from '../../web/messages/routes/order-detail.en.json' with { type: 'json' }
import {
  addShippableOrder,
  addShippingScenario,
  addStockedProduct,
  onHandOf,
  type ShippableOrder,
  type ShippingScenario,
  shipmentStatusesOf,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds every permission of the orders, of shipping and of the returns
const ADMIN = 'multi-store@test.com'
const DETAIL = routes.orders.detail
const SHIPPING = DETAIL.shipping
const GUIDE = DETAIL.guide
const RETURNS = DETAIL.returns
const ACTION = RETURNS.action
const STATUS = en.orders.status

// The journey of TDD_17 §9 through the screens, against a `local` courier of the store: make the guide of a confirmed order, print
// its label, cancel it (a guide of the platform's own courier is cancelled at once, and the panel offers neither the manual void nor
// "Request pickup"), and then a refund and an exchange of delivered orders, from the request to the stock and the replacement.
test.describe('the shipping journey of an order', () => {
  test.describe.configure({ mode: 'serial' })

  const run = randomUUID().slice(0, 6)
  let context: BrowserContext
  let page: Page
  let storeId: string
  let scenario: ShippingScenario
  let guided: ShippableOrder
  let refunded: ShippableOrder
  let exchanged: ShippableOrder
  const replacement = `Replacement ${run}`

  const shipping = () => page.getByRole('region', { name: SHIPPING.heading, exact: true })
  const returns = () => page.getByRole('region', { name: RETURNS.heading, exact: true })
  const dialog = (name: string) => page.getByRole('dialog', { name })

  async function open(order: ShippableOrder): Promise<void> {
    await page.goto(AppPaths.store.order(storeId, order.id))
    await expect(
      page.getByRole('heading', {
        name: en.orders.detail.heading.replace('{number}', order.orderNumber)
      })
    ).toBeVisible()
  }

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
    scenario = await addShippingScenario(storeId, run)
    guided = await addShippableOrder(storeId, scenario, 'CONFIRMED')
    refunded = await addShippableOrder(storeId, scenario, 'DELIVERED')
    exchanged = await addShippableOrder(storeId, scenario, 'DELIVERED')
    await addStockedProduct(storeId, scenario, replacement)
  })
  test.afterAll(async () => {
    await scenario.remove()
    await context.close()
  })

  test('makes the guide of a confirmed order from the dialog and prints its label', async () => {
    await open(guided)
    await expect(shipping().getByText(SHIPPING.empty, { exact: true })).toBeVisible()
    await shipping().getByRole('button', { name: SHIPPING.makeGuide }).click()

    const make = dialog(GUIDE.title.replace('{number}', guided.orderNumber))
    await make.getByLabel(GUIDE.connectionLabel).selectOption({ label: scenario.connection.name })
    await make.getByRole('button', { name: GUIDE.confirm, exact: true }).click()

    await expect(shipping().getByText(SHIPPING.status.label_created, { exact: true })).toBeVisible()
    await expect(shipping().getByText(SHIPPING.empty, { exact: true })).toBeHidden()
    // One live guide: the order offers no second one
    await expect(shipping().getByRole('button', { name: SHIPPING.makeGuide })).toHaveCount(0)
    expect(await shipmentStatusesOf(guided.id)).toEqual([ShipmentStatus.LABEL_CREATED])

    // The label is asked of the api by the press, and no carrier is called to print it
    const asked = page.waitForResponse(response =>
      /\/shipments\/[^/]+\/label$/.test(new URL(response.url()).pathname)
    )
    await shipping().getByRole('button', { name: SHIPPING.action.print_label }).click()
    expect((await asked).ok()).toBe(true)
  })

  test('offers what this courier can do: cancel its own guide at once, and no manual void and no pickup', async () => {
    await open(guided)
    await expect(shipping().getByText(SHIPPING.status.label_created, { exact: true })).toBeVisible()
    await expect(shipping().getByRole('button', { name: SHIPPING.action.cancel })).toBeVisible()
    await expect(shipping().getByRole('button', { name: SHIPPING.action.mark_voided })).toHaveCount(
      0
    )
    await expect(
      shipping().getByRole('button', { name: SHIPPING.action.request_pickup })
    ).toHaveCount(0)

    await shipping().getByRole('button', { name: SHIPPING.action.cancel }).click()
    await dialog(SHIPPING.move.cancel.title)
      .getByRole('button', { name: SHIPPING.move.cancel.confirm, exact: true })
      .click()

    // A guide of the platform is cancelled at once: nobody is asked
    await expect(shipping().getByText(SHIPPING.status.cancelled, { exact: true })).toBeVisible()
    await expect(shipping().getByRole('button', { name: SHIPPING.action.print_label })).toHaveCount(
      0
    )
    expect(await shipmentStatusesOf(guided.id)).toEqual([ShipmentStatus.CANCELLED])
    // The order is free to get another guide
    await expect(shipping().getByRole('button', { name: SHIPPING.makeGuide })).toBeVisible()
  })

  test('refunds a delivered order: request, approve, receive resellable, complete with the money given back', async () => {
    await open(refunded)
    await expect(returns().getByText(RETURNS.empty)).toBeVisible()
    await returns().getByRole('button', { name: RETURNS.new }).click()

    const create = dialog(RETURNS.create.title.replace('{number}', refunded.orderNumber))
    await create
      .getByLabel(RETURNS.create.reasonLabel)
      .selectOption({ label: en.orders.return.reason.DEFECTIVE })
    await create.getByRole('textbox', { name: refunded.productName }).fill('1')
    await create.getByRole('button', { name: RETURNS.create.confirm, exact: true }).click()

    const entry = returns().getByRole('listitem').filter({ hasText: RETURNS.status.requested })
    await expect(entry.getByText(RETURNS.type.refund, { exact: true })).toBeVisible()

    await entry.getByRole('button', { name: ACTION.approve.button, exact: true }).click()
    await dialog(ACTION.approve.title)
      .getByRole('button', { name: ACTION.approve.confirm, exact: true })
      .click()
    const approved = returns().getByRole('listitem').filter({ hasText: RETURNS.status.approved })
    await expect(approved).toBeVisible()

    await approved.getByRole('button', { name: ACTION.receive.button, exact: true }).click()
    const receive = dialog(ACTION.receive.title)
    await receive
      .getByLabel(ACTION.receive.conditionLabel.replace('{name}', refunded.productName))
      .selectOption({ label: RETURNS.condition.resellable })
    await receive.getByRole('button', { name: ACTION.receive.confirm, exact: true }).click()
    const received = returns().getByRole('listitem').filter({ hasText: RETURNS.status.received })
    await expect(received).toContainText(RETURNS.condition.resellable)
    // The resellable unit is back in the warehouse it left from
    await expect.poll(() => onHandOf(scenario.warehouse.id, refunded.productName)).toBe(1)

    await received.getByRole('button', { name: ACTION.complete.button, exact: true }).click()
    const complete = dialog(ACTION.complete.title)
    await complete.getByLabel(ACTION.complete.amountLabel).fill('19.99')
    await complete.getByRole('button', { name: ACTION.complete.confirm, exact: true }).click()
    const completed = returns().getByRole('listitem').filter({ hasText: RETURNS.status.completed })
    await expect(completed).toContainText('19.99')
  })

  test('exchanges a delivered order: approving it makes the confirmed replacement order', async () => {
    await open(exchanged)
    await returns().getByRole('button', { name: RETURNS.new }).click()

    const create = dialog(RETURNS.create.title.replace('{number}', exchanged.orderNumber))
    await create.getByLabel(RETURNS.create.typeLabel).selectOption({ label: RETURNS.type.exchange })
    await create
      .getByLabel(RETURNS.create.reasonLabel)
      .selectOption({ label: en.orders.return.reason.WRONG_ITEM })
    await create.getByRole('textbox', { name: exchanged.productName }).fill('1')
    await create.getByRole('button', { name: RETURNS.create.confirm, exact: true }).click()

    const entry = returns().getByRole('listitem').filter({ hasText: RETURNS.status.requested })
    await entry.getByRole('button', { name: ACTION.approve.button, exact: true }).click()
    const approve = dialog(ACTION.approve.title)
    await approve.getByLabel(en.orders.create.lines.searchLabel).fill(replacement)
    await approve.getByRole('button', { name: replacement }).click()
    await expect(
      approve.getByRole('textbox', {
        name: ACTION.approve.quantityLabel.replace('{name}', replacement)
      })
    ).toHaveValue('1')
    await approve.getByRole('button', { name: ACTION.approve.confirm, exact: true }).click()

    const approved = returns().getByRole('listitem').filter({ hasText: RETURNS.status.approved })
    await expect(approved).toBeVisible()
    await approved.getByRole('link', { name: RETURNS.replacement }).click()
    await expect(page).toHaveURL(url => !url.pathname.endsWith(exchanged.id))
    await expect(page).toHaveURL(/\/orders\/[^/]+$/)
    await expect(
      page.getByRole('heading', {
        name: en.orders.detail.heading.replace('{number}', exchanged.orderNumber)
      })
    ).toHaveCount(0)
    await expect(page.getByText(replacement).first()).toBeVisible()
    await expect(page.getByText(STATUS.CONFIRMED, { exact: true }).first()).toBeVisible()
  })
})
