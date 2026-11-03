import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { deleteStoreIfThere, signInByApi, uninstallWidget } from '../support/api'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const ADMIN = 'admin@test.com'
const VIEWER = 'viewer@test.com'
const WIDGET_NAME = 'Web widget'

const channels = en.settings.channels
const plugins = en.settings.plugins

function storeIdOf(page: Page): string {
  const storeId = /\/s\/([^/]+)\//.exec(new URL(page.url()).pathname)?.[1]
  expect(storeId).toBeDefined()
  return storeId ?? ''
}

test.describe('Settings → Channels and Plugins', () => {
  test('an administrator installs the widget, connects it, sets it up and disconnects it', async ({
    page
  }) => {
    const host = `e2e-${randomUUID().slice(0, 8)}.example.com`
    // The widget is installed on the first store of the administrator, which the other specs share:
    // whatever happens in the case, the channel is taken off again at the end
    const token = await signInByApi(ADMIN)
    let storeId: string | undefined
    try {
      await signIn(page, ADMIN)
      await page.waitForURL(/\/s\/[^/]+\/inbox/)
      storeId = storeIdOf(page)

      // The channel is installed once per store; the laptop keeps its database between runs
      await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.PLUGINS))
      const row = page.getByRole('listitem').filter({ hasText: WIDGET_NAME })
      const install = row.getByRole('button', { name: `${plugins.install.action} ${WIDGET_NAME}` })
      const uninstall = row.getByRole('button', {
        name: `${plugins.uninstall.action} ${WIDGET_NAME}`
      })
      // The catalog is read first: one of the two buttons says where the store stands
      await expect(install.or(uninstall)).toBeVisible()
      if ((await install.count()) > 0) await install.click()
      await expect(
        row.getByRole('button', { name: `${plugins.uninstall.action} ${WIDGET_NAME}` })
      ).toBeVisible()

      // The form is the one the plugin asks for: the sites, one per line
      await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.CHANNELS))
      await page
        .getByRole('button', { name: `${channels.add.connect} ${WIDGET_NAME}`, exact: false })
        .click()
      const dialog = page.getByRole('dialog', {
        name: channels.connectDialog.title.replace('{name}', WIDGET_NAME)
      })
      await dialog.getByLabel(channels.connect.web_widget.siteOrigins).fill(`https://${host}`)
      await dialog.getByRole('button', { name: channels.connectDialog.submit }).click()

      const card = page
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: host }) })
      await expect(card).toBeVisible()
      await expect(card.getByText(channels.status.active)).toBeVisible()

      // The widget card: snippet, sites and the pre-chat switch
      await card.getByRole('button', { name: channels.widget.toggle }).click()
      await expect(card.getByText(/pk_widget_/)).toBeVisible()
      await expect(
        card.getByRole('heading', { name: channels.widget.connectSrc.title })
      ).toBeVisible()
      const preChat = card.getByLabel(channels.widget.preChat.label)
      await expect(preChat).not.toBeChecked()
      await preChat.click()
      await expect(preChat).toBeChecked()

      const secondHost = `https://second-${host}`
      const origins = card.getByLabel(channels.widget.origins.label)
      await origins.fill(`https://${host}\n${secondHost}`)
      await card.getByRole('button', { name: channels.widget.origins.save }).click()
      await expect(page.getByText(channels.widget.originsSaved)).toBeVisible()

      await page.reload()
      const again = page
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: host }) })
      await again.getByRole('button', { name: channels.widget.toggle }).click()
      await expect(again.getByLabel(channels.widget.preChat.label)).toBeChecked()
      await expect(again.getByLabel(channels.widget.origins.label)).toHaveValue(
        `https://${host}\n${secondHost}`
      )

      // Test the connection, then disconnect it: the confirmation names the account
      await again.getByRole('button', { name: channels.test.action }).click()
      // The verdict is a line of text; the copy buttons have status regions of their own
      await expect(
        again.getByText(new RegExp(`^(${channels.test.healthy}|${channels.test.unhealthy})`))
      ).toBeVisible()
      await again.getByRole('button', { name: `${channels.disconnect.action} ${host}` }).click()
      const confirm = page.getByRole('alertdialog')
      await confirm.getByRole('button', { name: channels.disconnect.confirm }).click()
      await expect(page.getByText(channels.disconnect.done.replace('{name}', host))).toBeVisible()
      await expect(page.getByRole('heading', { name: channels.past.title })).toBeVisible()
      await expect(
        page
          .getByRole('listitem')
          .filter({ has: page.getByRole('heading', { name: host }) })
          .getByText(channels.disconnectedNote)
      ).toBeVisible()

      // Uninstalling asks first, says it is done and gives the install button back
      await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.PLUGINS))
      await row.getByRole('button', { name: `${plugins.uninstall.action} ${WIDGET_NAME}` }).click()
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: plugins.uninstall.confirm })
        .click()
      await expect(
        row.getByRole('button', { name: `${plugins.install.action} ${WIDGET_NAME}` })
      ).toBeVisible()
    } finally {
      if (storeId !== undefined) await uninstallWidget(token, storeId)
    }
  })

  test('a viewer is told it has no access to channels or plugins', async ({ page }) => {
    await signIn(page, VIEWER)
    await page.waitForURL(/\/s\/[^/]+\/inbox/)
    const storeId = storeIdOf(page)
    for (const section of [StoreSettingsSections.CHANNELS, StoreSettingsSections.PLUGINS]) {
      await page.goto(AppPaths.store.settings(storeId, section))
      await expect(
        page.getByRole('heading', { name: en.emptyStates.permissionDenied.title })
      ).toBeVisible()
    }
  })

  // A store with nothing connected: the empty inbox offers the page that connects a channel
  test('the empty inbox of a store with no channel leads to Channels', async ({ page }) => {
    const name = `E2E Channels ${randomUUID().slice(0, 8)}`
    // A store that holds nothing is deleted by the case itself; if it stops half way, the store goes
    // anyway, so that a laptop does not collect one per failed run
    const token = await signInByApi(ADMIN)
    let storeId: string | undefined
    try {
      await signIn(page, ADMIN)
      await page.goto(AppPaths.org.stores)
      await page.getByRole('button', { name: en.org.newStore }).click()
      const create = page.getByRole('dialog', { name: en.org.create.title })
      await create.getByLabel(en.settings.store.name).fill(name)
      await create.getByRole('button', { name: en.org.create.submit }).click()
      await page.getByRole('link', { name: `${en.org.settings} ${name}` }).click()
      await page.waitForURL(/\/settings\//)
      storeId = storeIdOf(page)

      await page.goto(AppPaths.store.inbox(storeId))
      await page.getByRole('link', { name: en.inbox.empty.connectChannel }).click()
      await expect(page).toHaveURL(/\/settings\/channels$/)
      await expect(page.getByRole('heading', { name: channels.empty.title })).toBeVisible()

      await page.goto(AppPaths.org.stores)
      await page.getByRole('button', { name: `${en.org.delete.action} ${name}` }).click()
      const confirm = page.getByRole('alertdialog')
      await confirm.getByLabel(en.confirm.phraseLabel).fill(name)
      await confirm.getByRole('button', { name: en.org.delete.confirm }).click()
      await expect(page.getByText(name, { exact: true })).toHaveCount(0)
    } finally {
      if (storeId !== undefined) await deleteStoreIfThere(token, storeId)
    }
  })
})
