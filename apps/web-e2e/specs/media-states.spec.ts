import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { AuthorType, MediaStatus, MessageType } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { writeNote } from '../support/api'
import {
  addMediaTo,
  addMessageTo,
  newConversationIn,
  settleMedia,
  storeIdNamed
} from '../support/database'
import { STORAGE_URL } from '../support/env'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

// The first message of a Socket.IO connection: the socket is up
const SOCKET_IO_CONNECTED = '40'
const FIRST_STORE = 'Main Store'
const AGENT = 'agent2@test.com'
const MINUTE_MS = 60_000
// A valid 1x1 image, what the bucket would answer for the variants
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

const threadOf = (page: Page) => page.getByRole('list', { name: en.inbox.thread.label })
const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * MINUTE_MS)

// The files of the thread have two states, a skeleton or their content, in one box. Apart from
// thread.spec.ts because the api limits each client address to 100 requests a minute and that spec is
// already close to it: this one has a context, and so an address, of its own.
test.describe.serial('the files of the thread', () => {
  let context: BrowserContext
  let page: Page
  let storeId: string
  // The bearer token of the page, taken from its own requests: a second session writes with it
  let token = ''

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext()
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    page.on('request', request => {
      const authorization = request.headers()['authorization']
      if (authorization?.startsWith('Bearer ')) token = authorization.slice('Bearer '.length)
    })
    await signIn(page, AGENT)
    storeId = await storeIdNamed(FIRST_STORE)
  })
  // A route of one case (the bucket) must not answer the next one if the case failed
  test.afterEach(async () => {
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  })
  test.afterAll(async () => {
    await context.close()
  })

  // The picture and its skeleton fill one box: the thread does not jump when the picture arrives
  test('keeps the box of a picture the same size from its skeleton to its image', async () => {
    const conversationId = await newConversationIn(storeId)
    const message = await addMessageTo(storeId, conversationId, {
      type: MessageType.IMAGE,
      content: '',
      createdAt: minutesAgo(2)
    })
    // Clean, but the worker has not made the variants yet
    const media = await addMediaTo(storeId, message.id, {
      filename: 'photo.png',
      contentType: 'image/png',
      status: MediaStatus.CLEAN
    })
    await page.route(`${STORAGE_URL}/**`, route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
    )
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const waiting = threadOf(page)
      .getByRole('status')
      .filter({ hasText: en.inbox.thread.media.loading.replace('{name}', 'photo.png') })
    await expect(waiting).toBeVisible()
    const before = await waiting.boundingBox()
    // Not a download card while it waits
    await expect(threadOf(page).getByRole('link', { name: /photo\.png/ })).toHaveCount(0)

    await settleMedia(storeId, media.id)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const image = threadOf(page).getByRole('button', {
      name: en.inbox.thread.media.open.replace('{name}', 'photo.png')
    })
    await expect(image).toBeVisible()
    const after = await image.boundingBox()
    expect(before).not.toBeNull()
    expect(after?.width).toBeCloseTo(before?.width ?? -1, 0)
    expect(after?.height).toBeCloseTo(before?.height ?? -1, 0)
    expect((after?.width ?? 0) / (after?.height ?? 1)).toBeCloseTo(4 / 3, 1)
    // A box that fills the bubble, not one the bubble shrinks around
    expect(after?.width).toBeGreaterThan(200)
  })

  // The worker stores a customer's message first and fetches the file after: for that moment there is a
  // message with no file. It is the box of the picture from the first frame, not the word "Image".
  test('draws the box of a picture that has not been stored yet, and keeps it when it arrives', async () => {
    const conversationId = await newConversationIn(storeId)
    const message = await addMessageTo(storeId, conversationId, {
      type: MessageType.IMAGE,
      authorType: AuthorType.CUSTOMER,
      content: '',
      createdAt: new Date()
    })
    await page.route(`${STORAGE_URL}/**`, route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
    )
    // The event of the worker is announced once and not replayed: the socket has to be up before it comes
    const connected = new Promise<void>(resolve => {
      page.once('websocket', socket => {
        socket.on('framereceived', frame => {
          if (String(frame.payload).startsWith(SOCKET_IO_CONNECTED)) resolve()
        })
      })
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const arriving = threadOf(page)
      .getByRole('status')
      .filter({ hasText: en.inbox.thread.media.arriving })
    await expect(arriving).toBeVisible()
    await connected
    await expect(
      threadOf(page).getByText(en.inbox.thread.mediaLabel.IMAGE, { exact: true })
    ).toHaveCount(0)
    const before = await arriving.boundingBox()
    expect((before?.width ?? 0) / (before?.height ?? 1)).toBeCloseTo(4 / 3, 1)
    expect(before?.width).toBeGreaterThan(200)

    // The file is stored and clean, with its variants
    await addMediaTo(storeId, message.id, {
      filename: 'arrived.png',
      contentType: 'image/png',
      status: MediaStatus.CLEAN,
      processed: 'with-variants'
    })
    // The same page, not a new load: a note of another session makes the thread read its messages again, as
    // the announcement of the worker does when it has stored the file
    expect(token).not.toBe('')
    await writeNote(token, storeId, conversationId, 'Written while the file arrives')
    const image = threadOf(page).getByRole('button', {
      name: en.inbox.thread.media.open.replace('{name}', 'arrived.png')
    })
    await expect(image).toBeVisible()
    const after = await image.boundingBox()
    expect(after?.width).toBeCloseTo(before?.width ?? -1, 0)
    expect(after?.height).toBeCloseTo(before?.height ?? -1, 0)
  })

  test('draws a sticker that has not been stored yet in the square box of a sticker, with no bubble', async () => {
    const conversationId = await newConversationIn(storeId)
    await addMessageTo(storeId, conversationId, {
      type: MessageType.IMAGE,
      authorType: AuthorType.CUSTOMER,
      content: '',
      createdAt: new Date(),
      metadata: { sticker: true }
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const arriving = threadOf(page)
      .getByRole('status')
      .filter({ hasText: en.inbox.thread.media.arriving })
    await expect(arriving).toBeVisible()
    const box = await arriving.boundingBox()
    expect(box?.width).toBeCloseTo(128, 0)
    expect(box?.height).toBeCloseTo(128, 0)
  })

  // A slow connection: the links of the file take their time. The thread shows the box of the picture all
  // along, never the word of its kind, and the picture lands in the same box.
  test('keeps the box of a picture while its links are slow, with no word in its place', async () => {
    const conversationId = await newConversationIn(storeId)
    const message = await addMessageTo(storeId, conversationId, {
      type: MessageType.IMAGE,
      authorType: AuthorType.CUSTOMER,
      content: '',
      createdAt: minutesAgo(2)
    })
    const media = await addMediaTo(storeId, message.id, {
      filename: 'slow.png',
      contentType: 'image/png',
      status: MediaStatus.CLEAN,
      processed: 'with-variants'
    })
    await page.route(`${STORAGE_URL}/**`, route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
    )
    // `fallback` hands the request on to the route of the context, which sets the address of the case
    // The links are held until the case lets them go, so that no timer decides what the case sees
    let release: () => void = () => undefined
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    await page.route(`**/media/${media.id}`, async route => {
      await held
      await route.fallback()
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const loading = threadOf(page)
      .getByRole('status')
      .filter({ hasText: en.inbox.thread.media.loading.replace('{name}', 'slow.png') })
    await expect(loading).toBeVisible()
    await expect(
      threadOf(page).getByText(en.inbox.thread.mediaLabel.IMAGE, { exact: true })
    ).toHaveCount(0)
    const before = await loading.boundingBox()

    release()
    const image = threadOf(page).getByRole('button', {
      name: en.inbox.thread.media.open.replace('{name}', 'slow.png')
    })
    await expect(image).toBeVisible()
    const after = await image.boundingBox()
    expect(after?.width).toBeCloseTo(before?.width ?? -1, 0)
    expect(after?.height).toBeCloseTo(before?.height ?? -1, 0)
  })

  test('draws a sticker alone, with no bubble, in a square box', async () => {
    const conversationId = await newConversationIn(storeId)
    const message = await addMessageTo(storeId, conversationId, {
      type: MessageType.IMAGE,
      content: '',
      createdAt: minutesAgo(2),
      metadata: { sticker: true }
    })
    await addMediaTo(storeId, message.id, {
      filename: 'sticker.webp',
      contentType: 'image/webp',
      status: MediaStatus.CLEAN,
      processed: 'with-variants'
    })
    await page.route(`${STORAGE_URL}/**`, route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
    )
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const sticker = threadOf(page).getByRole('button', {
      name: en.inbox.thread.media.open.replace('{name}', 'sticker.webp')
    })
    await expect(sticker).toBeVisible()
    const box = await sticker.boundingBox()
    expect(box?.width).toBeCloseTo(128, 0)
    expect(box?.height).toBeCloseTo(128, 0)
    // Two levels up is the place a bubble would be: it has no fill and no border
    const bubble = sticker.locator('xpath=../..')
    await expect(bubble).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(bubble).toHaveCSS('border-top-width', '0px')
  })

  test('draws a picture the decoder refused as a download in the box of a file', async () => {
    const conversationId = await newConversationIn(storeId)
    const message = await addMessageTo(storeId, conversationId, {
      type: MessageType.IMAGE,
      content: 'a photo',
      createdAt: minutesAgo(2)
    })
    await addMediaTo(storeId, message.id, {
      filename: 'broken.png',
      contentType: 'image/png',
      status: MediaStatus.CLEAN,
      processed: 'refused'
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const download = threadOf(page).getByRole('link', { name: /broken\.png/ })
    await expect(download).toBeVisible()
    const box = await download.boundingBox()
    expect(box?.height).toBeCloseTo(40, 0)
    // The width of the pill of a voice note, not the width of the words in it
    expect(box?.width).toBeCloseTo(260, 0)
  })
})
