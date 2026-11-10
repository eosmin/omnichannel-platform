import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { ConversationLimits, ConversationStatus } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import {
  ageConversation,
  endSnooze,
  newConversationIn,
  statusOf,
  storeIdNamed
} from '../support/database'
import { signIn } from '../support/login'
import { personOf } from '../support/people'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const DAY_MS = 86_400_000
const NOTE = 'Call back about the refund <b>today</b>'
// The sweep of the worker runs every minute, and the row then follows the event of the api
const SWEEP_TIMEOUT_MS = 150_000

// A snoozed conversation that wakes up: the agent leaves a reminder, the sweep wakes it, and the list shows it
// at the top with a badge until someone opens it. The time of the snooze is moved in the database; the sweep,
// the mark and the event are the real ones.
test.describe.serial('a snoozed conversation that wakes up', () => {
  let context: BrowserContext
  let page: Page
  let storeId: string

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext()
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, personOf('admin', import.meta.url))
    storeId = await storeIdNamed(FIRST_STORE)
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('shows the reminder in the list and in the thread, raises the row, and opening it takes the badge off', async () => {
    // The sweep runs once a minute: the wait for it is longer than the time of a case
    test.setTimeout(SWEEP_TIMEOUT_MS + 90_000)
    // Old, so that it would sit far down the list if nothing raised it
    const conversationId = await newConversationIn(storeId)
    await ageConversation(conversationId, 3 * DAY_MS)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))

    const reply = page.getByRole('textbox', { name: en.inbox.composer.replyLabel })
    await reply.fill('/snooze')
    await reply.press('Enter')
    const dialog = page.getByRole('dialog', { name: en.inbox.snooze.title })
    const note = dialog.getByLabel(en.inbox.snooze.noteLabel)
    await expect(note).toHaveAttribute(
      'maxlength',
      String(ConversationLimits.SNOOZE_NOTE_MAX_LENGTH)
    )
    await note.fill(NOTE)
    await dialog
      .getByRole('button', { name: new RegExp(en.inbox.snooze.presets.tomorrowMorning) })
      .click()
    await expect.poll(() => statusOf(conversationId)).toBe(ConversationStatus.SNOOZED)

    await endSnooze(conversationId)
    await page.goto(AppPaths.store.inbox(storeId))
    const list = page.getByRole('list', { name: en.inbox.listLabel })
    const row = list.locator(`a[href*="${conversationId}"]`)
    // The badge reads the reminder as text: the tags in it are not drawn as tags
    const badge = en.inbox.wokeNote.replace('{note}', NOTE)
    await expect(row.getByText(badge)).toBeVisible({ timeout: SWEEP_TIMEOUT_MS })
    // First in the list, though its last message is three days old
    await expect(list.getByRole('link').first()).toHaveAttribute('href', new RegExp(conversationId))

    // Opening it: the line of the thread says it woke up and repeats the reminder, and the badge goes
    await row.click()
    const thread = page.getByRole('list', { name: en.inbox.thread.label })
    await expect(thread.getByText(/^Woke up/)).toBeVisible()
    await expect(
      thread.getByText(en.inbox.thread.system.reminder.replace('{note}', NOTE))
    ).toBeVisible()
    await expect(list.getByText(badge)).toHaveCount(0)
  })
})
