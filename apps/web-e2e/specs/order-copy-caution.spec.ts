import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addOrdersTo, type SeededOrder, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds the permissions of the orders, the customers and the settings
const ADMIN = 'multi-store@test.com'
const CREATE = en.orders.create
const CAUTION = en.customers.cautionFlag
const REASON = 'Refused two packages in a row'
// A product the other specs do not count the stock of: the copied order reserves units of it
const FIXTURE = 'Fixture product 25'

test.describe('the caution flag and "Copy order"', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string
  const customerName = `Caution customer ${randomUUID().slice(0, 8)}`
  let seeded: SeededOrder | undefined
  let remove: () => Promise<void> = () => Promise.resolve()

  const drawer = () => page.getByRole('dialog', { name: CREATE.title, exact: true })

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
    const made = await addOrdersTo(storeId, customerName, [
      { customerNotes: 'Ring the bell twice', packingNotes: 'Wrap it twice' }
    ])
    seeded = made.orders[0]
    remove = made.remove
  })
  test.afterAll(async () => {
    await remove()
    await context.close()
  })

  test('flags the customer with a required reason, and the orders list shows the chip', async () => {
    await page.goto(AppPaths.store.customers(storeId))
    await page.getByLabel(en.customers.list.searchLabel).fill(customerName)
    await page.getByRole('button', { name: customerName }).click()
    const profile = page.getByRole('dialog', { name: en.customers.profile.title })
    await profile.getByRole('button', { name: CAUTION.open.set, exact: true }).click()

    const dialog = page.getByRole('dialog', { name: CAUTION.set.title, exact: true })
    // The reason is required: nothing is sent without it
    await expect(
      dialog.getByRole('button', { name: CAUTION.set.submit, exact: true })
    ).toBeDisabled()
    await dialog.getByLabel(CAUTION.reason, { exact: true }).fill(REASON)
    await dialog.getByRole('button', { name: CAUTION.set.submit, exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(profile.getByRole('note')).toContainText(REASON)

    await page.goto(AppPaths.store.orders(storeId))
    const row = page.getByRole('row').filter({ hasText: customerName })
    await expect(row.getByText(CAUTION.chip, { exact: true })).toBeVisible()
  })

  test('copies an order from its detail: the draft, the caution banner with the reason, the checkboxes of the store, and a copy is made', async () => {
    if (seeded === undefined) throw new Error('the order was not seeded')
    await page.goto(AppPaths.store.order(storeId, seeded.id))
    await expect(page.getByText(CAUTION.chip, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: en.orders.copy.open, exact: true }).click()

    await expect(drawer()).toBeVisible()
    await expect(drawer().getByText(en.orders.copy.heading, { exact: true })).toBeVisible()
    // It informs and never blocks: the banner shows the reason and the form stays usable
    await expect(drawer().getByRole('note')).toContainText(REASON)
    await expect(drawer().getByLabel(CREATE.notes.customer, { exact: true })).toHaveValue(
      'Ring the bell twice'
    )
    await expect(drawer().getByLabel(CREATE.notes.packing, { exact: true })).toHaveValue(
      'Wrap it twice'
    )
    await expect(drawer().getByLabel(CREATE.confirm.label, { exact: true })).toBeVisible()
    await expect(drawer().getByLabel(CREATE.sendSummary.label, { exact: true })).toBeVisible()

    // The seeded order had no items: the agent adds one, as in any new order
    await drawer().getByLabel(CREATE.lines.searchLabel, { exact: true }).fill(FIXTURE)
    await drawer()
      .getByRole('button', { name: new RegExp(`^${FIXTURE}\\b`) })
      .click()
    await drawer()
      .getByLabel(CREATE.phones.field.replace('{index}', '1'), { exact: true })
      .fill('71234567')
    await drawer().getByRole('button', { name: CREATE.submit, exact: true }).click()
    await expect(page.getByText(/Order .* created\./)).toBeVisible()
    await expect(drawer()).toHaveCount(0)
  })

  test('takes the flag off from the profile', async () => {
    await page.goto(AppPaths.store.customers(storeId))
    await page.getByLabel(en.customers.list.searchLabel).fill(customerName)
    await page.getByRole('button', { name: customerName }).click()
    const profile = page.getByRole('dialog', { name: en.customers.profile.title })
    await profile.getByRole('button', { name: CAUTION.open.clear, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: CAUTION.clear.title, exact: true })
    await dialog.getByRole('button', { name: CAUTION.clear.submit, exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(profile.getByRole('note')).toHaveCount(0)
  })
})
