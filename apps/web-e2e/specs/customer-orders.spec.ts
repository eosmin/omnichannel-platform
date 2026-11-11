import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addOrdersTo, type SeededOrder, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds the permissions of the customers and of the orders
const ADMIN = 'multi-store@test.com'
const PROFILE = en.customers.profile
const ORDERS = en.customers.orders

test.describe('the orders in the customer profile', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string
  const customerName = `Profile orders ${randomUUID().slice(0, 8)}`
  let seeded: SeededOrder[] = []
  let remove: () => Promise<void> = () => Promise.resolve()

  const numberText = (order: SeededOrder) =>
    en.orders.list.number.replace('{number}', order.orderNumber)

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
    // Only the confirmed and the delivered count in the figures: 2 orders, 50.00 spent, 25.00 on average
    const made = await addOrdersTo(storeId, customerName, [
      { status: 'PENDING_CONFIRMATION', totalCents: 1000 },
      { status: 'CONFIRMED', totalCents: 2000 },
      { status: 'DELIVERED', totalCents: 3000 }
    ])
    seeded = made.orders
    remove = made.remove
  })
  test.afterAll(async () => {
    await remove()
    await context.close()
  })

  test('shows the figures, lists the orders by state and draws them in the activity', async () => {
    await page.goto(AppPaths.store.customers(storeId))
    await page.getByLabel(en.customers.list.searchLabel).fill(customerName)
    await page.getByRole('button', { name: customerName }).click()
    const profile = page.getByRole('dialog', { name: PROFILE.title })
    await expect(profile).toBeVisible()

    // The figures count what the store took on, not the pending order
    await expect(profile.getByText(PROFILE.stats.totalSpent)).toBeVisible()
    await expect(profile.getByText(PROFILE.stats.totalSpent).locator('xpath=..')).toContainText(
      '$50.00'
    )
    await expect(profile.getByText(PROFILE.stats.averageOrder).locator('xpath=..')).toContainText(
      '$25.00'
    )

    // The activity draws the three orders, and the filter keeps only them
    await profile
      .getByRole('tablist', { name: en.customers.timeline.filterLabel })
      .getByRole('tab', { name: en.customers.timeline.filters.order })
      .click()
    for (const order of seeded) {
      await expect(
        profile.getByText(en.customers.timeline.order.replace('{number}', order.orderNumber))
      ).toBeVisible()
    }

    // The orders section lists them all, then only the delivered one
    await profile
      .getByRole('tablist', { name: PROFILE.sectionLabel })
      .getByRole('tab', { name: PROFILE.sections.orders })
      .click()
    for (const order of seeded) {
      await expect(profile.getByRole('link', { name: numberText(order) })).toBeVisible()
    }
    await profile.getByRole('tab', { name: en.orders.status.DELIVERED }).click()
    await expect(
      profile.getByRole('link', { name: numberText(seeded[2] as SeededOrder) })
    ).toBeVisible()
    await expect(
      profile.getByRole('link', { name: numberText(seeded[0] as SeededOrder) })
    ).toHaveCount(0)

    // An order opens its page
    await profile.getByRole('link', { name: numberText(seeded[2] as SeededOrder) }).click()
    await expect(page).toHaveURL(AppPaths.store.order(storeId, (seeded[2] as SeededOrder).id))
  })

  test('the profile of a customer with no orders says so', async () => {
    const none = await addOrdersTo(storeId, `Profile none ${randomUUID().slice(0, 8)}`, [])
    try {
      await page.goto(AppPaths.store.customers(storeId))
      await page.getByLabel(en.customers.list.searchLabel).fill('Profile none')
      await page
        .getByRole('button', { name: /Profile none/ })
        .first()
        .click()
      const profile = page.getByRole('dialog', { name: PROFILE.title })
      await profile
        .getByRole('tablist', { name: PROFILE.sectionLabel })
        .getByRole('tab', { name: PROFILE.sections.orders })
        .click()
      await expect(profile.getByText(ORDERS.empty)).toBeVisible()
    } finally {
      await none.remove()
    }
  })
})
