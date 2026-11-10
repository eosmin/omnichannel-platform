import { AppPaths } from '@platform/api-client'
import { MessageMetadataKeys, MessageType } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addMessageTo, newConversationIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const AGENT = personOf('agent', import.meta.url)
const MINUTE_MS = 60_000
const minutesAgo = (minutes: number): Date => new Date(Date.now() - minutes * MINUTE_MS)
const story = en.inbox.thread.storyReply

// Its own session and address: the thread of the other specs spends most of the minute's requests
test('draws the card of the story a customer answered, with a notice when the story is gone', async ({
  browser
}) => {
  const context = await browser.newContext()
  try {
    await reachServicesFromOwnAddress(context)
    const page = await context.newPage()
    await signIn(page, AGENT)
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newConversationIn(storeId)
    // The first has no link (it did not come); the second has one on a host the CSP does not draw, as an
    // expired or a foreign link would be: both end as the notice
    await addMessageTo(storeId, conversationId, {
      type: MessageType.TEXT,
      content: 'Me encanta',
      metadata: { [MessageMetadataKeys.STORY_REPLY]: {} },
      createdAt: minutesAgo(2)
    })
    await addMessageTo(storeId, conversationId, {
      type: MessageType.TEXT,
      content: 'Y esta otra',
      metadata: {
        [MessageMetadataKeys.STORY_REPLY]: { url: 'https://stories.example.invalid/gone.jpg' }
      },
      createdAt: minutesAgo(1)
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const thread = page.getByRole('list', { name: en.inbox.thread.label })
    await expect(thread.getByText(story.label)).toHaveCount(2)
    await expect(thread.getByText(story.unavailable)).toHaveCount(2)
    await expect(thread.getByText('Me encanta')).toBeVisible()
    // The story is not a shared link
    await expect(thread.getByRole('link')).toHaveCount(0)
  } finally {
    await context.close()
  }
})
