import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

test.describe('magic link login', () => {
  test('a person with an account signs in with the link and lands in a store', async ({ page }) => {
    await signIn(page, 'agent@test.com')

    await expect(page).toHaveURL(/\/s\/[^/]+\/inbox$/)
  })

  test('a link works once', async ({ page, browser }) => {
    const token = await signIn(page, 'viewer@test.com')
    // The token is out of the address bar once it is traded
    expect(await page.evaluate(() => window.location.hash)).toBe('')

    const replay = await browser.newContext()
    await reachServicesFromOwnAddress(replay)
    const other = await replay.newPage()
    await other.goto(`${AppPaths.magicLink}#token=${token}`)
    await expect(other.getByRole('heading', { name: en.loginVerify.failedTitle })).toBeVisible()
    await replay.close()
  })

  test('a visitor with no session is sent to the login', async ({ page }) => {
    await page.goto('/org/stores')

    await expect(page).toHaveURL(AppPaths.login)
  })
})
