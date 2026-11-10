import { expect, test } from '@playwright/test'

import { maxInWindow, seedLinkBudget, waitForLinkBudget } from '../support/link-budget'

// The wait for room in the window of the magic link is not the time of the case (a case that signs in as
// an address the others have just used waited, and failed at 30 s before it began). The proof is a case
// with a timeout (1.5 s) shorter than its wait (about 2.5 s): it passes only because the timeout grew by the wait, and it does
// not grow when there is no wait. The assertions keep their own timeout.
test.describe('the wait for the budget of the magic link', () => {
  test('grows the timeout of the case by what it waits, and by nothing more', async () => {
    test.setTimeout(1_500)
    const address = `probe-${Date.now()}@test.com`
    // Enough links in the last seconds to fill the window (one below the limit of the api); the oldest leaves
    // it in about two and a half seconds
    const now = Date.now()
    seedLinkBudget(address, [
      now - 59_500,
      ...Array.from({ length: maxInWindow() - 1 }, (_, i) => now - 5_000 + i)
    ])

    const before = test.info().timeout
    const startedAt = Date.now()
    await waitForLinkBudget(address)
    const waited = Date.now() - startedAt

    expect(waited).toBeGreaterThan(1_500)
    // Grown by about the wait
    const grown = test.info().timeout - before
    expect(grown).toBeGreaterThanOrEqual(waited - 500)
    expect(grown).toBeLessThanOrEqual(waited + 1_500)
  })

  test('leaves the timeout alone when there is room', async () => {
    test.setTimeout(3_000)
    const before = test.info().timeout
    await waitForLinkBudget(`room-${Date.now()}@test.com`)
    expect(test.info().timeout).toBe(before)
  })
})
