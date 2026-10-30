import type { Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { RealtimeEvents } from '@platform/core/realtime'

import { messagesOf, newConversationIn, storeIdNamed, userIdOf } from '../support/database'
import {
  ConnectionStatuses,
  dropConnection,
  enqueue,
  harnessPath,
  heard,
  statusOf,
  waitingOf
} from '../support/harness'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const START_SCREEN = /\/s\/[^/]+\/inbox$/
const FIRST_STORE = 'Main Store'
const OTHER_STORE = 'Tienda Escalón'

// Signs in, opens the test page of the store and waits for its socket to be up
async function openHarness(page: Page, email: string): Promise<string> {
  await signIn(page, email)
  // The start screen is still being reached; a navigation now would cut it
  await page.waitForURL(START_SCREEN)
  const storeId = await storeIdNamed(FIRST_STORE)
  await page.goto(harnessPath(storeId))
  await expect.poll(() => statusOf(page)).toBe(ConnectionStatuses.CONNECTED)
  return storeId
}

test.describe('the realtime client in the browser', () => {
  test('a message written with no connection is sent once when it returns', async ({
    page,
    context
  }) => {
    const storeId = await openHarness(page, 'admin@test.com')
    const conversationId = await newConversationIn(storeId)

    await context.setOffline(true)
    await dropConnection(page)
    await expect.poll(() => statusOf(page)).not.toBe(ConnectionStatuses.CONNECTED)

    const pendingId = await enqueue(page, conversationId, 'written with no connection')
    expect(await waitingOf(page)).toBe(1)
    expect(await messagesOf(conversationId)).toHaveLength(0)

    await context.setOffline(false)

    // The reconnection backs off, so the wait is longer than the default
    await expect.poll(() => waitingOf(page), { timeout: 20_000 }).toBe(0)
    await expect
      .poll(() => messagesOf(conversationId))
      .toEqual([{ content: 'written with no connection', idempotencyKey: pendingId }])
  })

  test('two sockets of one store hear each other', async ({ page, browser }) => {
    await openHarness(page, 'admin@test.com')

    const agentContext = await browser.newContext()
    await reachServicesFromOwnAddress(agentContext)
    try {
      const agentPage = await agentContext.newPage()
      const storeId = await openHarness(agentPage, 'agent@test.com')
      const agentId = await userIdOf('agent@test.com')

      await expect
        .poll(() => heard(page, RealtimeEvents.USER_ONLINE))
        .toContainEqual({ userId: agentId })

      const conversationId = await newConversationIn(storeId)
      const pendingId = await enqueue(agentPage, conversationId, 'seen by the other socket')

      await expect
        .poll(() => heard(page, RealtimeEvents.MESSAGE_QUEUED))
        .toContainEqual(expect.objectContaining({ conversationId, clientMessageId: pendingId }))
    } finally {
      await agentContext.close()
    }
  })

  test('a person who is not a member of the store is sent away', async ({ page }) => {
    const foreignStoreId = await storeIdNamed(OTHER_STORE)

    // The viewer belongs to Main Store only
    await signIn(page, 'viewer@test.com')
    await page.waitForURL(START_SCREEN)
    await page.goto(harnessPath(foreignStoreId))

    await expect(page).toHaveURL(AppPaths.noAccess)
  })
})
