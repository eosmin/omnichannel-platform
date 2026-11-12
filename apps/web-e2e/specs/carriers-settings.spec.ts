import { randomUUID } from 'node:crypto'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addOwnerOfNewStore, addShippingViewer } from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const carriers = en.settings.carriers

// Settings → Carriers, through the screen, with the courier the platform makes the guides for (the fake carrier of the
// shipping specs lives in the api's own tests). Its own store: the cases connect and let go of a carrier.
test.describe('Settings → Carriers', () => {
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-carriers-owner-${run}@example.com`
  const viewerEmail = `e2e-carriers-viewer-${run}@example.com`
  let storeId = ''

  test.beforeAll(async () => {
    storeId = await addOwnerOfNewStore(ownerEmail, `E2E Carriers ${run}`)
    await addShippingViewer(storeId, viewerEmail)
  })

  const settingsPath = (): string =>
    AppPaths.store.settings(storeId, StoreSettingsSections.CARRIERS)

  test('an owner connects a courier, edits its pickup rules, lets it go and renames it', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    // Shipping is installed in the store first, as the owner does in Plugins: a carrier cannot be connected before
    await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.PLUGINS))
    const shipping = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: 'Shipping' }) })
    await shipping.getByRole('button', { name: en.settings.plugins.install.action }).click()
    await expect(shipping.getByText(en.settings.plugins.installed)).toBeVisible()
    await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.GENERAL))
    await page
      .getByRole('navigation', { name: en.settings.nav.store.label })
      .getByRole('link', { name: en.settings.nav.store.carriers })
      .click()
    await expect(page).toHaveURL(new RegExp(`${settingsPath()}$`))
    await expect(page.getByRole('heading', { name: carriers.title, level: 1 })).toBeVisible()
    await expect(page.getByText(carriers.empty.title)).toBeVisible()

    // Connect: a courier the platform makes the guides for asks for its name, phone and prefix, and refuses an empty form
    await page.getByRole('button', { name: carriers.add }).click()
    const dialog = page.getByRole('dialog', { name: carriers.connect.title })
    await dialog.getByRole('button', { name: carriers.connect.submit }).click()
    await expect(dialog.getByRole('alert').first()).toBeVisible()
    await dialog.getByLabel(carriers.connect.courierName).fill('Juan Messenger')
    await dialog.getByLabel(carriers.connect.courierPhone).fill('5551234567')
    await dialog.getByLabel(carriers.connect.courierPrefix).fill('jm')
    await dialog.getByLabel(carriers.connect.displayName).fill('Juan local')
    await dialog.getByRole('button', { name: carriers.connect.submit }).click()

    const card = page.getByTestId('carrier-card').filter({ hasText: 'Juan local' })
    await expect(card).toBeVisible()
    await expect(card.getByText(carriers.card.status.active)).toBeVisible()

    // Edit: turn pickups on with two days and a cutoff; only what changed is sent
    await card.getByRole('button', { name: carriers.card.edit }).click()
    const rules = page.getByRole('dialog', { name: /Juan local/ })
    await rules.getByRole('checkbox', { name: carriers.rules.pickup.enabled }).check()
    await rules.getByRole('checkbox', { name: carriers.rules.pickup.weekdays['1'] }).check()
    await rules.getByRole('checkbox', { name: carriers.rules.pickup.weekdays['3'] }).check()
    await rules.getByLabel(carriers.rules.pickup.cutoff).fill('15:00')
    // The shipping settings: who pays, the usual fee and the attempts; a fee range that does not hold is refused first
    await rules.getByLabel(carriers.rules.shipping.payer).selectOption('recipient')
    await rules.getByLabel(carriers.rules.shipping.fees.default).fill('9')
    await rules.getByLabel(carriers.rules.shipping.fees.max).fill('5')
    await rules.getByRole('button', { name: carriers.rules.save }).click()
    await expect(rules.getByRole('alert').getByText(carriers.rules.problems.feeRange)).toBeVisible()
    await rules.getByLabel(carriers.rules.shipping.fees.max).fill('12')
    await rules.getByLabel(carriers.rules.shipping.attempts).fill('5')
    await rules.getByRole('button', { name: carriers.rules.save }).click()
    await expect(page.getByText('Juan local').first()).toBeVisible()
    await expect(rules).toHaveCount(0)

    // What was saved is what comes back when the dialog is opened again (fees travel as cents and come back as dollars)
    await card.getByRole('button', { name: carriers.card.edit }).click()
    const reopened = page.getByRole('dialog', { name: /Juan local/ })
    await expect(reopened.getByLabel(carriers.rules.shipping.payer)).toHaveValue('recipient')
    await expect(reopened.getByLabel(carriers.rules.shipping.fees.default)).toHaveValue('9.00')
    await expect(reopened.getByLabel(carriers.rules.shipping.fees.max)).toHaveValue('12.00')
    await expect(reopened.getByLabel(carriers.rules.shipping.attempts)).toHaveValue('5')
    await reopened.getByRole('button', { name: en.common.cancel }).click()
    await expect(reopened).toHaveCount(0)

    // The status mapping tab: nothing waits and nothing is mapped for a courier that sends no statuses
    await page.getByRole('tab', { name: carriers.sections.mapping }).click()
    await expect(page.getByText(carriers.mapping.waiting.none)).toBeVisible()
    await page.getByRole('tab', { name: carriers.sections.connections }).click()

    // Disconnect: the warning names what is open, and the connection moves to the disconnected list
    await card.getByRole('button', { name: carriers.card.disconnect.action }).click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: carriers.card.disconnect.confirm })
      .click()
    await expect(page.getByTestId('carrier-card')).toHaveCount(0)
    await page.getByRole('button', { name: /Show 1 disconnected carrier/ }).click()
    const past = page.getByTestId('carrier-card').filter({ hasText: 'Juan local' })
    await expect(past.getByText(carriers.card.disconnectedNote)).toBeVisible()

    // A connection that was let go takes only a new name, which frees the old one
    await past.getByRole('button', { name: carriers.card.rename }).click()
    const renaming = page.getByRole('dialog', { name: /Juan local/ })
    await expect(renaming.getByRole('checkbox')).toHaveCount(0)
    await renaming.getByLabel(carriers.rules.name).fill('Juan local (old)')
    await renaming.getByRole('button', { name: carriers.rules.save }).click()
    await expect(page.getByText('Juan local (old)').first()).toBeVisible()
  })

  test('a person who may only look sees the connections and no controls', async ({ page }) => {
    await signIn(page, viewerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(settingsPath())
    await expect(page.getByRole('heading', { name: carriers.title, level: 1 })).toBeVisible()
    await expect(page.getByRole('button', { name: carriers.add })).toHaveCount(0)
  })
})
