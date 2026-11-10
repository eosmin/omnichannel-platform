import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import {
  AssignmentReasons,
  AuthorType,
  MessageType,
  SystemMessageEvents
} from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addMessageTo, newConversationIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const ADMIN = personOf('admin', import.meta.url)
const { assignOnReply } = en.settings.inbox

// Its own session and address: the api limits the requests of each address
test('the switch to assign on reply is saved, and the line of such an assignment says so', async ({
  browser
}) => {
  const context = await browser.newContext()
  try {
    await reachServicesFromOwnAddress(context)
    const page = await context.newPage()
    await signIn(page, ADMIN)
    const storeId = await storeIdNamed(FIRST_STORE)

    await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.INBOX))
    const form = page.getByRole('form', { name: assignOnReply.label })
    const box = form.getByRole('checkbox')
    const was = await box.isChecked()
    try {
      await box.setChecked(!was)
      await form.getByRole('button', { name: assignOnReply.save }).click()
      await expect(page.getByText(assignOnReply.saved)).toBeVisible()
      await page.reload()
      await expect(
        page.getByRole('form', { name: assignOnReply.label }).getByRole('checkbox')
      ).toBeChecked({ checked: !was })
    } finally {
      // The other specs share this store
      await page.goto(AppPaths.store.settings(storeId, StoreSettingsSections.INBOX))
      const back = page.getByRole('form', { name: assignOnReply.label })
      const now = await back.getByRole('checkbox').isChecked()
      if (now !== was) {
        await back.getByRole('checkbox').setChecked(was)
        await back.getByRole('button', { name: assignOnReply.save }).click()
        await expect(page.getByText(assignOnReply.saved)).toBeVisible()
      }
    }

    // The line the server writes when a reply took the conversation: an assignment with the reason
    const conversationId = await newConversationIn(storeId)
    await addMessageTo(storeId, conversationId, {
      type: MessageType.SYSTEM,
      authorType: AuthorType.SYSTEM,
      content: '',
      createdAt: new Date(Date.now() - 60_000),
      system: {
        event: SystemMessageEvents.ASSIGNED,
        actorType: 'user',
        reason: AssignmentReasons.ON_REPLY
      }
    })
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const thread = page.getByRole('list', { name: en.inbox.thread.label })
    await expect(thread.getByText(/took it by replying/)).toBeVisible()
    await expect(thread.getByText(/Reason:/)).toHaveCount(0)
  } finally {
    await context.close()
  }
})
