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

// A capture of the page kept with the result of the run (the report and the output folder), to be seen by a person
async function capture(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' })
}

// A reply of the team with `count` files that went, each with an id of its own at the provider (WhatsApp-like)
async function replyWithPictures(
  storeId: string,
  conversationId: string,
  count: number
): Promise<{ messageId: string; ids: string[] }> {
  const message = await addMessageTo(storeId, conversationId, {
    authorType: AuthorType.AGENT,
    type: MessageType.IMAGE,
    deliveryStatus: DeliveryStatus.SENT,
    channelMessageId: 'wamid.pic-1',
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
      channelMessageId: `wamid.pic-${at + 1}`
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

// The owner's captures: an album of 3 of WhatsApp had no buttons on its first picture and two buttons of the
// message beside the bubble
test('with three pictures every picture, the first too, has its own buttons and the message has none to answer or react', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    const { messageId, ids } = await replyWithPictures(storeId, conversationId, 3)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const list = page.getByRole('list', { name: thread.label })
    const album = page.locator(`#message-${messageId}`)
    const first = page.locator(`#file-${ids[0]}`)
    await expect(first).toBeVisible()

    // No button of the message: neither to answer nor to react to it as a whole
    await expect(
      album.getByRole('button', { name: thread.actions.reply, exact: true })
    ).toHaveCount(0)
    await expect(
      album.getByRole('button', { name: thread.actions.react, exact: true })
    ).toHaveCount(0)

    // The first picture offers its buttons when the pointer is over it
    const firstReply = first.getByRole('button', { name: fill(thread.actions.replyFile, 1, 3) })
    const firstReact = first.getByRole('button', { name: fill(thread.actions.reactFile, 1, 3) })
    // The bar around the buttons is the one that fades
    const bar = firstReply.locator('xpath=..')
    await expect(bar).toHaveCSS('opacity', '0')
    await first.hover()
    await expect(bar).toHaveCSS('opacity', '1')
    await expect(firstReact).toBeVisible()
    await capture(page, 'tres-imagenes-botones-en-la-primera')

    // Reacting to the first names THAT picture, and the reaction is drawn under it
    await firstReact.click()
    const put = page.waitForRequest(
      request => request.method() === 'PUT' && request.url().endsWith('/reaction')
    )
    await page.getByRole('menuitem', { name: '👍' }).click()
    expect((await put).postDataJSON()).toMatchObject({ emoji: '👍', mediaId: ids[0] })
    await expect(
      list.getByRole('list', { name: fill(thread.reactions.ofFile, 1, 3) })
    ).toContainText('👍')
    await expect(list.getByRole('list', { name: fill(thread.reactions.ofFile, 2, 3) })).toHaveCount(
      0
    )

    // Reacting to the second one is its own reaction, under the second
    const second = page.locator(`#file-${ids[1]}`)
    await second.hover()
    await second.getByRole('button', { name: fill(thread.actions.reactFile, 2, 3) }).click()
    await page.getByRole('menuitem', { name: '❤️' }).click()
    await expect(
      list.getByRole('list', { name: fill(thread.reactions.ofFile, 2, 3) })
    ).toContainText('❤️')
    await capture(page, 'tres-imagenes-reaccion-en-la-segunda')

    // My own reaction to the first is known as mine: the menu offers to take it back
    await first.hover()
    await firstReact.click()
    await expect(
      page.getByRole('menuitem', {
        name: thread.actions.removeReactionWith.replace('{emoji}', '👍')
      })
    ).toBeVisible()
    await page.keyboard.press('Escape')
  } finally {
    await page.context().close()
  }
})

test('a quote of the first picture marks that thumbnail and no other', async ({ browser }) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    const { messageId, ids } = await replyWithPictures(storeId, conversationId, 3)
    await addMessageTo(storeId, conversationId, {
      authorType: AuthorType.CUSTOMER,
      content: 'The first',
      replyToMessageId: messageId,
      replyToMediaId: ids[0],
      createdAt: new Date(Date.now() - 10_000)
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const list = page.getByRole('list', { name: thread.label })
    await list.getByRole('button', { name: new RegExp(fill(thread.quote.file, 1, 3)) }).click()
    await expect(page.locator(`#file-${ids[0]}`)).toHaveClass(/ring-primary/)
    for (const other of [1, 2]) {
      await expect(page.locator(`#file-${ids[other]}`)).not.toHaveClass(/ring-primary/)
    }
    await capture(page, 'cita-de-la-primera-resalta-la-primera')
  } finally {
    await page.context().close()
  }
})

// The real flow of the owner's defect: with no button on the first picture the agent could only quote the message,
// and following that quote marked the whole block
test('answering the first and then the second picture quotes that picture, and following the quote marks its thumbnail', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    const { ids } = await replyWithPictures(storeId, conversationId, 3)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const list = page.getByRole('list', { name: thread.label })
    const box = page.getByRole('textbox', { name: en.inbox.composer.replyLabel })

    for (const [at, text] of [
      [0, 'About the first'],
      [1, 'About the second']
    ] as const) {
      const picture = page.locator(`#file-${ids[at]}`)
      await expect(picture).toBeVisible()
      await picture.hover()
      await picture.getByRole('button', { name: fill(thread.actions.replyFile, at + 1, 3) }).click()
      await box.fill(text)
      // The request that sends the reply names the picture that was answered
      const sent = page.waitForRequest(
        request => request.method() === 'POST' && request.url().endsWith('/messages')
      )
      await page.getByRole('button', { name: en.inbox.composer.send }).click()
      expect((await sent).postDataJSON()).toMatchObject({ replyToMediaId: ids[at] })
      const quote = list.getByRole('button', {
        name: new RegExp(fill(thread.quote.file, at + 1, 3))
      })
      await expect(quote).toBeVisible()
      await quote.click()
      // Only the picture that was answered is marked, never the block
      for (const [other, id] of ids.entries()) {
        const mark = page.locator(`#file-${id}`)
        if (other === at) await expect(mark).toHaveClass(/ring-primary/)
        else await expect(mark).not.toHaveClass(/ring-primary/)
      }
      await capture(page, `flujo-real-citar-la-imagen-${at + 1}`)
    }
  } finally {
    await page.context().close()
  }
})

test('a message with one picture keeps the buttons of the message and none by picture', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    const { messageId } = await replyWithPictures(storeId, conversationId, 1)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const list = page.getByRole('list', { name: thread.label })
    const message = page.locator(`#message-${messageId}`)
    await expect(message).toBeVisible()
    await message.hover()
    await expect(
      message.getByRole('button', { name: thread.actions.reply, exact: true })
    ).toBeVisible()
    await expect(
      message.getByRole('button', { name: thread.actions.react, exact: true })
    ).toBeVisible()
    await expect(list.getByRole('button', { name: /image \d+ of \d+/ })).toHaveCount(0)
    await capture(page, 'una-imagen-botones-del-mensaje')
  } finally {
    await page.context().close()
  }
})
