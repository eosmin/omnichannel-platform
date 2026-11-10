import { type Browser, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import {
  AuthorType,
  CaptionState,
  DeliveryStatus,
  MediaStatus,
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

// A reply of the team with pictures that went. `captions` is the text of each picture by its place (the first is
// the text of the message); the state of the message's text is written in the database (the worker that sends the
// texts is covered by the integration suite of the api): what is under test is what the thread draws and asks.
async function replyWithPictures(
  storeId: string,
  captions: (string | null)[],
  captionState?: CaptionState,
  // The text of the message went apart: it is its own, every picture has only its own text (the first too)
  apartText?: string
): Promise<string> {
  const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
  const message = await addMessageTo(storeId, conversationId, {
    authorType: AuthorType.AGENT,
    type: MessageType.IMAGE,
    ...(apartText === undefined
      ? captions[0] === null
        ? {}
        : { content: captions[0] }
      : { content: apartText, textApart: true }),
    deliveryStatus: DeliveryStatus.SENT,
    createdAt: new Date(Date.now() - MINUTE_MS / 2),
    ...(captionState === undefined ? {} : { captionState })
  })
  for (const [position, caption] of captions.entries()) {
    await addMediaTo(storeId, message.id, {
      filename: `picture-${position}.png`,
      contentType: 'image/png',
      status: MediaStatus.CLEAN,
      processed: 'with-variants',
      position,
      delivery: DeliveryStatus.SENT,
      ...((position > 0 || apartText !== undefined) && caption !== null ? { caption } : {})
    })
  }
  return conversationId
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

// Its own session and address: the api limits the requests of each address
test('the text of the message sent again asks first when it may have gone, and not when it failed', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const asked: string[] = []
    await page.route('**/messages/*/resend-caption', route => {
      asked.push(new URL(route.request().url()).pathname)
      return route.fulfill({ status: 409, contentType: 'application/json', body: '{}' })
    })
    const list = page.getByRole('list', { name: thread.label })

    // Unconfirmed: the customer may already have it, so nothing goes until the agent confirms
    const unconfirmed = await replyWithPictures(storeId, ['Text'], CaptionState.UNCONFIRMED)
    await page.goto(AppPaths.store.conversation(storeId, unconfirmed))
    await expect(list.getByText(thread.captionUnconfirmed)).toBeVisible()
    await list.getByRole('button', { name: thread.resendCaption }).click()
    const dialog = page.getByRole('alertdialog', { name: thread.captionResendTitle })
    await expect(dialog).toContainText(thread.captionResendMaybeSent)
    await dialog.getByRole('button', { name: thread.captionResendCancel }).click()
    await expect(dialog).toHaveCount(0)
    expect(asked).toHaveLength(0)
    await list.getByRole('button', { name: thread.resendCaption }).click()
    await page
      .getByRole('alertdialog', { name: thread.captionResendTitle })
      .getByRole('button', { name: thread.captionResendConfirm })
      .click()
    await expect.poll(() => asked.length).toBe(1)

    // Failed: it did not go, so it is sent at once
    const failed = await replyWithPictures(storeId, ['Text'], CaptionState.FAILED)
    await page.goto(AppPaths.store.conversation(storeId, failed))
    await expect(list.getByText(thread.captionFailed)).toBeVisible()
    await list.getByRole('button', { name: thread.resendCaption }).click()
    await expect.poll(() => asked.length).toBe(2)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)

    // Not held any more: the api takes the request of a text that failed, with its file sent and the window open,
    // and answers with the message
    await page.unroute('**/messages/*/resend-caption')
    const real = await replyWithPictures(storeId, ['Text'], CaptionState.FAILED)
    await page.goto(AppPaths.store.conversation(storeId, real))
    await expect(list.getByText(thread.captionFailed)).toBeVisible()
    const answered = page.waitForResponse(
      response =>
        response.request().method() === 'POST' && response.url().endsWith('/resend-caption')
    )
    await list.getByRole('button', { name: thread.resendCaption }).click()
    expect((await answered).status()).toBe(200)
  } finally {
    await page.context().close()
  }
})

test('the texts of an album are listed in the order of its files, each with the number on its picture', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    // The second picture has no text: it has no line, and the others keep their numbers
    const album = await replyWithPictures(storeId, ['Uno', null, 'Tres'])
    await page.goto(AppPaths.store.conversation(storeId, album))
    const texts = page
      .getByRole('list', { name: thread.label })
      .getByRole('list', { name: thread.albumCaptions })
    await expect(texts.getByRole('listitem')).toHaveCount(2)
    await expect(texts.getByRole('listitem').nth(0)).toContainText('Uno')
    await expect(texts.getByRole('listitem').nth(1)).toContainText('Tres')
    // The text of the first file is drawn once, in the list
    await expect(page.getByText('Uno', { exact: true })).toHaveCount(1)
    const marks = page.getByTestId('album-caption-mark')
    await expect(marks).toHaveText(['1', '3'])
    await expect(texts.getByTestId('album-caption-number')).toHaveText(['1', '3'])
  } finally {
    await page.context().close()
  }
})

test('in an album, the text of the message asks before it is sent again, inside its line of the list', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const asked: string[] = []
    await page.route('**/resend-caption', route => {
      asked.push(new URL(route.request().url()).pathname)
      return route.fulfill({ status: 409, contentType: 'application/json', body: '{}' })
    })
    const album = await replyWithPictures(storeId, ['Uno', 'Dos'], CaptionState.UNCONFIRMED)
    await page.goto(AppPaths.store.conversation(storeId, album))
    const texts = page.getByRole('list', { name: thread.albumCaptions })
    const first = texts.getByRole('listitem').nth(0)
    await expect(first).toContainText('Uno')
    await expect(first).toContainText(thread.captionUnconfirmed)
    // The text of the second picture is drawn, with no state and no button of its own
    await expect(texts.getByRole('listitem').nth(1)).toContainText('Dos')
    await expect(texts.getByRole('button')).toHaveCount(1)
    await first.getByRole('button', { name: thread.resendCaption }).click()
    await expect(page.getByRole('alertdialog', { name: thread.captionResendTitle })).toBeVisible()
    expect(asked).toHaveLength(0)
  } finally {
    await page.context().close()
  }
})

test('with the text of the message apart, every picture draws its own text, the first too, and the text of the message comes after them', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const album = await replyWithPictures(
      storeId,
      ['Uno', null, 'Tres'],
      undefined,
      'For all of them'
    )
    await page.goto(AppPaths.store.conversation(storeId, album))
    const list = page.getByRole('list', { name: thread.label })
    const texts = list.getByRole('list', { name: thread.albumCaptions })
    await expect(texts.getByRole('listitem')).toHaveCount(2)
    await expect(texts.getByRole('listitem').nth(0)).toContainText('Uno')
    await expect(texts.getByRole('listitem').nth(1)).toContainText('Tres')
    await expect(texts.getByTestId('album-caption-number')).toHaveText(['1', '3'])
    // The text of the message is not a line of the first picture: it is drawn once, after the list
    await expect(list.getByText('For all of them', { exact: true })).toHaveCount(1)
    await expect(texts.getByText('For all of them')).toHaveCount(0)
  } finally {
    await page.context().close()
  }
})
