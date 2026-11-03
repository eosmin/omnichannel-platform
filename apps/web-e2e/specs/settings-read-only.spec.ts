import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import { AppPaths, type StoreSettingsSection, StoreSettingsSections } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addReadOnlySettingsUser, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const settings = en.settings

// A person who may look at the settings and change none of them (TDD_09 §13): every page opens, says
// what it holds, and draws no action. Pages that need a right this person lacks say so.
test.describe('Settings for a person who may only look', () => {
  let storeId = ''
  let remove: () => Promise<void> = () => Promise.resolve()
  const email = `e2e-readonly-${randomUUID().slice(0, 8)}@example.com`

  test.beforeAll(async () => {
    storeId = await storeIdNamed('Main Store')
    remove = await addReadOnlySettingsUser(storeId, email)
  })
  test.afterAll(async () => {
    await remove()
  })

  const open = (page: Page, section: StoreSettingsSection) =>
    page.goto(AppPaths.store.settings(storeId, section))
  // By the start of the name: a button says what it does and to what ("Install Web widget")
  const noButton = (page: Page, name: string) =>
    expect(
      page.getByRole('button', {
        name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      })
    ).toHaveCount(0)
  // The list has been read: its rows, or its empty state, are on the page. An absence checked before
  // that would pass whatever the page draws.
  const listed = (page: Page, listLabel: string, emptyTitle: string) =>
    expect(
      page
        .getByRole('list', { name: listLabel, exact: true })
        .or(page.getByText(emptyTitle))
        .first()
    ).toBeVisible()

  test('no page draws an action, and each says what it can show', async ({ page }) => {
    await signIn(page, email)
    await page.waitForURL(/\/s\/[^/]+\//)

    await open(page, StoreSettingsSections.CHANNELS)
    await expect(
      page.getByRole('heading', { name: settings.channels.title, level: 1 })
    ).toBeVisible()
    // The store has a connection, so the actions of its card would be there for someone who may
    await expect(page.getByRole('list', { name: settings.channels.listLabel })).toBeVisible()
    await noButton(page, settings.channels.disconnect.action)
    await noButton(page, settings.channels.test.action)
    await noButton(page, settings.channels.add.connect)

    await open(page, StoreSettingsSections.PLUGINS)
    await expect(
      page.getByRole('heading', { name: settings.plugins.title, level: 1 })
    ).toBeVisible()
    await expect(page.getByRole('list', { name: settings.plugins.listLabel })).toBeVisible()
    await noButton(page, settings.plugins.install.action)
    await noButton(page, settings.plugins.uninstall.action)

    await open(page, StoreSettingsSections.TEAM)
    await expect(page.getByRole('heading', { name: settings.team.title, level: 1 })).toBeVisible()
    await listed(page, settings.team.members.listLabel, settings.team.members.empty.title)
    await noButton(page, settings.team.members.remove.action)
    await page.getByRole('tab', { name: settings.team.tabs.roles }).click()
    await listed(page, settings.team.roles.listLabel, settings.team.roles.emptyCustom)
    await noButton(page, settings.team.roles.create)
    await page.getByRole('tab', { name: settings.team.tabs.invitations }).click()
    await listed(page, settings.team.invitations.listLabel, settings.team.invitations.empty.title)
    await noButton(page, settings.team.invitations.invite)

    await open(page, StoreSettingsSections.ROUTING)
    await expect(
      page.getByRole('heading', { name: settings.routing.title, level: 1 })
    ).toBeVisible()
    await listed(page, settings.routing.listLabel, settings.routing.empty.title)
    await noButton(page, settings.routing.create)

    await open(page, StoreSettingsSections.BUSINESS_HOURS)
    // With a schedule the page says it is read-only; with none it offers to start one only to who may
    await expect(
      page.getByText(settings.hours.readOnly).or(page.getByText(settings.hours.empty.title))
    ).toBeVisible()
    await noButton(page, settings.hours.save)
    await noButton(page, settings.hours.empty.start)

    await open(page, StoreSettingsSections.TAGS)
    await expect(page.getByRole('heading', { name: settings.tags.title, level: 1 })).toBeVisible()
    await listed(page, settings.tags.listLabel, settings.tags.empty.title)
    await noButton(page, settings.tags.create)

    await open(page, StoreSettingsSections.SNIPPETS)
    await expect(
      page.getByRole('heading', { name: settings.snippets.title, level: 1 })
    ).toBeVisible()
    await listed(page, settings.snippets.listLabel, settings.snippets.empty.title)
    await noButton(page, settings.snippets.create)

    await open(page, StoreSettingsSections.INBOX)
    await expect(page.getByText(settings.inbox.readOnly).first()).toBeVisible()
    await noButton(page, settings.inbox.save)
  })

  test('the page of the store itself needs the right to manage stores, and says so', async ({
    page
  }) => {
    await signIn(page, email)
    await page.waitForURL(/\/s\/[^/]+\//)

    await open(page, StoreSettingsSections.GENERAL)

    await expect(
      page.getByRole('heading', { name: en.emptyStates.permissionDenied.title })
    ).toBeVisible()
  })
})
