import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { expectDialogFitsThePhoneWidth } from '../support/dialog-fit'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, test } from '../support/test'

const routing = en.settings.routing
const hours = en.settings.hours

function storeIdOf(page: Page): string {
  const storeId = /\/s\/([^/]+)\//.exec(new URL(page.url()).pathname)?.[1]
  expect(storeId).toBeDefined()
  return storeId ?? ''
}

async function createRule(page: Page, name: string, keyword: string): Promise<void> {
  await page.getByRole('button', { name: routing.create }).click()
  const dialog = page.getByRole('dialog', { name: routing.dialog.createTitle })
  await dialog.getByLabel(routing.dialog.name, { exact: true }).fill(name)
  await expectDialogFitsThePhoneWidth(page, dialog)
  await dialog.getByLabel(routing.dialog.keywords).fill(keyword)
  await dialog.getByRole('button', { name: routing.dialog.save }).click()
  await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible()
}

function ruleNames(page: Page, suffix: string) {
  return page
    .getByRole('list', { name: routing.listLabel })
    .getByRole('heading')
    .filter({ hasText: suffix })
}

test.describe('Settings → Routing and Business hours', () => {
  test('an administrator makes rules, puts one first, turns it off and deletes it', async ({
    page
  }) => {
    const suffix = randomUUID().slice(0, 8)
    const first = `E2E first ${suffix}`
    const second = `E2E second ${suffix}`

    await signIn(page, personOf('admin', import.meta.url))
    await page.waitForURL(/\/s\/[^/]+\/inbox/)
    await page.goto(AppPaths.store.settings(storeIdOf(page), StoreSettingsSections.ROUTING))
    await expect(page.getByRole('heading', { name: routing.title, level: 1 })).toBeVisible()

    // A rule with no person to pick is refused before the request
    await page.getByRole('button', { name: routing.create }).click()
    const dialog = page.getByRole('dialog', { name: routing.dialog.createTitle })
    await dialog.getByLabel(routing.dialog.name, { exact: true }).fill(`E2E bad ${suffix}`)
    await dialog.getByLabel(routing.dialog.action).selectOption('round_robin')
    await dialog.getByRole('button', { name: routing.dialog.save }).click()
    await expect(dialog.getByText(routing.dialog.problems.roundRobinNeedsMany)).toBeVisible()
    await dialog.getByRole('button', { name: en.common.cancel }).click()

    await createRule(page, first, 'alpha')
    await createRule(page, second, 'beta')
    await expect(ruleNames(page, suffix)).toHaveText([
      new RegExp(`${first}`),
      new RegExp(`${second}`)
    ])

    // The second goes up with the keyboard buttons, and the order is kept after a reload
    await page
      .getByRole('button', { name: routing.reorder.up.replace('{name}', second), exact: true })
      .click()
    await expect(ruleNames(page, suffix)).toHaveText([
      new RegExp(`${second}`),
      new RegExp(`${first}`)
    ])
    await page.reload()
    await expect(ruleNames(page, suffix)).toHaveText([
      new RegExp(`${second}`),
      new RegExp(`${first}`)
    ])

    // Turning a rule off marks it
    const row = page.getByRole('listitem').filter({ hasText: first })
    await row.getByLabel(routing.toggle.replace('{name}', first)).click()
    await expect(row.getByText(routing.disabled, { exact: true })).toBeVisible()

    // Deleting asks first
    for (const name of [first, second]) {
      await page
        .getByRole('listitem')
        .filter({ hasText: name })
        .getByRole('button', { name: routing.delete.action, exact: false })
        .click()
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: routing.delete.confirm })
        .click()
      await expect(page.getByRole('heading', { name: new RegExp(name) })).toHaveCount(0)
    }
  })

  test('an administrator sets the business hours and they stay after a reload', async ({
    page
  }) => {
    await signIn(page, personOf('admin', import.meta.url))
    await page.waitForURL(/\/s\/[^/]+\/inbox/)
    await page.goto(AppPaths.store.settings(storeIdOf(page), StoreSettingsSections.BUSINESS_HOURS))
    await expect(page.getByRole('heading', { name: hours.title, level: 1 })).toBeVisible()

    // A store with no schedule offers to start one
    const start = page.getByRole('button', { name: hours.empty.start })
    if (await start.isVisible()) await start.click()

    // Saturday opens with the default hours and is saved
    await page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: hours.days.sat }) })
      .getByRole('button', { name: hours.addRange })
      .click()
    await page.getByRole('button', { name: hours.save }).click()
    await expect(page.getByText(hours.saved)).toBeVisible()

    await page.reload()
    const saturday = page
      .getByRole('listitem')
      .filter({ has: page.getByRole('heading', { name: hours.days.sat }) })
    await expect(saturday.getByText(hours.closed)).toHaveCount(0)

    // Close it again; a store that had no schedule keeps the weekdays it started with
    await saturday.getByRole('button', { name: /Remove hours 1 of Saturday/ }).click()
    await page.getByRole('button', { name: hours.save }).click()
    await expect(page.getByText(hours.saved).first()).toBeVisible()
  })

  test('a viewer who may not see settings gets the permission message', async ({ page }) => {
    await signIn(page, personOf('viewer', import.meta.url))
    await page.waitForURL(/\/s\/[^/]+\//)
    const storeId = storeIdOf(page)
    for (const section of [StoreSettingsSections.ROUTING, StoreSettingsSections.BUSINESS_HOURS]) {
      await page.goto(AppPaths.store.settings(storeId, section))
      await expect(
        page.getByRole('heading', { name: en.emptyStates.permissionDenied.title })
      ).toBeVisible()
    }
  })
})
