import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, test } from '../support/test'

const MULTI_STORE_USER = personOf('multi', import.meta.url)
const SECOND_STORE = 'Tienda Escalón'

test.describe('a person sees what their permissions allow', () => {
  test('an administrator opens the stores of the organization', async ({ page }) => {
    await signIn(page, personOf('admin', import.meta.url))

    await page.goto(AppPaths.org.stores)

    await expect(page.getByRole('heading', { name: en.org.storesTitle })).toBeVisible()
    await expect(page.getByText('Main Store', { exact: true })).toBeVisible()
  })

  test('a viewer is sent away from the stores of the organization', async ({ page }) => {
    await signIn(page, personOf('viewer', import.meta.url))

    await page.goto(AppPaths.org.stores)

    await expect(page).toHaveURL(AppPaths.noAccess)
    // The viewer has a store: the screen does not say they have none, and offers the way back
    await expect(page.getByRole('heading', { name: en.noAccess.hereTitle })).toBeVisible()
    await expect(page.getByText(en.noAccess.body)).toBeHidden()
    await page.getByRole('button', { name: en.noAccess.goToMyStore }).click()
    await expect(page).toHaveURL(/\/s\/[^/]+\/inbox/)
  })

  test('the address of a store goes to its inbox, and a refused page names what it needs', async ({
    page
  }) => {
    await signIn(page, personOf('viewer', import.meta.url))
    await expect(page).toHaveURL(/\/s\/([^/]+)\/inbox/)
    const storeId = /\/s\/([^/]+)\//.exec(new URL(page.url()).pathname)?.[1] ?? ''

    // `/s/<id>` is no page of its own: it used to answer "not found"
    await page.goto(`/s/${storeId}`)
    await expect(page).toHaveURL(new RegExp(`/s/${storeId}/inbox`))

    // The exports center opens with any of three permissions: the refusal names all three
    await page.goto(AppPaths.store.exports(storeId))
    const names = en.settings.team.permissions
    const refusal = page.getByText(/one of these permissions/i)
    await expect(refusal).toBeVisible()
    for (const name of [
      names.conversations.export,
      names.customers.export,
      names.media.download_all
    ]) {
      await expect(refusal).toContainText(name)
    }
  })

  test('a person in two stores sees both in the switcher', async ({ page }) => {
    await signIn(page, MULTI_STORE_USER)
    await page.goto(AppPaths.org.stores)

    await page.getByRole('button', { name: en.shell.switchStore }).click()

    await expect(page.getByRole('menuitem', { name: /Main Store/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: new RegExp(SECOND_STORE) })).toBeVisible()
  })
})
