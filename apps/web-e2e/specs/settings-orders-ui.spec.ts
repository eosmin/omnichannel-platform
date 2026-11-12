import { randomUUID } from 'node:crypto'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { API_PREFIX, ApiRoutes } from '@platform/core/api'

import en from '../../web/messages/en.json' with { type: 'json' }
import { addOwnerOfNewStore, addReadOnlySettingsUser, storeIdNamed } from '../support/database'
import { signIn } from '../support/login'
import { expect, test } from '../support/test'

const messages = en.settings.orderMessages
const preferences = en.settings.preferences
const returns = en.settings.returns

// Settings → Order messages, Returns and Preferences, through the screens. Its own store: the cases change what a store
// sends and decides, and the stores that the other specs share must not be the ones that change.
test.describe('Settings → Order messages, Returns and Preferences', () => {
  const run = randomUUID().slice(0, 8)
  const ownerEmail = `e2e-orders-ui-owner-${run}@example.com`
  let storeId = ''

  test.beforeAll(async () => {
    storeId = await addOwnerOfNewStore(ownerEmail, `E2E Orders UI ${run}`)
  })

  const pathOf = (section: (typeof StoreSettingsSections)[keyof typeof StoreSettingsSections]) =>
    AppPaths.store.settings(storeId, section)

  test('an administrator writes a message, sees it filled in, saves it and deletes it', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(pathOf(StoreSettingsSections.GENERAL))
    // Reached from the navigation of Settings, not only by its address
    await page
      .getByRole('navigation', { name: en.settings.nav.store.label })
      .getByRole('link', { name: en.settings.nav.store.orderMessages })
      .click()
    await expect(page).toHaveURL(new RegExp(`${pathOf(StoreSettingsSections.ORDER_TEMPLATES)}$`))
    await expect(page.getByRole('heading', { name: messages.title, level: 1 })).toBeVisible()

    const kinds = page.getByRole('navigation', { name: messages.kindsLabel })
    await kinds.getByRole('button', { name: messages.kinds.order_shipped.label }).click()
    const body = page.getByLabel(messages.body)
    await expect(body).toHaveValue('')
    await expect(page.getByText(messages.notSet)).toBeVisible()
    // The kinds that go out by themselves start with their switch on
    const auto = page.getByRole('checkbox', { name: messages.sending.auto })
    await expect(auto).toBeChecked()

    // The variables are put where the cursor is, and the preview shows the text filled in with a sample order
    await body.fill('Hola ')
    await page.getByRole('button', { name: messages.variables.customerName.label }).click()
    await expect(body).toHaveValue('Hola {{customerName}}')
    const preview = page.getByRole('status', { name: messages.previewTitle })
    await expect(preview).toContainText('Hola ')
    await expect(preview).not.toContainText('{{')

    // A text that uses the scheduled date and goes out by itself is warned about before it is saved
    await expect(page.getByText(messages.warnings.autoSendNeedsScheduledDate)).toHaveCount(0)
    await page.getByRole('button', { name: messages.variables.scheduledDeliveryDate.label }).click()
    await expect(page.getByText(messages.warnings.autoSendNeedsScheduledDate)).toBeVisible()
    await auto.uncheck()
    await expect(page.getByText(messages.warnings.autoSendNeedsScheduledDate)).toHaveCount(0)

    // What was typed is kept while another kind is looked at
    await kinds.getByRole('button', { name: messages.kinds.order_summary.label }).click()
    // The summary follows a store preference: it has no switch of its own
    await expect(page.getByRole('checkbox', { name: messages.sending.auto })).toHaveCount(0)
    await expect(page.getByText(messages.sending.byPreferenceSummary)).toBeVisible()
    await kinds.getByRole('button', { name: messages.kinds.order_shipped.label }).click()
    await expect(page.getByLabel(messages.body)).toHaveValue(
      'Hola {{customerName}}{{scheduledDeliveryDate}}'
    )

    // A variable that does not exist is refused before any request
    const puts: unknown[] = []
    await page.route(
      url => url.pathname.startsWith(`${API_PREFIX}${ApiRoutes.orderTemplates.list}/`),
      route => {
        if (route.request().method() === 'PUT') puts.push(route.request().postDataJSON())
        void route.continue()
      }
    )
    await page.getByLabel(messages.body).fill('Hola {{nombre}}')
    await page.getByRole('button', { name: messages.save }).click()
    await expect(page.getByRole('alert').getByText(messages.problems.unknownVariable)).toBeVisible()
    expect(puts).toHaveLength(0)

    await page.getByLabel(messages.body).fill('Hola {{customerName}}, tu pedido {{orderNumber}}')
    await page.getByRole('button', { name: messages.save }).click()
    await expect(page.getByText(messages.saved).first()).toBeVisible()
    expect(puts).toEqual([
      {
        body: 'Hola {{customerName}}, tu pedido {{orderNumber}}',
        autoSend: false,
        attachSummary: false,
        channelTemplate: null
      }
    ])

    // It is still there after a reload
    await page.reload()
    await kinds.getByRole('button', { name: messages.kinds.order_shipped.label }).click()
    await expect(page.getByLabel(messages.body)).toHaveValue(
      'Hola {{customerName}}, tu pedido {{orderNumber}}'
    )
    await expect(page.getByText(messages.isSet)).toBeVisible()
    await expect(page.getByRole('checkbox', { name: messages.sending.auto })).not.toBeChecked()

    // Deleting it asks first, and the platform text is used again
    await page.getByRole('button', { name: messages.delete.button }).click()
    await expect(page.getByRole('alertdialog')).toBeVisible()
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: messages.delete.confirm })
      .click()
    await expect(page.getByText(messages.deleted).first()).toBeVisible()
    await expect(page.getByLabel(messages.body)).toHaveValue('')
    await expect(page.getByText(messages.notSet)).toBeVisible()
  })

  test('an administrator chooses who pays the way back of a return', async ({ page }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(pathOf(StoreSettingsSections.RETURNS))
    await expect(page.getByRole('heading', { name: returns.title, level: 1 })).toBeVisible()
    const store = page.getByRole('radio', {
      name: new RegExp(`^${returns.payer.options.sender.label}`)
    })
    const customer = page.getByRole('radio', {
      name: new RegExp(`^${returns.payer.options.recipient.label}`)
    })
    const save = page.getByRole('button', { name: returns.save })
    await expect(store).toBeChecked()
    await expect(save).toBeDisabled()

    const patches: unknown[] = []
    await page.route(
      url => url.pathname === `${API_PREFIX}${ApiRoutes.settings.returns}`,
      route => {
        if (route.request().method() === 'PATCH') patches.push(route.request().postDataJSON())
        void route.continue()
      }
    )
    await customer.check()
    await save.click()
    await expect(page.getByText(returns.saved).first()).toBeVisible()
    expect(patches).toEqual([{ returnShippingPayer: 'recipient' }])
    await page.reload()
    await expect(customer).toBeChecked()
  })

  test('an administrator sets the preferences of the orders and the list of reasons', async ({
    page
  }) => {
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/s\/[^/]+\//)
    await page.goto(pathOf(StoreSettingsSections.PREFERENCES))
    await expect(page.getByRole('heading', { name: preferences.title, level: 1 })).toBeVisible()

    // The factory state: the boxes start as the preferences of the store say
    const confirm = page.getByRole('checkbox', { name: preferences.create.confirm })
    const summary = page.getByRole('checkbox', { name: preferences.create.summary })
    const save = page.getByRole('button', { name: preferences.save })
    await expect(confirm).not.toBeChecked()
    await expect(summary).toBeChecked()
    await expect(save).toBeDisabled()

    const puts: unknown[] = []
    await page.route(
      url => url.pathname === `${API_PREFIX}${ApiRoutes.settings.preferences}`,
      route => {
        if (route.request().method() === 'PUT') puts.push(route.request().postDataJSON())
        void route.continue()
      }
    )
    // Days that are not a whole number are refused before any request
    await page.getByLabel(preferences.delivery.overdueLabel).fill('0')
    await save.click()
    await expect(page.getByRole('alert').getByText(preferences.problems.overdueDays)).toBeVisible()
    expect(puts).toHaveLength(0)

    await confirm.check()
    await page
      .getByLabel(preferences.delivery.failedLabel)
      .selectOption({ label: preferences.delivery.failedPolicies.first_only })
    await page.getByLabel(preferences.delivery.overdueLabel).fill('10')
    await page.getByLabel(preferences.reasons.newLabel).fill('Fraud suspected')
    await page.getByRole('button', { name: preferences.reasons.add }).click()
    await save.click()
    await expect(page.getByText(preferences.saved).first()).toBeVisible()
    expect(puts).toHaveLength(1)
    expect(puts[0]).toMatchObject({
      orders: {
        confirmOnCreate: true,
        failedAttemptMessages: 'first_only'
      },
      remittances: { overdueAfterDays: 10 }
    })
    // The key the person did not touch is not sent
    expect(puts[0]).not.toHaveProperty('orders.sendSummaryOnCreate')

    await page.reload()
    await expect(confirm).toBeChecked()
    await expect(page.getByLabel(preferences.delivery.overdueLabel)).toHaveValue('10')
    await expect(
      page.getByRole('list', { name: preferences.reasons.listLabel }).getByRole('textbox')
    ).toHaveValue('Fraud suspected')
  })

  test('a person who may only look sees the preferences and cannot change them', async ({
    page
  }) => {
    const mainStoreId = await storeIdNamed('Main Store')
    const email = `e2e-orders-ui-readonly-${run}@example.com`
    const remove = await addReadOnlySettingsUser(mainStoreId, email)
    try {
      await signIn(page, email)
      await page.waitForURL(/\/s\/[^/]+\//)
      await page.goto(AppPaths.store.settings(mainStoreId, StoreSettingsSections.PREFERENCES))
      await expect(page.getByRole('heading', { name: preferences.title, level: 1 })).toBeVisible()
      await expect(page.getByText(preferences.readOnly)).toBeVisible()
      await expect(page.getByRole('checkbox', { name: preferences.create.confirm })).toBeDisabled()
      await expect(page.getByRole('button', { name: preferences.save })).toHaveCount(0)

      await page.goto(AppPaths.store.settings(mainStoreId, StoreSettingsSections.RETURNS))
      await expect(page.getByText(returns.readOnly)).toBeVisible()
      await expect(page.getByRole('button', { name: returns.save })).toHaveCount(0)
    } finally {
      await remove()
    }
  })
})
