import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { calendarDayIn, nextCalendarDay, PaginationLimits } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addOrdersTo,
  addUserWithoutOrders,
  type SeededOrder,
  setStoreTimezone,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds every permission of the orders
const ADMIN = 'multi-store@test.com'
const ORDERS = en.orders.list
// A zone far from UTC: "today" of the store is not "today" of the server for part of every day, and the case still holds
const STORE_ZONE = 'Pacific/Kiritimati'

const uniqueName = (label: string): string => `${label} ${randomUUID().slice(0, 8)}`

test.describe('the orders page', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string
  let zoneBefore = ''
  const customerName = uniqueName('Orders customer')
  const removals: (() => Promise<void>)[] = []
  let seeded: SeededOrder[] = []
  let today = ''
  let tomorrow = ''

  const row = (orderNumber: string) => page.getByRole('row').filter({ hasText: orderNumber })
  const numberText = (order: SeededOrder) => ORDERS.number.replace('{number}', order.orderNumber)

  async function openOrders(query = ''): Promise<void> {
    await page.goto(`${AppPaths.store.orders(storeId)}${query}`)
    await expect(page.getByRole('heading', { name: ORDERS.title })).toBeVisible()
  }

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
    zoneBefore = await setStoreTimezone(storeId, STORE_ZONE)
    today = calendarDayIn(STORE_ZONE, new Date())
    tomorrow = nextCalendarDay(today)
    const made = await addOrdersTo(storeId, customerName, [
      { status: 'PENDING_CONFIRMATION', scheduledDeliveryDate: today },
      { status: 'SHIPPED', paymentStatus: 'COMPLETED', scheduledDeliveryDate: tomorrow },
      { status: 'CONFIRMED' }
    ])
    seeded = made.orders
    removals.push(made.remove)
  })
  test.afterAll(async () => {
    for (const remove of removals) await remove()
    await setStoreTimezone(storeId, zoneBefore)
    await context.close()
  })

  test('lists the orders of the store with the customer, the state, the payment and the total in dollars', async () => {
    await openOrders(`?q=${encodeURIComponent(customerName)}`)

    for (const order of seeded) await expect(row(order.orderNumber)).toBeVisible()
    const shipped = row((seeded[1] as SeededOrder).orderNumber)
    await expect(shipped.getByText(en.orders.status.SHIPPED)).toBeVisible()
    await expect(shipped.getByText(en.orders.paymentStatus.COMPLETED)).toBeVisible()
    await expect(shipped.getByText('$20.00')).toBeVisible()
    await expect(shipped.getByRole('button', { name: customerName })).toBeVisible()
  })

  test('searches by the number of an order and by the name of the customer, and keeps the text in the address', async () => {
    await openOrders()
    const search = page.getByLabel(ORDERS.searchLabel)

    await search.fill(customerName)
    await expect(page).toHaveURL(/[?&]q=/)
    for (const order of seeded) await expect(row(order.orderNumber)).toBeVisible()

    const target = seeded[2] as SeededOrder
    await search.fill(target.orderNumber)
    await expect(row(target.orderNumber)).toBeVisible()
    await expect(row((seeded[0] as SeededOrder).orderNumber)).toBeHidden()

    await search.fill(`${customerName} nobody`)
    await expect(page.getByText(ORDERS.noMatches)).toBeVisible()
  })

  test('filters by state and payment, keeps the filters when the page is opened again, and clears them', async () => {
    await openOrders(`?q=${encodeURIComponent(customerName)}`)

    await page.getByLabel(ORDERS.filters.status, { exact: true }).selectOption('SHIPPED')
    await expect(page).toHaveURL(/status=SHIPPED/)
    await expect(row((seeded[1] as SeededOrder).orderNumber)).toBeVisible()
    await expect(row((seeded[0] as SeededOrder).orderNumber)).toBeHidden()

    await page.reload()
    await expect(page.getByLabel(ORDERS.filters.status, { exact: true })).toHaveValue('SHIPPED')
    await expect(row((seeded[1] as SeededOrder).orderNumber)).toBeVisible()

    await page.getByLabel(ORDERS.filters.status, { exact: true }).selectOption('')
    await page.getByLabel(ORDERS.filters.paymentStatus, { exact: true }).selectOption('PENDING')
    await expect(row((seeded[1] as SeededOrder).orderNumber)).toBeHidden()
    await expect(row((seeded[0] as SeededOrder).orderNumber)).toBeVisible()

    await page.getByRole('button', { name: /^Clear \d+ filters?$/ }).click()
    await expect(page.getByLabel(ORDERS.searchLabel)).toHaveValue('')
    await expect(page).not.toHaveURL(/paymentStatus=|q=/)
  })

  test('the shortcuts Today and Tomorrow list the orders scheduled for that day of the store', async () => {
    await openOrders(`?q=${encodeURIComponent(customerName)}`)
    const todayButton = page.getByRole('button', { name: ORDERS.filters.shortcuts.today })
    const tomorrowButton = page.getByRole('button', { name: ORDERS.filters.shortcuts.tomorrow })

    await todayButton.click()
    await expect(page).toHaveURL(/scheduledDeliveryOn=today/)
    await expect(todayButton).toHaveAttribute('aria-pressed', 'true')
    await expect(row((seeded[0] as SeededOrder).orderNumber)).toBeVisible()
    await expect(row((seeded[1] as SeededOrder).orderNumber)).toBeHidden()

    await tomorrowButton.click()
    await expect(page).toHaveURL(/scheduledDeliveryOn=tomorrow/)
    await expect(row((seeded[1] as SeededOrder).orderNumber)).toBeVisible()
    await expect(row((seeded[0] as SeededOrder).orderNumber)).toBeHidden()

    // Pressing the one that is on turns it off
    await tomorrowButton.click()
    await expect(page).not.toHaveURL(/scheduledDeliveryOn/)
    await expect(row((seeded[2] as SeededOrder).orderNumber)).toBeVisible()
  })

  test('sorts by the day of delivery, the orders with no day last', async () => {
    await openOrders(`?q=${encodeURIComponent(customerName)}`)

    await page.getByLabel(ORDERS.filters.sort).selectOption('scheduled_delivery')

    await expect(page).toHaveURL(/sort=scheduled_delivery/)
    const numbers = page.getByRole('row').getByRole('link', { name: /^#E2E-/ })
    await expect(numbers).toHaveText(seeded.map(numberText))
  })

  test('shows the scheduled day in its own column, and none for an order without one', async () => {
    await openOrders(`?q=${encodeURIComponent(customerName)}`)

    await expect(
      row((seeded[2] as SeededOrder).orderNumber).getByText(ORDERS.noSchedule)
    ).toBeVisible()
    await expect(
      row((seeded[0] as SeededOrder).orderNumber).getByText(ORDERS.noSchedule)
    ).toBeHidden()
  })

  test('opens an order from its number, and the way back returns to the same filters', async () => {
    const query = `?q=${encodeURIComponent(customerName)}`
    await openOrders(query)
    const target = seeded[0] as SeededOrder

    await page.getByRole('link', { name: numberText(target) }).click()

    await expect(page).toHaveURL(new RegExp(`/s/${storeId}/orders/[0-9a-f-]{36}$`))
    await page.goBack()
    await expect(page.getByLabel(ORDERS.searchLabel)).toHaveValue(customerName)
  })

  test('keeps a selection of rows and counts it, and clears it', async () => {
    await openOrders(`?q=${encodeURIComponent(customerName)}`)

    await page
      .getByLabel(ORDERS.selectOrder.replace('{number}', (seeded[0] as SeededOrder).orderNumber))
      .check()
    await expect(page.getByRole('status').filter({ hasText: /1 order selected/ })).toBeVisible()

    await page.getByLabel(ORDERS.selectAll).check()
    await expect(page.getByRole('status').filter({ hasText: /3 orders selected/ })).toBeVisible()

    await page.getByRole('button', { name: ORDERS.clearSelection }).click()
    await expect(page.getByRole('status').filter({ hasText: /selected/ })).toBeHidden()
  })

  test('pages through a long list with Load more', async () => {
    const pagerName = uniqueName('Pager customer')
    const made = await addOrdersTo(
      storeId,
      pagerName,
      Array.from({ length: PaginationLimits.DEFAULT + 3 }, () => ({}))
    )
    removals.push(made.remove)

    await openOrders(`?q=${encodeURIComponent(pagerName)}`)
    const rows = page.getByRole('row').getByRole('link', { name: /^#E2E-/ })
    await expect(rows).toHaveCount(PaginationLimits.DEFAULT)

    await page.getByRole('button', { name: ORDERS.loadMore }).click()

    await expect(rows).toHaveCount(PaginationLimits.DEFAULT + 3)
    await expect(page.getByRole('button', { name: ORDERS.loadMore })).toBeHidden()
  })

  test('queues the orders file for the filters on the page and follows the toast to the exports center', async () => {
    await openOrders(`?q=${encodeURIComponent(customerName)}&status=SHIPPED`)

    await page.getByRole('button', { name: ORDERS.export }).click()
    await expect(page.getByText(ORDERS.exportQueued)).toBeVisible()

    await page.getByRole('button', { name: ORDERS.viewExports }).click()
    await expect(page).toHaveURL(new RegExp(`/s/${storeId}/exports$`))
    await expect(page.getByRole('cell', { name: en.exports.types.orders }).first()).toBeVisible()
  })

  test('a person without orders:view sees no entry in the navigation and a refusal on the page', async ({
    browser
  }) => {
    const email = `no-orders-${randomUUID().slice(0, 8)}@test.com`
    const remove = await addUserWithoutOrders(storeId, email)
    const other = await browser.newContext({ locale: 'en' })
    try {
      await reachServicesFromOwnAddress(other)
      const otherPage = await other.newPage()
      await signIn(otherPage, email)

      await otherPage.goto(AppPaths.store.orders(storeId))

      await expect(otherPage.getByText(ORDERS.noAccess)).toBeVisible()
      await expect(
        otherPage.getByRole('navigation', { name: en.shell.nav.label }).getByRole('link', {
          name: en.shell.nav.orders
        })
      ).toBeHidden()
    } finally {
      await other.close()
      await remove()
    }
  })
})
