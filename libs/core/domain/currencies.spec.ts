import { isSupportedCurrency, SUPPORTED_CURRENCIES } from './currencies'

describe('supported currencies', () => {
  it('accepts the currencies the stores use', () => {
    for (const code of ['USD', 'EUR', 'MXN', 'GTQ', 'JPY', 'ZWG', 'XCG']) {
      expect(isSupportedCurrency(code)).toBe(true)
    }
  })

  it('refuses three letters that are not a current currency', () => {
    // ZZZ is no currency at all; the others are test, metal or replaced codes
    for (const code of [
      'ZZZ',
      'XXX',
      'XTS',
      'XAU',
      'HRK',
      'VEF',
      'BGN',
      'ANG',
      'usd',
      'US',
      'USDD',
      ''
    ]) {
      expect(isSupportedCurrency(code)).toBe(false)
    }
  })

  it('is sorted, without repeats and of three capital letters each', () => {
    expect([...SUPPORTED_CURRENCIES]).toEqual([...new Set(SUPPORTED_CURRENCIES)].sort())
    expect(SUPPORTED_CURRENCIES.every(code => /^[A-Z]{3}$/.test(code))).toBe(true)
  })

  it('agrees with the runtime on every code it keeps, so none is a typo', () => {
    const known = new Set(Intl.supportedValuesOf('currency'))
    expect(SUPPORTED_CURRENCIES.filter(code => !known.has(code))).toEqual([])
  })
})
