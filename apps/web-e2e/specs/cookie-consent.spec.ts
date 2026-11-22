import type { BrowserContext, Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { API_PREFIX, ApiRoutes } from '@platform/core/api'
import { COOKIE_CONSENT_COOKIE_NAME, COOKIE_POLICY_VERSION } from '@platform/core/cookie-consent'

import en from '../../web/messages/en.json' with { type: 'json' }
import { ANSWERED_VISITOR_ID } from '../support/cookie-consent'
import { WEB_URL } from '../support/env'
import { expect, test } from '../support/test'

const t = en.cookieConsent
const CONSENT_PATH = `${API_PREFIX}${ApiRoutes.compliance.cookieConsent}`
const isConsentCall = (url: string): boolean => new URL(url).pathname === CONSENT_PATH

// The context of `test` carries an answered cookie so that the banner does not stand over the other specs; this spec is about the
// banner, so it starts as a visitor who has not answered
async function visitorWhoHasNotAnswered(context: BrowserContext): Promise<void> {
  await context.clearCookies({ name: COOKIE_CONSENT_COOKIE_NAME })
}

async function storedChoice(context: BrowserContext): Promise<string | undefined> {
  const cookie = (await context.cookies(WEB_URL)).find(
    item => item.name === COOKIE_CONSENT_COOKIE_NAME
  )
  return cookie === undefined ? undefined : decodeURIComponent(cookie.value)
}

const banner = (page: Page) => page.getByRole('region', { name: t.bannerTitle })

test.describe('the cookie banner', () => {
  test.beforeEach(async ({ context }) => visitorWhoHasNotAnswered(context))

  test('asks, does not block the page, and writes nothing before an answer', async ({
    page,
    context
  }) => {
    await page.goto(AppPaths.login)
    await expect(banner(page)).toBeVisible()
    expect(await storedChoice(context)).toBeUndefined()
    // The app works with the banner open
    await page.getByLabel(en.login.emailLabel).fill('person@example.com')
    await expect(page.getByLabel(en.login.emailLabel)).toHaveValue('person@example.com')
  })

  test('"only essential" records everything optional as off, keeps it, and does not ask again', async ({
    page,
    context
  }) => {
    await page.goto(AppPaths.login)
    const call = page.waitForResponse(response => isConsentCall(response.url()))
    await banner(page).getByRole('button', { name: t.reject }).click()
    const response = await call
    expect(response.status()).toBe(200)
    expect(response.request().postDataJSON()).toMatchObject({
      categories: { functional: false, analytics: false, marketing: false },
      policyVersion: COOKIE_POLICY_VERSION
    })
    await expect(banner(page)).toBeHidden()
    await expect.poll(() => storedChoice(context)).toContain(`${COOKIE_POLICY_VERSION}.1.000.`)

    await page.reload()
    await expect(page.getByRole('heading', { name: en.login.title })).toBeVisible()
    await expect(banner(page)).toHaveCount(0)
  })

  test('"accept all" records everything as on', async ({ page, context }) => {
    await page.goto(AppPaths.login)
    const call = page.waitForResponse(response => isConsentCall(response.url()))
    await banner(page).getByRole('button', { name: t.accept }).click()
    expect((await call).request().postDataJSON()).toMatchObject({
      categories: { functional: true, analytics: true, marketing: true }
    })
    await expect.poll(() => storedChoice(context)).toContain(`${COOKIE_POLICY_VERSION}.1.111.`)
  })

  test('the panel starts with everything optional off, keeps the essential one on, and saves a mixed choice', async ({
    page,
    context
  }) => {
    await page.goto(AppPaths.login)
    await banner(page).getByRole('button', { name: t.customize }).click()
    const dialog = page.getByRole('dialog', { name: t.panelTitle })
    await expect(dialog).toBeVisible()
    const essential = dialog.getByRole('checkbox', { name: t.categories.necessary.label })
    await expect(essential).toBeChecked()
    await expect(essential).toBeDisabled()
    for (const category of ['functional', 'analytics', 'marketing'] as const) {
      await expect(
        dialog.getByRole('checkbox', { name: t.categories[category].label })
      ).not.toBeChecked()
    }
    await dialog.getByRole('checkbox', { name: t.categories.analytics.label }).check()
    const call = page.waitForResponse(response => isConsentCall(response.url()))
    await dialog.getByRole('button', { name: t.save }).click()
    expect((await call).request().postDataJSON()).toMatchObject({
      categories: { functional: false, analytics: true, marketing: false }
    })
    await expect(dialog).toBeHidden()
    await expect.poll(() => storedChoice(context)).toContain(`${COOKIE_POLICY_VERSION}.1.010.`)
  })

  test('the choice can be changed later from the button, which shows what is saved', async ({
    page,
    context
  }) => {
    await page.goto(AppPaths.login)
    await banner(page).getByRole('button', { name: t.accept }).click()
    await expect.poll(() => storedChoice(context)).toContain('.1.111.')

    await page.getByRole('button', { name: t.openPreferences }).click()
    const dialog = page.getByRole('dialog', { name: t.panelTitle })
    const marketing = dialog.getByRole('checkbox', { name: t.categories.marketing.label })
    await expect(marketing).toBeChecked()
    await marketing.uncheck()
    await dialog.getByRole('button', { name: t.save }).click()
    await expect.poll(() => storedChoice(context)).toContain('.1.110.')
  })

  test('works with the keyboard: Escape closes the panel and the focus goes back to its button', async ({
    page
  }) => {
    await page.goto(AppPaths.login)
    await page.getByRole('button', { name: t.openPreferences }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog', { name: t.panelTitle })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: t.panelTitle })).toBeHidden()
    await expect(page.getByRole('button', { name: t.openPreferences })).toBeFocused()
  })

  test('asks again when the policy text changed, with the same visitor id', async ({
    page,
    context
  }) => {
    await context.addCookies([
      {
        name: COOKIE_CONSENT_COOKIE_NAME,
        value: encodeURIComponent(`2020-01-01.1.111.${ANSWERED_VISITOR_ID}`),
        url: WEB_URL
      }
    ])
    await page.goto(AppPaths.login)
    await expect(banner(page)).toBeVisible()
    const call = page.waitForResponse(response => isConsentCall(response.url()))
    await banner(page).getByRole('button', { name: t.reject }).click()
    expect((await call).request().postDataJSON()).toMatchObject({ visitorId: ANSWERED_VISITOR_ID })
  })

  test('keeps the choice in the browser when the api cannot be reached, and sends it again on the next page', async ({
    page,
    context
  }) => {
    const unreachable = (url: URL): boolean => isConsentCall(url.toString())
    await page.route(unreachable, route => route.abort())
    await page.goto(AppPaths.login)
    await banner(page).getByRole('button', { name: t.reject }).click()
    await expect(banner(page)).toBeHidden()
    expect(await storedChoice(context)).toContain(`${COOKIE_POLICY_VERSION}.0.000.`)

    await page.unroute(unreachable)
    const retry = page.waitForResponse(response => isConsentCall(response.url()))
    await page.reload()
    expect((await retry).status()).toBe(200)
    await expect.poll(() => storedChoice(context)).toContain(`${COOKIE_POLICY_VERSION}.1.000.`)
    await expect(banner(page)).toHaveCount(0)
  })

  test('an answer given while the first one is still travelling is the one that is kept and sent', async ({
    page,
    context
  }) => {
    const posted: unknown[] = []
    let releaseFirst: () => void = () => undefined
    const firstHeld = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    await page.route(
      url => isConsentCall(url.toString()),
      async route => {
        posted.push(route.request().postDataJSON())
        if (posted.length === 1) await firstHeld
        await route.continue()
      }
    )
    await page.goto(AppPaths.login)
    await banner(page).getByRole('button', { name: t.accept }).click()
    await expect.poll(() => posted.length).toBe(1)
    // The first request has not ended: the person changes their mind
    await page.getByRole('button', { name: t.openPreferences }).click()
    await page
      .getByRole('dialog', { name: t.panelTitle })
      .getByRole('button', { name: t.reject })
      .click()
    expect(await storedChoice(context)).toContain(`${COOKIE_POLICY_VERSION}.0.000.`)
    releaseFirst()

    await expect.poll(() => storedChoice(context)).toContain(`${COOKIE_POLICY_VERSION}.1.000.`)
    expect(posted[posted.length - 1]).toMatchObject({
      categories: { functional: false, analytics: false, marketing: false }
    })
  })

  test('the banner floats over the page: fixed, and the content does not move when it mounts or leaves', async ({
    page,
    context
  }) => {
    await page.goto(AppPaths.login)
    const heading = page.getByRole('heading', { name: en.login.title })
    const form = page.getByLabel(en.login.emailLabel)
    await expect(banner(page)).toBeVisible()
    // Out of the flow: a banner in the normal flow would be `static` and would push the form
    await expect(banner(page)).toHaveCSS('position', 'fixed')
    const withBanner = { heading: await heading.boundingBox(), form: await form.boundingBox() }

    await banner(page).getByRole('button', { name: t.reject }).click()
    await expect(banner(page)).toBeHidden()
    const withoutBanner = { heading: await heading.boundingBox(), form: await form.boundingBox() }

    expect(withBanner.heading).not.toBeNull()
    expect(withBanner).toEqual(withoutBanner)
    // The page has no more height because of the banner either
    const scrollHeight = (): Promise<number> =>
      page.evaluate(() => document.documentElement.scrollHeight)
    const heightWithout = await scrollHeight()
    await context.clearCookies({ name: COOKIE_CONSENT_COOKIE_NAME })
    await page.reload()
    await expect(banner(page)).toBeVisible()
    expect(await scrollHeight()).toBe(heightWithout)
  })
})

// The default context of `test` is a visitor who already answered (everything optional off): the page draws no banner and ships none
// of its code, and the button fetches the panel when it is asked for
test.describe('a visitor who already answered', () => {
  test('changes the choice from the button, which shows what is saved', async ({
    page,
    context
  }) => {
    await page.goto(AppPaths.login)
    await expect(page.getByRole('heading', { name: en.login.title })).toBeVisible()
    await expect(banner(page)).toHaveCount(0)

    await page.getByRole('button', { name: t.openPreferences }).click()
    const dialog = page.getByRole('dialog', { name: t.panelTitle })
    await expect(dialog).toBeVisible()
    const functional = dialog.getByRole('checkbox', { name: t.categories.functional.label })
    await expect(functional).not.toBeChecked()
    await functional.check()
    const call = page.waitForResponse(response => isConsentCall(response.url()))
    await dialog.getByRole('button', { name: t.save }).click()
    expect((await call).request().postDataJSON()).toMatchObject({
      visitorId: ANSWERED_VISITOR_ID,
      categories: { functional: true, analytics: false, marketing: false }
    })
    await expect.poll(() => storedChoice(context)).toContain(`${COOKIE_POLICY_VERSION}.1.100.`)

    // Asked again, the panel opens again with what was just saved
    await page.getByRole('button', { name: t.openPreferences }).click()
    await expect(
      page
        .getByRole('dialog', { name: t.panelTitle })
        .getByRole('checkbox', { name: t.categories.functional.label })
    ).toBeChecked()
  })
})
