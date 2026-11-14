import { randomUUID } from 'node:crypto'

import type { BrowserContext, Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newCustomerIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator of the first store, who may search every kind of thing. Not admin@test.com: the magic link is
// limited to 5 requests a minute for each address and the other specs spend that one.
const ADMIN = 'multi-store@test.com'

// A name no other run has used: the database keeps what a case writes, and the case finds the customer by it
const uniqueName = (label: string): string => `${label} ${randomUUID().slice(0, 8)}`

test.describe('the search of the store', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string

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

  // The browser of the suite reports Windows to the app, so `Mod` is Ctrl here
  test('the palette finds a customer by a name typed without accents and opens their profile', async () => {
    const accented = uniqueName('Josefína')
    await newCustomerIn(storeId, { name: accented })
    await page.goto(AppPaths.store.orders(storeId))

    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: en.search.palette.title })
    await palette.getByRole('combobox').fill(accented.replace('í', 'i'))
    await palette.getByRole('option', { name: new RegExp(accented) }).click()

    await expect(page.getByRole('dialog', { name: en.customers.profile.title })).toBeVisible()
    await expect(palette).toBeHidden()
  })

  test('waits for the minimum length before it asks, and says so', async () => {
    await page.goto(AppPaths.store.orders(storeId))
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: en.search.palette.title })
    await palette.getByRole('combobox').fill('x')
    await expect(palette.getByRole('status')).toHaveText(/at least 2 characters/)
    await page.keyboard.press('Escape')
  })

  test('the slash puts the cursor in the box of the top bar and the box opens the results page', async () => {
    const name = uniqueName('Resultado')
    await newCustomerIn(storeId, { name })
    await page.goto(AppPaths.store.orders(storeId))

    await page.keyboard.press('/')
    const box = page.getByRole('searchbox', { name: en.search.box.label })
    await expect(box).toBeFocused()
    // The slash itself is not typed into the box
    await expect(box).toHaveValue('')
    await box.fill(name)
    await box.press('Enter')

    await expect(page).toHaveURL(new RegExp(`${AppPaths.store.search(storeId)}\\?q=`))
    await expect(page.getByRole('link', { name: en.search.page.scopes.customers })).toBeVisible()
    await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible()
  })

  test('narrows the results page to one kind of thing and keeps the text in the address', async () => {
    const name = uniqueName('Alcance')
    await newCustomerIn(storeId, { name })
    await page.goto(`${AppPaths.store.search(storeId, name)}&scope=customers`)

    await expect(page.getByRole('link', { name: en.search.page.scopes.customers })).toHaveAttribute(
      'aria-current',
      'page'
    )
    await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible()
    await expect(page.getByRole('searchbox', { name: en.search.page.label })).toHaveValue(name)
  })
})
