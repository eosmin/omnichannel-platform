import type { Browser } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { ReportLimits } from '@platform/core/analytics'

import en from '../../web/messages/en.json' with { type: 'json' }
import analytics from '../../web/messages/routes/analytics.en.json' with { type: 'json' }
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

// An admin holds analytics:export and analytics:manage_reports; the viewer role holds analytics:view only
const ADMIN = 'admin@test.com'
const VIEWER = 'viewer2@test.com'

async function enter(browser: Browser, email: string) {
  const context = await browser.newContext()
  await reachServicesFromOwnAddress(context)
  const page = await context.newPage()
  await signIn(page, email)
  await expect(page).toHaveURL(/\/s\/([^/]+)\/inbox/)
  const storeId = /\/s\/([^/]+)\//.exec(new URL(page.url()).pathname)?.[1] ?? ''
  return { context, page, storeId }
}

const words = analytics.analytics

test.describe('analytics reports and export', () => {
  test('an admin exports the figures as a file and is sent to the exports center', async ({
    browser
  }) => {
    const { context, page, storeId } = await enter(browser, ADMIN)
    try {
      await page.goto(AppPaths.store.analytics(storeId))
      await page.getByRole('button', { name: words.pageActions.export }).click()

      const dialog = page.getByRole('dialog', { name: words.export.title })
      await expect(dialog).toBeVisible()
      await dialog.getByLabel(words.export.format).selectOption('excel')
      await dialog.getByRole('button', { name: words.picker.none }).click()
      await dialog.getByRole('button', { name: words.export.submit }).click()
      await expect(dialog.getByText(words.export.noMetrics)).toBeVisible()

      await dialog.getByRole('button', { name: words.picker.all }).click()
      await dialog.getByRole('button', { name: words.export.submit }).click()
      await expect(dialog.getByText(words.export.queued)).toBeVisible()

      await dialog.getByRole('link', { name: words.export.goToExports }).click()
      await expect(page).toHaveURL(new RegExp(`${AppPaths.store.exports(storeId)}$`))
      await expect(page.getByRole('heading', { level: 1, name: en.exports.title })).toBeVisible()
    } finally {
      await context.close()
    }
  })

  test('an admin makes, pauses and deletes a scheduled report', async ({ browser }) => {
    const { context, page, storeId } = await enter(browser, ADMIN)
    try {
      await page.goto(AppPaths.store.analytics(storeId))
      await page.getByRole('link', { name: words.pageActions.reports }).click()
      await expect(page).toHaveURL(new RegExp(`${AppPaths.store.analyticsReports(storeId)}$`))
      await expect(page.getByRole('heading', { level: 1, name: words.reports.title })).toBeVisible()

      const name = `Monday summary ${Date.now()}`
      await page.getByRole('button', { name: words.reports.create }).click()
      const dialog = page.getByRole('dialog', { name: words.reports.form.createTitle })
      // Nothing written: the form says which field to fix and sends nothing
      await dialog.getByRole('button', { name: words.reports.form.create }).click()
      await expect(dialog.getByText(words.reports.form.problems.name)).toBeVisible()

      await dialog.getByLabel(words.reports.form.name).fill(name)
      await dialog.getByLabel(words.reports.form.recipients).fill('not-an-address')
      await dialog.getByRole('button', { name: words.reports.form.create }).click()
      await expect(
        dialog.getByText(
          words.reports.form.problems.recipients.replace(
            '{max}',
            String(ReportLimits.MAX_RECIPIENTS)
          )
        )
      ).toBeVisible()

      await dialog.getByLabel(words.reports.form.recipients).fill('boss@example.com')
      await dialog.getByRole('button', { name: words.reports.form.create }).click()
      await expect(dialog).toBeHidden()

      const row = page.getByRole('row', { name: new RegExp(name) })
      await expect(row).toBeVisible()
      await expect(row.getByText(words.reports.state.on)).toBeVisible()

      await row
        .getByRole('button', { name: words.reports.actions.pause.replace('{name}', name) })
        .click()
      await expect(row.getByText(words.reports.state.off)).toBeVisible()

      await row
        .getByRole('button', { name: words.reports.actions.delete.replace('{name}', name) })
        .click()
      await page.getByRole('button', { name: words.reports.delete.confirm }).click()
      await expect(page.getByRole('row', { name: new RegExp(name) })).toHaveCount(0)
    } finally {
      await context.close()
    }
  })

  test('who holds analytics:view only sees no export and no reports', async ({ browser }) => {
    const { context, page, storeId } = await enter(browser, VIEWER)
    try {
      await page.goto(AppPaths.store.analytics(storeId))
      await expect(page.getByRole('heading', { level: 1, name: words.title })).toBeVisible()
      // The cards are drawn once the permissions are known: only then is an absent control proof that it is hidden
      await expect(page.getByRole('heading', { name: words.kpi.conversations.title })).toBeVisible()
      await expect(page.getByRole('button', { name: words.pageActions.export })).toHaveCount(0)
      await expect(page.getByRole('link', { name: words.pageActions.reports })).toHaveCount(0)

      await page.goto(AppPaths.store.analyticsReports(storeId))
      await expect(page.getByText(en.emptyStates.permissionDenied.title)).toBeVisible()
    } finally {
      await context.close()
    }
  })
})
