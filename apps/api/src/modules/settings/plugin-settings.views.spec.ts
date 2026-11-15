import { readStorePreferences } from '@platform/core/store-preferences'

import { pluginPreferencesView } from './plugin-settings.views'

describe('the store preferences as a plugin reads them', () => {
  it('answers the allowlist and not the approval controls of the owner', () => {
    const view = pluginPreferencesView(
      readStorePreferences({ orders: { discountLimitPercent: 15, notifyOnPriceOverride: false } })
    )

    expect(Object.keys(view).sort()).toEqual([
      'assignOnReply',
      'orders',
      'remittances',
      'returns',
      'sendReadReceipts'
    ])
    expect(Object.keys(view.orders).sort()).toEqual([
      'cancellationReasons',
      'confirmOnCreate',
      'failedAttemptMessages',
      'freeShippingRule',
      'sendSummaryOnCreate'
    ])
    expect(JSON.stringify(view)).not.toContain('discountLimitPercent')
    expect(JSON.stringify(view)).not.toContain('notifyOnPriceOverride')
  })

  it('holds back a key the preferences gain later', () => {
    const grown = { ...readStorePreferences({}), marginFloorPercent: 30 }

    expect(pluginPreferencesView(grown)).not.toHaveProperty('marginFloorPercent')
  })
})
