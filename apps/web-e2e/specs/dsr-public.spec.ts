import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { expect, test } from '../support/test'

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
    const confirm = page.getByRole('button', { name: en.dsrVerify.confirm })
    await expect(confirm).toBeVisible()

    await confirm.click()

    await expect(page.getByRole('alert')).toHaveText(en.dsrVerify.invalid)
    // The token is out of the address bar, and nothing offers a second press
    expect(await page.evaluate(() => window.location.hash)).toBe('')
    await expect(page.getByRole('button', { name: en.dsrVerify.confirm })).toHaveCount(0)
  })

  test('says the link is not valid when the address carries no token', async ({ page }) => {
    await page.goto(AppPaths.dsrVerify)

    await expect(page.getByRole('alert')).toHaveText(en.dsrVerify.invalid)
    await expect(page.getByRole('button')).toHaveCount(0)
  })

  test('sends no Referer and lets no cache or search engine keep the page', async ({ page }) => {
    const response = await page.goto(`${AppPaths.dsrVerify}#token=${UNKNOWN_TOKEN}`)

    expect(response?.headers()['referrer-policy']).toBe('no-referrer')
    expect(response?.headers()['cache-control']).toBe('no-store')
    expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow')
  })
})
