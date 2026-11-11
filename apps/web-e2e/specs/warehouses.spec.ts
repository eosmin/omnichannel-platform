import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { API_PREFIX, ApiRoutes } from '@platform/core/api'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addInventoryViewer,
  addOwnerOfNewStore,
  addStoreToOrganizationOf
} from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const text = en.warehouses
const PHONE = { width: 360, height: 740 }

// Organization → Warehouses, through the screen. Its own organization: the cases make, switch off and link
// warehouses, and the stores that the other specs share must not see them.
test.describe('Organization → Warehouses', () => {
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-warehouses-owner-${run}@example.com`
  const viewerEmail = `e2e-warehouses-viewer-${run}@example.com`
  const mainName = `E2E Warehouse Shop ${run}`
  const outletName = `E2E Warehouse Outlet ${run}`
  let storeId = ''
  let removeViewer: (() => Promise<void>) | null = null

  test.beforeAll(async () => {
    storeId = await addOwnerOfNewStore(ownerEmail, mainName)
    await addStoreToOrganizationOf(storeId, outletName, ownerEmail)
    removeViewer = await addInventoryViewer(storeId, viewerEmail)
  })

  test.afterAll(async () => {
    await removeViewer?.()
  })

  const openPage = async (page: Page, email: string): Promise<void> => {
    await signIn(page, email)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.org.warehouses)
    await expect(page.getByRole('heading', { name: text.title, level: 1 })).toBeVisible()
  }

  const rowOf = (page: Page, code: string) => page.getByRole('button', { name: new RegExp(code) })

  test('an administrator makes warehouses, a repeated code is refused, and the stores are linked in order', async ({
    page
  }) => {
    const code = `E2E-${run}`.toUpperCase()
    await openPage(page, ownerEmail)

    const posts: unknown[] = []
    await page.route(
      url => url.pathname === `${API_PREFIX}${ApiRoutes.warehouses.create}`,
      route => {
        if (route.request().method() === 'POST') posts.push(route.request().postDataJSON())
        void route.continue()
      }
    )

    // A code with a space, and an address with only a postal code, are refused before any request
    await page.getByRole('button', { name: text.new }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(text.form.name, { exact: true }).fill('Main warehouse')
    await dialog.getByLabel(text.form.code, { exact: true }).fill('bad code')
    await dialog.getByRole('button', { name: text.create.submit }).click()
    await expect(dialog.getByRole('alert').getByText(text.problems.code)).toBeVisible()
    await dialog.getByLabel(text.form.code, { exact: true }).fill(code)
    await dialog.getByLabel(text.form.postalCode).fill('37000')
    await dialog.getByRole('button', { name: text.create.submit }).click()
    await expect(dialog.getByRole('alert').getByText(text.problems.line1)).toBeVisible()
    expect(posts).toHaveLength(0)

    await dialog.getByLabel(text.form.postalCode).fill('')
    await dialog.getByRole('button', { name: text.create.submit }).click()
    await expect(dialog).toBeHidden()
    expect(posts).toEqual([{ name: 'Main warehouse', code }])
    await expect(rowOf(page, code)).toContainText(text.noStores)

    // The same code in another letter case belongs to the first one
    await page.getByRole('button', { name: text.new }).click()
    await dialog.getByLabel(text.form.name, { exact: true }).fill('Second warehouse')
    await dialog.getByLabel(text.form.code, { exact: true }).fill(code.toLowerCase())
    await dialog.getByRole('button', { name: text.create.submit }).click()
    await expect(dialog.getByRole('alert').getByText(text.problems.codeInUse)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()

    // Link both stores, the second first in the list, and the order is what was sent
    const puts: unknown[] = []
    await page.route(
      url => /\/warehouses\/[^/]+\/stores$/.test(url.pathname),
      route => {
        if (route.request().method() === 'PUT') puts.push(route.request().postDataJSON())
        void route.continue()
      }
    )
    await rowOf(page, code).click()
    const stores = dialog.getByRole('group', { name: text.stores.legend })
    await expect(stores.getByText(text.stores.empty)).toBeVisible()
    await stores.getByLabel(text.stores.addLabel).selectOption({ label: mainName })
    await stores.getByRole('button', { name: text.stores.add }).click()
    await stores.getByLabel(text.stores.addLabel).selectOption({ label: outletName })
    await stores.getByRole('button', { name: text.stores.add }).click()
    await stores
      .getByRole('button', { name: text.stores.moveUp.replace('{store}', outletName) })
      .click()
    await stores.getByRole('button', { name: text.stores.save }).click()
    await expect(page.getByText(text.stores.saved).first()).toBeVisible()
    expect(puts).toHaveLength(1)
    const sent = puts[0] as { stores: { storeId: string; priority: number }[] }
    expect(sent.stores.map(link => link.priority)).toEqual([1, 2])
    expect(sent.stores[1]?.storeId).toBe(storeId)

    // It is still so after a reload: the outlet reserves from this warehouse first
    await page.reload()
    await rowOf(page, code).click()
    const items = page.getByRole('dialog').getByRole('listitem')
    await expect(items.nth(0)).toContainText(outletName)
    await expect(items.nth(1)).toContainText(mainName)
  })

  test('an administrator switches a warehouse off and on again', async ({ page }) => {
    const code = `OFF-${run}`.toUpperCase()
    await openPage(page, ownerEmail)
    await page.getByRole('button', { name: text.new }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(text.form.name, { exact: true }).fill('Seasonal')
    await dialog.getByLabel(text.form.code, { exact: true }).fill(code)
    await dialog.getByRole('button', { name: text.create.submit }).click()
    await expect(dialog).toBeHidden()

    await rowOf(page, code).click()
    await dialog.getByRole('button', { name: text.state.switchOff }).click()
    await expect(page.getByText(text.state.switchedOff).first()).toBeVisible()
    await expect(dialog.getByText(text.stores.inactiveHint)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(rowOf(page, code)).toContainText(text.inactive)

    await rowOf(page, code).click()
    await dialog.getByRole('button', { name: text.state.switchOn }).click()
    await expect(page.getByText(text.state.switchedOn).first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(rowOf(page, code)).not.toContainText(text.inactive)
  })

  test('a person who may only see the inventory sees the warehouses and cannot change them', async ({
    page
  }) => {
    await openPage(page, viewerEmail)
    await expect(page.getByRole('button', { name: text.new })).toHaveCount(0)
    // The warehouse the first case made: the cases run in order, in one organization
    await rowOf(page, `E2E-${run}`.toUpperCase()).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(text.readOnly)).toBeVisible()
    await expect(dialog.getByRole('button', { name: text.edit.save })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: text.state.switchOff })).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: text.stores.save })).toHaveCount(0)
  })

  test('the form fits a phone', async ({ page }) => {
    await page.setViewportSize(PHONE)
    await openPage(page, ownerEmail)
    await page.getByRole('button', { name: text.new }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(overflow).toBe(0)
  })
})
