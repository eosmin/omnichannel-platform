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
// The store page is drawn after the session is read: a key pressed before the top bar is there goes to nobody
async function openStorePage(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await expect(
    page.getByRole('searchbox', { name: en.search.box.label, exact: true })
  ).toBeVisible()
}

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
    await openStorePage(page, AppPaths.store.orders(storeId))

    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: en.search.palette.title })
    await palette.getByRole('combobox').fill(accented.replace('í', 'i'))
    await palette.getByRole('option', { name: new RegExp(accented) }).click()

    await expect(page.getByRole('dialog', { name: en.customers.profile.title })).toBeVisible()
    await expect(palette).toBeHidden()
  })

  // N-BR2-14: Mod+K is a chord with a modifier, so it does not collide with what is typed
  test('Ctrl+K opens the palette from a text field, a textarea and a select, and Escape gives the focus back', async () => {
    await openStorePage(page, AppPaths.store.customers(storeId))
    const field = page.getByRole('searchbox', { name: en.search.box.label, exact: true })
    await page.evaluate(() => {
      const extra = document.createElement('div')
      extra.innerHTML =
        '<textarea id="pa-textarea" aria-label="pa-textarea"></textarea>' +
        '<select id="pa-select" aria-label="pa-select"><option>a</option></select>'
      document.body.appendChild(extra)
    })
    const palette = page.getByRole('dialog', { name: en.search.palette.title })
    for (const target of [field, page.locator('#pa-textarea'), page.locator('#pa-select')]) {
      await target.focus()
      await page.keyboard.press('Control+k')
      await expect(palette).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(palette).toBeHidden()
      await expect(target).toBeFocused()
    }
  })

  test('waits for the minimum length before it asks, and says so', async () => {
    await openStorePage(page, AppPaths.store.orders(storeId))
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: en.search.palette.title })
    await palette.getByRole('combobox').fill('x')
    await expect(palette.getByRole('status')).toHaveText(/at least 2 characters/)
    await page.keyboard.press('Escape')
  })

  test('the slash puts the cursor in the box of the top bar and the box opens the results page', async () => {
    const name = uniqueName('Resultado')
    await newCustomerIn(storeId, { name })
    await openStorePage(page, AppPaths.store.orders(storeId))

    await page.keyboard.press('/')
    const box = page.getByRole('searchbox', { name: en.search.box.label, exact: true })
    await expect(box).toBeFocused()
    // The slash itself is not typed into the box
    await expect(box).toHaveValue('')
    await box.fill(name)
    await box.press('Enter')

    await expect(page).toHaveURL(new RegExp(`${AppPaths.store.search(storeId)}\\?q=`))
    await expect(
      page
        .getByRole('navigation', { name: en.search.page.scopes.label })
        .getByRole('link', { name: en.search.page.scopes.customers })
    ).toBeVisible()
    await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible()
  })

  test('an empty box and Enter open the results page, which says what to type', async () => {
    await openStorePage(page, AppPaths.store.orders(storeId))
    await page.keyboard.press('/')
    const box = page.getByRole('searchbox', { name: en.search.box.label, exact: true })
    await expect(box).toBeFocused()
    await box.press('Enter')
    await expect(page).toHaveURL(new RegExp(`${AppPaths.store.search(storeId)}$`))
    await expect(page.getByText(en.search.page.start)).toBeVisible()
  })

  test('narrows the results page to one kind of thing and keeps the text in the address', async () => {
    const name = uniqueName('Alcance')
    await newCustomerIn(storeId, { name })
    await page.goto(`${AppPaths.store.search(storeId, name)}&scope=customers`)

    await expect(
      page
        .getByRole('navigation', { name: en.search.page.scopes.label })
        .getByRole('link', { name: en.search.page.scopes.customers })
    ).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('button', { name: new RegExp(name) })).toBeVisible()
    await expect(
      page.getByRole('searchbox', { name: en.search.page.label, exact: true })
    ).toHaveValue(name)
  })
})
