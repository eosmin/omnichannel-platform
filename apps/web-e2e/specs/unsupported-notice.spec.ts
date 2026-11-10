import { type Browser, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { AuthorType, MessageType } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addMessageTo, newWhatsAppConversationWrittenAgo, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const AGENT = personOf('agent', import.meta.url)
const MINUTE_MS = 60_000
const thread = en.inbox.thread

// Content the channel does not deliver: one marker per message, as a channel stores it
async function conversationWith(storeId: string, kinds: (string | null)[]): Promise<string> {
  const conversationId = await newWhatsAppConversationWrittenAgo(storeId, MINUTE_MS)
  for (const [at, kind] of kinds.entries()) {
    await addMessageTo(storeId, conversationId, {
      authorType: AuthorType.CUSTOMER,
      type: MessageType.TEXT,
      content: kind === null ? 'a plain text' : `[${kind}]`,
      createdAt: new Date(Date.now() - MINUTE_MS / 2 + at * 1000),
      ...(kind === null ? {} : { metadata: { unsupportedType: kind } })
    })
  }
  return conversationId
}

async function signedInPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext()
  await reachServicesFromOwnAddress(context)
  const page = await context.newPage()
  await signIn(page, AGENT)
  return page
}

test('one notice says the same for every kind of content, and consecutive ones are one bubble with the count', async ({
  browser
}) => {
  const page = await signedInPage(browser)
  try {
    const storeId = await storeIdNamed(FIRST_STORE)
    const lone = await conversationWith(storeId, ['story_mention'])
    await page.goto(AppPaths.store.conversation(storeId, lone))
    await expect(page.getByText(thread.unsupportedKind.notice)).toHaveCount(1)

    const many = await conversationWith(storeId, [
      'order',
      'story_mention',
      'ig_post',
      null,
      'order'
    ])
    await page.goto(AppPaths.store.conversation(storeId, many))
    const three = thread.unsupportedGroup.replace('<num>{count}</num>', '3')
    // The tag of the highlight is gone from the sentence that is looked for (or the replace did nothing)
    expect(three).not.toContain('<')
    await expect(page.getByText(three)).toHaveCount(1)
    // The number is what the agent looks for: it stands out of the sentence
    await expect(page.getByText(three).locator('strong')).toHaveText('3')
    // The text between them ends the run: the last one is a notice of its own
    await expect(page.getByText('a plain text')).toHaveCount(1)
    await expect(page.getByText(thread.unsupportedKind.notice)).toHaveCount(1)
  } finally {
    await page.context().close()
  }
})
