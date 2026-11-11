import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds every permission of the orders, the customers and the stock
const ADMIN = 'multi-store@test.com'
const CREATE = en.orders.create
const EDIT = en.orders.edit
// The dev fixtures give each of their 30 products 20 units in the default warehouse
const FIXTURE = 'Fixture product 7'

test.describe('the edit-order drawer', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string

  const createDrawer = () => page.getByRole('dialog', { name: CREATE.title, exact: true })
  const editDrawer = () => page.getByRole('dialog', { name: EDIT.title, exact: true })
  const quantity = () =>
    editDrawer().getByLabel(CREATE.lines.quantity.replace('{name}', FIXTURE), { exact: true })

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('changes the units and the shipping fee of an order from its detail page, and the server keeps them', async () => {
    // An order made with the create drawer, opened from its toast
    await page.goto(AppPaths.store.orders(storeId))
    await page.getByRole('button', { name: en.orders.list.newOrder, exact: true }).click()
    await expect(createDrawer()).toBeVisible()
    await createDrawer().getByRole('button', { name: CREATE.customer.new, exact: true }).click()
    await createDrawer()
      .getByLabel(CREATE.customer.newName, { exact: true })
      .fill(`Edit customer ${randomUUID().slice(0, 8)}`)
    await createDrawer().getByLabel(CREATE.customer.newPhone, { exact: true }).fill('+50371234567')
    await createDrawer().getByRole('button', { name: CREATE.customer.save, exact: true }).click()
    await createDrawer().getByLabel(CREATE.lines.searchLabel, { exact: true }).fill(FIXTURE)
    await createDrawer()
      .getByRole('button', { name: new RegExp(`^${FIXTURE}\\b`) })
      .click()
    await createDrawer().getByRole('button', { name: CREATE.submit, exact: true }).click()
    await page.getByRole('button', { name: CREATE.open, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Order/)

    await page.getByRole('button', { name: EDIT.open, exact: true }).click()
    await expect(editDrawer()).toBeVisible()
    await expect(quantity()).toHaveValue('1')
    // Nothing changed: it is said and nothing is sent
    await editDrawer().getByRole('button', { name: EDIT.submit, exact: true }).click()
    await expect(editDrawer().getByText(EDIT.nothing)).toBeVisible()

    await quantity().fill('3')
    await editDrawer().getByLabel(CREATE.prices.shipping, { exact: true }).fill('4.00')
    await editDrawer().getByRole('button', { name: EDIT.submit, exact: true }).click()
    await expect(page.getByText(EDIT.saved, { exact: true })).toBeVisible()
    await expect(editDrawer()).toHaveCount(0)

    // What the server kept
    await page.getByRole('button', { name: EDIT.open, exact: true }).click()
    await expect(quantity()).toHaveValue('3')
    await expect(editDrawer().getByLabel(CREATE.prices.shipping, { exact: true })).toHaveValue(
      '4.00'
    )
  })
})
