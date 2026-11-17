import { randomUUID } from 'node:crypto'

import { AppPaths } from '@platform/api-client'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addFiscalViewer, addOwnerOfNewStore } from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const fiscal = en.finance.fiscal
const nav = en.settings.nav.finance

// Finance → fiscal documents and the issuer (Step 4B.9b-2). Its own organization, so the issuer this case makes is nobody else's. The
// documents themselves are made when a sale is recognized and are read through the api's own cases; here the screens that need no
// document are driven: the empty list that says there is no issuer, the issuer form that follows the manifest of the provider, and the
// person who may read and change nothing.
test.describe('Finance → fiscal documents and issuer', () => {
  test.describe.configure({ mode: 'serial' })
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-fiscal-owner-${run}@example.com`
  const viewerEmail = `e2e-fiscal-viewer-${run}@example.com`
  let removeViewer: () => Promise<void> = () => Promise.resolve()

  test.beforeAll(async () => {
    const storeId = await addOwnerOfNewStore(ownerEmail, `E2E Fiscal ${run}`)
    removeViewer = await addFiscalViewer(storeId, viewerEmail)
  })

  test.afterAll(async () => {
    await removeViewer()
  })

  test('with no issuer the list says so, and the issuer form is set up from the provider manifest', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.fiscal)
    await expect(page.getByRole('heading', { name: fiscal.title, level: 1 })).toBeVisible()
    await expect(page.getByTestId('fiscal-caution')).toBeVisible()
    await expect(page.getByTestId('fiscal-no-issuer')).toBeVisible()
    await expect(page.getByTestId('fiscal-empty')).toBeVisible()
    await expect(page.getByTestId('fiscal-banner')).toHaveCount(0)

    // The navigation of the area has both pages
    await expect(page.getByRole('link', { name: nav.fiscalIssuer, exact: true })).toBeVisible()
    await page.getByRole('link', { name: fiscal.noIssuerLink, exact: true }).click()
    await expect(page.getByRole('heading', { name: fiscal.issuer.title, level: 1 })).toBeVisible()

    // An empty form is refused before anything is sent
    const form = page.getByTestId('fiscal-issuer-form')
    await form.getByRole('button', { name: fiscal.issuer.submit, exact: true }).click()
    await expect(form.getByRole('alert').first()).toBeVisible()
    await expect(form.getByTestId('fiscal-credentials-state')).toHaveText(
      fiscal.issuer.credentials.none
    )

    // What the manifest asks for is marked, and a complete form is saved
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
      .getByLabel(fiscal.issuer.credentials.keys.signingKey, { exact: true })
      .fill(`key-${run}`)
    await form.getByRole('button', { name: fiscal.issuer.submit, exact: true }).click()
    // The credentials are written and never read back: the form says there are some and shows none
    await expect(
      page.getByTestId('fiscal-issuer-form').getByTestId('fiscal-credentials-state')
    ).toHaveText(fiscal.issuer.credentials.stored)
    await expect(
      page
        .getByTestId('fiscal-issuer-form')
        .getByLabel(fiscal.issuer.credentials.keys.signingKey, { exact: true })
    ).toHaveValue('')

    // With an issuer the series of numbers are shown (the simulator keeps one count for the organization, so no series yet), and the fields
    // the provider does not ask for are not drawn
    await expect(page.getByRole('heading', { name: fiscal.series.title })).toBeVisible()
    await expect(page.getByTestId('fiscal-series-empty')).toHaveText(fiscal.series.empty)
    await expect(form.getByLabel(fiscal.issuer.pointOfSaleCode)).toHaveCount(0)

    // With an issuer the list no longer says it is missing
    await page.goto(AppPaths.finance.fiscal)
    await expect(page.getByRole('heading', { name: fiscal.title, level: 1 })).toBeVisible()
    await expect(page.getByTestId('fiscal-empty')).toBeVisible()
    await expect(page.getByTestId('fiscal-no-issuer')).toHaveCount(0)
  })

  test('a person who may only read sees the issuer and cannot change it', async ({ page }) => {
    await signIn(page, viewerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(AppPaths.finance.fiscalIssuer)
    await expect(page.getByRole('heading', { name: fiscal.issuer.title, level: 1 })).toBeVisible()
    const form = page.getByTestId('fiscal-issuer-form')
    await expect(form.getByText(fiscal.issuer.readOnly, { exact: true })).toBeVisible()
    await expect(form.getByRole('button', { name: fiscal.issuer.submit, exact: true })).toHaveCount(
      0
    )
    await expect(
      form.getByLabel(`${fiscal.issuer.legalName} ${fiscal.issuer.requiredMark}`, { exact: true })
    ).toBeDisabled()
    // The two fiscal pages are the only ones of the area this person may open
    await expect(page.getByRole('link', { name: nav.fiscal, exact: true })).toBeVisible()
    await expect(page.getByRole('link', { name: nav.accounts, exact: true })).toHaveCount(0)
  })
})
