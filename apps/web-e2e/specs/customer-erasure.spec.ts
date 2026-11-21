import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newConversationOfCustomerNamed, storeIdNamed } from '../support/database'
import { expectDialogFitsThePhoneWidth } from '../support/dialog-fit'
import { signIn } from '../support/login'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

const FIRST_STORE = 'Main Store'
// An administrator: the Admin preset holds `customers:erase`
const ADMIN = 'multi-store@test.com'
const ERASURE = en.customers.erasure

test.describe('the erasure of a customer', () => {
  test.describe.configure({ mode: 'serial' })

  let context: BrowserContext
  let page: Page
  let storeId: string
  let conversationId = ''
  const customerName = `Erasure customer ${randomUUID().slice(0, 8)}`

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(context)
    page = await context.newPage()
    await signIn(page, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
    conversationId = (await newConversationOfCustomerNamed(storeId, customerName)).conversationId
  })
  test.afterAll(async () => {
    await context.close()
  })

  test('asks for a typed word, says what goes and what stays, and marks the profile as erased', async () => {
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    // Before the erasure the agent can answer
    await expect(page.getByRole('textbox', { name: en.inbox.composer.replyLabel })).toBeVisible()

    await page.goto(AppPaths.store.customers(storeId))
    await page.getByLabel(en.customers.list.searchLabel).fill(customerName)
    await page.getByRole('button', { name: customerName }).click()
    const profile = page.getByRole('dialog', { name: en.customers.profile.title })
    await profile.getByRole('button', { name: ERASURE.open, exact: true }).click()

    const dialog = page.getByRole('dialog', { name: ERASURE.title, exact: true })
    await expect(dialog.getByText(ERASURE.erasesTitle, { exact: true })).toBeVisible()
    await expect(dialog.getByText(ERASURE.keepsTitle, { exact: true })).toBeVisible()
    await expectDialogFitsThePhoneWidth(page, dialog)
    // Nothing is sent without the word
    const submit = dialog.getByRole('button', { name: ERASURE.submit, exact: true })
    await expect(submit).toBeDisabled()
    await dialog.getByLabel(ERASURE.confirmLabel.replace('{word}', ERASURE.confirmWord)).fill('no')
    await expect(submit).toBeDisabled()
    await dialog
      .getByLabel(ERASURE.confirmLabel.replace('{word}', ERASURE.confirmWord))
      .fill(ERASURE.confirmWord)
    await submit.click()
    await expect(dialog).toHaveCount(0)

    await expect(profile.getByText(ERASURE.chip, { exact: true })).toBeVisible()
    await expect(profile.getByText(ERASURE.note, { exact: true })).toBeVisible()
    // Read only: the erase button and the edit controls are gone
    await expect(profile.getByRole('button', { name: ERASURE.open, exact: true })).toHaveCount(0)
    await expect(profile.getByRole('button', { name: en.customers.edit.editProfile })).toHaveCount(
      0
    )
    // Nor the box of notes: the api refuses a note of an erased customer
    await expect(profile.getByLabel(en.customers.edit.note.label, { exact: true })).toHaveCount(0)
  })

  test('the conversation of an erased customer is read only, with its own text', async () => {
    await page.goto(AppPaths.store.conversation(storeId, conversationId))
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByText(en.inbox.erased.chip, { exact: true }).first()).toBeVisible()
    await expect(page.getByText(en.inbox.erased.composer, { exact: true })).toBeVisible()
    await expect(page.getByRole('textbox', { name: en.inbox.composer.replyLabel })).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: en.inbox.composer.noteLabel })).toHaveCount(0)
  })
})
