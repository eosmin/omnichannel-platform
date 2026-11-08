import { randomUUID } from 'node:crypto'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { ChannelIds } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { installChannel, signInByApi } from '../support/api'
import { addConnectionWithTokenInfo, removeConnections, setUserTimezone } from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const ADMIN = 'admin3@test.com'
const health = en.settings.channels.health.token
const DAY = 86_400_000

// The page writes a date in the zone of the account, so the case fixes the zone of the person and writes the
// expected date in that same zone (that the page follows the account, and not the machine, is the case of
// `time-zone.spec.ts`; the other fallbacks are not this case's). It used to ask the browser, which in CI is UTC,
// and for the first hours of every UTC day (00:00 to about 05:00) the page, in the zone of the account, was still on
// the day before: the case failed at those hours and passed at the rest.
const ZONE = 'UTC'
// Noon of the day, in that zone: far from midnight, so a date cannot change day by an hour or by a zone near it
const inDays = (days: number): string => {
  const at = new Date(Date.now() + days * DAY)
  at.setUTCHours(12, 0, 0, 0)
  return at.toISOString()
}

// The date as the page writes it (English, in the fixed zone)
const written = (iso: string): string =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: ZONE }).format(new Date(iso))

// What the platform learned of the token of each connection from the provider (the daily job and every connect),
// drawn in the card of the connection
test.describe('Settings → Channels: the token of a connection', () => {
  test('says when the token stops, that it does not, that it no longer works, and what was pasted', async ({
    page
  }) => {
    const run = randomUUID().slice(0, 8)
    const name = (label: string): string => `e2e-token-${run}-${label}`
    const ids: string[] = []
    // Fixed before the sign in, put back at the end: other cases read the same person
    const zoneBefore = await setUserTimezone(ADMIN, ZONE)
    try {
      const token = await signInByApi(ADMIN)
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
        card('far').getByText(health.expires.replace('{date}', written(later)))
      ).toBeVisible()
      await expect(
        card('far')
          .getByRole('status')
          .filter({ hasText: /The token expires/ })
      ).toHaveCount(0)
      const warning = card('near')
        .getByRole('status')
        .filter({ hasText: /The token expires/ })
      await expect(warning).toHaveText(health.expires.replace('{date}', written(soon)))

      await expect(card('never').getByText(health.never)).toBeVisible()
      // A token that stopped, and one that Meta says is not valid, are alerts that say what to do
      await expect(card('expired').getByRole('alert')).toHaveText(
        health.expired.replace('{date}', written(gone))
      )
      await expect(card('invalid').getByRole('alert')).toHaveText(health.invalid)

      // The token of a person: the card says which one the channel needs, and still tells its date
      await expect(card('user').getByText(health.userToken)).toBeVisible()
      await expect(
        card('user').getByText(health.expires.replace('{date}', written(inDays(40))))
      ).toBeVisible()

      // Not known is not said: no word about the token, in particular not that it expired
      const unknown = card('unknown')
      await expect(unknown).toBeVisible()
      for (const text of [health.never, health.invalid, health.userToken]) {
        await expect(unknown.getByText(text)).toHaveCount(0)
      }
      await expect(unknown.getByText(/The token (expires|expired)/)).toHaveCount(0)
    } finally {
      // The zone goes back even when the cleanup fails
      try {
        await removeConnections(ids)
      } finally {
        await setUserTimezone(ADMIN, zoneBefore)
      }
    }
  })
})
