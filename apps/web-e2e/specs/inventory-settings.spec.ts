import { randomUUID } from 'node:crypto'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { API_PREFIX, ApiRoutes } from '@platform/core/api'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addOwnerOfNewStore,
  addReadOnlySettingsUser,
  inventorySettingsOf,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const inventory = en.settings.inventory
const PHONE = { width: 360, height: 740 }

// Settings → Inventory, through the screen. Its own file and its own store: the cases change the switches of a
// store, and the stores that the other specs share must not be the ones that change.
test.describe('Settings → Inventory', () => {
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-inventory-owner-${run}@example.com`
  let storeId = ''

  test.beforeAll(async () => {
    storeId = await addOwnerOfNewStore(ownerEmail, `E2E Inventory ${run}`)
  })

  const settingsPath = (): string =>
    AppPaths.store.settings(storeId, StoreSettingsSections.INVENTORY)

  test('an administrator turns on negative stock, sets a default threshold and clears it', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    // The page is reached from the navigation of Settings, not only by its address
    await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.GENERAL))
    await page
      .getByRole('navigation', { name: en.settings.nav.store.label })
      .getByRole('link', { name: en.settings.nav.store.inventory })
      .click()
    await expect(page).toHaveURL(new RegExp(`${settingsPath()}$`))
    await expect(page.getByRole('heading', { name: inventory.title, level: 1 })).toBeVisible()

    // The factory state of a store: both switches off, no default threshold
    const negative = page.getByRole('checkbox', { name: inventory.negative.switch })
    const split = page.getByRole('checkbox', { name: inventory.split.switch })
    const threshold = page.getByLabel(inventory.threshold.label)
    const save = page.getByRole('button', { name: inventory.save })
    await expect(negative).not.toBeChecked()
    await expect(split).not.toBeChecked()
    await expect(threshold).toHaveValue('')
    // Nothing to save yet, and the warning of selling without stock is not shown
    await expect(save).toBeDisabled()
    await expect(page.getByText(inventory.negative.warning)).toHaveCount(0)

    // A threshold that is not a whole number is refused before any request
    const patches: unknown[] = []
    await page.route(
      url => url.pathname === `${API_PREFIX}${ApiRoutes.settings.inventory}`,
      route => {
        if (route.request().method() === 'PATCH') patches.push(route.request().postDataJSON())
        void route.continue()
      }
    )
    await threshold.fill('abc')
    await save.click()
    await expect(page.getByRole('alert').getByText(inventory.problems.threshold)).toBeVisible()
    expect(patches).toHaveLength(0)

    // Turning negative stock on explains what it does, and the save sends only what changed
    await negative.check()
    await expect(page.getByText(inventory.negative.warning)).toBeVisible()
    await threshold.fill('5')
    await save.click()
    await expect(page.getByText(inventory.saved).first()).toBeVisible()
    expect(patches).toEqual([{ allowNegativeStock: true, defaultLowStockThreshold: 5 }])
    expect(await inventorySettingsOf(storeId)).toEqual({
      allowNegativeStock: true,
      allowSplitFulfillment: false,
      defaultLowStockThreshold: 5
    })
    await expect(save).toBeDisabled()

    // It is still there after a reload, and a second change sends only its own key
    await page.reload()
    await expect(negative).toBeChecked()
    await expect(threshold).toHaveValue('5')
    await split.check()
    await save.click()
    await expect(page.getByText(inventory.saved).first()).toBeVisible()
    expect(patches.at(-1)).toEqual({ allowSplitFulfillment: true })

    // An empty threshold is "no alert": it travels as null
    await threshold.fill('')
    await negative.uncheck()
    await save.click()
    await expect.poll(() => patches.length).toBe(3)
    expect(patches.at(-1)).toEqual({ allowNegativeStock: false, defaultLowStockThreshold: null })
    expect(await inventorySettingsOf(storeId)).toEqual({
      allowNegativeStock: false,
      allowSplitFulfillment: true,
      defaultLowStockThreshold: null
    })
  })

  test('the page fits a phone and asks before leaving with unsaved changes', async ({ page }) => {
    await page.setViewportSize(PHONE)
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(settingsPath())
    await expect(page.getByRole('heading', { name: inventory.title, level: 1 })).toBeVisible()
    await page.getByRole('checkbox', { name: inventory.negative.switch }).check()
    await expect(page.getByText(inventory.negative.warning)).toBeVisible()
    // Nothing sticks out of the screen (what scrolls inside its own box, like the navigation, may be wider); the
    // elements that do are named when it fails
    const wider = await page.evaluate((): string[] => {
      const width = document.documentElement.clientWidth
      const scrolls = (element: Element): boolean =>
        element.parentElement !== null &&
        (getComputedStyle(element.parentElement).overflowX === 'auto' ||
          scrolls(element.parentElement))
      const sticking = Array.from(document.querySelectorAll<HTMLElement>('body *'))
        .filter(element => element.getBoundingClientRect().right > width && !scrolls(element))
        .map(element => `${element.tagName}.${String(element.className)}`.slice(0, 120))
      return [`page ${document.documentElement.scrollWidth - width}`, ...sticking]
    })
    expect(wider).toEqual(['page 0'])

    // The navigation guards the unsaved change
    await page
      .getByRole('navigation', { name: en.settings.nav.store.label })
      .getByRole('link', { name: en.settings.nav.store.channels })
      .click()
    await expect(page.getByRole('dialog')).toBeVisible()
  })

  test('a person who may only look sees the settings and cannot change them', async ({ page }) => {
    const mainStoreId = await storeIdNamed('Main Store')
    const email = `e2e-inventory-readonly-${run}@example.com`
    const remove = await addReadOnlySettingsUser(mainStoreId, email)
    try {
      const before = await inventorySettingsOf(mainStoreId)
      await signIn(page, email)
      await page.waitForURL(/\/s\/[^/]+\//)
      await page.goto(AppPaths.store.settings(mainStoreId, StoreSettingsSections.INVENTORY))
      await expect(page.getByRole('heading', { name: inventory.title, level: 1 })).toBeVisible()

      await expect(page.getByText(inventory.readOnly)).toBeVisible()
      await expect(page.getByRole('checkbox', { name: inventory.negative.switch })).toBeDisabled()
      await expect(page.getByRole('checkbox', { name: inventory.split.switch })).toBeDisabled()
      await expect(page.getByLabel(inventory.threshold.label)).toBeDisabled()
      await expect(page.getByRole('button', { name: inventory.save })).toHaveCount(0)
      expect(await inventorySettingsOf(mainStoreId)).toEqual(before)
    } finally {
      await remove()
    }
  })

  test('a person who may not see settings gets no page and no link', async ({ page }) => {
    const mainStoreId = await storeIdNamed('Main Store')
    await signIn(page, 'agent@test.com')
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.store.settings(mainStoreId, StoreSettingsSections.INVENTORY))

    await expect(page.getByRole('heading', { name: inventory.title, level: 1 })).toHaveCount(0)
    await expect(page.getByRole('checkbox', { name: inventory.negative.switch })).toHaveCount(0)
    await expect(page.getByRole('link', { name: en.settings.nav.store.inventory })).toHaveCount(0)
  })
})
