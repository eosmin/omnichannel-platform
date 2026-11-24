import { randomUUID } from 'node:crypto'

import { type BrowserContext, type Page } from '@playwright/test'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { newCustomerIn, storeIdNamed } from '../support/database'
import { dsrPublicIntakeOn } from '../support/env'
import { signIn } from '../support/login'
import { dsrVerifyTokenIn, emailCountTo, emptyMailboxOf, nextEmailTo } from '../support/mailbox'
import { expect, reachServicesFromOwnAddress, test } from '../support/test'

// The whole public flow of a data request, with the flag ON: the store makes its key, a visitor files an erasure on the form of that
// address, the worker mails the link, the visitor opens it and confirms, and the request waits in the queue for a person.
//
// It runs only when the api and the worker of the run have `DSR_PUBLIC_INTAKE_ENABLED=true`, which they refuse to start with while
// `DSR_PUBLIC_FLOW_READY` is false (the rest of the flow of Step 7.2-H2b). A run that checks the flow locally flips `DSR_PUBLIC_FLOW_READY` in
// `compliance-constants.ts` WITHOUT committing it, exports `DSR_PUBLIC_INTAKE_ENABLED=true` and runs this file. CI keeps both off and skips it.
const FIRST_STORE = 'Main Store'
// An administrator: the Admin preset holds `customers:dsr_manage_form` and `customers:dsr_review`
const ADMIN = 'multi-store@test.com'
// The worker sends the mail through a queue: this is how long the test waits before it says "no mail came"
const NO_MAIL_WAIT_MS = 4_000
const FORM = en.dsrRequest
const QUEUE = en.settings.dataRequests

test.describe('the public flow of a data request', () => {
  test.skip(
    !dsrPublicIntakeOn,
    'the public flow is off in this run (DSR_PUBLIC_INTAKE_ENABLED is not true)'
  )
  test.describe.configure({ mode: 'serial' })

  let admin: BrowserContext
  let adminPage: Page
  let visitor: BrowserContext
  let visitorPage: Page
  let storeId: string
  let formAddress = ''
  const unique = randomUUID().slice(0, 8)
  const customerEmail = `dsr-customer-${unique}@example.com`
  const strangerEmail = `dsr-stranger-${unique}@example.com`

  test.beforeAll(async ({ browser }) => {
    admin = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(admin)
    adminPage = await admin.newPage()
    await signIn(adminPage, ADMIN)
    storeId = await storeIdNamed(FIRST_STORE)
    await newCustomerIn(storeId, { name: `Dsr customer ${unique}`, email: customerEmail })
    // The visitor has no session and no store: a context of its own
    visitor = await browser.newContext({ locale: 'en' })
    await reachServicesFromOwnAddress(visitor)
    visitorPage = await visitor.newPage()
  })
  test.afterAll(async () => {
    await admin.close()
    await visitor.close()
  })

  async function queuedInReview(): Promise<number> {
    await adminPage.goto(AppPaths.store.settings(storeId, StoreSettingsSections.DATA_REQUESTS))
    await expect(adminPage.getByRole('heading', { name: QUEUE.title })).toBeVisible()
    return adminPage.getByRole('row').filter({ hasText: QUEUE.statuses.manual_review }).count()
  }

  async function fileRequest(address: string): Promise<void> {
    await visitorPage.goto(formAddress)
    await expect(visitorPage.getByRole('heading', { name: FORM.heading })).toBeVisible()
    await visitorPage.getByLabel(FORM.typeLabel).selectOption({ label: FORM.types.erasure })
    await visitorPage.getByLabel(FORM.emailLabel).fill(address)
    await visitorPage.getByRole('button', { name: FORM.submit }).click()
  }

  test('the store gets the address of its form next to the key', async () => {
    await adminPage.goto(AppPaths.store.settings(storeId, StoreSettingsSections.DATA_REQUESTS))
    const create = adminPage.getByRole('button', { name: en.settings.dsrForm.make })
    if ((await create.count()) > 0) await create.click()
    const address = adminPage.getByText(new RegExp(`${AppPaths.dsrRequest}#key=`))
    await expect(address).toBeVisible()
    formAddress = (await address.textContent()) ?? ''
    expect(formAddress).toContain(`${AppPaths.dsrRequest}#key=`)
  })

  test('a visitor files an erasure, gets the same answer, and the mail holds the link that confirms it', async () => {
    const before = await queuedInReview()
    await emptyMailboxOf(customerEmail)

    await fileRequest(customerEmail)
    const result = visitorPage.getByRole('main').getByRole('status')
    await expect(result).toContainText(FORM.sent)
    // The key is out of the address bar
    expect(await visitorPage.evaluate(() => window.location.hash)).toBe('')

    // The worker-to-page round trip: the link of the mail opens the page of C1b-1, and the button confirms
    const token = dsrVerifyTokenIn(await nextEmailTo(customerEmail))
    await visitorPage.goto(`${AppPaths.dsrVerify}#token=${token}`)
    await visitorPage.getByRole('main').getByRole('button', { name: en.dsrVerify.confirm }).click()
    await expect(visitorPage.getByRole('main').getByRole('status')).toContainText(en.dsrVerify.done)

    // A person reviews it: it waits in the queue, in review
    await expect.poll(queuedInReview).toBe(before + 1)
  })

  test('the same address again gets the same answer and no second mail', async () => {
    await emptyMailboxOf(customerEmail)
    await fileRequest(customerEmail)
    await expect(visitorPage.getByRole('main').getByRole('status')).toContainText(FORM.sent)
    await visitorPage.waitForTimeout(NO_MAIL_WAIT_MS)
    expect(await emailCountTo(customerEmail)).toBe(0)
  })

  test('an address that is no customer gets the same text and no mail', async () => {
    await emptyMailboxOf(strangerEmail)
    await fileRequest(strangerEmail)
    await expect(visitorPage.getByRole('main').getByRole('status')).toContainText(FORM.sent)
    await visitorPage.waitForTimeout(NO_MAIL_WAIT_MS)
    expect(await emailCountTo(strangerEmail)).toBe(0)
  })

  test('a key the store never made says the link is incomplete, not that the store is unknown', async () => {
    await visitorPage.goto(`${AppPaths.dsrRequest}#key=${'z'.repeat(32)}`)
    await visitorPage.getByLabel(FORM.emailLabel).fill(strangerEmail)
    await visitorPage.getByRole('button', { name: FORM.submit }).click()
    // The api answers the same 202 for a key it does not know: the page cannot tell, and says the same as for any address
    await expect(visitorPage.getByRole('main').getByRole('status')).toContainText(FORM.sent)
  })
})
