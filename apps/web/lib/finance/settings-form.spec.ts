import type { FinanceSettingsView } from '@platform/api-client'

import { settingsChangesOf, settingsDraftOf } from './settings-form'

const settings: FinanceSettingsView = {
  countryCode: 'SV',
  baseCurrency: 'USD',
  accountingStartDate: '2026-11-01',
  lockedThrough: null,
  recognizeSaleOn: 'delivered',
  roundingAccountId: 'r1',
  taxRounding: 'half_up',
  shippingTaxed: true,
  updatedAt: '2026-11-15T10:00:00.000Z'
}

describe('settingsChangesOf', () => {
  it('is empty for an untouched form', () => {
    expect(settingsChangesOf(settings, settingsDraftOf(settings))).toEqual({})
  })

  it('sends only the choices that changed', () => {
    const draft = { ...settingsDraftOf(settings), shippingTaxed: false, taxRounding: 'down' }

    expect(settingsChangesOf(settings, draft)).toEqual({
      shippingTaxed: false,
      taxRounding: 'down'
    })
  })

  it('never takes the rounding account away: an empty choice sends nothing', () => {
    expect(
      settingsChangesOf(settings, { ...settingsDraftOf(settings), roundingAccountId: '' })
    ).toEqual({})
  })

  it('sends the rounding account when one is chosen for the first time', () => {
    const start = { ...settings, roundingAccountId: null }

    expect(
      settingsChangesOf(start, { ...settingsDraftOf(start), roundingAccountId: 'r2' })
    ).toEqual({
      roundingAccountId: 'r2'
    })
  })
})
