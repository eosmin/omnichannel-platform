import { randomUUID } from 'node:crypto'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { CarrierId } from '@platform/core/domain'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addCarrierConnectionTo, addOwnerOfNewStore, addShippingViewer } from '../support/database'
import { expectDialogFitsThePhoneWidth } from '../support/dialog-fit'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const carriers = en.settings.carriers
const guides = carriers.guides

// Settings → Carriers → Prepaid guides (TDD_17 §4.18): the balance of one connection, a purchase with a gift, the average cost,
// and who may see it. Its own store, so the balance starts at nothing.
test.describe('Settings → Carriers → Prepaid guides', () => {
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-guides-owner-${run}@example.com`
  const viewerEmail = `e2e-guides-viewer-${run}@example.com`
  const name = `Guides ${run}`
  let storeId = ''
  let removeConnection: () => Promise<void> = () => Promise.resolve()

  test.beforeAll(async () => {
    storeId = await addOwnerOfNewStore(ownerEmail, `E2E Guides ${run}`)
    await addShippingViewer(storeId, viewerEmail)
    removeConnection = await addCarrierConnectionTo(storeId, CarrierId.LOCAL, name)
  })

  test.afterAll(async () => {
    await removeConnection()
  })

  const settingsPath = (): string =>
    AppPaths.store.settings(storeId, StoreSettingsSections.CARRIERS)

  test('an owner follows the balance, records a purchase with a gift and reads the average cost', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(settingsPath())
    await page.getByRole('tab', { name: carriers.sections.guides }).click()
    const panel = page.getByTestId('carrier-guide-panel').filter({ hasText: name })
    await expect(panel.getByText(guides.notTracked)).toBeVisible()

    // The policy turns the balance on; the rules of the benefit are marked as still to confirm with the carrier
    await panel.getByRole('button', { name: guides.actions.policy }).click()
    const policy = page.getByRole('dialog', { name: new RegExp(name) })
    await expect(policy.getByText(guides.policy.toConfirmMark).first()).toBeVisible()
    await policy.getByRole('checkbox', { name: guides.policy.balance.enabled }).check()
    await policy.getByRole('button', { name: guides.policy.submit }).click()
    await expect(policy).toHaveCount(0)
    await expect(panel.getByTestId('guide-available')).toHaveText('0')

    // A purchase: an empty form is refused first, and the dialog fits a phone
    await panel.getByRole('button', { name: guides.actions.purchase }).click()
    const purchase = page.getByRole('dialog', { name: new RegExp(name) })
    await purchase.getByRole('button', { name: guides.purchase.submit }).click()
    await expect(purchase.getByRole('alert').first()).toBeVisible()
    await expectDialogFitsThePhoneWidth(page, purchase)
    await purchase.getByLabel(guides.purchase.paid).fill('100')
    await purchase.getByLabel(guides.purchase.gift).fill('10')
    await purchase.getByLabel(guides.purchase.cost).fill('45.50')
    await purchase.getByRole('button', { name: guides.purchase.submit }).click()
    await expect(purchase).toHaveCount(0)

    // 110 guides for 45.50: 41 cents each, gifts counted; the purchase is in the movements
    await expect(panel.getByTestId('guide-available')).toHaveText('110')
    await expect(panel.getByText('$0.41')).toBeVisible()
    await expect(panel.getByTestId('guide-movement')).toHaveCount(1)
    await expect(panel.getByTestId('guide-balance-state')).toHaveText(guides.state.ok)

    // An adjustment needs a reason; a void takes the purchase out of the balance but leaves the line
    await panel.getByRole('button', { name: guides.actions.adjustment }).click()
    const adjustment = page.getByRole('dialog', { name: new RegExp(name) })
    await adjustment.getByLabel(guides.adjustment.guides).fill('-10')
    await adjustment.getByRole('button', { name: guides.adjustment.submit }).click()
    await expect(
      adjustment.getByRole('alert').getByText(guides.adjustment.problems.note)
    ).toBeVisible()
    await adjustment.getByLabel(guides.adjustment.note).fill('Lost in a move')
    await adjustment.getByRole('button', { name: guides.adjustment.submit }).click()
    await expect(adjustment).toHaveCount(0)
    await expect(panel.getByTestId('guide-available')).toHaveText('100')
  })

  test('a person who may only look at shipping does not see the balance of the guides', async ({
    page
  }) => {
    await signIn(page, viewerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(settingsPath())
    await expect(page.getByRole('heading', { name: carriers.title, level: 1 })).toBeVisible()
    await expect(page.getByRole('tab', { name: carriers.sections.guides })).toHaveCount(0)
  })
})
