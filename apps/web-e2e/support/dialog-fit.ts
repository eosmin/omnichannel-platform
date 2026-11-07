import type { Locator, Page } from '@playwright/test'

import { expect } from './test'

// A dialog holds its content: nothing is wider or taller than the box, and its buttons are inside it, on a phone
// and on a desktop (a long address or a wide field must not push the box wider than the screen)
const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1280, height: 800 }
const SCREENS = [PHONE, DESKTOP]
// The two widths of a phone where the width is the only thing measured (MODAL-390): a dialog with a long list
// scrolls down by design, and it never scrolls sideways
const PHONE_SCREENS = [PHONE, { width: 360, height: 740 }]

// Nothing sticks out of the box to the side, on the two phone widths
export async function expectDialogFitsThePhoneWidth(page: Page, dialog: Locator): Promise<void> {
  await measureDialog(page, dialog, PHONE_SCREENS, false)
}

export async function expectDialogHoldsItsContent(page: Page, dialog: Locator): Promise<void> {
  await measureDialog(page, dialog, SCREENS, true)
}

async function measureDialog(
  page: Page,
  dialog: Locator,
  screens: readonly { width: number; height: number }[],
  isHeightMeasured: boolean
): Promise<void> {
  const original = page.viewportSize()
  try {
    for (const screen of screens) {
      await page.setViewportSize(screen)
      // Everything is measured in one go, after the layout of the new size has settled
      const box = await dialog.evaluate(
        element =>
          new Promise<{
            scrollWidth: number
            clientWidth: number
            scrollHeight: number
            clientHeight: number
            left: number
            right: number
            stray: number
          }>(resolve =>
            requestAnimationFrame(() => {
              const frame = element.getBoundingClientRect()
              // Controls and text that stick out of the box on either side
              const stray = Array.from(element.querySelectorAll('button, input, code, p')).filter(
                item => {
                  const rect = item.getBoundingClientRect()
                  return rect.left < frame.left - 1 || rect.right > frame.right + 1
                }
              ).length
              resolve({
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
                scrollHeight: element.scrollHeight,
                clientHeight: element.clientHeight,
                left: frame.left,
                right: frame.right,
                stray
              })
            })
          )
      )
      expect(box.scrollWidth, `no horizontal scroll at ${screen.width}px`).toBeLessThanOrEqual(
        box.clientWidth
      )
      if (isHeightMeasured) {
        expect(box.scrollHeight, `no vertical scroll at ${screen.width}px`).toBeLessThanOrEqual(
          box.clientHeight
        )
      }
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(screen.width)
      expect(box.stray, `nothing sticks out of the box at ${screen.width}px`).toBe(0)
    }
  } finally {
    if (original !== null) await page.setViewportSize(original)
  }
}
