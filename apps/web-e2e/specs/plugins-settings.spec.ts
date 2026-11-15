import { randomUUID } from 'node:crypto'

import type { BrowserContext, Page } from '@playwright/test'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { PLUGIN_REVOKE_CONFIRMATION } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addOwnerOfNewStore, removeWidgetPlugin } from '../support/database'
import { expectDialogHoldsItsContent } from '../support/dialog-fit'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const SCREEN = en.settings.plugins
const CONFIRM = en.confirm

// Settings → Plugins (Step 5.6 PR W1): the owner registers a plugin by its manifest, authorizes what it asks for, hands it the one-time
// code, reads its detail and revokes it with the word typed. The plugin has no webhooks, so the install runs no challenge against
// the network. Each dialog must fit a phone (390 px) as well as a desktop.
test.describe('Settings → Plugins', () => {
  test.describe.configure({ mode: 'serial' })

  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-plugins-${run}@example.com`
  const pluginId = `e2e-plugin-${run}`
  const pluginName = `Acme Sync ${run}`
  const manifest = {
    id: pluginId,
    version: '1.0.0',
    name: pluginName,
    description: 'Keeps the orders of the store in the accounting books',
    author: { name: 'Acme Inc', email: 'support@acme-e2e.com' },
    type: 'integration',
    pricing: { model: 'free' },
    scopes: ['orders:read', 'messages:write']
  }
  let context: BrowserContext
  let page: Page
  let storeId = ''

  test.beforeAll(async ({ browser }) => {
    storeId = await addOwnerOfNewStore(ownerEmail, `E2E Plugins ${run}`)
    context = await browser.newContext({ locale: 'en', viewport: { width: 1280, height: 900 } })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.PLUGINS))
    await expect(page.getByRole('heading', { name: SCREEN.title, level: 1 })).toBeVisible()
  })
  test.afterAll(async () => {
    await context.close()
    await removeWidgetPlugin(pluginId)
  })

  const row = () => page.getByRole('listitem').filter({ hasText: pluginName })

  test('registers a plugin by its manifest, and the list shows it', async () => {
    await page.getByRole('button', { name: SCREEN.register.action }).click()
    const dialog = page.getByRole('dialog', { name: SCREEN.register.title })
    await expect(dialog).toBeVisible()
    await expectDialogHoldsItsContent(page, dialog)

    // Not JSON: said at once, nothing is sent
    await dialog.getByLabel(SCREEN.register.manifest).fill('not json')
    await dialog.getByRole('button', { name: SCREEN.register.submit }).click()
    await expect(dialog.getByRole('alert')).toHaveText(SCREEN.register.notJson)

    await dialog.getByLabel(SCREEN.register.manifest).fill(JSON.stringify(manifest))
    await dialog.getByRole('button', { name: SCREEN.register.submit }).click()
    await expect(dialog).toBeHidden()
    await expect(row()).toBeVisible()
    await expect(row().getByRole('button', { name: new RegExp(`^${SCREEN.install.action}`) })).toBeVisible()
  })

  test('asks for the consent of the owner and hands the setup code once', async () => {
    await row().getByRole('button', { name: new RegExp(`^${SCREEN.install.action}`) }).click()
    const consent = page.getByRole('dialog', {
      name: SCREEN.consent.title.replace('{name}', pluginName)
    })
    await expect(consent).toBeVisible()
    // What it asks for, in the words of the store
    await expect(consent.getByText(SCREEN.scopes['orders:read'])).toBeVisible()
    await expect(consent.getByText(SCREEN.scopes['messages:write'])).toBeVisible()
    await expectDialogHoldsItsContent(page, consent)

    await consent.getByRole('button', { name: SCREEN.consent.authorize }).click()
    const code = page.getByTestId('plugin-setup-code')
    await expect(code).toBeVisible()
    await expect(code).toHaveText(/^[A-Za-z0-9_-]{43}$/)
    await expectDialogHoldsItsContent(page, page.getByRole('dialog'))
    await page.getByRole('button', { name: en.common.close }).click()
    await expect(code).toBeHidden()

    // The installation waits for its plugin
    await expect(row()).toContainText(SCREEN.pendingSetup)
  })

  test('shows the detail with the scopes it was granted, and never the key', async () => {
    await row().getByRole('button', { name: new RegExp(`^${SCREEN.detail.action}`) }).click()
    const detail = page.getByRole('dialog', { name: pluginName })
    await expect(detail).toBeVisible()
    await expect(detail.getByText(SCREEN.detail.status.pending_setup)).toBeVisible()
    await expect(detail.getByText(SCREEN.scopes['orders:read'])).toBeVisible()
    await expect(detail.getByText(SCREEN.scopes['messages:write'])).toBeVisible()
    await expect(detail.getByRole('button', { name: SCREEN.detail.newCode })).toBeVisible()
    // The setup code of the earlier dialog is not on this one
    await expect(detail.getByText(/[A-Za-z0-9_-]{43}/)).toHaveCount(0)
    await expectDialogHoldsItsContent(page, detail)
    await page.keyboard.press('Escape')
    await expect(detail).toBeHidden()
  })

  test('revokes only with the word typed, and the plugin can be installed again', async () => {
    await row().getByRole('button', { name: new RegExp(`^${SCREEN.revoke.action}`) }).click()
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(SCREEN.revoke.title.replace('{name}', pluginName))
    const confirm = dialog.getByRole('button', { name: SCREEN.revoke.confirm })
    await expect(confirm).toBeDisabled()
    await expectDialogHoldsItsContent(page, dialog)

    await dialog.getByLabel(CONFIRM.phraseLabel).fill(PLUGIN_REVOKE_CONFIRMATION.toLowerCase())
    await expect(confirm).toBeDisabled()
    await dialog.getByLabel(CONFIRM.phraseLabel).fill(PLUGIN_REVOKE_CONFIRMATION)
    await expect(confirm).toBeEnabled()
    await confirm.click()

    await expect(dialog).toBeHidden()
    await expect(row()).not.toContainText(SCREEN.pendingSetup)
    await expect(row().getByRole('button', { name: new RegExp(`^${SCREEN.install.action}`) })).toBeVisible()

    // The detail reads the revocation at once, with nothing left to do on a revoked installation
    await row().getByRole('button', { name: new RegExp(`^${SCREEN.detail.action}`) }).click()
    const detail = page.getByRole('dialog', { name: pluginName })
    await expect(detail.getByText(SCREEN.detail.status.revoked)).toBeVisible()
    await expect(detail.getByRole('button', { name: SCREEN.detail.newCode })).toHaveCount(0)
  })
})
