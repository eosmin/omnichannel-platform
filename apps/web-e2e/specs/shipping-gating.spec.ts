import { randomUUID } from 'node:crypto'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import routes from '../../web/messages/routes/order-detail.en.json' with { type: 'json' }
import {
  addOrdersViewerWithoutShipping,
  addShippingLists,
  addShippingReader,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const SHIPPING = routes.orders.detail.shipping
const RETURNS = routes.orders.detail.returns
const ORDER_LINK = en.shipments.list.orderNumber.replace('{number}', '').trim()

// Which controls of shipping a member sees, by permission: a viewer reads guides, pickups and the orders, and changes nothing; a
// member without `shipping:view` meets no panel and no page. What a carrier can do comes from its declarations, which the journey
// spec shows with the `local` courier (no cancel at the carrier, no pickup request).
test.describe('shipping by permission', () => {
  test.describe.configure({ mode: 'serial' })

  const run = randomUUID().slice(0, 6)
  const viewerEmail = `ship-viewer-${run}@test.com`
  const blindEmail = `ship-blind-${run}@test.com`
  let storeId: string
  let lists: Awaited<ReturnType<typeof addShippingLists>>
  const removals: (() => Promise<void>)[] = []

  test.beforeAll(async () => {
    storeId = await storeIdNamed(FIRST_STORE)
    lists = await addShippingLists(storeId, run)
    removals.push(lists.remove)
    removals.push(await addShippingReader(storeId, viewerEmail))
    removals.push(await addOrdersViewerWithoutShipping(storeId, blindEmail))
  })
  test.afterAll(async () => {
    for (const remove of removals.toReversed()) await remove()
  })

  test('a viewer reads the shipments and the pickups and has no button that changes them', async ({
    page
  }) => {
    await signIn(page, viewerEmail)
    await page.goto(AppPaths.store.shipments(storeId))
    await expect(page.getByRole('heading', { name: en.shipments.list.title })).toBeVisible()
    await expect(page.getByRole('cell', { name: lists.waitingGuide, exact: true })).toBeVisible()

    await page.goto(AppPaths.store.pickups(storeId))
    await expect(page.getByRole('heading', { name: en.pickups.list.title })).toBeVisible()
    await expect(page.getByRole('cell', { name: lists.connectionName, exact: true })).toBeVisible()
    // Asking the carrier for a pickup needs `shipping:manage_pickups`
    await expect(page.getByRole('button', { name: en.pickups.list.request })).toHaveCount(0)
  })

  test('a viewer opens the order of a guide and sees the panel without its actions', async ({
    page
  }) => {
    await signIn(page, viewerEmail)
    await page.goto(AppPaths.store.shipments(storeId))
    await page
      .getByRole('link', { name: /Order #/ })
      .first()
      .waitFor()
    const row = page.getByRole('row').filter({ hasText: lists.waitingGuide })
    await row.getByRole('link', { name: ORDER_LINK }).click()

    const panel = page.getByRole('region', { name: SHIPPING.heading, exact: true })
    await expect(panel).toBeVisible()
    await expect(panel).toContainText(lists.waitingGuide)
    for (const action of [
      SHIPPING.makeGuide,
      SHIPPING.action.print_label,
      SHIPPING.action.cancel,
      SHIPPING.action.mark_voided,
      SHIPPING.action.request_pickup
    ]) {
      await expect(panel.getByRole('button', { name: action })).toHaveCount(0)
    }
    // The Returns panel opens for `returns:view` and offers no new return without `returns:manage`
    const returns = page.getByRole('region', { name: RETURNS.heading, exact: true })
    await expect(returns).toBeVisible()
    await expect(returns.getByRole('button', { name: RETURNS.new })).toHaveCount(0)
  })

  test('a member without shipping:view gets no shipping page and no panel', async ({ page }) => {
    await signIn(page, blindEmail)
    await page.goto(AppPaths.store.shipments(storeId))
    await expect(page.getByText(en.emptyStates.permissionDenied.title)).toBeVisible()
    await expect(page.getByText(lists.waitingGuide)).toHaveCount(0)

    await page.goto(AppPaths.store.pickups(storeId))
    await expect(page.getByText(en.emptyStates.permissionDenied.title)).toBeVisible()

    await page.goto(AppPaths.store.remittance(storeId, lists.remittanceId))
    await expect(page.getByText(en.emptyStates.permissionDenied.title)).toBeVisible()
  })

  test('a draft remittance opens with its lines and its discard action for who manages remittances', async ({
    page
  }) => {
    await signIn(page, 'multi-store@test.com')
    await page.goto(AppPaths.store.remittance(storeId, lists.remittanceId))
    await expect(page.getByText(en.remittances.status.draft, { exact: true }).first()).toBeVisible()
    await expect(page.getByText(en.remittances.outcome.not_found).first()).toBeVisible()
    await expect(page.getByRole('button', { name: en.remittances.discard.action })).toBeVisible()
  })
})
