import { randomUUID } from 'node:crypto'

import type { Page } from '@playwright/test'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { ChannelIds } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { installChannel, signInByApi } from '../support/api'
import { addConnectionWithTokenInfo, removeConnections } from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const ADMIN = 'admin@test.com'
const health = en.settings.channels.health.token
const DAY = 86_400_000

const inDays = (days: number): string => new Date(Date.now() + days * DAY).toISOString()

// The date as the page writes it (the language and the time zone of the browser), so that the case does not
// guess at either
async function written(page: Page, iso: string): Promise<string> {
  return page.evaluate(
    value => new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(value)),
    iso
  )
}

// What the platform learned of the token of each connection from the provider (the daily job and every connect),
// drawn in the card of the connection
test.describe('Settings → Channels: the token of a connection', () => {
  test('says when the token stops, that it does not, that it no longer works, and what was pasted', async ({
    page
  }) => {
    const run = randomUUID().slice(0, 8)
    const name = (label: string): string => `e2e-token-${run}-${label}`
    const ids: string[] = []
    const token = await signInByApi(ADMIN)
    try {
      await signIn(page, ADMIN)
      await page.waitForURL(/\/s\/[^/]+\/inbox/)
      const storeId = /\/s\/([^/]+)\//.exec(new URL(page.url()).pathname)?.[1] ?? ''
      expect(storeId).not.toBe('')
      await installChannel(token, storeId, ChannelIds.MESSENGER)

      const later = inDays(30)
      const soon = inDays(3)
      const gone = inDays(-2)
      const cases = {
        far: { kind: 'page', isValid: true, expiresAt: later },
        near: { kind: 'page', isValid: true, expiresAt: soon },
        never: { kind: 'page', isValid: true, expiresAt: null },
        expired: { kind: 'page', isValid: true, expiresAt: gone },
        invalid: { kind: 'page', isValid: false, expiresAt: null },
        user: { kind: 'user', isValid: true, expiresAt: inDays(40) }
      }
      for (const [label, tokenInfo] of Object.entries(cases)) {
        ids.push(await addConnectionWithTokenInfo(storeId, { name: name(label), tokenInfo }))
      }
      // One that was never asked about: the card says nothing of the token
      ids.push(await addConnectionWithTokenInfo(storeId, { name: name('unknown') }))

      await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.CHANNELS))
      const card = (label: string) =>
        page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: name(label) }) })
      await expect(card('far')).toBeVisible()

      // A date far away is plain text; one within the week is a status with the same words
      await expect(
        card('far').getByText(health.expires.replace('{date}', await written(page, later)))
      ).toBeVisible()
      await expect(
        card('far')
          .getByRole('status')
          .filter({ hasText: /The token expires/ })
      ).toHaveCount(0)
      const warning = card('near')
        .getByRole('status')
        .filter({ hasText: /The token expires/ })
      await expect(warning).toHaveText(health.expires.replace('{date}', await written(page, soon)))

      await expect(card('never').getByText(health.never)).toBeVisible()
      // A token that stopped, and one that Meta says is not valid, are alerts that say what to do
      await expect(card('expired').getByRole('alert')).toHaveText(
        health.expired.replace('{date}', await written(page, gone))
      )
      await expect(card('invalid').getByRole('alert')).toHaveText(health.invalid)

      // The token of a person: the card says which one the channel needs, and still tells its date
      await expect(card('user').getByText(health.userToken)).toBeVisible()
      await expect(
        card('user').getByText(health.expires.replace('{date}', await written(page, inDays(40))))
      ).toBeVisible()

      // Not known is not said: no word about the token, in particular not that it expired
      const unknown = card('unknown')
      await expect(unknown).toBeVisible()
      for (const text of [health.never, health.invalid, health.userToken]) {
        await expect(unknown.getByText(text)).toHaveCount(0)
      }
      await expect(unknown.getByText(/The token (expires|expired)/)).toHaveCount(0)
    } finally {
      await removeConnections(ids)
    }
  })
})
