import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { expectDialogFitsThePhoneWidth } from '../support/dialog-fit'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const ADMIN = personOf('admin', import.meta.url)
const VIEWER = personOf('viewer', import.meta.url)
const AGENT = personOf('agent', import.meta.url)

const newStoreName = (): string => `E2E Shop ${randomUUID().slice(0, 8)}`

async function createStoreNamed(page: Page, name: string): Promise<void> {
  await page.goto(AppPaths.org.stores)
  await page.getByRole('button', { name: en.org.newStore }).click()
  const dialog = page.getByRole('dialog', { name: en.org.create.title })
  await dialog.getByLabel(en.settings.store.name).fill(name)
  await expectDialogFitsThePhoneWidth(page, dialog)
  await dialog.getByRole('button', { name: en.org.create.submit }).click()
  await expect(page.getByText(name, { exact: true })).toBeVisible()
}

test.describe('the stores of the organization', () => {
  test('an administrator creates a store, renames it, changes its settings and deletes it', async ({
    page
  }) => {
    const name = newStoreName()
    const renamed = `${name} B`
    await signIn(page, ADMIN)
    await createStoreNamed(page, name)

    await page.getByRole('button', { name: `${en.org.rename.action} ${name}` }).click()
    const renameDialog = page.getByRole('dialog', { name: en.org.rename.title })
    await renameDialog.getByLabel(en.org.rename.name).fill(renamed)
    await expectDialogFitsThePhoneWidth(page, renameDialog)
    await renameDialog.getByRole('button', { name: en.common.save }).click()
    await expect(page.getByText(renamed, { exact: true })).toBeVisible()

    // The settings of the new store: the administrator who created it belongs to it
    await page.getByRole('link', { name: `${en.org.settings} ${renamed}` }).click()
    await expect(page).toHaveURL(/\/settings\/general$/)
    await page.getByLabel(en.settings.store.currency).selectOption('EUR')
    await page.getByRole('button', { name: en.common.save }).click()
    await expect(page.getByText(en.settings.store.saved)).toBeVisible()
    await page.reload()
    await expect(page.getByLabel(en.settings.store.currency)).toHaveValue('EUR')

    await page.goto(AppPaths.org.stores)
    await page.getByRole('button', { name: `${en.org.delete.action} ${renamed}` }).click()
    const confirm = page.getByRole('alertdialog')
    await expectDialogFitsThePhoneWidth(page, confirm)
    // The confirm button waits for the exact name of the store
    await expect(confirm.getByRole('button', { name: en.org.delete.confirm })).toBeDisabled()
    await confirm.getByLabel(en.confirm.phraseLabel).fill(renamed)
    await confirm.getByRole('button', { name: en.org.delete.confirm }).click()
    await expect(page.getByText(renamed, { exact: true })).toHaveCount(0)
  })

  test('the organization profile is read and renamed by who may edit settings', async ({
    page
  }) => {
    await signIn(page, ADMIN)
    await page.goto(AppPaths.org.profile)

    const nameField = page.getByLabel(en.settings.organization.name)
    await expect(nameField).toBeEnabled()
    await expect(page.getByRole('navigation', { name: en.settings.nav.org.label })).toBeVisible()
    // Saving needs a change
    await expect(page.getByRole('button', { name: en.common.save })).toBeDisabled()

    const original = await nameField.inputValue()
    await nameField.fill(`${original} Z`)
    await page.getByRole('button', { name: en.common.save }).click()
    await expect(page.getByText(en.settings.organization.saved)).toBeVisible()
    await page.reload()
    await expect(nameField).toHaveValue(`${original} Z`)

    // Back to how the fixtures have it
    await nameField.fill(original)
    await page.getByRole('button', { name: en.common.save }).click()
    await page.reload()
    await expect(nameField).toHaveValue(original)
  })
})

test.describe('the settings of a store follow the permissions', () => {
  test('a viewer has no settings entry and is told so on the page', async ({ page }) => {
    await signIn(page, VIEWER)
    await page.waitForURL(/\/s\/[^/]+\/inbox/)
    const storeId = /\/s\/([^/]+)\//.exec(new URL(page.url()).pathname)?.[1]
    expect(storeId).toBeDefined()

    await expect(
      page.getByRole('navigation', { name: en.shell.nav.label }).getByRole('link', {
        name: en.shell.nav.settings
      })
    ).toHaveCount(0)
    await page.goto(AppPaths.store.settings(storeId ?? ''))
    await expect(
      page.getByRole('heading', { name: en.emptyStates.permissionDenied.title })
    ).toBeVisible()
  })

  test('an administrator reaches the settings from the store navigation', async ({ page }) => {
    await signIn(page, ADMIN)

    await page
      .getByRole('navigation', { name: en.shell.nav.label })
      .getByRole('link', { name: en.shell.nav.settings })
      .click()

    await expect(page).toHaveURL(/\/settings\/general$/)
    await expect(page.getByRole('heading', { name: en.settings.store.title })).toBeVisible()
  })
})

test.describe('my account', () => {
  test('the preferences are saved and are there after a reload', async ({ page }) => {
    await signIn(page, AGENT)
    await page.goto(AppPaths.account.preferences)

    await page.getByLabel(en.account.preferences.density).selectOption('compact')
    await page.getByRole('button', { name: en.common.save }).click()
    await expect(page.getByText(en.account.preferences.saved)).toBeVisible()
    await page.reload()
    await expect(page.getByLabel(en.account.preferences.density)).toHaveValue('compact')

    // Back to how the fixtures have it
    await page.getByLabel(en.account.preferences.density).selectOption('comfortable')
    await page.getByRole('button', { name: en.common.save }).click()
    await expect(page.getByText(en.account.preferences.saved)).toBeVisible()
  })

  // A viewer holds no permission to upload to the store, and still sets a picture: it belongs to the
  // person. The e2e stack has an antivirus (the composer cases need it), so the picture is "getting
  // ready" for a moment and then shows; either is the right state, and a refusal is not. The pipeline
  // itself is tested in tests/api/account.spec.ts and the worker's media-pipeline suite.
  test('a viewer uploads a picture, it is being prepared, and takes it away', async ({ page }) => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64'
    )
    await signIn(page, VIEWER)
    await page.goto(AppPaths.account.profile)
    await expect(page.getByRole('button', { name: en.account.profile.avatar.remove })).toHaveCount(
      0
    )

    await page
      .getByTestId('avatar-input')
      .setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png })
    await expect(page.getByText(en.account.profile.avatar.uploaded)).toBeVisible()
    const avatar = en.account.profile.avatar
    const preparingOrShown = page
      .getByText(avatar.processing)
      .or(page.getByRole('img', { name: avatar.alt }))
    await expect(preparingOrShown).toBeVisible()
    await page.reload()
    await expect(preparingOrShown).toBeVisible()
    await expect(page.getByText(avatar.refused)).toHaveCount(0)

    await page.getByRole('button', { name: en.account.profile.avatar.remove }).click()
    await expect(page.getByText(en.account.profile.avatar.removed)).toBeVisible()
    // No row is left to start the next run with a picture
    await page.reload()
    await expect(page.getByRole('button', { name: en.account.profile.avatar.remove })).toHaveCount(
      0
    )
  })

  test('the name is changed and shown in the top bar', async ({ page }) => {
    await signIn(page, AGENT)
    await page.goto(AppPaths.account.profile)
    const nameField = page.getByLabel(en.account.name)
    const original = await nameField.inputValue()

    await nameField.fill(`${original} Z`)
    await page.getByRole('button', { name: en.common.save }).click()
    await expect(page.getByText(en.account.profile.saved)).toBeVisible()
    await expect(page.getByText(`${original} Z`, { exact: true }).first()).toBeVisible()

    await nameField.fill(original)
    await page.getByRole('button', { name: en.common.save }).click()
    await expect(page.getByText(en.account.profile.saved)).toBeVisible()
  })

  test('another device is signed out from the list of sessions', async ({ page, browser }) => {
    await signIn(page, AGENT)
    const other = await browser.newContext()
    await reachServicesFromOwnAddress(other)
    const otherPage = await other.newPage()
    await signIn(otherPage, AGENT)

    await page.goto(AppPaths.account.security)
    await expect(page.getByText(en.account.security.thisDevice)).toHaveCount(1)
    const revoke = page.getByRole('button', { name: new RegExp(en.account.security.revoke) })
    const before = await revoke.count()
    expect(before).toBeGreaterThan(0)

    await revoke.first().click()

    await expect(page.getByText(en.account.security.revoked)).toBeVisible()
    await expect(revoke).toHaveCount(before - 1)
    await other.close()
  })
})
