import { ProductLimits } from '@platform/core/domain'

import { centsToInput, formatCents, parseCents } from './money'

describe('parseCents', () => {
  it.each([
    ['15', 1500],
    ['15.5', 1550],
    ['15,50', 1550],
    ['0.07', 7],
    ['0', 0],
    [' 12.34 ', 1234],
    ['19.99', 1999],
    ['.5', 50],
    ['12.', 1200]
  ])('reads %j as %d cents', (text, cents) => {
    expect(parseCents(text)).toBe(cents)
  })

  it('never goes through a float: 0.29 and 1.15 keep their cents', () => {
    expect(parseCents('0.29')).toBe(29)
    expect(parseCents('1.15')).toBe(115)
    expect(parseCents('4.35')).toBe(435)
  })

  it.each(['', '.', ',', '-1', '1.234', '1,234.50', 'abc', '1e3', '$5', '1 000', '1234567890'])(
    'refuses %j',
    text => {
      expect(parseCents(text)).toBeNull()
    }
  )

  it('takes the limit of the catalog and refuses one cent more', () => {
    expect(parseCents('1000000.00')).toBe(ProductLimits.MAX_AMOUNT_CENTS)
    expect(parseCents('1000000.01')).toBeNull()
  })
})

describe('centsToInput', () => {
  it.each([
    [1550, '15.50'],
    [7, '0.07'],
    [0, '0.00'],
    [100_000_000, '1000000.00']
  ])('writes %d as %s', (cents, text) => {
    expect(centsToInput(cents)).toBe(text)
  })

  it('is read back as the same cents', () => {
    for (const cents of [0, 1, 99, 100, 1999, 123_456]) {
      expect(parseCents(centsToInput(cents))).toBe(cents)
    }
  })
})

describe('formatCents', () => {
  const format = (locale: string) =>
    ({
      number: (value: number, options: Intl.NumberFormatOptions) =>
        new Intl.NumberFormat(locale, options).format(value)
    }) as Parameters<typeof formatCents>[0]

  it('writes whole cents with two decimals in the language of the person', () => {
    expect(formatCents(format('en'), 1999)).toBe('$19.99')
    expect(formatCents(format('en'), 7)).toBe('$0.07')
    expect(formatCents(format('en'), 100_000_000)).toBe('$1,000,000.00')
    // The space is a no-break space in the language data
    expect(formatCents(format('es-MX'), 1550).replace(/\u00a0/g, ' ')).toBe('USD 15.50')
  })
})
