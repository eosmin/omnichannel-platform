import type { Page } from '@playwright/test'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { installChannel, signInByApi, uninstallChannel } from '../support/api'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

// The "toy third-party plugin" test of the web (channel-agnostic refactor, lane B). A channel that this repository
// has never heard of is registered in the api of the e2e run (`E2E_TOY_PLUGIN=1`, only under NODE_ENV=test; see
// playwright.shared.ts) and the settings screens must draw it from its descriptor alone: not a line of apps/web or
// libs/api-client may name it. The descriptor it declares: displayName 'Acme Chat', one secret field `apiKey`
// labelled { es: 'Clave de Acme', en: 'Acme API key' } with no message key, and no login.
const TOY_PLUGIN = { id: 'acme_chat', name: 'Acme Chat', secretLabel: 'Acme API key' } as const

const ADMIN = 'admin2@test.com'
const channels = en.settings.channels

function storeIdOf(page: Page): string {
  const storeId = /\/s\/([^/]+)\//.exec(new URL(page.url()).pathname)?.[1]
  expect(storeId).toBeDefined()
  return storeId ?? ''
}

test.describe('Toy third-party channel plugin', () => {
  test('is named, and its connect form drawn, from its descriptor with no code of the web about it', async ({
    page
  }) => {
    const token = await signInByApi(ADMIN)
    let storeId: string | undefined
    try {
      await signIn(page, ADMIN)
      await page.waitForURL(/\/s\/[^/]+\/inbox/)
      storeId = storeIdOf(page)
      await installChannel(token, storeId, TOY_PLUGIN.id)

      await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.CHANNELS))

      // The name comes from the descriptor, not from a message file keyed by the id
      await page
        .getByRole('button', { name: `${channels.add.connect} ${TOY_PLUGIN.name}`, exact: false })
        .click()
      const dialog = page.getByRole('dialog', {
        name: channels.connectDialog.title.replace('{name}', TOY_PLUGIN.name)
      })
      await expect(dialog).toBeVisible()

      // The form is the declared one: a secret field, masked, labelled by the text the plugin wrote
      const apiKey = dialog.getByLabel(TOY_PLUGIN.secretLabel)
      await expect(apiKey).toBeVisible()
      await expect(apiKey).toHaveAttribute('type', 'password')

      // The plugin declares no login: no "Connect with ..." button of any provider
      await expect(dialog.getByRole('button', { name: /^Connect with /i })).toHaveCount(0)
    } finally {
      if (storeId !== undefined) {
        await uninstallChannel(token, storeId, TOY_PLUGIN.id).catch(() => undefined)
      }
    }
  })
})
