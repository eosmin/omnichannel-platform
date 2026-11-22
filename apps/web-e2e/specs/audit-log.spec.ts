import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { storeIdNamed } from '../support/database'
import { expectDialogFitsThePhoneWidth } from '../support/dialog-fit'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator: the Admin preset holds `org:view_audit_log`
const ADMIN = 'multi-store@test.com'
const LOG = en.settings.auditLog
// What the viewer writes when it is read: the one entry the test can count on finding
const VIEWED_ACTION = 'audit_log.viewed'

test.describe('the audit log of a store', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('is in the settings navigation and lists what happened, newest first', async () => {
    await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.AUDIT_LOG))
    await expect(page.getByRole('heading', { level: 1, name: LOG.title })).toBeVisible()
    await expect(
      page.getByRole('link', { name: en.settings.nav.store.auditLog, exact: true })
    ).toBeVisible()
    // Reading the log wrote an entry of its own (after the answer): ask again until it is there
    await expect(async () => {
      await page.getByRole('button', { name: LOG.filters.apply }).click()
      await expect(page.getByRole('table', { name: LOG.caption })).toBeVisible()
    }).toPass()
  })

  test('narrows by action, opens one entry in full and says what an empty filter finds', async () => {
    await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.AUDIT_LOG))
    await page.getByLabel(LOG.filters.action, { exact: true }).fill(VIEWED_ACTION)
    const table = page.getByRole('table', { name: LOG.caption })
    await expect(async () => {
      await page.getByRole('button', { name: LOG.filters.apply }).click()
      await expect(table.getByRole('cell', { name: VIEWED_ACTION }).first()).toBeVisible()
    }).toPass()

    await table
      .getByRole('button', { name: new RegExp(LOG.open) })
      .first()
      .click()
    const dialog = page.getByRole('dialog', { name: LOG.entry.title })
    await expect(dialog.getByText(VIEWED_ACTION, { exact: true })).toBeVisible()
    await expect(dialog.getByText(LOG.entry.metadata, { exact: true }).first()).toBeVisible()
    await expectDialogFitsThePhoneWidth(page, dialog)
    await dialog.getByRole('button', { name: en.common.close, exact: true }).first().click()
    await expect(dialog).toHaveCount(0)

    await page.getByLabel(LOG.filters.action, { exact: true }).fill('no.such.action')
    await page.getByRole('button', { name: LOG.filters.apply }).click()
    await expect(page.getByText(LOG.empty, { exact: true })).toBeVisible()
  })

  test('refuses a reversed range before sending it, and queues the CSV of the filters', async () => {
    await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.AUDIT_LOG))
    await page.getByLabel(LOG.filters.from, { exact: true }).fill('2026-11-10')
    await page.getByLabel(LOG.filters.to, { exact: true }).fill('2026-11-01')
    await expect(page.getByRole('alert').filter({ hasText: LOG.filters.reversed })).toBeVisible()
    await expect(page.getByRole('button', { name: LOG.filters.apply })).toBeDisabled()

    await page.getByRole('button', { name: LOG.filters.clear }).click()
    await page.getByRole('button', { name: LOG.export.button }).click()
    await expect(page.getByText(LOG.export.queued, { exact: true })).toBeVisible()
  })
})
