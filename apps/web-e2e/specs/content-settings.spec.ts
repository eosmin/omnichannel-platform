import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import { AppPaths, type StoreSettingsSection, StoreSettingsSections } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const tags = en.settings.tags
const snippets = en.settings.snippets
const inbox = en.settings.inbox

function storeIdOf(page: Page): string {
  const storeId = /\/s\/([^/]+)\//.exec(new URL(page.url()).pathname)?.[1]
  expect(storeId).toBeDefined()
  return storeId ?? ''
}

async function openSection(page: Page, section: StoreSettingsSection): Promise<void> {
  await page.goto(AppPaths.store.settings(storeIdOf(page), section))
}

test.describe('Settings → Tags, Snippets and Inbox behavior', () => {
  test('an administrator makes, edits and deletes a tag', async ({ page }) => {
    const name = `E2E tag ${randomUUID().slice(0, 8)}`
    await signIn(page, 'admin@test.com')
    await page.waitForURL(/\/s\/[^/]+\/inbox/)
    await openSection(page, StoreSettingsSections.TAGS)
    await expect(page.getByRole('heading', { name: tags.title, level: 1 })).toBeVisible()

    // A tag with no name is refused before the request
    await page.getByRole('button', { name: tags.create }).click()
    const dialog = page.getByRole('dialog', { name: tags.dialog.createTitle })
    await dialog.getByRole('button', { name: tags.dialog.save }).click()
    await expect(dialog.getByText(tags.dialog.problems.nameRequired)).toBeVisible()

    await dialog.getByLabel(tags.dialog.name, { exact: true }).fill(name)
    await dialog.getByRole('button', { name: tags.dialog.save }).click()
    const row = page.getByRole('listitem').filter({ hasText: name })
    await expect(row).toBeVisible()

    // A second tag with the same name is refused by the api, and the dialog says so
    await page.getByRole('button', { name: tags.create }).click()
    await dialog.getByLabel(tags.dialog.name, { exact: true }).fill(name.toUpperCase())
    await dialog.getByRole('button', { name: tags.dialog.save }).click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    await dialog.getByRole('button', { name: en.common.cancel }).click()

    // Edit: the description appears next to the tag and stays after a reload
    await row.getByRole('button', { name: tags.edit }).click()
    const edit = page.getByRole('dialog', { name: tags.dialog.editTitle })
    await edit.getByLabel(tags.dialog.descriptionLabel).fill('Top customers')
    await edit.getByRole('button', { name: tags.dialog.save }).click()
    await page.reload()
    await expect(page.getByRole('listitem').filter({ hasText: name })).toContainText(
      'Top customers'
    )

    // Deleting asks first
    await page
      .getByRole('listitem')
      .filter({ hasText: name })
      .getByRole('button', { name: tags.delete.action })
      .click()
    await page.getByRole('alertdialog').getByRole('button', { name: tags.delete.confirm }).click()
    await expect(page.getByRole('heading', { name })).toHaveCount(0)
  })

  test('an administrator makes, edits and deletes a snippet', async ({ page }) => {
    const suffix = randomUUID().slice(0, 8)
    const title = `E2E snippet ${suffix}`
    await signIn(page, 'admin@test.com')
    await page.waitForURL(/\/s\/[^/]+\/inbox/)
    await openSection(page, StoreSettingsSections.SNIPPETS)
    await expect(page.getByRole('heading', { name: snippets.title, level: 1 })).toBeVisible()
    // The MVP has no AI: nothing on the page offers it
    await expect(page.getByText(/approved for AI/i)).toHaveCount(0)

    await page.getByRole('button', { name: snippets.create }).click()
    const dialog = page.getByRole('dialog', { name: snippets.dialog.createTitle })
    await dialog.getByRole('button', { name: snippets.dialog.save }).click()
    await expect(dialog.getByText(snippets.dialog.problems.shortcutRequired)).toBeVisible()
    await dialog.getByLabel(snippets.dialog.shortcut).fill(`/E2E-${suffix}`)
    await dialog.getByLabel(snippets.dialog.titleLabel).fill(title)
    await dialog.getByLabel(snippets.dialog.content).fill('Thank you for writing')
    await dialog.getByRole('button', { name: snippets.dialog.save }).click()

    // The shortcut is kept in lowercase, without the slash typed
    const row = page.getByRole('listitem').filter({ hasText: title })
    await expect(row).toContainText(`/e2e-${suffix}`)

    await row.getByRole('button', { name: snippets.edit }).click()
    const edit = page.getByRole('dialog', { name: snippets.dialog.editTitle })
    await edit.getByLabel(snippets.dialog.content).fill('Thanks a lot')
    await edit.getByRole('button', { name: snippets.dialog.save }).click()
    await page.reload()
    await expect(page.getByRole('listitem').filter({ hasText: title })).toContainText(
      'Thanks a lot'
    )

    await page
      .getByRole('listitem')
      .filter({ hasText: title })
      .getByRole('button', { name: snippets.delete.action })
      .click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: snippets.delete.confirm })
      .click()
    await expect(page.getByRole('heading', { name: new RegExp(title) })).toHaveCount(0)
  })

  test('an administrator changes the inbox behavior and the read receipts, and they stay', async ({
    page
  }) => {
    await signIn(page, 'admin@test.com')
    await page.waitForURL(/\/s\/[^/]+\/inbox/)
    await openSection(page, StoreSettingsSections.INBOX)
    await expect(page.getByRole('heading', { name: inbox.title, level: 1 })).toBeVisible()

    const behavior = page.getByRole('form', { name: inbox.behaviorLabel })
    const archive = behavior.getByLabel(inbox.archive.days)
    const original = await archive.inputValue()

    // A number outside the limits is refused before the request
    await archive.fill('0')
    await behavior.getByRole('button', { name: inbox.save }).click()
    await expect(behavior.getByText(inbox.problems.archiveDays)).toBeVisible()

    await archive.fill('45')
    await behavior.getByRole('button', { name: inbox.save }).click()
    await expect(page.getByText(inbox.saved)).toBeVisible()

    const receipts = page.getByRole('form', { name: inbox.receipts.label })
    const box = receipts.getByRole('checkbox')
    const receiptsWere = await box.isChecked()
    await box.setChecked(!receiptsWere)
    await receipts.getByRole('button', { name: inbox.receipts.save }).click()
    await expect(page.getByText(inbox.receipts.saved)).toBeVisible()

    await page.reload()
    await expect(
      page.getByRole('form', { name: inbox.behaviorLabel }).getByLabel(inbox.archive.days)
    ).toHaveValue('45')
    await expect(
      page.getByRole('form', { name: inbox.receipts.label }).getByRole('checkbox')
    ).toBeChecked({ checked: !receiptsWere })

    // Put both back: the other specs share this store
    await page
      .getByRole('form', { name: inbox.behaviorLabel })
      .getByLabel(inbox.archive.days)
      .fill(original)
    await page
      .getByRole('form', { name: inbox.behaviorLabel })
      .getByRole('button', { name: inbox.save })
      .click()
    await expect(page.getByText(inbox.saved).first()).toBeVisible()
    await page
      .getByRole('form', { name: inbox.receipts.label })
      .getByRole('checkbox')
      .setChecked(receiptsWere)
    await page
      .getByRole('form', { name: inbox.receipts.label })
      .getByRole('button', { name: inbox.receipts.save })
      .click()
    await expect(page.getByText(inbox.receipts.saved).first()).toBeVisible()
  })

  test('a viewer reads tags and snippets without any action, and cannot open the inbox settings', async ({
    page
  }) => {
    await signIn(page, 'viewer@test.com')
    await page.waitForURL(/\/s\/[^/]+\//)
    await openSection(page, StoreSettingsSections.TAGS)
    await expect(page.getByRole('heading', { name: tags.title, level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: tags.create })).toHaveCount(0)
    await expect(page.getByRole('button', { name: tags.edit })).toHaveCount(0)

    await openSection(page, StoreSettingsSections.SNIPPETS)
    await expect(page.getByRole('heading', { name: snippets.title, level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: snippets.create })).toHaveCount(0)

    await openSection(page, StoreSettingsSections.INBOX)
    await expect(
      page.getByRole('heading', { name: en.emptyStates.permissionDenied.title })
    ).toBeVisible()
  })
})
