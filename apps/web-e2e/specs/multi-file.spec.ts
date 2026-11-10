import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { filesSentIn, newWhatsAppConversationWrittenAgo, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const AGENT = personOf('agent', import.meta.url)
const MINUTE_MS = 60_000
// Each file is uploaded and scanned (ClamAV, the worker) before the message can leave: slower in CI than on a laptop
const SCAN_TIMEOUT_MS = 60_000
// What WhatsApp is declared to take in one message (MetaMediaFilesPerMessage)
const WHATSAPP_MAX_FILES = 10
// A valid 1x1 image: the bucket checks the bytes of what it is given
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: ONE_PIXEL_PNG })

const attach = en.inbox.composer.attach
const chipsOf = (page: Page) =>
  page.getByRole('list', { name: attach.listLabel }).getByRole('listitem')
const removeButton = (page: Page, name: string) =>
  page.getByRole('button', { name: attach.remove.replace('{name}', name) })

// Several files in one message, from the composer. Apart from thread.spec.ts: each file is three requests
// (the signed address, the confirmation, the scan) and the api limits an address to 100 a minute, so every
// case takes an address of its own.
test.describe.serial('the composer with several files', () => {
  let context: BrowserContext
  let page: Page
  let newAddress: () => void
  let storeId: string

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext()
    newAddress = await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, AGENT)
    storeId = await storeIdNamed(FIRST_STORE)
  })
  test.beforeEach(() => newAddress())
  test.afterAll(async () => {
    await context.close()
  })

  async function openConversation(): Promise<string> {
    const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await expect(
      page
        .getByRole('list', { name: en.inbox.thread.label })
        .getByText('Hello, is my order on its way?')
    ).toBeVisible()
    return conversationId
  }

  test('three pictures chosen at once go in their order, one removed leaves two, and the text is the caption', async () => {
    // The scan of each file is part of the case
    test.setTimeout(SCAN_TIMEOUT_MS + 30_000)
    const conversationId = await openConversation()

    await page
      .locator('input[type=file]')
      .setInputFiles([png('first.png'), png('second.png'), png('third.png')])

    await expect(chipsOf(page)).toHaveCount(3)
    await expect(chipsOf(page).nth(0)).toContainText('first.png')
    await expect(chipsOf(page).nth(1)).toContainText('second.png')
    await expect(chipsOf(page).nth(2)).toContainText('third.png')
    await expect(page.getByText(attach.captionEach)).toBeVisible()

    await removeButton(page, 'second.png').click()
    await expect(chipsOf(page)).toHaveCount(2)
    await expect(chipsOf(page).nth(1)).toContainText('third.png')

    // Every file is clean before the message can leave
    await page
      .getByRole('textbox', { name: en.inbox.composer.replyLabel })
      .fill('Your three photos')
    const send = page.getByRole('button', { name: en.inbox.composer.send })
    await expect(send).toBeEnabled({ timeout: SCAN_TIMEOUT_MS })
    await send.click()

    await expect(chipsOf(page)).toHaveCount(0)
    await expect
      .poll(() => filesSentIn(conversationId))
      .toEqual([
        // The text of the box is the message's own, sent after the files: no file carries it
        { filename: 'first.png', position: 0, caption: null, text: 'Your three photos' },
        { filename: 'third.png', position: 1, caption: null, text: 'Your three photos' }
      ])
  })

  test('the message is full at the number the channel takes: the rest are not added and the agent is told', async () => {
    await openConversation()

    const files = Array.from({ length: WHATSAPP_MAX_FILES + 1 }, (_, at) => png(`photo-${at}.png`))
    await page.locator('input[type=file]').setInputFiles(files)

    await expect(chipsOf(page)).toHaveCount(WHATSAPP_MAX_FILES)
    await expect(
      page.getByRole('alert').filter({
        hasText: attach.tooMany.replace('{max}', String(WHATSAPP_MAX_FILES))
      })
    ).toBeVisible()
    // The picker says why it is off
    await expect(
      page.getByRole('button', {
        name: attach.full.replace('{max}', String(WHATSAPP_MAX_FILES))
      })
    ).toBeDisabled()

    await removeButton(page, 'photo-3.png').click()
    await expect(chipsOf(page)).toHaveCount(WHATSAPP_MAX_FILES - 1)
    await expect(page.getByRole('button', { name: attach.button })).toBeEnabled()
  })

  test('a message carries one kind of file: a document beside pictures is told, not added', async () => {
    await openConversation()

    await page
      .locator('input[type=file]')
      .setInputFiles([
        png('photo.png'),
        { name: 'invoice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') }
      ])

    await expect(chipsOf(page)).toHaveCount(1)
    await expect(chipsOf(page).first()).toContainText('photo.png')
    await expect(page.getByRole('alert').filter({ hasText: attach.mixed })).toBeVisible()
  })
})
