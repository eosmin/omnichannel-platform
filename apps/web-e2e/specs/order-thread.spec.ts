import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addOrderLineTo,
  addOrdersTo,
  newConversationIn,
  removeOrderLinesOf,
  type SeededOrder,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store: it holds the permissions of the inbox, the orders and the catalog
const ADMIN = 'multi-store@test.com'
const LINE = en.inbox.thread.orderLine

test.describe('orders in the thread and the keyboard', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string
  let conversationId = ''
  let order: SeededOrder
  let remove: () => Promise<void> = () => Promise.resolve()

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
    conversationId = await newConversationIn(storeId)
    const made = await addOrdersTo(storeId, 'Thread order customer', [{ status: 'CONFIRMED' }])
    order = made.orders[0] as SeededOrder
    remove = made.remove
    await addOrderLineTo(storeId, conversationId, order, {
      status: 'PENDING_CONFIRMATION',
      totalCents: 1999
    })
    await addOrderLineTo(storeId, conversationId, order, {
      status: 'CONFIRMED',
      previous: 'PENDING_CONFIRMATION'
    })
  })
  test.afterAll(async () => {
    await removeOrderLinesOf(conversationId)
    await remove()
    await context.close()
  })

  test('draws the lines of the order between the messages and links to the order', async () => {
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    // The total is written in the format of the page (US$19.99): only its amount is part of the case
    await expect(
      page.getByText(
        new RegExp(
          `${LINE.created
            .replace('{number}', order.orderNumber)
            .replace('{status}', en.orders.status.PENDING_CONFIRMATION)
            .replace('{total}', '\\S*19\\.99')}`
        )
      )
    ).toBeVisible()
    await expect(
      page.getByText(
        LINE.statusChanged
          .replace('{number}', order.orderNumber)
          .replace('{previous}', en.orders.status.PENDING_CONFIRMATION)
          .replace('{status}', en.orders.status.CONFIRMED)
      )
    ).toBeVisible()

    await page
      .getByRole('link', { name: LINE.open.replace('{number}', order.orderNumber) })
      .first()
      .click()
    await expect(page).toHaveURL(AppPaths.store.order(storeId, order.id))
  })

  test('g o goes to the orders', async () => {
    await page.goto(AppPaths.store.inbox(storeId))
    await expect(page.getByRole('main')).toBeVisible()

    await page.keyboard.press('g')
    await page.keyboard.press('o')

    await expect(page).toHaveURL(AppPaths.store.orders(storeId))
  })

  test('the Product button starts the /product command in the reply box', async () => {
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const box = page.getByRole('textbox', { name: en.inbox.composer.replyLabel })

    await page.getByRole('button', { name: en.inbox.composer.productButton }).click()

    await expect(box).toHaveValue('/product ')
  })
  test('the Order button and /order open the create-order drawer for the conversation', async () => {
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const drawer = page.getByRole('dialog', { name: en.orders.create.title, exact: true })

    await page.getByRole('button', { name: en.inbox.composer.orderButton }).click()
    await expect(drawer).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()

    const box = page.getByRole('textbox', { name: en.inbox.composer.replyLabel })
    await box.fill('/order')
    await page.keyboard.press('Enter')
    await expect(drawer).toBeVisible()
    // The command leaves nothing in the box: it is not a message
    await expect(box).toHaveValue('')
  })
})
