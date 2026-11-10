import { AppPaths } from '@platform/api-client'
import {
  AuthorType,
  ConversationStatusReasons,
  MessageType,
  SystemMessageEvents
} from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addMessageTo, newConversationIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const AGENT = personOf('agent', import.meta.url)
const REMINDER = 'Call back about the invoice'

// Its own session and address: the api limits the requests of each address
test('a conversation that wakes leaves one line in the thread, with its reminder inside', async ({
  browser
}) => {
  const context = await browser.newContext()
  try {
    await reachServicesFromOwnAddress(context)
    const page = await context.newPage()
    await signIn(page, AGENT)
    const storeId = await storeIdNamed(FIRST_STORE)
    const conversationId = await newConversationIn(storeId)
    // What the sweep writes when a snooze runs out: the event, the code of the reason and the reminder
    await addMessageTo(storeId, conversationId, {
      type: MessageType.SYSTEM,
      authorType: AuthorType.SYSTEM,
      content: '',
      createdAt: new Date(Date.now() - 60_000),
      system: {
        event: SystemMessageEvents.WOKEN,
        actorType: 'system',
        reason: ConversationStatusReasons.SNOOZE_EXPIRED,
        note: REMINDER
      }
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    // "Woke up" in English, the words of the catalog
    const line = page
      .getByRole('list', { name: en.inbox.thread.label })
      .getByText(/^Woke up/)
      .first()
    await expect(line).toBeVisible()
    // One paragraph holds the event, the time and the reminder: no "Reason:" line and no second paragraph
    const wrapper = line.locator('xpath=ancestor::div[1]')
    await expect(wrapper.locator('p')).toHaveCount(1)
    await expect(wrapper).toContainText(`Reminder: ${REMINDER}`)
    await expect(wrapper).not.toContainText('Reason:')
  } finally {
    await context.close()
  }
})
