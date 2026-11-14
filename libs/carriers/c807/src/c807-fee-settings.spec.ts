import { ShippingPayer } from '@platform/core/domain'

import { C807Plugin } from './c807.plugin'

// What the owner can agree with C807 (owner, 2026-11-14): a commission over the cash it collects and a price per type of service
describe('the fee settings of C807', () => {
  const { feeSettings } = new C807Plugin()
  const cod = { cod: true, serviceCode: 'standard' }

  it('takes a commission and prices the three types of service of its guides', () => {
    expect(feeSettings.commission).toBe(true)
    expect(feeSettings.rateServices.map(service => service.code)).toEqual(['CCE', 'SEC', 'SER'])
    for (const service of feeSettings.rateServices) {
      expect(service.labelKey).toMatch(/^settings\.carriers\.rates\.c807\./)
    }
  })

  it('prices a collected guide as CCE whoever pays the carrier, as the guide itself is made', () => {
    expect(feeSettings.rateServiceOf({ ...cod, shippingPayer: ShippingPayer.SENDER })).toBe('CCE')
    expect(feeSettings.rateServiceOf({ ...cod, shippingPayer: ShippingPayer.RECIPIENT })).toBe(
      'CCE'
    )
  })

  it('prices a paid order with the recipient paying the carrier as SEC, and one paid in full as SER', () => {
    const paid = { cod: false, serviceCode: 'standard' }
    expect(feeSettings.rateServiceOf({ ...paid, shippingPayer: ShippingPayer.RECIPIENT })).toBe(
      'SEC'
    )
    expect(feeSettings.rateServiceOf({ ...paid, shippingPayer: ShippingPayer.SENDER })).toBe('SER')
  })
})
