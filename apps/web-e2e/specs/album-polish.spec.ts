import { type Browser, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import {
  AuthorType,
  DeliveryStatus,
  MediaStatus,
  MessageMetadataKeys,
  MessageType
} from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
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

const TRANSPARENT = 'rgba(0, 0, 0, 0)'
// An answer as long as a person writes to a story: the bubble grew with it to the width of the column
const LONG_ANSWER =
  'Me encanta esta historia, de verdad, ¿cuánto cuesta el modelo que sale en la segunda foto y tienen envío a domicilio hasta mi casa esta misma semana?'

// The owner's capture: a white empty square over the corner of each picture after the first
test('the buttons of a picture are drawn on a surface that shows only with them: no white square', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    await albumOf(storeId, conversationId, 3)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const list = page.getByRole('list', { name: thread.label })
    const reply = list.getByRole('button', { name: fill(thread.actions.replyFile, 2, 3) })
    // The bar holding the buttons, and what holds the bar over the picture
    const bar = reply.locator('xpath=..')
    const holder = bar.locator('xpath=..')

    // At rest: nothing of it can be seen, and nothing around it has a colour (the square was the holder)
    await expect(bar).toHaveCSS('opacity', '0')
    await expect(bar).not.toHaveCSS('background-color', TRANSPARENT)
    await expect(holder).toHaveCSS('background-color', TRANSPARENT)

    // On the picture: the buttons are there, with a surface behind them, and the icons are drawn
    await list
      .getByRole('button', { name: en.inbox.thread.media.open.replace('{name}', 'p2.png') })
      .hover()
    await expect(bar).toHaveCSS('opacity', '1')
    await expect(reply.locator('svg')).toBeVisible()
    await expect(reply).toBeVisible()
  } finally {
    await page.context().close()
  }
})

test('following a quote marks the original for a moment: the message, or the very picture, and says so', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    const { messageId, ids } = await albumOf(storeId, conversationId, 5)
    // A reply of the customer to the FOURTH picture, and another to the message of the team as a whole
    const fourthId = ids[3]
    if (fourthId === undefined) throw new Error('the album has no fourth picture')
    await addMessageTo(storeId, conversationId, {
      authorType: AuthorType.CUSTOMER,
      content: 'This fourth one, please',
      replyToMessageId: messageId,
      replyToMediaId: fourthId,
      createdAt: new Date(Date.now() - 10_000)
    })
    await addMessageTo(storeId, conversationId, {
      authorType: AuthorType.CUSTOMER,
      content: 'And this whole message',
      replyToMessageId: messageId,
      createdAt: new Date(Date.now() - 5_000)
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const list = page.getByRole('list', { name: thread.label })

    // The quote says which picture; following it marks THAT thumbnail (not its neighbours) and announces it
    await expect(list.getByText(fill(thread.quote.file, 4, 5))).toBeVisible()
    await list.getByRole('button', { name: new RegExp(fill(thread.quote.file, 4, 5)) }).click()
    const fourth = page.locator(`#file-${ids[3]}`)
    await expect(fourth).toHaveClass(/ring-primary/)
    await expect(page.locator(`#file-${ids[2]}`)).not.toHaveClass(/ring-primary/)
    await expect(page.getByRole('status').filter({ hasText: thread.jumpedPicture })).toBeVisible()
    // It goes away by itself, fading (the element has a transition)
    await expect(fourth).toHaveCSS('transition-property', /box-shadow/)
    await expect(fourth).toHaveCSS('transition-duration', '0.7s')
    await expect(fourth).not.toHaveClass(/ring-primary/, { timeout: 6000 })

    // A quote of the message as a whole marks the message (not a picture) and says so, again on a second follow
    const wholeQuote = list
      .locator('li')
      .filter({ hasText: 'And this whole message' })
      .getByRole('button')
      .first()
    await wholeQuote.click()
    await expect(page.locator(`#message-${messageId}`)).toHaveClass(/ring-primary/)
    await expect(page.getByRole('status').filter({ hasText: thread.jumpedMessage })).toHaveText(
      thread.jumpedMessage
    )
    await expect(page.locator(`#message-${messageId}`)).not.toHaveClass(/ring-primary/, {
      timeout: 6000
    })
    // The focus ring of the message is instant again once the mark has gone
    await expect(page.locator(`#message-${messageId}`)).not.toHaveClass(/duration-700/, {
      timeout: 3000
    })
    await wholeQuote.click()
    await expect(page.getByRole('status').filter({ hasText: thread.jumpedMessage })).toHaveText(
      thread.jumpedMessage
    )

    // A reader who asked for less motion gets the mark with no transition
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await list.getByRole('button', { name: new RegExp(fill(thread.quote.file, 4, 5)) }).click()
    await expect(page.locator(`#file-${ids[3]}`)).toHaveClass(/ring-primary/)
    await expect(page.locator(`#file-${ids[3]}`)).toHaveCSS('transition-property', 'none')
  } finally {
    await page.context().close()
  }
})

test('the card of the story a customer answered fits its picture: a bubble of a normal width', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    await addMessageTo(storeId, conversationId, {
      authorType: AuthorType.CUSTOMER,
      type: MessageType.TEXT,
      content: LONG_ANSWER,
      metadata: { [MessageMetadataKeys.STORY_REPLY]: {} },
      createdAt: new Date(Date.now() - 10_000)
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const list = page.getByRole('list', { name: thread.label })
    const label = list.getByText(thread.storyReply.label)
    await expect(label).toBeVisible()
    const card = label.locator('xpath=..')
    const bubble = card.locator('xpath=..')

    const cardBox = await card.boundingBox()
    const bubbleBox = await bubble.boundingBox()
    expect(cardBox?.width ?? 0).toBeLessThanOrEqual(161)
    // The bubble is as wide as its content, never the width of the column (it was about 800 px)
    expect(bubbleBox?.width ?? 0).toBeLessThanOrEqual(361)
    await expect(list.getByText(LONG_ANSWER)).toBeVisible()
  } finally {
    await page.context().close()
  }
})
