import type { Locator, Page } from '@playwright/test'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { API_PREFIX, ApiRoutes } from '@platform/core/api'
import { TenantHeaders } from '@platform/core/auth'
import { ChannelIds, MetaOAuthScopes } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'

import en from '../../web/messages/en.json' with { type: 'json' }
import { installChannel, signInByApi, uninstallChannel } from '../support/api'
import { expectDialogHoldsItsContent } from '../support/dialog-fit'
import { API_URL, WEB_URL } from '../support/env'
import {
  FAKE_APP_ID,
  FAKE_LOGIN_CODE,
  FAKE_IG_USERNAME,
  FAKE_LOGIN_CODE_CLEARED,
  FAKE_PAGE_ID,
  FAKE_PAGE_NAME,
  FAKE_NO_IG_PAGE_NAME,
  FAKE_PAGE_TOKEN,
  FAKE_USER_TOKEN,
  type FakeGraph,
  startFakeGraph
} from '../support/fake-graph'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

// An administrator of two stores, with a magic link budget of his own: admin@test.com is the one the specs that
// follow this one sign in as, and a spec that spends its budget makes the next ones wait
const ADMIN = 'multi-store@test.com'
const channels = en.settings.channels
const CALLBACK = `${API_URL}${API_PREFIX}${ApiRoutes.channels.oauthCallback}`
const MESSENGER_NAME = 'Messenger'
const INSTAGRAM_NAME = 'Instagram'

// A name as a pattern, with nothing in it taken for a metacharacter
function exactly(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function storeIdOf(page: Page): string {
  const storeId = /\/s\/([^/]+)\//.exec(new URL(page.url()).pathname)?.[1]
  expect(storeId).toBeDefined()
  return storeId ?? ''
}

// Facebook is not reachable from the suite: the page goes to the dialog of Facebook, and this answers for it the
// way Facebook does, with a redirect to the callback of the api (which is real, and trades the code at the fake
// Graph). `answer` says what the person did in the dialog. Every address the page was sent to is kept.
async function facebookSays(page: Page, answer: (state: string) => string): Promise<URL[]> {
  const asked: URL[] = []
  await page.route('https://www.facebook.com/**', route => {
    const url = new URL(route.request().url())
    asked.push(url)
    return route.fulfill({
      status: 302,
      headers: { location: answer(url.searchParams.get('state') ?? '') }
    })
  })
  return asked
}

// The id of the session that the callback sent the browser back with, read from its own answer: the page
// takes it out of the address at once, so this is the one place a test can see it
function watchSession(page: Page): { current: () => string | null } {
  let session: string | null = null
  page.on('response', response => {
    if (!response.url().startsWith(CALLBACK)) return
    const location = response.headers()['location']
    if (location !== undefined) session = new URL(location).searchParams.get('oauth')
  })
  return { current: () => session }
}

test.describe('Connect with Facebook', () => {
  let graph: FakeGraph
  test.beforeAll(async () => {
    graph = await startFakeGraph()
  })
  test.afterAll(async () => {
    await graph.close()
  })

  test('connects a Page found through its portfolio, tells which permission was cleared, a no, and drops a session left open', async ({
    page
  }) => {
    // The scenarios share two sessions of the administrator (the page and the api): each sign in spends the magic
    // link budget of the address, and the budget of this address is the scarce thing, not the time
    test.setTimeout(180_000)
    const token = await signInByApi(ADMIN)
    let storeId: string | undefined
    try {
      await signIn(page, ADMIN)
      await page.waitForURL(/\/s\/[^/]+\/inbox/)
      storeId = storeIdOf(page)
      await installChannel(token, storeId, ChannelIds.MESSENGER)
      const session = watchSession(page)
      const channelsPage = AppPaths.store.settings(storeId, StoreSettingsSections.CHANNELS)
      const connectButton = page.getByRole('button', {
        name: `${channels.add.connect} ${MESSENGER_NAME}`,
        exact: false
      })
      const openConnectDialog = async () => {
        await page.goto(channelsPage)
        await expect(connectButton).toBeVisible({ timeout: 30_000 })
        await connectButton.click()
        const dialog = page.getByRole('dialog', {
          name: channels.connectDialog.title.replace('{name}', MESSENGER_NAME)
        })
        await expect(dialog).toBeVisible()
        return dialog
      }

      // 1. The way in is Facebook, and the pasted token is one link away
      let asked = await facebookSays(
        page,
        state => `${CALLBACK}?code=${FAKE_LOGIN_CODE}&state=${state}`
      )
      let dialog = await openConnectDialog()
      await expect(
        dialog.getByRole('button', { name: channels.connectDialog.facebook })
      ).toBeVisible()
      await expect(dialog.getByLabel(channels.connect.messenger.accessToken)).toHaveCount(0)
      await expect(
        dialog.getByRole('button', { name: channels.connectDialog.useToken })
      ).toBeVisible()
      await expectDialogHoldsItsContent(page, dialog)

      // 2. Facebook says yes: the Pages of the person come back, found through the portfolio
      await dialog.getByRole('button', { name: channels.connectDialog.facebook }).click()
      let pick = page.getByRole('dialog', { name: channels.oauth.pick.title })
      await expect(pick).toBeVisible({ timeout: 30_000 })
      // The page asked the right app for the right permissions, with the callback of the api, and a state
      expect(asked).toHaveLength(1)
      const dialogUrl = asked[0]
      expect(dialogUrl?.searchParams.get('client_id')).toBe(FAKE_APP_ID)
      expect(dialogUrl?.searchParams.get('redirect_uri')).toBe(CALLBACK)
      expect(dialogUrl?.searchParams.get('response_type')).toBe('code')
      expect(dialogUrl?.searchParams.get('scope')).toContain(MetaOAuthScopes.PAGES_READ_ENGAGEMENT)
      expect(dialogUrl?.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
      // The id of the session is out of the address, and nowhere the browser keeps for later
      const sessionId = session.current()
      expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(page.url()).not.toContain(sessionId ?? 'x')
      await expect(page).toHaveURL(url => url.search === '')
      const stored = await page.evaluate(() =>
        JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })
      )
      expect(stored).not.toContain(sessionId ?? 'x')
      // Messenger takes either Page of the portfolio, so none is chosen until the person chooses; the list holds
      // no token or secret
      const pageRadio = pick.getByRole('radio', { name: FAKE_PAGE_NAME, exact: true })
      await expect(pageRadio).not.toBeChecked()
      await expect(pick).not.toContainText(FAKE_PAGE_TOKEN)
      await expect(pick).not.toContainText(FAKE_USER_TOKEN)
      await expectDialogHoldsItsContent(page, pick)
      await pageRadio.check()
      await pick.getByRole('button', { name: channels.oauth.pick.submit, exact: true }).click()
      await expect(
        page.getByText(channels.oauth.pick.connected.replace('{name}', FAKE_PAGE_NAME))
      ).toBeVisible()
      await expect(page.getByRole('heading', { name: FAKE_PAGE_NAME })).toBeVisible()
      // Exactly one subscription, of this Page: the fake is new for this file
      expect(graph.subscriptions()).toEqual([FAKE_PAGE_ID])
      // A connection made: the session is gone from the server
      await expect
        .poll(() => assetsStatus(token, storeId ?? '', sessionId ?? ''), { timeout: 10_000 })
        .toBe(HttpStatusCodes.NOT_FOUND)

      // 3. The person cleared a permission in the dialog: it is named, and nothing is connected
      await uninstallChannel(token, storeId, ChannelIds.MESSENGER)
      await installChannel(token, storeId, ChannelIds.MESSENGER)
      await page.unroute('https://www.facebook.com/**')
      asked = await facebookSays(
        page,
        state => `${CALLBACK}?code=${FAKE_LOGIN_CODE_CLEARED}&state=${state}`
      )
      dialog = await openConnectDialog()
      await dialog.getByRole('button', { name: channels.connectDialog.facebook }).click()
      pick = page.getByRole('dialog', { name: channels.oauth.pick.title })
      await expect(pick).toBeVisible({ timeout: 30_000 })
      await expect(pick.getByRole('alert')).toHaveText(channels.connectFailure.permission_missing)
      await expect(pick.getByText(MetaOAuthScopes.PAGES_READ_ENGAGEMENT)).toBeVisible()
      await expect(pick.getByText(channels.oauth.pick.missingHelp)).toBeVisible()
      await expect(
        pick.getByRole('button', { name: channels.oauth.pick.submit, exact: true })
      ).toHaveCount(0)
      await expectDialogHoldsItsContent(page, pick)
      await pick.getByRole('button', { name: channels.oauth.pick.close }).click()
      await expect(pick).toBeHidden()
      // The list is drawn (the store may hold other connections, so it is the list or the empty notice) and the
      // Page is not in it: nothing was connected
      await expect(
        page
          .getByRole('list', { name: channels.listLabel })
          .or(page.getByRole('heading', { name: channels.empty.title }))
      ).toBeVisible()
      await expect(page.getByRole('heading', { name: FAKE_PAGE_NAME })).toHaveCount(0)

      // 4. The person says no in the dialog of Facebook: a plain message, and the address stays clean
      await page.unroute('https://www.facebook.com/**')
      await facebookSays(
        page,
        state => `${CALLBACK}?error=access_denied&error_reason=user_denied&state=${state}`
      )
      dialog = await openConnectDialog()
      await dialog.getByRole('button', { name: channels.connectDialog.facebook }).click()
      const notice = page
        .getByRole('alert')
        .filter({ hasText: channels.connectFailure.oauth_cancelled })
      await expect(notice).toBeVisible({ timeout: 30_000 })
      await expect(page).toHaveURL(url => url.search === '')
      await notice.getByRole('button', { name: channels.oauth.dismiss }).click()
      await expect(notice).toBeHidden()

      // 5. Closing the Pages without choosing drops the session on the server
      await page.unroute('https://www.facebook.com/**')
      await facebookSays(page, state => `${CALLBACK}?code=${FAKE_LOGIN_CODE}&state=${state}`)
      dialog = await openConnectDialog()
      await dialog.getByRole('button', { name: channels.connectDialog.facebook }).click()
      pick = page.getByRole('dialog', { name: channels.oauth.pick.title })
      await expect(pick).toBeVisible({ timeout: 30_000 })
      const left = session.current()
      expect(left).toMatch(/^[A-Za-z0-9_-]{43}$/)
      await expect
        .poll(() => assetsStatus(token, storeId ?? '', left ?? ''), { timeout: 10_000 })
        .toBe(HttpStatusCodes.OK)
      await page.keyboard.press('Escape')
      await expect(pick).toBeHidden()
      await expect
        .poll(() => assetsStatus(token, storeId ?? '', left ?? ''), { timeout: 10_000 })
        .toBe(HttpStatusCodes.NOT_FOUND)

      // 6. A login that could not say which store it was for lands on the channels of the last one, with the reason
      await page.goto(`${WEB_URL}/?oauth_error=oauth_expired`)
      await page.waitForURL(/\/s\/[^/]+\/settings\/channels/)
      await expect(
        page.getByRole('alert').filter({ hasText: channels.connectFailure.oauth_expired })
      ).toBeVisible()
      await expect(page).toHaveURL(url => url.search === '')
      // A value that is not of the list is never painted: the generic message shows
      await page.goto(`${WEB_URL}/?oauth_error=${encodeURIComponent('<b>boom</b>')}`)
      await page.waitForURL(/\/s\/[^/]+\/settings\/channels/)
      await expect(
        page.getByRole('alert').filter({ hasText: channels.oauth.failedGeneric })
      ).toBeVisible()
      await expect(page.locator('body')).not.toContainText('boom')
    } finally {
      if (storeId !== undefined) await uninstallChannel(token, storeId, ChannelIds.MESSENGER)
    }
  })

  test('connects Messenger and Instagram on one Page in both orders, and offers no Instagram on a Page that has none', async ({
    page
  }) => {
    // The same two sessions of the administrator as above, and four logins
    test.setTimeout(300_000)
    const token = await signInByApi(ADMIN)
    let storeId: string | undefined
    try {
      await signIn(page, ADMIN)
      await page.waitForURL(/\/s\/[^/]+\/inbox/)
      storeId = storeIdOf(page)
      const channelsPage = AppPaths.store.settings(storeId, StoreSettingsSections.CHANNELS)
      const install = async () => {
        await installChannel(token, storeId ?? '', ChannelIds.MESSENGER)
        await installChannel(token, storeId ?? '', ChannelIds.INSTAGRAM)
      }
      await install()
      await facebookSays(page, state => `${CALLBACK}?code=${FAKE_LOGIN_CODE}&state=${state}`)

      // The Pages dialog of a login started from the connect dialog of a channel
      const openPages = async (name: string): Promise<Locator> => {
        await page.goto(channelsPage)
        const button = page.getByRole('button', {
          name: `${channels.add.connect} ${name}`,
          exact: false
        })
        await expect(button).toBeVisible({ timeout: 30_000 })
        await button.click()
        const dialog = page.getByRole('dialog', {
          name: channels.connectDialog.title.replace('{name}', name)
        })
        await dialog.getByRole('button', { name: channels.connectDialog.facebook }).click()
        const pick = page.getByRole('dialog', { name: channels.oauth.pick.title })
        await expect(pick).toBeVisible({ timeout: 30_000 })
        return pick
      }
      const submit = (pick: Locator) =>
        pick.getByRole('button', { name: channels.oauth.pick.submit, exact: true }).click()

      const connectMessenger = async () => {
        const pick = await openPages(MESSENGER_NAME)
        // Messenger has no use for an Instagram account: both Pages can be chosen
        await expect(pick.getByRole('radio', { name: FAKE_NO_IG_PAGE_NAME })).toBeEnabled()
        await pick.getByRole('radio', { name: FAKE_PAGE_NAME, exact: true }).check()
        await submit(pick)
        await expect(
          page.getByText(channels.oauth.pick.connected.replace('{name}', FAKE_PAGE_NAME))
        ).toBeVisible()
      }
      const connectInstagram = async () => {
        const pick = await openPages(INSTAGRAM_NAME)
        // The Page that links an account is the one choice, and says which account; the other is shown, says
        // it has none, and cannot be chosen
        const linked = pick.getByRole('radio', {
          name: new RegExp(`^${exactly(FAKE_PAGE_NAME)}\\s+Instagram: @`)
        })
        await expect(linked).toBeChecked()
        await expect(linked).toBeEnabled()
        await expect(pick.getByText(`Instagram: @${FAKE_IG_USERNAME}`)).toBeVisible()
        await expect(
          pick.getByRole('radio', { name: new RegExp(FAKE_NO_IG_PAGE_NAME) })
        ).toBeDisabled()
        await expect(pick.getByText(channels.oauth.pick.noInstagram)).toBeVisible()
        await submit(pick)
        await expect(
          page.getByText(channels.oauth.pick.connected.replace('{name}', FAKE_IG_USERNAME))
        ).toBeVisible()
      }
      const bothAreThere = async () => {
        await expect(page.getByRole('heading', { name: FAKE_PAGE_NAME, exact: true })).toBeVisible()
        await expect(
          page.getByRole('heading', { name: FAKE_IG_USERNAME, exact: true })
        ).toBeVisible()
      }

      // Messenger first, then Instagram on the Page it shares
      await connectMessenger()
      await connectInstagram()
      await page.goto(channelsPage)
      await bothAreThere()

      // Instagram first, then Messenger: the other order, from a store with neither
      await uninstallChannel(token, storeId, ChannelIds.MESSENGER)
      await uninstallChannel(token, storeId, ChannelIds.INSTAGRAM)
      await install()
      await connectInstagram()
      await connectMessenger()
      await page.goto(channelsPage)
      await bothAreThere()

      // A connection that broke is repaired from its own card, and stays one card: Meta refuses its token (the
      // person removed the app), the card says so, and the login takes the Page the connection already is
      graph.breakPageToken(true)
      await page
        .getByRole('button', { name: `${channels.test.action} ${FAKE_PAGE_NAME}`, exact: true })
        .click()
      const reconnect = page.getByRole('button', {
        name: `${channels.oauth.reconnect} ${FAKE_PAGE_NAME}`,
        exact: true
      })
      await expect(reconnect).toBeVisible({ timeout: 30_000 })
      graph.breakPageToken(false)
      await reconnect.click()
      const repair = page.getByRole('dialog', { name: channels.oauth.pick.title })
      await expect(repair).toBeVisible({ timeout: 30_000 })
      await expect(repair.getByText(channels.oauth.pick.repairHint)).toBeVisible()
      // The Page of the connection is marked and chosen, and the other one is not
      const current = repair.getByRole('radio', {
        name: new RegExp(
          `^${exactly(FAKE_PAGE_NAME)}\\s+${exactly(channels.oauth.pick.currentPage)}`
        )
      })
      await expect(current).toBeChecked()
      await submit(repair)
      await expect(
        page.getByText(channels.oauth.pick.repaired.replace('{name}', FAKE_PAGE_NAME))
      ).toBeVisible()
      await expect(page.getByRole('heading', { name: FAKE_PAGE_NAME, exact: true })).toHaveCount(1)
      await expect(reconnect).toHaveCount(0)
    } finally {
      // Whatever failed above is what the report shows: a cleanup that cannot run must not replace it
      if (storeId !== undefined) {
        await Promise.allSettled([
          uninstallChannel(token, storeId, ChannelIds.MESSENGER),
          uninstallChannel(token, storeId, ChannelIds.INSTAGRAM)
        ])
      }
    }
  })
})

// What the api says of a session to the person it belongs to: 200 while it exists, 404 once it was used or dropped
async function assetsStatus(token: string, storeId: string, sessionId: string): Promise<number> {
  const response = await fetch(
    `${API_URL}${API_PREFIX}${ApiRoutes.channels.oauthAssets(encodeURIComponent(sessionId))}`,
    { headers: { authorization: `Bearer ${token}`, [TenantHeaders.STORE_ID]: storeId } }
  )
  return response.status
}
