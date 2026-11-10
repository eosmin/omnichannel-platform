import { type Browser, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { AuthorType, DeliveryStatus, MediaStatus, MessageType } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addCustomerReactionTo,
  addMediaTo,
  addMessageTo,
  newWhatsAppConversationWrittenAgo,
  storeIdNamed
} from '../support/database'
import { STORAGE_URL } from '../support/env'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const AGENT = personOf('agent', import.meta.url)
const MINUTE_MS = 60_000
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)
const thread = en.inbox.thread
const fill = (text: string, number: number, total: number) =>
  text.replace('{number}', String(number)).replace('{total}', String(total))

// A reply of the team with `count` pictures that went, each with an id of its own at the provider
async function albumOf(
  storeId: string,
  conversationId: string,
  count: number
): Promise<{ messageId: string; ids: string[] }> {
  const message = await addMessageTo(storeId, conversationId, {
    authorType: AuthorType.AGENT,
    type: MessageType.IMAGE,
    deliveryStatus: DeliveryStatus.SENT,
    channelMessageId: 'wamid.album-1',
    createdAt: new Date(Date.now() - MINUTE_MS / 2)
  })
  const ids: string[] = []
  for (let at = 0; at < count; at += 1) {
    const file = await addMediaTo(storeId, message.id, {
      filename: `p${at + 1}.png`,
      contentType: 'image/png',
      status: MediaStatus.CLEAN,
      processed: 'with-variants',
      position: at,
      delivery: DeliveryStatus.SENT,
      channelMessageId: `wamid.album-${at + 1}`
    })
    ids.push(file.id)
  }
  return { messageId: message.id, ids }
}

async function signedInPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1500, height: 900 } })
  await reachServicesFromOwnAddress(context)
  const page = await context.newPage()
  await page.route(`${STORAGE_URL}/**`, route =>
    route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
  )
  await signIn(page, AGENT)
  return page
}

// The owner's capture: the reaction to the first picture of a WhatsApp album drew on the whole card
test('the reaction to the first picture of an album with an id for each picture is drawn under that picture', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    const { messageId, ids } = await albumOf(storeId, conversationId, 3)
    // The customer reacted to the first picture: the provider names the message, whose id is the first picture's
    await addCustomerReactionTo(messageId, { emoji: '👍' })
    await addCustomerReactionTo(messageId, { emoji: '🔥', mediaId: ids[2] })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const list = page.getByRole('list', { name: thread.label })

    await expect(page.locator(`#file-${ids[0]}`).getByRole('button', { name: /👍/ })).toBeVisible()
    await expect(page.locator(`#file-${ids[2]}`).getByRole('button', { name: /🔥/ })).toBeVisible()
    await expect(
      page.locator(`#file-${ids[1]}`).getByRole('list', { name: thread.reactions.group })
    ).toHaveCount(0)
    // Nothing is left for the message as a whole: no list of reactions outside the pictures
    const all = list.getByRole('list', { name: thread.reactions.group })
    await expect(all.filter({ hasText: '👍' })).toHaveCount(1)
  } finally {
    await page.context().close()
  }
})

test('a quote of one of five pictures marks that thumbnail, and names its number', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    const { messageId, ids } = await albumOf(storeId, conversationId, 5)
    await addMessageTo(storeId, conversationId, {
      authorType: AuthorType.CUSTOMER,
      content: 'The second',
      replyToMessageId: messageId,
      replyToMediaId: ids[1],
      createdAt: new Date(Date.now() - 10_000)
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const list = page.getByRole('list', { name: thread.label })
    await list.getByRole('button', { name: new RegExp(fill(thread.quote.file, 2, 5)) }).click()
    await expect(page.locator(`#file-${ids[1]}`)).toHaveClass(/ring-primary/)
    for (const other of [0, 2, 3, 4]) {
      await expect(page.locator(`#file-${ids[other]}`)).not.toHaveClass(/ring-primary/)
    }
  } finally {
    await page.context().close()
  }
})
