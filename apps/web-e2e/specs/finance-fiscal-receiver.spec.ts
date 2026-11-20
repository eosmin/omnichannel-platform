import { randomUUID } from 'node:crypto'

import { AppPaths } from '@platform/api-client'
import { ApiRoutes } from '@platform/core/api'

import en from '../../web/messages/en.json' with { type: 'json' }
import { financeCall, signInByApi } from '../support/api'
import { addOwnerOfNewStore, addShippedTaxedSale } from '../support/database'
import { expectDialogFitsThePhoneWidth } from '../support/dialog-fit'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const finance = en.finance
const fiscal = finance.fiscal
const detail = en.orders.detail

// Finance, a document with a receiver (Step 4B.9b-5c): the customer of a sale has fiscal data, so its document is a business one that
// needs a name and a tax id; the tax id of the simulator that says REJECT makes the authority refuse it. The refusal is read on the screen,
// the receiver is fixed through the screen (the fix is sealed in the document and the customer's own data is untouched), the document is
// sent again and accepted. Its own organization. The cases run in order.
test.describe('Finance → a business document with a sealed receiver', () => {
  test.describe.configure({ mode: 'serial' })
  // The worker makes the document and sends it after the screen answers: each wait below is up to a minute
  test.setTimeout(180_000)
  const run = randomUUID().slice(0, 8)
  // What the list and the detail show of a receiver's name: the first letter of each word (`maskPersonName`)
  const maskedName = (name: string): string =>
    name
      .split(' ')
      .map(word => `${word.charAt(0)}${'*'.repeat(word.length - 1)}`)
      .join(' ')
  const ownerEmail = `e2e-finance-receiver-owner-${run}@example.com`
  let storeId = ''
  let sale = {
    id: '',
    orderNumber: '',
    customerId: '',
    remove: (): Promise<void> => Promise.resolve()
  }

  test.beforeAll(async () => {
    storeId = await addOwnerOfNewStore(ownerEmail, `E2E Receiver ${run}`)
    sale = await addShippedTaxedSale(storeId)
    // The tax id the simulator refuses; the name is what a business document asks for besides it
    const token = await signInByApi(ownerEmail)
    await financeCall(token, storeId, ApiRoutes.fiscal.customerData.put(sale.customerId), {
      method: 'PUT',
      body: { name: `E2E Buyer ${run}`, taxId: 'REJECT' }
    })
  })

  test.afterAll(async () => {
    await sale.remove()
  })

  test('an owner sets the books and the issuer up, and delivers the sale', async ({ page }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.home)
    await expect(page.getByRole('heading', { name: finance.setup.title, level: 1 })).toBeVisible()
    await page.getByLabel(finance.setup.startsOn, { exact: true }).fill('2026-01-01')
    await page.getByLabel(finance.setup.country, { exact: true }).selectOption({ index: 0 })
    await page.getByRole('button', { name: finance.setup.submit, exact: true }).click()
    await expect(
      page.getByRole('heading', { name: finance.accounts.title, level: 1 })
    ).toBeVisible()

    await page.goto(AppPaths.finance.fiscalIssuer)
    const form = page.getByTestId('fiscal-issuer-form')
    const mark = fiscal.issuer.requiredMark
    await form
      .getByLabel(`${fiscal.issuer.legalName} ${mark}`, { exact: true })
      .fill(`E2E Shop ${run}`)
    await form
      .getByLabel(`${fiscal.issuer.taxId} ${mark}`, { exact: true })
      .fill('0614-010101-101-0')
    const row = form.getByTestId('fiscal-address-row').first()
    await row.getByLabel(fiscal.address.key, { exact: true }).fill('line1')
    await row.getByLabel(fiscal.address.value, { exact: true }).fill('1 Main Street')
    await form
      .getByLabel(finance.fiscal.issuer.credentials.keys.signingKey, { exact: true })
      .fill(`key-${run}`)
    await form.getByRole('button', { name: fiscal.issuer.submit, exact: true }).click()
    await expect(form.getByTestId('fiscal-credentials-state')).toHaveText(
      fiscal.issuer.credentials.stored
    )

    // The payment first (it posts the advance entry the sale clears), then the delivery
    await page.goto(AppPaths.store.order(storeId, sale.id))
    await page.getByRole('button', { name: detail.payment.record }).click()
    const payment = page.getByRole('dialog')
    await payment.getByLabel(detail.payment.recordStatus).selectOption('COMPLETED')
    await payment.getByRole('button', { name: detail.payment.recordConfirm }).click()
    await expect(page.getByText(detail.payment.done)).toBeVisible()
    const flows = page.getByRole('group', { name: detail.flows.groupLabel })
    await flows.getByRole('button', { name: detail.flows.deliver.button }).click()
    await page
      .getByRole('dialog')
      .getByRole('button', { name: detail.flows.deliver.confirm, exact: true })
      .click()
    await expect(page.getByText(en.orders.status.DELIVERED, { exact: true }).first()).toBeVisible()
  })

  test('the authority refuses it, and the screen says why and offers the fix', async ({ page }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.fiscal)
    const refused = page.locator('[data-testid="fiscal-document-row"][data-status="rejected"]')
    await expect(async () => {
      await page.reload()
      await expect(refused).toHaveCount(1, { timeout: 2_000 })
    }).toPass({ timeout: 60_000 })
    // The banner of the list says there is one to see
    await expect(page.getByTestId('fiscal-banner-rejected')).toBeVisible()

    await refused.click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByTestId('fiscal-attention')).toBeVisible()
    await expect(dialog.getByTestId('fiscal-rejection-reason')).toContainText('simulated_rejection')
    // The receiver is customer data: the first letter of each word of the name and the end of the tax id, never the whole of either
    const receiver = dialog.getByTestId('fiscal-receiver')
    await expect(receiver).toContainText(maskedName(`E2E Buyer ${run}`))
    await expect(receiver).not.toContainText(`Buyer ${run}`)
    await expect(receiver).not.toContainText('REJECT')
    await expect(dialog.getByTestId('fiscal-detail')).toContainText('Simulated business document')
    await expect(dialog.getByTestId('fiscal-sealed')).toBeVisible()
  })

  test('the receiver is fixed through the screen and the document is sent again and accepted', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/(?:s\/[^/]+\/|finance)/)
    await page.goto(AppPaths.finance.fiscal)
    await page.locator('[data-testid="fiscal-document-row"][data-status="rejected"]').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: fiscal.actions.editReceiver, exact: true }).click()

    const fix = page.getByRole('dialog', { name: /^Fix the receiver of document/ })
    await expectDialogFitsThePhoneWidth(page, fix)
    // Writing nothing is refused before anything is sent
    await fix.getByRole('button', { name: fiscal.receiver.submit, exact: true }).click()
    await expect(fix.getByRole('alert').getByText(fiscal.receiver.problems.nothing)).toBeVisible()
    const mark = fiscal.receiver.requiredMark
    await fix
      .getByLabel(`${fiscal.receiver.fields.taxId} ${mark}`, { exact: true })
      .fill(`E2E-OK-${run}`)
    await fix.getByRole('button', { name: fiscal.receiver.submit, exact: true }).click()
    await expect(fix).toHaveCount(0)

    // The request is waited for, so a refusal of the api shows here and not as a timeout of the reload below
    const sent = page.waitForResponse(response =>
      /\/fiscal\/documents\/[^/]+\/retry/.test(response.url())
    )
    await page
      .getByRole('dialog')
      .getByRole('button', { name: fiscal.actions.retry, exact: true })
      .click()
    expect((await sent).ok()).toBe(true)
    await page.keyboard.press('Escape')
    const accepted = page.locator('[data-testid="fiscal-document-row"][data-status="accepted"]')
    await expect(async () => {
      await page.reload()
      await expect(accepted).toHaveCount(1, { timeout: 2_000 })
    }).toPass({ timeout: 60_000 })
    await expect(
      page.locator('[data-testid="fiscal-document-row"][data-status="rejected"]')
    ).toHaveCount(0)
  })
})
