import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { AuthorType, DeliveryStatus, MediaStatus, MessageType } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  addMediaTo,
  addMessageTo,
  deliveryOfFiles,
  newWhatsAppConversationWrittenAgo,
  storeIdNamed
} from '../support/database'
import { STORAGE_URL } from '../support/env'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const MINUTE_MS = 60_000
// A valid 1x1 image, what the bucket would answer for the variants
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)
const media = en.inbox.thread.media
const actions = en.inbox.thread.actions

// A reply with several pictures is a grid, and each file says how it stands. The states are written in
// the database (the worker that sends them is covered by the integration suite of the api).
test.describe.serial('a reply with several files in the thread', () => {
  let context: BrowserContext
  let page: Page
  let storeId: string
  let newAddress: () => void

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext()
    newAddress = await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, personOf('admin', import.meta.url))
    storeId = await storeIdNamed(FIRST_STORE)
  })
  test.beforeEach(async () => {
    newAddress()
    await page.route(`${STORAGE_URL}/**`, route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
    )
  })
  test.afterEach(async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })
  test.afterAll(async () => {
    await context.close()
  })

  async function albumOf(deliveries: (DeliveryStatus | undefined)[], failedMessage: boolean) {
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    const message = await addMessageTo(storeId, conversationId, {
      authorType: AuthorType.AGENT,
      type: MessageType.IMAGE,
      content: '',
      createdAt: new Date(),
      ...(failedMessage
        ? { deliveryStatus: DeliveryStatus.FAILED, failureDefinitive: true }
        : { deliveryStatus: DeliveryStatus.SENT })
    })
    for (const [position, delivery] of deliveries.entries()) {
      await addMediaTo(storeId, message.id, {
        filename: `photo-${position}.png`,
        contentType: 'image/png',
        status: MediaStatus.CLEAN,
        processed: 'with-variants',
        position,
        ...(delivery === undefined ? {} : { delivery }),
        ...(delivery === DeliveryStatus.FAILED ? { sendErrorCode: 'CHANNEL_FILE_TOO_LARGE' } : {})
      })
    }
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    return { conversationId, messageId: message.id }
  }

  const pictureOf = (name: string) =>
    page.getByRole('button', { name: media.open.replace('{name}', name) })

  test('draws the pictures as a grid of two columns, in the order they were sent', async () => {
    await albumOf([DeliveryStatus.SENT, DeliveryStatus.SENT, DeliveryStatus.SENT], false)

    const boxOf = async (at: number) => {
      const picture = pictureOf(`photo-${at}.png`)
      await expect(picture).toBeVisible()
      const box = await picture.boundingBox()
      if (box === null) throw new Error(`photo-${at}.png has no box`)
      return box
    }
    const first = await boxOf(0)
    const second = await boxOf(1)
    const third = await boxOf(2)
    // Two on the first row, side by side and of one size; the third starts the second row
    expect(second.y).toBe(first.y)
    expect(second.x).toBeGreaterThan(first.x)
    expect(third.y).toBeGreaterThan(first.y)
    expect(third.x).toBe(first.x)
    expect(first.width).toBe(first.height)
    // None of them says it failed or waits
    await expect(page.getByText(media.fileQueued)).toHaveCount(0)
    await expect(page.getByText(media.retryOnlyFailed)).toHaveCount(0)
  })

  test('says which file failed and why, and "send again" asks only for the ones that did not go', async () => {
    const { messageId } = await albumOf(
      [DeliveryStatus.SENT, DeliveryStatus.FAILED, DeliveryStatus.SENT],
      true
    )

    await expect(pictureOf('photo-2.png')).toBeVisible()
    const failure = media.fileFailedWithReason.replace('{reason}', en.errors.CHANNEL_FILE_TOO_LARGE)
    await expect(page.getByText(failure)).toHaveCount(1)
    await expect(page.getByText(media.retryOnlyFailed)).toBeVisible()

    const row = page.getByRole('listitem').filter({ has: pictureOf('photo-1.png') })
    await row.getByRole('button', { name: actions.more }).click()
    const resent = page.waitForResponse(
      response => response.url().includes(`/messages/${messageId}/resend`) && response.ok()
    )
    await page.getByRole('menuitem', { name: actions.resend }).click()
    await resent

    // The failed file was taken up again (queued, or failed anew for another reason: the worker of the suite
    // has no bucket object to send), and the two that arrived are not asked for again
    await expect
      .poll(async () => {
        const [, again] = await deliveryOfFiles(messageId)
        return (
          again?.delivery !== DeliveryStatus.FAILED || again.errorCode !== 'CHANNEL_FILE_TOO_LARGE'
        )
      })
      .toBe(true)
    const files = await deliveryOfFiles(messageId)
    expect(files.filter((_, at) => at !== 1).map(file => file.delivery)).toEqual([
      DeliveryStatus.SENT,
      DeliveryStatus.SENT
    ])
  })
})
