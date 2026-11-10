import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { AuthorType, MediaStatus, MessageType } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addMediaTo, addMessageTo, newConversationIn, storeIdNamed } from '../support/database'
import { seedAnchor } from '../support/day-anchor'
import { STORAGE_URL } from '../support/env'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// A valid 1x1 image, what the bucket would answer for the variants
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)
const media = en.inbox.thread.media
const thread = en.inbox.thread

// Pictures a customer sends one after the other are one message each at the channel. The thread draws the ones sent
// within a minute as one block, and the viewer walks them; each picture stays its own message. A spec of its own:
// one sign in, one conversation.
test('draws the pictures a customer sent together as one block and walks them in the viewer', async ({
  browser
}) => {
  const context: BrowserContext = await browser.newContext()
  try {
    await reachServicesFromOwnAddress(context)
    const page: Page = await context.newPage()
    await page.route(`${STORAGE_URL}/**`, route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: ONE_PIXEL_PNG })
    )
    await signIn(page, personOf('admin', import.meta.url))
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newConversationIn(storeId)
    // One reading of the clock, and a window that does not cross midnight
    const anchor = seedAnchor(10 * 60_000)

    const picture = async (name: string, secondsBefore: number): Promise<string> => {
      const message = await addMessageTo(storeId, conversationId, {
        type: MessageType.IMAGE,
        authorType: AuthorType.CUSTOMER,
        content: '',
        createdAt: new Date(anchor - secondsBefore * 1000)
      })
      await addMediaTo(storeId, message.id, {
        filename: name,
        contentType: 'image/png',
        status: MediaStatus.CLEAN,
        processed: 'with-variants'
      })
      return message.id
    }
    // Three within a minute of each other, then a text, then one picture alone, then one a long while after
    const first = await picture('one.png', 400)
    const second = await picture('two.png', 380)
    const third = await picture('three.png', 350)
    await addMessageTo(storeId, conversationId, {
      content: 'Which one do you want?',
      authorType: AuthorType.AGENT,
      createdAt: new Date(anchor - 300 * 1000)
    })
    await picture('four.png', 120)
    await picture('five.png', 20)

    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const list = page.getByRole('list', { name: thread.label })
    const block = list.getByRole('group', { name: thread.imageRun.replace('{count}', '3') })
    await expect(block).toBeVisible()

    // Each picture is its own message: its own element, its own hour, its own menu
    await expect(block.locator('[id^="message-"]')).toHaveCount(3)
    await expect(block.locator('time')).toHaveCount(3)
    await expect(block.locator(`#message-${first}`)).toBeVisible()
    await expect(block.locator(`#message-${third}`)).toBeVisible()
    // The two after the text are not in it, and are two blocks of their own too far apart (a minute and a half)
    await expect(list.getByRole('group', { name: /pictures/ })).toHaveCount(1)
    await expect(
      list.getByRole('button', { name: media.open.replace('{name}', 'four.png') })
    ).toBeVisible()

    // Reply to the second picture alone: the box quotes that one, not the block
    await block.locator(`#message-${second}`).hover()
    await block
      .locator(`#message-${second}`)
      .getByRole('button', { name: thread.actions.reply })
      .click()
    await expect(page.getByRole('button', { name: en.inbox.composer.cancelReply })).toBeVisible()
    await page.getByRole('button', { name: en.inbox.composer.cancelReply }).click()

    // The viewer opens on the one that was pressed and the arrows walk the block, around
    await block.getByRole('button', { name: media.open.replace('{name}', 'one.png') }).click()
    await expect(page.getByRole('dialog', { name: 'one.png' })).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('dialog', { name: 'two.png' })).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('dialog', { name: 'three.png' })).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('dialog', { name: 'one.png' })).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('dialog', { name: 'three.png' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'three.png' })).toBeHidden()
  } finally {
    await context.close()
  }
})
