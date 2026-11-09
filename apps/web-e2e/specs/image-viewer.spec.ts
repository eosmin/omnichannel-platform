import { type Browser, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { AuthorType, DeliveryStatus, MediaStatus, MessageType } from '@platform/core/domain'

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
const media = en.inbox.thread.media
const position = (current: number, total: number) =>
  media.position.replace('{current}', String(current)).replace('{total}', String(total))

// A reply of the team with pictures that went, each with the text under it (null: none)
async function replyWithPictures(
  storeId: string,
  pictures: { name: string; caption: string | null }[]
): Promise<string> {
  const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
  const message = await addMessageTo(storeId, conversationId, {
    authorType: AuthorType.AGENT,
    type: MessageType.IMAGE,
    deliveryStatus: DeliveryStatus.SENT,
    textApart: true,
    createdAt: new Date(Date.now() - MINUTE_MS / 2)
  })
  for (const [at, picture] of pictures.entries()) {
    await addMediaTo(storeId, message.id, {
      filename: picture.name,
      contentType: 'image/png',
      status: MediaStatus.CLEAN,
      processed: 'with-variants',
      position: at,
      delivery: DeliveryStatus.SENT,
      ...(picture.caption === null ? {} : { caption: picture.caption })
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

// A spec of its own: one sign in, one address for the limit of the api
test('opens a picture of an album in the viewer and walks all of them with the arrows, the keys and the texts', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await replyWithPictures(storeId, [
      { name: 'a.png', caption: 'Uno' },
      { name: 'b.png', caption: null },
      { name: 'c.png', caption: 'Tres' }
    ])
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    await page.getByRole('button', { name: media.open.replace('{name}', 'b.png') }).click()
    const dialog = page.getByRole('dialog', { name: 'b.png' })
    await expect(dialog).toBeVisible()
    // The place among the pictures is said, and the picture without a text has none
    await expect(dialog.getByText(position(2, 3))).toBeVisible()
    await expect(dialog.getByText('Uno')).toHaveCount(0)

    // The key and the button lead to the next picture, which shows its number and its text
    await page.keyboard.press('ArrowRight')
    const third = page.getByRole('dialog', { name: 'c.png' })
    await expect(third).toBeVisible()
    await expect(third.getByText(position(3, 3))).toBeVisible()
    await expect(third.getByText('Tres')).toBeVisible()
    await expect(third.getByText('3.', { exact: true })).toBeVisible()
    await third.getByRole('button', { name: media.next }).click()
    const first = page.getByRole('dialog', { name: 'a.png' })
    await expect(first).toBeVisible()
    await expect(first.getByText(position(1, 3))).toBeVisible()
    await expect(first.getByText('Uno')).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('dialog', { name: 'c.png' })).toBeVisible()

    // The browser's own keys do not move the picture
    await page.keyboard.press('Alt+ArrowLeft')
    await expect(page.getByRole('dialog', { name: 'c.png' })).toBeVisible()

    // The focus stays inside the dialog while the keys move through it
    for (let press = 0; press < 6; press += 1) await page.keyboard.press('Tab')
    expect(
      await page.getByRole('dialog').evaluate(node => node.contains(document.activeElement))
    ).toBe(true)

    // Escape closes it and the focus goes back to the picture that opened it
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(
      page.getByRole('button', { name: media.open.replace('{name}', 'b.png') })
    ).toBeFocused()
  } finally {
    await page.context().close()
  }
})

test('a picture alone opens in the same viewer without arrows or a count', async ({ browser }) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await replyWithPictures(storeId, [{ name: 'only.png', caption: null }])
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    await page.getByRole('button', { name: media.open.replace('{name}', 'only.png') }).click()
    const dialog = page.getByRole('dialog', { name: 'only.png' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: media.next })).toHaveCount(0)
    await expect(dialog.getByText(/^Image \d+ of \d+$/)).toHaveCount(0)
  } finally {
    await page.context().close()
  }
})
