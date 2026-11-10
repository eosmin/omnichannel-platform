import { type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  captionsStoredIn,
  filesSentIn,
  newWhatsAppConversationWrittenAgo,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const AGENT = personOf('agent', import.meta.url)
const MINUTE_MS = 60_000
const SCAN_TIMEOUT_MS = 60_000
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
const attach = en.inbox.composer.attach
const captionFieldOf = (page: Page, name: string) =>
  page.getByRole('textbox', { name: attach.captionFor.replace('{name}', name) })

// Its own session and address: each file is three requests and the api limits an address to 100 a minute
test('each file, the first included, has a field for its text, with its limit, and the text of the box goes last, apart', async ({
  browser
}) => {
  test.setTimeout(SCAN_TIMEOUT_MS + 60_000)
  const context = await browser.newContext()
  try {
    await reachServicesFromOwnAddress(context)
    const page = await context.newPage()
    await signIn(page, AGENT)
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    // The picker takes several once the directory of channels has said so
    await expect(page.locator('input[type=file]')).toHaveAttribute('multiple', '')
    await page
      .locator('input[type=file]')
      .setInputFiles([png('one.png'), png('two.png'), png('three.png')])
    await expect(page.getByText(attach.captionEach)).toBeVisible()
    // Every file has a field, the first too; the message box is the text of the message, sent after the files
    const one = captionFieldOf(page, 'one.png')
    await expect(one).toBeVisible()
    const two = captionFieldOf(page, 'two.png')
    const three = captionFieldOf(page, 'three.png')
    await expect(two).toBeVisible()
    await expect(three).toBeVisible()

    await two.fill('Second photo')
    await expect(page.getByText(/^12 of \d+$/)).toBeVisible()
    // Escape leaves the field and keeps the text; it does not close the conversation
    await two.press('Escape')
    await expect(two).not.toBeFocused()
    await expect(two).toHaveValue('Second photo')
    expect(page.url()).toContain(conversationId)
    await three.fill('Third photo')
    await one.fill('First photo')

    await page.getByRole('textbox', { name: en.inbox.composer.replyLabel }).fill('For all of them')
    const send = page.getByRole('button', { name: en.inbox.composer.send })
    await expect(send).toBeEnabled({ timeout: SCAN_TIMEOUT_MS })
    await send.click()

    await expect
      .poll(() => captionsStoredIn(conversationId))
      .toEqual([
        { filename: 'one.png', caption: 'First photo' },
        { filename: 'two.png', caption: 'Second photo' },
        { filename: 'three.png', caption: 'Third photo' }
      ])

    // The text of the box is the message's own, not the first file's
    await expect
      .poll(() => filesSentIn(conversationId))
      .toEqual([
        { filename: 'one.png', position: 0, caption: 'First photo', text: 'For all of them' },
        { filename: 'two.png', position: 1, caption: 'Second photo', text: 'For all of them' },
        { filename: 'three.png', position: 2, caption: 'Third photo', text: 'For all of them' }
      ])

    // The thread draws the text of each file under it, the first included, and the text of the message once
    const thread = page.getByRole('list', { name: en.inbox.thread.label })
    await expect(thread.getByText('For all of them', { exact: true })).toHaveCount(1)
    await expect(thread.getByText('First photo', { exact: true })).toHaveCount(1)
    await expect(thread.getByText('Second photo', { exact: true })).toBeVisible()
    await expect(thread.getByText('Third photo', { exact: true })).toBeVisible()
  } finally {
    await context.close()
  }
})
