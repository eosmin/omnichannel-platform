import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import {
  AppPaths,
  type CarrierRegistryEntryView,
  StoreSettingsSections
} from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'
import { CARRIER_WEBHOOK_SECRET_HEADER, CarrierCapability, CarrierId } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addCarrierConnectionTo, addOwnerOfNewStore, addShippingViewer } from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const carriers = en.settings.carriers

// The text a plugin names a field of its form with: a message key of the settings section, read in English
function textOf(key: string | null): string {
  const found = (key ?? '')
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en
    )
  if (typeof found !== 'string') throw new Error(`no message for ${key}`)
  return found
}

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
    // The registry holds more than one carrier, so the owner picks the courier the platform makes the guides for
    await dialog.getByLabel(carriers.connect.carrier).selectOption(CarrierId.LOCAL)
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
    // The contact and the prefix of a courier the platform makes the guides for are edited here, and only what changed is sent
    await expect(reopened.getByLabel(carriers.rules.courier.phone)).toHaveValue('5551234567')
    await expect(reopened.getByLabel(carriers.rules.courier.prefix)).toHaveValue('JM')
    await reopened.getByLabel(carriers.rules.courier.phone).fill('5557654321')
    await reopened.getByLabel(carriers.rules.courier.prefix).fill('ab')
    await reopened.getByRole('button', { name: carriers.rules.save }).click()
    await expect(reopened).toHaveCount(0)
    await card.getByRole('button', { name: carriers.card.edit }).click()
    const contact = page.getByRole('dialog', { name: /Juan local/ })
    await expect(contact.getByLabel(carriers.rules.courier.phone)).toHaveValue('5557654321')
    await expect(contact.getByLabel(carriers.rules.courier.prefix)).toHaveValue('AB')
    await contact.getByLabel(carriers.rules.courier.prefix).fill('')
    await contact.getByRole('button', { name: carriers.rules.save }).click()
    await expect(
      contact.getByRole('alert').getByText(carriers.rules.problems.courierPrefix)
    ).toBeVisible()
    await contact.getByRole('button', { name: en.common.cancel }).click()
    await expect(contact).toHaveCount(0)

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
  // The cases below use a carrier that declares its form and pushes statuses; which one is read from the registry the page
  // loads, so the spec names none
  test.describe('a carrier that declares its form and pushes statuses', () => {
    // The cases depend on each other (the first reads the carrier, the second seeds its connection): one group, in order
    test.describe.configure({ mode: 'serial' })
    let pushingId = ''
    let removeConnection: () => Promise<void> = () => Promise.resolve()

    const readRegistry = async (page: Page): Promise<CarrierRegistryEntryView> => {
      const answered = page.waitForResponse(
        response => response.url().endsWith(ApiRoutes.carriers.registry) && response.ok()
      )
      await page.goto(settingsPath())
      const registry = (await (await answered).json()) as CarrierRegistryEntryView[]
      const found = registry.find(
        entry =>
          entry.connectFields.some(field => field.required) &&
          entry.capabilities.includes(CarrierCapability.WEBHOOK_STATUS)
      )
      if (found === undefined)
        throw new Error('the registry offers no carrier that pushes statuses')
      return found
    }

    test('the connect form is drawn from what the carrier declares, with its secrets masked', async ({
      page
    }) => {
      await signIn(page, ownerEmail)
      await page.waitForURL(/\/s\/[^/]+\//)
      const entry = await readRegistry(page)
      pushingId = entry.id
      await page.getByRole('button', { name: carriers.add }).click()
      const dialog = page.getByRole('dialog', { name: carriers.connect.title })
      await dialog.getByLabel(carriers.connect.carrier).selectOption(entry.id)
      // The JSON box is gone: every declared field has its own input, and a secret is a password input
      await expect(dialog.getByLabel(carriers.connect.credentials)).toHaveCount(0)
      for (const field of entry.connectFields) {
        const input = dialog.getByLabel(textOf(field.labelKey), { exact: true })
        await expect(input).toBeVisible()
        await expect(input).toHaveAttribute('type', field.secret ? 'password' : 'text')
      }
      // A required field left empty is refused before any request
      await dialog.getByRole('button', { name: carriers.connect.submit }).click()
      await expect(
        dialog.getByRole('alert').getByText(carriers.connect.problems.fields)
      ).toBeVisible()
      await dialog.getByRole('button', { name: en.common.cancel }).click()
    })

    test('the owner reads where the notices go, and the status mapping offers the codes with no decision', async ({
      page
    }) => {
      // A retry of this case must not leave the first connection behind
      await removeConnection()
      removeConnection = await addCarrierConnectionTo(storeId, pushingId, `Pushing ${run}`)
      await signIn(page, ownerEmail)
      await page.waitForURL(/\/s\/[^/]+\//)
      await page.goto(settingsPath())
      const card = page.getByTestId('carrier-card').filter({ hasText: `Pushing ${run}` })
      // How to register the notices: the header name sits next to the address, and the secret is never in the page
      await expect(card.getByTestId('carrier-webhook-header')).toHaveText(
        CARRIER_WEBHOOK_SECRET_HEADER
      )
      await expect(card.getByText(carriers.card.webhook.howTo)).toBeVisible()
      await expect(card.getByTestId('carrier-webhook-secret')).toHaveCount(0)

      // A new secret is shown once, with the header, in a dialog that only its button closes
      await card.getByRole('button', { name: carriers.card.rotate.action }).click()
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: carriers.card.rotate.confirm })
        .click()
      const secret = page.getByRole('dialog', { name: /Secret for the notices of/ })
      await expect(secret.getByTestId('carrier-webhook-secret')).not.toHaveText('')
      await expect(secret.getByTestId('carrier-webhook-header')).toHaveText(
        CARRIER_WEBHOOK_SECRET_HEADER
      )
      await secret.getByRole('button', { name: en.common.close }).click()
      await expect(secret).toHaveCount(0)
      await page.reload()
      await expect(
        page
          .getByTestId('carrier-card')
          .filter({ hasText: `Pushing ${run}` })
          .getByTestId('carrier-webhook-secret')
      ).toHaveCount(0)

      // The mapping lists the codes of the plugin that have no row; deciding one moves it to the mapped table
      await page.getByRole('tab', { name: carriers.sections.mapping }).click()
      const offered = page.getByTestId('catalog-status')
      await expect(
        page.getByRole('heading', { name: carriers.mapping.catalog.title })
      ).toBeVisible()
      const before = await offered.count()
      expect(before).toBeGreaterThan(0)
      const first = offered.first()
      const decided = (await first.locator('span').first().textContent()) ?? ''
      expect(decided).not.toBe('')
      await first.getByRole('combobox').selectOption('delivered')
      await first.getByRole('button', { name: carriers.mapping.waiting.apply }).click()
      await expect(offered).toHaveCount(before - 1)
      await expect(
        page
          .getByRole('list', { name: carriers.mapping.table.title })
          .getByRole('listitem')
          .filter({ hasText: decided })
          .getByText(carriers.mapping.table.custom)
      ).toBeVisible()
    })

    test('the owner agrees a commission and a rate per service, drawn from what the carrier declares', async ({
      page
    }) => {
      await signIn(page, ownerEmail)
      await page.waitForURL(/\/s\/[^/]+\//)
      await page.goto(settingsPath())
      const card = page.getByTestId('carrier-card').filter({ hasText: `Pushing ${run}` })
      await card.getByRole('button', { name: carriers.card.edit }).click()
      const rules = page.getByRole('dialog', { name: new RegExp(`Pushing ${run}`) })
      const group = rules.getByRole('group', { name: carriers.fees.legend })
      const commission = group.getByLabel(carriers.fees.commission)
      // The first box of the group is the commission, the others are one price per service the carrier declares
      const firstRate = group.getByRole('textbox').nth(1)
      await expect(commission).toBeVisible()
      await expect(firstRate).toBeVisible()
      // Nothing is agreed yet
      await expect(commission).toHaveValue('')
      // What is not a percent or a price is refused before any request. Save is only on when something valid changed, so another
      // setting is changed first, as the case of the fee range does
      await rules.getByLabel(carriers.rules.shipping.attempts).fill('5')
      await commission.fill('abc')
      await rules.getByRole('button', { name: carriers.rules.save }).click()
      await expect(
        rules.getByRole('alert').getByText(carriers.rules.problems.commission)
      ).toBeVisible()
      await commission.fill('4,5')
      await firstRate.fill('x')
      await rules.getByRole('button', { name: carriers.rules.save }).click()
      await expect(rules.getByRole('alert').getByText(carriers.rules.problems.rates)).toBeVisible()
      await firstRate.fill('3.5')
      // The units that travel: basis points and cents
      const sent = page.waitForRequest(
        request => request.method() === 'PATCH' && request.url().includes('/carriers/')
      )
      await rules.getByRole('button', { name: carriers.rules.save }).click()
      const body = (await sent).postDataJSON() as {
        commissionBps: number
        serviceRatesCents: Record<string, number>
      }
      expect(body.commissionBps).toBe(450)
      expect(Object.values(body.serviceRatesCents)).toEqual([350])
      await expect(rules).toHaveCount(0)

      // What was agreed comes back as a percent with a point and a price in dollars
      await card.getByRole('button', { name: carriers.card.edit }).click()
      const reopened = page.getByRole('dialog', { name: new RegExp(`Pushing ${run}`) })
      const again = reopened.getByRole('group', { name: carriers.fees.legend })
      await expect(again.getByLabel(carriers.fees.commission)).toHaveValue('4.5')
      await expect(again.getByRole('textbox').nth(1)).toHaveValue('3.50')
    })

    test('a person who may only look sees the notice address and the codes, with no control to change them', async ({
      page
    }) => {
      await signIn(page, viewerEmail)
      await page.waitForURL(/\/s\/[^/]+\//)
      await page.goto(settingsPath())
      const card = page.getByTestId('carrier-card').filter({ hasText: `Pushing ${run}` })
      await expect(card).toBeVisible()
      await expect(card.getByTestId('carrier-webhook-header')).toHaveText(
        CARRIER_WEBHOOK_SECRET_HEADER
      )
      await expect(card.getByRole('button', { name: carriers.card.rotate.action })).toHaveCount(0)
      await expect(card.getByRole('button', { name: carriers.card.edit })).toHaveCount(0)
      await page.getByRole('tab', { name: carriers.sections.mapping }).click()
      await expect(
        page.getByRole('heading', { name: carriers.mapping.catalog.title })
      ).toBeVisible()
      await expect(page.getByTestId('catalog-status').first()).toBeVisible()
      await expect(page.getByTestId('catalog-status').getByRole('combobox')).toHaveCount(0)
      await expect(page.getByRole('button', { name: carriers.mapping.waiting.apply })).toHaveCount(
        0
      )
    })

    test.afterAll(async () => {
      await removeConnection()
    })
  })
})
