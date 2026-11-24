import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { expect, test } from '../support/test'

// The alert and the buttons are looked for inside the main of the page: the route announcer of Next.js is also an alert, and the cookie banner of
// the layout has buttons of its own
// The public pages of the data requests (Step 7.2, C1b): no session, no store. This file holds what does not need the public flow switched on
// (the api answers the same refusal for a token that does not hold and for the flow being off); the whole flow, with the flag on, is
// the file of the form.
const UNKNOWN_TOKEN = 'a'.repeat(43)

test.describe('the page that confirms a data request', () => {
  test('opens with no session, does nothing until the button is pressed, and says one thing for a token that does not hold', async ({
    page
  }) => {
    await page.goto(`${AppPaths.dsrVerify}#token=${UNKNOWN_TOKEN}`)

    // A visitor with no session is not sent to the login: this page is public
    await expect(page).toHaveURL(new RegExp(`${AppPaths.dsrVerify}#token=`))
    await expect(page.getByRole('heading', { name: en.dsrVerify.heading })).toBeVisible()
    const confirm = page.getByRole('main').getByRole('button', { name: en.dsrVerify.confirm })
    await expect(confirm).toBeVisible()

    await confirm.click()

    await expect(page.getByRole('main').getByRole('alert')).toHaveText(en.dsrVerify.invalid)
    // The token is out of the address bar, and nothing offers a second press
    expect(await page.evaluate(() => window.location.hash)).toBe('')
    await expect(
      page.getByRole('main').getByRole('button', { name: en.dsrVerify.confirm })
    ).toHaveCount(0)
  })

  test('says the link is not valid when the address carries no token', async ({ page }) => {
    await page.goto(AppPaths.dsrVerify)

    await expect(page.getByRole('main').getByRole('alert')).toHaveText(en.dsrVerify.invalid)
    await expect(page.getByRole('main').getByRole('button')).toHaveCount(0)
  })

  test('sends no Referer and lets no cache or search engine keep the page', async ({ page }) => {
    const response = await page.goto(`${AppPaths.dsrVerify}#token=${UNKNOWN_TOKEN}`)

    expect(response?.headers()['referrer-policy']).toBe('no-referrer')
    expect(response?.headers()['cache-control']).toBe('no-store')
    expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow')
  })
})

test.describe('the public form of data requests', () => {
  test('opens with no session, keeps the key out of the address after sending, and says one thing', async ({
    page
  }) => {
    const response = await page.goto(`${AppPaths.dsrRequest}#key=${'k'.repeat(32)}`)

    // A visitor with no session is not sent to the login: this page is public, and no Referer, cache or search engine keeps its address
    await expect(page).toHaveURL(new RegExp(`${AppPaths.dsrRequest}#key=`))
    expect(response?.headers()['referrer-policy']).toBe('no-referrer')
    expect(response?.headers()['cache-control']).toBe('no-store')
    expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow')
    await expect(page.getByRole('heading', { name: en.dsrRequest.heading })).toBeVisible()

    // An address that is not an address is not sent: the field says so and holds the focus
    await page.getByLabel(en.dsrRequest.emailLabel).fill('not-an-address')
    await page.getByRole('button', { name: en.dsrRequest.submit }).click()
    await expect(page.getByRole('main').getByText(en.dsrRequest.emailInvalid)).toBeVisible()
    await expect(page.getByLabel(en.dsrRequest.emailLabel)).toBeFocused()

    // The flag is off here (CI) or on (the local run of the whole flow): either way the page says the same thing
    await page.getByLabel(en.dsrRequest.emailLabel).fill('nobody@example.com')
    await page.getByRole('button', { name: en.dsrRequest.submit }).click()
    await expect(page.getByRole('main').getByRole('status')).toContainText(en.dsrRequest.sent)
    expect(await page.evaluate(() => window.location.hash)).toBe('')
  })

  test('says the link is incomplete when the address carries no key', async ({ page }) => {
    await page.goto(AppPaths.dsrRequest)

    await expect(page.getByRole('main').getByRole('alert')).toHaveText(en.dsrRequest.incomplete)
    await expect(page.getByRole('main').getByRole('button')).toHaveCount(0)
  })
})
