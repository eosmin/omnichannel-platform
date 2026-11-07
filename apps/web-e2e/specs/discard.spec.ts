import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'
import { AuthorType, DeliveryStatus } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addMessageTo, newConversationIn, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
const thread = en.inbox.thread
const actions = thread.actions

// A failed reply is drawn in two ways, by what the api knows of it (`failureDefinitive`): known not to have
// gone out (red, can be discarded) or maybe gone out (amber, can only be sent again, with a warning). The
// states are written in the database; the failure itself (a refusal of Meta, a timeout) is covered by the
// integration suite of the api. One session for both cases: the magic link is limited for each address.
test.describe.serial('a reply that failed', () => {
  let context: BrowserContext
  let page: Page
  let storeId: string
  let newAddress: () => void

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext()
    newAddress = await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, 'admin@test.com')
    storeId = await storeIdNamed(FIRST_STORE)
  })
  test.afterAll(async () => {
    await context.close()
  })
  test.beforeEach(() => {
    newAddress()
  })

  async function failedReply(
    conversationId: string,
    content: string,
    failureDefinitive: boolean
  ): Promise<void> {
    await addMessageTo(storeId, conversationId, {
      content,
      authorType: AuthorType.AGENT,
      deliveryStatus: DeliveryStatus.FAILED,
      deliveryError: 'CHANNEL_CREDENTIALS_INVALID',
      failureDefinitive,
      createdAt: new Date()
    })
  }

  const rowOf = (text: string) => page.getByRole('listitem').filter({ hasText: text })

  test('known not to have gone out: red, can be discarded, and it leaves the thread with no trace', async () => {
    const conversationId = await newConversationIn(storeId)
    const text = `Discard me ${Date.now()}`
    await failedReply(conversationId, text, true)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const row = rowOf(text)
    await expect(row.getByText(en.inbox.thread.failedWithReason.split('{')[0] ?? '')).toBeVisible()
    await expect(row.getByText(thread.ticks.unconfirmedNote)).toHaveCount(0)

    await row.getByRole('button', { name: actions.more }).click()
    await page.getByRole('menuitem', { name: actions.resend }).waitFor()
    await page.getByRole('menuitem', { name: actions.discard }).click()
    const dialog = page.getByRole('alertdialog', { name: actions.discardTitle })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: actions.discard }).click()

    // The reply is gone, and nothing says that a message was deleted
    await expect(page.getByText(text)).toHaveCount(0)
    for (const deleted of [
      thread.deletedGeneric,
      thread.deletedByCustomer,
      thread.deletedByOwner
    ]) {
      await expect(page.getByText(deleted)).toHaveCount(0)
    }
  })

  test('may have gone out: amber, no way to discard it, and sending it again asks first', async () => {
    const conversationId = await newConversationIn(storeId)
    const text = `Maybe sent ${Date.now()}`
    await failedReply(conversationId, text, false)
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    const row = rowOf(text)
    await expect(row.getByText(thread.ticks.unconfirmedNote)).toBeVisible()

    await row.getByRole('button', { name: actions.more }).click()
    await expect(page.getByRole('menuitem', { name: actions.discard })).toHaveCount(0)
    await page.getByRole('menuitem', { name: actions.resend }).click()
    const dialog = page.getByRole('alertdialog', { name: actions.resendTitle })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(actions.resendDuplicateDescription)).toBeVisible()
    await dialog.getByRole('button', { name: en.common.cancel }).click()
    await expect(dialog).toBeHidden()
    // Nothing was sent: the reply is still there, still unconfirmed
    await expect(row.getByText(thread.ticks.unconfirmedNote)).toBeVisible()
  })
})
