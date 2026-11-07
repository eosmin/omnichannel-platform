import { AppPaths, StoreSettingsSections } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const behavior = en.settings.inbox

// A button that waits for the server (`Button busy`) is off at once and shows a spinner after 400 ms. The
// spinner is laid over the button: at no moment, before it shows or after, may the button change size (a layout
// jump). The save of the inbox behavior is held for the whole case and refused at the end, so nothing is stored.
test('a button that waits for the server keeps its size when the spinner shows', async ({
  page
}) => {
  await signIn(page, 'admin4@test.com')
  const storeId = await storeIdNamed(FIRST_STORE)
  await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.INBOX))

  const form = page.getByRole('form', { name: behavior.behaviorLabel })
  // A valid change that is not stored: the threshold of the load, one more than it is
  const threshold = form.getByLabel(behavior.load.threshold)
  await threshold.fill(String(Number(await threshold.inputValue()) + 1))
  const save = form.getByRole('button', { name: behavior.save })
  // The size only: the click can scroll the page, and then the position changes
  const sizeOf = async (): Promise<{ width: number; height: number }> => {
    const box = await save.boundingBox()
    expect(box).not.toBeNull()
    return { width: box?.width ?? 0, height: box?.height ?? 0 }
  }
  const before = await sizeOf()

  let release: () => void = () => undefined
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  await page.route('**/settings/inbox', async route => {
    if (route.request().method() === 'GET') {
      await route.fallback()
      return
    }
    await held
    await route.abort()
  })

  await save.click()
  try {
    await expect(save).toHaveAttribute('aria-busy', 'true')
    // Before the spinner shows (it takes 400 ms): the same size, sampled while it is still hidden
    await expect(save.locator('.busy-spinner')).toHaveCSS('opacity', '0')
    expect(await sizeOf()).toEqual(before)

    // After: the spinner is visible and the size is still the same
    const spinner = save.locator('.busy-spinner')
    await expect(spinner).toHaveCSS('opacity', '1', { timeout: 3000 })
    expect(await sizeOf()).toEqual(before)
  } finally {
    release()
  }
})
