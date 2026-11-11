import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newConversationIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds every permission of the orders, the customers and the stock
const ADMIN = 'multi-store@test.com'
const CREATE = en.orders.create
// The dev fixtures give each of their 30 products 20 units in the default warehouse
const FIXTURE = 'Fixture product 7'

const uniqueName = (label: string): string => `${label} ${randomUUID().slice(0, 8)}`

test.describe('the create-order drawer', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string

  const drawer = () => page.getByRole('dialog', { name: CREATE.title, exact: true })

  async function openDrawerFromOrders(): Promise<void> {
    await page.goto(AppPaths.store.orders(storeId))
    await page.getByRole('button', { name: en.orders.list.newOrder, exact: true }).click()
    await expect(drawer()).toBeVisible()
  }

  async function saveNewCustomer(values: {
    name: string
    email?: string
    phone?: string
  }): Promise<void> {
    await drawer().getByRole('button', { name: CREATE.customer.new, exact: true }).click()
    await drawer().getByLabel(CREATE.customer.newName).fill(values.name)
    if (values.email !== undefined) {
      await drawer().getByLabel(CREATE.customer.newEmail).fill(values.email)
    }
    if (values.phone !== undefined) {
      await drawer().getByLabel(CREATE.customer.newPhone).fill(values.phone)
    }
    await drawer().getByRole('button', { name: CREATE.customer.save, exact: true }).click()
    await expect(drawer().getByTestId('order-customer')).toContainText(values.name)
  }

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

  test('makes an order from the orders page for a new customer: the phone comes from the customer, the stock shows and the order is listed', async () => {
    const customerName = uniqueName('Drawer customer')
    await openDrawerFromOrders()
    await saveNewCustomer({ name: customerName, phone: '+50371234567' })

    // The recipient phone is the national number of the customer, with no country code
    await expect(drawer().getByLabel(CREATE.phones.field.replace('{index}', '1'))).toHaveValue(
      '71234567'
    )

    await drawer().getByLabel(CREATE.lines.searchLabel, { exact: true }).fill(FIXTURE)
    await drawer()
      .getByRole('button', { name: new RegExp(`^${FIXTURE}\\b`) })
      .click()
    await drawer().getByLabel(CREATE.lines.quantity.replace('{name}', FIXTURE)).fill('2')
    // The stock of each warehouse is read for the member who may see it
    await expect(drawer().getByText(/available in/)).toBeVisible()
    await drawer().getByLabel(CREATE.notes.packing).fill('Wrap it twice')

    await drawer().getByRole('button', { name: CREATE.submit, exact: true }).click()

    await expect(page.getByText(/Order .* created\./)).toBeVisible()
    await expect(drawer()).toHaveCount(0)
    await expect(page.getByRole('button', { name: customerName })).toBeVisible()
  })

  test('refuses a form that is not ready, naming the field, and sends nothing', async () => {
    await openDrawerFromOrders()
    await drawer().getByRole('button', { name: CREATE.submit, exact: true }).click()
    await expect(drawer().getByText(CREATE.errors.customer)).toBeVisible()
    await expect(drawer()).toBeVisible()
  })

  test('lists the possible duplicates of a new customer, never blocks it, and offers the merge with the old one', async () => {
    const email = `drawer-${randomUUID().slice(0, 8)}@example.com`
    const oldName = uniqueName('Old drawer customer')
    const newName = uniqueName('New drawer customer')
    await openDrawerFromOrders()
    await saveNewCustomer({ name: oldName, email })
    await drawer().getByRole('button', { name: CREATE.customer.change, exact: true }).click()
    await saveNewCustomer({ name: newName, email })

    const duplicates = drawer().getByRole('region', { name: CREATE.customer.duplicates.title })
    await expect(duplicates).toBeVisible()
    await expect(duplicates.getByText(oldName)).toBeVisible()
    await expect(duplicates.getByText(CREATE.customer.duplicates.matchedOn.email)).toBeVisible()
    await duplicates
      .getByRole('button', { name: CREATE.customer.duplicates.merge.replace('{name}', oldName) })
      .click()
    await expect(page.getByRole('dialog', { name: en.customers.merge.title })).toBeVisible()
  })

  test('opens from the open conversation with Shift+O, for the customer of that conversation', async () => {
    const conversationId = await newConversationIn(storeId)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await expect(
      page.getByRole('button', { name: en.inbox.actions.resolveMore, exact: true })
    ).toBeVisible()
    await page.keyboard.press('Shift+O')

    await expect(drawer()).toBeVisible()
    await expect(drawer().getByTestId('order-customer')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer()).toHaveCount(0)
  })
})
