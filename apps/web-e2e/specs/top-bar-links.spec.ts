import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const MIN_TOUCH = 40

// The links of the top bar are read whole on the two widths of a phone: none is cut by the edge of its bar, the
// bar scrolls to nothing, and they sit on a row of their own that a finger can hit (QA 69: "Customers" showed as
// "Custome" at 390 px). A spec of its own: it signs in once and asks for little.
test('the links of the top bar are whole on a phone', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true
  })
  try {
    await reachServicesFromOwnAddress(context)
    const page = await context.newPage()
    await signIn(page, 'admin2@test.com')
    const storeId = await storeIdNamed(FIRST_STORE)
    await page.goto(AppPaths.store.inbox(storeId))
    const nav = page.getByRole('navigation', { name: en.shell.nav.label })
    // The five of them, the one that was cut among them: a bar with fewer would measure nothing
    for (const label of [
      en.shell.nav.inbox,
      en.shell.nav.customers,
      en.shell.nav.products,
      en.shell.nav.exports,
      en.shell.nav.settings
    ]) {
      await expect(nav.getByRole('link', { name: label })).toBeVisible()
    }
    // On a row of their own, under the store and the account menu
    const above = await page.getByRole('banner').getByRole('button').last().boundingBox()
    const row = await nav.boundingBox()
    expect(above).not.toBeNull()
    expect(row).not.toBeNull()
    expect(row?.y ?? 0).toBeGreaterThanOrEqual((above?.y ?? 0) + (above?.height ?? 0) - 1)
    // The size of a finger
    const links = nav.getByRole('link')
    for (let at = 0; at < (await links.count()); at++) {
      const box = await links.nth(at).boundingBox()
      expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(MIN_TOUCH)
    }

    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 })
      const fit = await nav.evaluate(
        element =>
          new Promise<{ scrollWidth: number; clientWidth: number; cut: string[] }>(resolve =>
            requestAnimationFrame(() => {
              const frame = element.getBoundingClientRect()
              const cut = Array.from(element.querySelectorAll('a'))
                .filter(link => {
                  const box = link.getBoundingClientRect()
                  return box.left < frame.left - 1 || box.right > frame.right + 1
                })
                .map(link => link.textContent)
              resolve({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, cut })
            })
          )
      )
      expect(fit.cut, `links cut by the bar at ${width}px`).toEqual([])
      expect(fit.scrollWidth, `the bar scrolls at ${width}px`).toBeLessThanOrEqual(fit.clientWidth)
    }
  } finally {
    await context.close()
  }
})
