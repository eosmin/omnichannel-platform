import { type Page } from '@playwright/test'

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
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const AGENT = 'agent@test.com'
const MINUTE_MS = 60_000
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)
const thread = en.inbox.thread

// A reply of the team with two pictures that went, whose second text did not clearly go. The state is written in
// the database (the worker that sends the texts is covered by the integration suite of the api); what is under
// test is what the thread draws and asks. The request is held by the page, so nothing is sent for real.
async function conversationWithText(storeId: string, state: CaptionState): Promise<string> {
  const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
  const message = await addMessageTo(storeId, conversationId, {
    authorType: AuthorType.AGENT,
    type: MessageType.IMAGE,
    content: 'Text of the first',
    deliveryStatus: DeliveryStatus.SENT,
    createdAt: new Date(Date.now() - MINUTE_MS / 2)
  })
  for (const [position, filename] of ['first.png', 'second.png'].entries()) {
    await addMediaTo(storeId, message.id, {
      filename,
      contentType: 'image/png',
      status: MediaStatus.CLEAN,
      processed: 'with-variants',
      position,
      delivery: DeliveryStatus.SENT,
      ...(position === 1 ? { caption: 'Text of the second', captionState: state } : {})
    })
  }
  return conversationId
}

async function holdResends(page: Page): Promise<string[]> {
  const asked: string[] = []
  await page.route('**/resend-caption', route => {
    asked.push(new URL(route.request().url()).pathname)
    return route.fulfill({ status: 409, contentType: 'application/json', body: '{}' })
  })
  return asked
}

// Its own session and address: the api limits the requests of each address
test('the text under a file that failed is sent again at once, and one that may have gone asks first', async ({
  browser
}) => {
  const context = await browser.newContext()
  try {
    await reachServicesFromOwnAddress(context)
    const page = await context.newPage()
    await page.route(`${STORAGE_URL}/**`, route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
    )
    await signIn(page, AGENT)
    const storeId = await storeIdNamed(FIRST_STORE)
    const asked = await holdResends(page)
    const list = page.getByRole('list', { name: thread.label })

    // Failed: the text is drawn under its file with what happened, and "send again" goes at once
    const failed = await conversationWithText(storeId, CaptionState.FAILED)
    await page.goto(AppPaths.store.conversation(storeId, failed))
    await expect(list.getByText('Text of the second', { exact: true })).toBeVisible()
    await expect(list.getByText(thread.fileCaptionFailed)).toBeVisible()
    // The first file's text is the one of the message: drawn once, with no state of its own
    await expect(list.getByText('Text of the first', { exact: true })).toHaveCount(1)
    await list.getByRole('button', { name: thread.fileCaptionResend }).click()
    await expect.poll(() => asked.length).toBe(1)
    expect(asked[0]).toMatch(/\/messages\/[^/]+\/media\/[^/]+\/resend-caption$/)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)

    // Unconfirmed: the customer may already have it, so nothing goes until the agent confirms
    const unconfirmed = await conversationWithText(storeId, CaptionState.UNCONFIRMED)
    await page.goto(AppPaths.store.conversation(storeId, unconfirmed))
    await expect(list.getByText(thread.fileCaptionUnconfirmed)).toBeVisible()
    await list.getByRole('button', { name: thread.fileCaptionResend }).click()
    const dialog = page.getByRole('alertdialog', { name: thread.fileCaptionResendTitle })
    await expect(dialog).toContainText(thread.fileCaptionResendMaybeSent)
    // Not now: the dialog closes and nothing was asked
    await dialog.getByRole('button', { name: thread.fileCaptionResendCancel }).click()
    await expect(dialog).toHaveCount(0)
    expect(asked.length).toBe(1)
    // Confirmed: now it is asked, once
    await list.getByRole('button', { name: thread.fileCaptionResend }).click()
    await page
      .getByRole('alertdialog', { name: thread.fileCaptionResendTitle })
      .getByRole('button', { name: thread.fileCaptionResendConfirm })
      .click()
    await expect.poll(() => asked.length).toBe(2)

    // Not held any more: the api itself takes the request of a text that failed, with its file sent and the
    // window open, and answers with the message
    await page.unroute('**/resend-caption')
    const real = await conversationWithText(storeId, CaptionState.FAILED)
    await page.goto(AppPaths.store.conversation(storeId, real))
    await expect(list.getByText(thread.fileCaptionFailed)).toBeVisible()
    const answered = page.waitForResponse(
      response =>
        response.request().method() === 'POST' && response.url().endsWith('/resend-caption')
    )
    await list.getByRole('button', { name: thread.fileCaptionResend }).click()
    expect((await answered).status()).toBe(200)
    await expect(page.getByRole('alertdialog')).toHaveCount(0)
  } finally {
    await context.close()
  }
})
