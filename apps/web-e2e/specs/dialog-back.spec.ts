import { AppPaths, StoreSettingsSections } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const tags = en.settings.tags

// The Back of the browser with a dialog open closes the dialog and keeps the page (TRX-02): the dialog took no
// step of its own in the history, so Back used to leave the page it was on. The case of a dialog that opens
// right after another one closed is in `inbox.spec.ts`.
test.describe.serial('the Back of the browser with a dialog open', () => {
  test('closes the dialog of Settings and stays on the page, and the next Back leaves it', async ({
    page
  }) => {
    await signIn(page, 'admin4@test.com')
    const storeId = await storeIdNamed(FIRST_STORE)
    await page.goto(AppPaths.store.inbox(storeId))
    const tagsPage = AppPaths.store.settings(storeId, StoreSettingsSections.TAGS)
    await page.goto(tagsPage)
    await page.getByRole('button', { name: tags.create }).click()
    const dialog = page.getByRole('dialog', { name: tags.dialog.createTitle })
    await expect(dialog).toBeVisible()

    await page.goBack()
    await expect(dialog).toBeHidden()
    expect(new URL(page.url()).pathname).toBe(tagsPage)

    // With the dialog gone, Back is the Back of the page again
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`${AppPaths.store.inbox(storeId)}`))
  })

  test('a dialog closed with Escape: the next Back still leaves the page in one press', async ({
    page
  }) => {
    await signIn(page, 'admin4@test.com')
    const storeId = await storeIdNamed(FIRST_STORE)
    await page.goto(AppPaths.store.inbox(storeId))
    const tagsPage = AppPaths.store.settings(storeId, StoreSettingsSections.TAGS)
    await page.goto(tagsPage)
    await page.getByRole('button', { name: tags.create }).click()
    const dialog = page.getByRole('dialog', { name: tags.dialog.createTitle })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // The step that the dialog left is skipped: one Back leaves the page
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`${AppPaths.store.inbox(storeId)}`))
  })

  test('a dialog opened after another closed with Escape closes with Back and stays', async ({
    page
  }) => {
    await signIn(page, 'admin4@test.com')
    const storeId = await storeIdNamed(FIRST_STORE)
    await page.goto(AppPaths.store.inbox(storeId))
    const tagsPage = AppPaths.store.settings(storeId, StoreSettingsSections.TAGS)
    await page.goto(tagsPage)
    const dialog = page.getByRole('dialog', { name: tags.dialog.createTitle })

    await page.getByRole('button', { name: tags.create }).click()
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // The second dialog uses the step the first left: its Back closes it and stays
    await page.getByRole('button', { name: tags.create }).click()
    await expect(dialog).toBeVisible()
    await page.goBack()
    await expect(dialog).toBeHidden()
    expect(new URL(page.url()).pathname).toBe(tagsPage)

    // No step is left over it: the next Back leaves the page
    await page.goBack()
    await expect.poll(() => new URL(page.url()).pathname).toBe(AppPaths.store.inbox(storeId))
  })

  test('after a dialog closed and the app navigated, Back returns to the page it was on', async ({
    page
  }) => {
    await signIn(page, 'admin4@test.com')
    const storeId = await storeIdNamed(FIRST_STORE)
    await page.goto(AppPaths.store.inbox(storeId))
    const tagsPage = AppPaths.store.settings(storeId, StoreSettingsSections.TAGS)
    await page.goto(tagsPage)
    await page.getByRole('button', { name: tags.create }).click()
    const dialog = page.getByRole('dialog', { name: tags.dialog.createTitle })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // A client-side navigation (a link of the app), not a new document: the step the dialog left stays behind
    await page
      .getByRole('navigation', { name: en.shell.nav.label })
      .getByRole('link', { name: en.shell.nav.customers })
      .click()
    await expect(page).toHaveURL(new RegExp(`${AppPaths.store.customers(storeId)}$`))
    await page.goBack()
    await expect.poll(() => new URL(page.url()).pathname).toBe(tagsPage)
  })
})
