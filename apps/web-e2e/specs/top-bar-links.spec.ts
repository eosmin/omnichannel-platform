import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const MIN_TOUCH = 44

// The links of the top bar are read whole on the two widths of a phone: they are behind one button of the bar, none
// is cut by an edge of the window, and each is the size of a finger (QA 69: "Customers" showed as "Custome" at
// 390 px; N-BR2-63: four rows of links over the thread). A spec of its own: it signs in once and asks for little.
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
    // On a phone the links are one button with the page the person is on; the links open under it
    const nav = page.getByRole('navigation', { name: en.shell.nav.label })
    const menu = nav.getByRole('button')
    await expect(menu).toBeVisible()
    await expect(menu).toHaveText(en.shell.nav.inbox)
    // One row: the bar is as tall as its controls, not several rows of links
    const bar = await page.getByRole('banner').boundingBox()
    expect(bar?.height ?? Infinity).toBeLessThan(2 * MIN_TOUCH)

    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 844 })
      await menu.click()
      const links = page.getByRole('menu').getByRole('menuitem')
      // The five of them, the one that was cut among them: a menu with fewer would measure nothing
      for (const label of [
        en.shell.nav.inbox,
        en.shell.nav.customers,
        en.shell.nav.products,
        en.shell.nav.exports,
        en.shell.nav.settings
      ]) {
        await expect(links.filter({ hasText: label })).toBeVisible()
      }
      // None is cut by an edge of the window, and each is the size of a finger
      const count = await links.count()
      for (let at = 0; at < count; at++) {
        const box = await links.nth(at).boundingBox()
        expect(box).not.toBeNull()
        expect(box?.x ?? -1, `link ${at} at ${width}px`).toBeGreaterThanOrEqual(0)
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(width)
        expect(Math.min(box?.width ?? 0, box?.height ?? 0)).toBeGreaterThanOrEqual(MIN_TOUCH)
      }
      await page.keyboard.press('Escape')
    }
  } finally {
    await context.close()
  }
})
