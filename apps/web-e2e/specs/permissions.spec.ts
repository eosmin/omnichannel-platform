import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const MULTI_STORE_USER = 'multi-store@test.com'
const SECOND_STORE = 'Tienda Escalón'

test.describe('a person sees what their permissions allow', () => {
  test('an administrator opens the stores of the organization', async ({ page }) => {
    await signIn(page, 'admin@test.com')

    await page.goto(AppPaths.org.stores)

    await expect(page.getByRole('heading', { name: en.org.storesTitle })).toBeVisible()
    await expect(page.getByText('Main Store', { exact: true })).toBeVisible()
  })

  test('a viewer is sent away from the stores of the organization', async ({ page }) => {
    await signIn(page, 'viewer@test.com')

    await page.goto(AppPaths.org.stores)

    await expect(page).toHaveURL(AppPaths.noAccess)
    await expect(page.getByRole('heading', { name: en.noAccess.title })).toBeVisible()
  })

  test('a person in two stores sees both in the switcher', async ({ page }) => {
    await signIn(page, MULTI_STORE_USER)
    await page.goto(AppPaths.org.stores)

    await page.getByRole('button', { name: en.shell.switchStore }).click()

    await expect(page.getByRole('menuitem', { name: /Main Store/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: new RegExp(SECOND_STORE) })).toBeVisible()
  })
})
