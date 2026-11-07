import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const MULTI_STORE_USER = 'multi-store@test.com'
const SECOND_STORE = 'Tienda Escalón'

test.describe('a person sees what their permissions allow', () => {
  test('an administrator opens the stores of the organization', async ({ page }) => {
    await signIn(page, 'admin3@test.com')

    await page.goto(AppPaths.org.stores)

    await expect(page.getByRole('heading', { name: en.org.storesTitle })).toBeVisible()
    await expect(page.getByText('Main Store', { exact: true })).toBeVisible()
  })

  test('a viewer is sent away from the stores of the organization', async ({ page }) => {
    await signIn(page, 'viewer@test.com')

    await page.goto(AppPaths.org.stores)

    await expect(page).toHaveURL(AppPaths.noAccess)
    // The viewer has a store: the screen does not say they have none, and offers the way back
    await expect(page.getByRole('heading', { name: en.noAccess.hereTitle })).toBeVisible()
    await expect(page.getByText(en.noAccess.body)).toBeHidden()
    await page.getByRole('button', { name: en.noAccess.goToMyStore }).click()
    await expect(page).toHaveURL(/\/s\/[^/]+\/inbox/)
  })

  test('a person in two stores sees both in the switcher', async ({ page }) => {
    await signIn(page, MULTI_STORE_USER)
    await page.goto(AppPaths.org.stores)

    await page.getByRole('button', { name: en.shell.switchStore }).click()

    await expect(page.getByRole('menuitem', { name: /Main Store/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: new RegExp(SECOND_STORE) })).toBeVisible()
  })
})
