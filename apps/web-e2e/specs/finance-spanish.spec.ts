import { randomUUID } from 'node:crypto'

import type { BrowserContext, Page } from '@playwright/test'

import { AppPaths, LOCALE_COOKIE } from '@platform/api-client'
import { Locales } from '@platform/core/i18n'

import es from '../../web/messages/es.json' with { type: 'json' }
import { addOwnerOfNewStore } from '../support/database'
import { WEB_URL } from '../support/env'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const finance = es.finance

// Finance in Spanish, on a phone and on a desktop (Step 4B.9b-5c): the screens of the books are read with the words of the person, the
// month is not written with a capital on its "de", the VAT page says when the sales count in words and not with the name of the setting,
// and no page of the area grows a sideways scroll bar on 390 px. The cases of the other specs read the English messages.
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth
  }))
  expect(widths.scroll).toBeLessThanOrEqual(widths.client)
}

test.describe('Finanzas → the screens in Spanish', () => {
  test.describe.configure({ mode: 'serial' })
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-finance-es-owner-${run}@example.com`

  test.beforeAll(async () => {
    await addOwnerOfNewStore(ownerEmail, `E2E Español ${run}`)
  })

  // The sign-in form of the suite is read in English, so the person signs in with it and the interface is changed to Spanish after
  async function signInInSpanish(page: Page, context: BrowserContext): Promise<void> {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await context.addCookies([{ name: LOCALE_COOKIE, value: Locales.ES, url: WEB_URL }])
  }

  test('the books are set up and a month is opened, written with the words of the person', async ({
    page,
    context
  }) => {
    await signInInSpanish(page, context)
    await page.goto(AppPaths.finance.home)
    await expect(page.getByRole('heading', { name: finance.setup.title, level: 1 })).toBeVisible()
    await page.getByLabel(finance.setup.startsOn, { exact: true }).fill('2026-01-01')
    await page.getByLabel(finance.setup.country, { exact: true }).selectOption({ index: 0 })
    await page.getByRole('button', { name: finance.setup.submit, exact: true }).click()
    await expect(
      page.getByRole('heading', { name: finance.accounts.title, level: 1 })
    ).toBeVisible()

    await page.goto(AppPaths.finance.periods)
    await page.getByRole('button', { name: finance.periods.open.action, exact: true }).click()
    const dialog = page.getByRole('dialog', { name: finance.periods.open.title })
    await dialog.getByLabel(finance.periods.open.month, { exact: true }).fill('1')
    await dialog.getByLabel(finance.periods.open.year, { exact: true }).fill('2030')
    await dialog.getByRole('button', { name: finance.periods.open.submit, exact: true }).click()
    await expect(dialog).toHaveCount(0)

    // "enero de 2030" in the page, and only its first letter raised by the style: no "De"
    const label = page
      .locator('[data-testid="finance-period-row"][data-period="2030-01"]')
      .locator('span.font-medium')
    await expect(label).toHaveText('enero de 2030')
    expect(await label.evaluate(element => getComputedStyle(element).textTransform)).toBe('none')
  })

  test('the VAT page says when the sales count in words, on a phone and on a desktop', async ({
    page,
    context
  }) => {
    await signInInSpanish(page, context)
    await page.goto(AppPaths.finance.vat)
    await expect(page.getByRole('heading', { name: finance.vat.title, level: 1 })).toBeVisible()
    const vat = page.getByTestId('finance-vat')
    const form = vat.getByRole('form', { name: finance.statementsCommon.formLabel })
    await form.getByLabel(finance.statementsCommon.from, { exact: true }).fill('2026-01-01')
    await form.getByLabel(finance.statementsCommon.to, { exact: true }).fill('2026-01-31')
    await form.getByRole('button', { name: finance.statementsCommon.show, exact: true }).click()
    const basis = vat.getByTestId('finance-vat-basis')
    await expect(basis).toContainText(finance.vat.recognized.delivered)
    // The name of the setting is not what the person reads
    await expect(basis).not.toContainText('delivered')
    for (const screen of [PHONE, DESKTOP]) {
      await page.setViewportSize(screen)
      await expectNoSidewaysScroll(page)
    }
  })

  test('the fiscal list and the other pages of the area do not scroll sideways on a phone', async ({
    page,
    context
  }) => {
    await signInInSpanish(page, context)
    await page.setViewportSize(PHONE)
    await page.goto(AppPaths.finance.fiscal)
    await expect(page.getByRole('heading', { name: finance.fiscal.title, level: 1 })).toBeVisible()
    await expect(page.getByLabel(finance.fiscal.filters.from, { exact: true })).toBeVisible()
    await expect(page.getByLabel(finance.fiscal.filters.to, { exact: true })).toBeVisible()
    await expectNoSidewaysScroll(page)

    for (const path of [
      AppPaths.finance.accounts,
      AppPaths.finance.periods,
      AppPaths.finance.journal,
      AppPaths.finance.transactions,
      AppPaths.finance.reports,
      AppPaths.finance.statements,
      AppPaths.finance.books,
      AppPaths.finance.suppliers,
      AppPaths.finance.purchases
    ]) {
      await page.goto(path)
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
      await expectNoSidewaysScroll(page)
    }
  })
})
