import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { ChannelIds } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  deleteStoreIfThere,
  installChannel,
  signInByApi,
  uninstallChannel,
  uninstallWidget
} from '../support/api'
import { expectDialogHoldsItsContent } from '../support/dialog-fit'
import {
  FAKE_BUSY_TOKEN,
  FAKE_OTHER_PAGE_TOKEN,
  FAKE_PAGE_ID,
  FAKE_PAGE_NAME,
  FAKE_PAGE_TOKEN,
  FAKE_PAGE_TOKEN_RENEWED,
  FAKE_REJECTED_TOKEN,
  type FakeGraph,
  startFakeGraph
} from '../support/fake-graph'
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

// The name the channels screen shows for the Messenger plugin (CI page text: "Messenger")
const MESSENGER_NAME = 'Messenger'

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
      await dialog.getByRole('button', { name: channels.connectDialog.submit, exact: true }).click()

      const card = page
        .getByRole('listitem')
        .filter({ has: page.getByRole('heading', { name: host }) })
      await expect(card).toBeVisible()
      await expect(card.getByText(channels.status.active)).toBeVisible()

      // The widget card: snippet, sites and the pre-chat switch
      await card.getByRole('button', { name: channels.widget.toggle }).click()
      await expect(card.getByText(/pk_widget_/)).toBeVisible()
      await expect(card.getByRole('heading', { name: channels.widget.csp.title })).toBeVisible()
      // One line per directive the site must allow: the script, and where the chat connects
      await expect(card.getByText(/^script-src https?:\/\/\S+$/)).toBeVisible()
      await expect(card.getByText(/^connect-src https?:\/\/\S+ wss?:\/\/\S+/)).toBeVisible()
      await expect(card.getByText(channels.widget.csp.others)).toBeVisible()
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
      await again.getByRole('button', { name: `${channels.test.action} ${host}` }).click()
      // The verdict is a line of text; the copy buttons have status regions of their own
      await expect(
        again.getByText(new RegExp(`^(${channels.test.healthy}|${channels.test.unhealthy})`))
      ).toBeVisible()
      await again.getByRole('button', { name: `${channels.disconnect.action} ${host}` }).click()
      const confirm = page.getByRole('alertdialog')
      await confirm.getByRole('button', { name: channels.disconnect.confirm }).click()
      await expect(page.getByText(channels.disconnect.done.replace('{name}', host))).toBeVisible()
      await expect(page.getByRole('heading', { name: channels.past.title })).toBeVisible()
      // The disconnected accounts are read when asked for
      await page.getByRole('button', { name: channels.past.show }).click()
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

  // Connecting a Meta channel against a Graph that refuses a token the way Meta does (code 190)
  test.describe('connecting Messenger', () => {
    let graph: FakeGraph
    test.beforeAll(async () => {
      graph = await startFakeGraph()
    })
    test.afterAll(async () => {
      await graph.close()
    })

    test('says what to do when Meta refuses the token, goes back to the field, and connects with a good one', async ({
      page
    }) => {
      // Two sessions of the administrator: each waits for the magic link budget of that address,
      // which the earlier specs have spent (support/link-budget.ts)
      test.setTimeout(120_000)
      const token = await signInByApi(ADMIN)
      let storeId: string | undefined
      try {
        await signIn(page, ADMIN)
        await page.waitForURL(/\/s\/[^/]+\/inbox/)
        storeId = storeIdOf(page)
        await installChannel(token, storeId, ChannelIds.MESSENGER)

        await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.CHANNELS))
        const connectButton = page.getByRole('button', {
          name: `${channels.add.connect} ${MESSENGER_NAME}`,
          exact: false
        })
        // When the button is missing, the log says what the page showed instead
        await expect
          .poll(
            async () =>
              (await connectButton.count()) > 0 || (await page.locator('main').innerText()),
            {
              message: 'the Messenger connect button is not on the page',
              timeout: 30_000
            }
          )
          .toBe(true)
        await connectButton.click()
        const dialog = page.getByRole('dialog', {
          name: channels.connectDialog.title.replace('{name}', MESSENGER_NAME)
        })
        // Escape closes it and the focus goes back to the button that opened it, not to the page body (CAN-17)
        await expect(dialog).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(dialog).toBeHidden()
        await expect(connectButton).toBeFocused()
        await connectButton.click()
        // Where the channel has the login with Facebook it comes first, and the pasted token is one link away
        await dialog.getByRole('button', { name: channels.connectDialog.useToken }).click()
        const field = dialog.getByLabel(channels.connect.messenger.accessToken)
        // The dialog with the callback address (the widest thing in it) fits a phone and a desktop
        await expectDialogHoldsItsContent(page, dialog)

        // A token Meta refuses: the message says what happened and what to do, not "invalid credentials"
        await field.fill(FAKE_REJECTED_TOKEN)
        await dialog
          .getByRole('button', { name: channels.connectDialog.submit, exact: true })
          .click()
        await expect(dialog.getByRole('alert')).toHaveText(channels.connectFailure.token_rejected)
        await expect(field).toBeFocused()
        await expect(field).toHaveAttribute('aria-invalid', 'true')
        // The field points at the message, so the reason is read together with the field
        const alertId = await dialog.getByRole('alert').getAttribute('id')
        expect(alertId).not.toBeNull()
        await expect(field).toHaveAttribute('aria-describedby', alertId ?? '')
        // Nothing the person pasted is shown back, nor anything of Meta's answer
        await expect(dialog).not.toContainText(FAKE_REJECTED_TOKEN)
        await expect(dialog).not.toContainText('Invalid OAuth')

        // Meta asking to wait is not about the token: the message says so and the field is left alone
        await field.fill(FAKE_BUSY_TOKEN)
        await dialog
          .getByRole('button', { name: channels.connectDialog.submit, exact: true })
          .click()
        await expect(dialog.getByRole('alert')).toHaveText(channels.connectFailure.provider_busy)
        await expect(field).not.toBeFocused()
        await expect(field).not.toHaveAttribute('aria-invalid', 'true')

        // The right one connects, and the card names the Page
        await field.fill(FAKE_PAGE_TOKEN)
        await dialog
          .getByRole('button', { name: channels.connectDialog.submit, exact: true })
          .click()
        await expect(
          page.getByText(channels.connectDialog.connected.replace('{name}', FAKE_PAGE_NAME))
        ).toBeVisible()
        await expect(page.getByRole('heading', { name: FAKE_PAGE_NAME })).toBeVisible()
        expect(graph.subscriptions()).toEqual([FAKE_PAGE_ID])

        // The token is replaced in the card itself, tied to this connection
        await page
          .getByRole('button', { name: `${channels.updateToken.action} ${FAKE_PAGE_NAME}` })
          .click()
        const update = page.getByRole('dialog', {
          name: channels.updateToken.title.replace('{name}', FAKE_PAGE_NAME)
        })
        await expectDialogHoldsItsContent(page, update)
        const newField = update.getByLabel(channels.connect.messenger.accessToken)

        // The token of another Page is refused, says so without naming it, and subscribes nothing
        await newField.fill(FAKE_OTHER_PAGE_TOKEN)
        await update.getByRole('button', { name: channels.updateToken.submit }).click()
        await expect(update.getByRole('alert')).toHaveText(channels.connectFailure.other_account)
        // Nothing of the other Page, anywhere on the page (the dialog, a toast, the list)
        await expect(page.locator('body')).not.toContainText('E2E Other Page')
        await expect(page.locator('body')).not.toContainText(FAKE_OTHER_PAGE_TOKEN)
        expect(graph.subscriptions()).toEqual([FAKE_PAGE_ID])

        // A new token of the same Page replaces it: same card, same name, no second connection
        await newField.fill(FAKE_PAGE_TOKEN_RENEWED)
        await update.getByRole('button', { name: channels.updateToken.submit }).click()
        await expect(
          page.getByText(channels.updateToken.done.replace('{name}', FAKE_PAGE_NAME))
        ).toBeVisible()
        await expect(update).toHaveCount(0)
        await expect(page.getByRole('heading', { name: FAKE_PAGE_NAME })).toHaveCount(1)
        expect(graph.subscriptions()).toEqual([FAKE_PAGE_ID, FAKE_PAGE_ID])

        // The owner names the connection: the card, and nothing else of it, takes the new name
        const MY_NAME = 'Messenger principal'
        const renameButton = page.getByRole('button', {
          name: `${channels.rename.action} ${FAKE_PAGE_NAME}`
        })
        await renameButton.click()
        const naming = page.getByRole('dialog', {
          name: channels.rename.title.replace('{name}', FAKE_PAGE_NAME)
        })
        // The field of this dialog takes the focus when it opens; Escape still gives it back to the button
        await expect(naming.getByLabel(channels.rename.label)).toBeFocused()
        await page.keyboard.press('Escape')
        await expect(naming).toBeHidden()
        await expect(renameButton).toBeFocused()
        await renameButton.click()
        await expectDialogHoldsItsContent(page, naming)
        // Nothing to save until the text changes
        await expect(naming.getByRole('button', { name: channels.rename.submit })).toBeDisabled()
        await naming.getByLabel(channels.rename.label).fill(`  ${MY_NAME}  `)
        await naming.getByRole('button', { name: channels.rename.submit }).click()
        await expect(page.getByText(channels.rename.done.replace('{name}', MY_NAME))).toBeVisible()
        await expect(page.getByRole('heading', { name: MY_NAME })).toHaveCount(1)
        // The name of the account is still what the hint says it goes back to
        await page.getByRole('button', { name: `${channels.rename.action} ${MY_NAME}` }).click()
        const again = page.getByRole('dialog', {
          name: channels.rename.title.replace('{name}', MY_NAME)
        })
        await expect(again.getByText(FAKE_PAGE_NAME, { exact: false })).toBeVisible()
        await again.getByLabel(channels.rename.label).fill('')
        await again.getByRole('button', { name: channels.rename.submit }).click()
        await expect(
          page.getByText(channels.rename.done.replace('{name}', FAKE_PAGE_NAME))
        ).toBeVisible()
        await expect(again).toHaveCount(0)
        await expect(page.getByRole('heading', { name: FAKE_PAGE_NAME })).toHaveCount(1)
        // It was saved, not only drawn: the same after the page is read again
        await page.reload()
        await expect(page.getByRole('heading', { name: FAKE_PAGE_NAME })).toHaveCount(1)
        await expect(page.getByRole('heading', { name: MY_NAME })).toHaveCount(0)
      } finally {
        if (storeId !== undefined) await uninstallChannel(token, storeId, ChannelIds.MESSENGER)
      }
    })
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
      if (storeId !== undefined) await deleteStoreIfThere(token, storeId, name)
    }
  })
})
