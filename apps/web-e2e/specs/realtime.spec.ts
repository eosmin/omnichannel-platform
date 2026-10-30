import type { Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { messagesOf, newConversationIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const START_SCREEN = /\/s\/[^/]+\/inbox$/
const FIRST_STORE = 'Main Store'
const OTHER_STORE = 'Tienda Escalón'

const threadOf = (page: Page) => page.getByRole('list', { name: en.inbox.thread.label })

// Signs in and opens a conversation of the store with its composer ready
async function openConversation(page: Page, email: string, conversationId: string): Promise<void> {
  await signIn(page, email)
  // The start screen is still being reached; a navigation now would cut it
  await page.waitForURL(START_SCREEN)
  await page.goto(AppPaths.store.conversation(await storeIdNamed(FIRST_STORE), conversationId))
  await expect(page.getByRole('textbox', { name: en.inbox.composer.replyLabel })).toBeVisible()
}

async function writeReply(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: en.inbox.composer.replyLabel }).fill(text)
}

test.describe('the realtime client in the inbox', () => {
  test('a message written with no connection waits in the thread and is sent once when the network returns', async ({
    page,
    context
  }) => {
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newConversationIn(storeId)
    await openConversation(page, 'admin@test.com', conversationId)

    await writeReply(page, 'written with no connection')
    await context.setOffline(true)
    await page.getByRole('button', { name: en.inbox.composer.send }).click()

    // The composer clears and the message waits in the thread, with its clock
    await expect(threadOf(page).getByText('written with no connection')).toBeVisible()
    await expect(threadOf(page).getByText(en.inbox.thread.ticks.queued)).toBeVisible()
    expect(await messagesOf(conversationId)).toHaveLength(0)

    await context.setOffline(false)

    // The reconnection backs off, so the wait is longer than the default
    await expect
      .poll(async () => (await messagesOf(conversationId)).map(m => m.content), {
        timeout: 30_000
      })
      .toEqual(['written with no connection'])
    // The stored message replaced the one of the queue: there is one bubble, not two
    await expect(threadOf(page).getByText('written with no connection')).toHaveCount(1)
  })

  test('two sockets of one store hear each other', async ({ page, browser }) => {
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newConversationIn(storeId)
    await openConversation(page, 'admin@test.com', conversationId)

    const agentContext = await browser.newContext()
    await reachServicesFromOwnAddress(agentContext)
    try {
      const agentPage = await agentContext.newPage()
      await openConversation(agentPage, 'agent@test.com', conversationId)

      await writeReply(agentPage, 'seen by the other socket')
      await agentPage.getByRole('button', { name: en.inbox.composer.send }).click()

      // No reload: the event of the socket makes the thread of the first page read again
      await expect(threadOf(page).getByText('seen by the other socket')).toBeVisible()
    } finally {
      await agentContext.close()
    }
  })

  test('a person who is not a member of the store is sent away', async ({ page }) => {
    const foreignStoreId = await storeIdNamed(OTHER_STORE)

    // The viewer belongs to Main Store only
    await signIn(page, 'viewer@test.com')
    await page.waitForURL(START_SCREEN)
    await page.goto(AppPaths.store.inbox(foreignStoreId))

    await expect(page).toHaveURL(AppPaths.noAccess)
  })
})
