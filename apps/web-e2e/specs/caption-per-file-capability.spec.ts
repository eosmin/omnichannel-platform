import { AppPaths } from '@platform/api-client'
import { ChannelIds } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  newConversationOnChannel,
  newWhatsAppConversationWrittenAgo,
  storeIdNamed
} from '../support/database'
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
const png = (name: string) => ({ name, mimeType: 'image/png', buffer: ONE_PIXEL_PNG })
const attach = en.inbox.composer.attach

// Its own session and address: each file is three requests and the api limits an address to 100 a minute
test('the field for the text under each file is offered where the channel carries it, and only the one text elsewhere', async ({
  browser
}) => {
  const context = await browser.newContext()
  try {
    await reachServicesFromOwnAddress(context)
    const page = await context.newPage()
    await signIn(page, AGENT)
    const storeId = await storeIdNamed(FIRST_STORE)
    const fieldOf = (name: string) =>
      page.getByRole('textbox', { name: attach.captionFor.replace('{name}', name) })

    // WhatsApp carries a text under each file: every file has a field, the first included
    const whatsApp = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
    await page.goto(AppPaths.store.conversation(storeId, whatsApp))
    // The picker takes several once the directory of channels has answered: only then are its capabilities known
    await expect(page.locator('input[type=file]')).toHaveAttribute('multiple', '')
    await page.locator('input[type=file]').setInputFiles([png('one.png'), png('two.png')])
    await expect(page.getByText(attach.captionEach)).toBeVisible()
    await expect(fieldOf('one.png')).toBeVisible()
    await expect(fieldOf('two.png')).toBeVisible()

    // Messenger sends the text of a file as a message of its own: no field, and the text is the one of the message
    const messenger = await newConversationOnChannel(storeId, ChannelIds.MESSENGER, MINUTE_MS)
    await page.goto(AppPaths.store.conversation(storeId, messenger))
    // The picker takes several once the directory of channels has answered: only then are its capabilities known
    await expect(page.locator('input[type=file]')).toHaveAttribute('multiple', '')
    await page.locator('input[type=file]').setInputFiles([png('one.png'), png('two.png')])
    await expect(page.getByText(attach.captionAfter)).toBeVisible()
    await expect(fieldOf('one.png')).toHaveCount(0)
    await expect(fieldOf('two.png')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: en.inbox.composer.replyLabel })).toBeVisible()
  } finally {
    await context.close()
  }
})
