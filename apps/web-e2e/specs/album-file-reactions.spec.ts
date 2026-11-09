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
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const AGENT = 'agent@test.com'
const MINUTE_MS = 60_000
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)
const thread = en.inbox.thread
const fill = (text: string, number: number, total: number) =>
  text.replace('{number}', String(number)).replace('{total}', String(total))

// A reply of the team with three pictures that went, each with an id of its own at the provider (the first is the
// message's), and a reaction of the customer under the third
async function albumWithCustomerReaction(storeId: string): Promise<{
  conversationId: string
  second: string
  third: string
}> {
  const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
  const message = await addMessageTo(storeId, conversationId, {
    authorType: AuthorType.AGENT,
    type: MessageType.IMAGE,
    deliveryStatus: DeliveryStatus.SENT,
    channelMessageId: 'wamid.album-1',
    createdAt: new Date(Date.now() - MINUTE_MS / 2)
  })
  const ids: string[] = []
  for (const [at, name] of ['a.png', 'b.png', 'c.png'].entries()) {
    const file = await addMediaTo(storeId, message.id, {
      filename: name,
      contentType: 'image/png',
      status: MediaStatus.CLEAN,
      processed: 'with-variants',
      position: at,
      delivery: DeliveryStatus.SENT,
      channelMessageId: at === 0 ? 'wamid.album-1' : `wamid.album-${at + 1}`
    })
    ids.push(file.id)
  }
  const third = ids[2] ?? ''
  await addCustomerReactionTo(message.id, { emoji: '❤️', mediaId: third })
  return { conversationId, second: ids[1] ?? '', third }
}

async function signedInPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  await reachServicesFromOwnAddress(context)
  const page = await context.newPage()
  await page.route(`${STORAGE_URL}/**`, route =>
    route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
  )
  await signIn(page, AGENT)
  return page
}

// A spec of its own: one sign in, one address for the limit of the api
test('each picture of an album the team sent has its own reaction and its own reply', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const { conversationId, second: secondId } = await albumWithCustomerReaction(storeId)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const list = page.getByRole('list', { name: thread.label })

    // The reaction of the customer is under THE THIRD picture, not under the message or the others
    const third = list.getByRole('list', { name: fill(thread.reactions.ofFile, 3, 3) })
    await expect(third).toContainText('❤️')
    await expect(list.getByRole('list', { name: fill(thread.reactions.ofFile, 2, 3) })).toHaveCount(
      0
    )
    await expect(list.getByRole('list', { name: thread.reactions.group, exact: true })).toHaveCount(
      0
    )

    // The second picture has its own buttons, named by its number; the first has none of its own
    await expect(
      list.getByRole('button', { name: fill(thread.actions.reactFile, 1, 3) })
    ).toHaveCount(0)
    await list.getByRole('button', { name: fill(thread.actions.reactFile, 2, 3) }).click()
    // The request names the SECOND file, not the message and not the first
    const putRequest = page.waitForRequest(
      request => request.method() === 'PUT' && request.url().endsWith('/reaction')
    )
    await page.getByRole('menuitem', { name: '👍' }).click()
    expect((await putRequest).postDataJSON()).toMatchObject({
      emoji: '👍',
      mediaId: secondId
    })
    // The reaction of the agent is under the second picture
    const second = list.getByRole('list', { name: fill(thread.reactions.ofFile, 2, 3) })
    await expect(second).toContainText('👍')

    // Replying to the second picture: the box says which one, and the reply quotes THAT picture
    await list.getByRole('button', { name: fill(thread.actions.replyFile, 2, 3) }).click()
    const replying = fill(en.inbox.composer.replyingFile, 2, 3).split('{author}')
    await expect(page.getByText(new RegExp(`^${replying[0]}.+${replying[1]}$`))).toBeVisible()
    await page.getByRole('textbox', { name: en.inbox.composer.replyLabel }).fill('About this one')
    await page.getByRole('button', { name: en.inbox.composer.send }).click()
    await expect(list.getByText(fill(thread.quote.file, 2, 3))).toBeVisible()
  } finally {
    await page.context().close()
  }
})
