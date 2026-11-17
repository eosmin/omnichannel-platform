import {
  bpsOfPercentText,
  centsOfDecimalText,
  positiveCentsOfDecimalText,
  decimalOfCents,
  moneyText,
  percentFigureText,
  percentOfBps
} from './money'

describe('decimalOfCents', () => {
  it.each([
    [0, '0.00'],
    [5, '0.05'],
    [100, '1.00'],
    [12345, '123.45'],
    ['-5', '-0.05'],
    ['-12345', '-123.45'],
    ['0', '0.00'],
    ['-0', '0.00'],
    ['9007199254740993', '90071992547409.93']
  ])('writes %s as %s, from the digits', (cents, text) => {
    expect(decimalOfCents(cents)).toBe(text)
  })

  it.each(['1.5', '', 'abc', '1e3', ' 5'])('refuses %j: an amount is whole cents', value => {
    expect(() => decimalOfCents(value)).toThrow()
  })

  it('refuses a float', () => {
    expect(() => decimalOfCents(1.5)).toThrow()
  })
})

describe('moneyText', () => {
  it('writes dollars with two decimals in the language of the person', () => {
    expect(moneyText('en', 1550)).toBe('$15.50')
    expect(moneyText('en', '-5')).toBe('-$0.05')
  })

  it('keeps the cents of a sum a float would lose', () => {
    expect(moneyText('en', '9007199254740993')).toBe('$90,071,992,547,409.93')
  })
})

describe('the figure of a rate in the language of the person', () => {
  it.each([
    ['en', 1250, '12.5'],
    ['es', 1250, '12,5'],
    ['es', 1, '0,01'],
    ['en', 1300, '13'],
    ['es', 0, '0']
  ])('writes %s %i as %s', (locale, bps, text) => {
    expect(percentFigureText(locale, bps)).toBe(text)
  })
})

describe('rates in basis points', () => {
  it.each([
    [1300, '13'],
    [1250, '12.5'],
    [125, '1.25'],
    [1, '0.01'],
    [0, '0'],
    [10000, '100']
  ])('writes %i as %s %%', (bps, text) => {
    expect(percentOfBps(bps)).toBe(text)
  })

  it.each([
    ['13', 1300],
    ['12.5', 1250],
    ['12,5', 1250],
    ['0.01', 1],
    [' 7 ', 700]
  ])('reads %j as %i basis points', (text, bps) => {
    expect(bpsOfPercentText(text)).toBe(bps)
  })

  it.each(['', '-1', '1.234', 'abc', '13%', '1e2', '.5'])('does not read %j as a rate', text => {
    expect(bpsOfPercentText(text)).toBeNull()
  })

  it('round trips every rate of the api', () => {
    for (let bps = 0; bps <= 10_000; bps += 1) {
      expect(bpsOfPercentText(percentOfBps(bps))).toBe(bps)
    }
  })
})

describe('centsOfDecimalText', () => {
  it.each([
    ['1234.56', 123456],
    ['1234,56', 123456],
    ['0.5', 50],
    ['-0,5', -50],
    ['7', 700],
    ['  12.30 ', 1230],
    ['-0', 0]
  ])('reads %j as %d cents', (text, cents) => {
    expect(centsOfDecimalText(text)).toBe(cents)
  })

  it.each(['', '1.234', '1.234,56', '1,234.56', '--1', '1e3', 'abc', '12.', '.5', '99999999999'])(
    'refuses %j',
    text => {
      expect(centsOfDecimalText(text)).toBeNull()
    }
  )

  it('refuses what does not fit the 32 bits of an amount of the books', () => {
    expect(centsOfDecimalText('21474836.47')).toBe(2_147_483_647)
    expect(centsOfDecimalText('21474836.48')).toBeNull()
  })
})

describe('positiveCentsOfDecimalText', () => {
  it.each([
    ['12', 1200],
    ['12.5', 1250],
    ['12,50', 1250],
    ['0.05', 5],
    ['  7.00 ', 700],
    ['21474836.47', 2147483647]
  ])('reads %s as %i cents', (text, cents) => {
    expect(positiveCentsOfDecimalText(text)).toBe(cents)
  })

  it.each(['', '0', '0.00', '-5', '+5', '1.234', '1,000.00', '12 USD', '1e3', '.5', '21474836.48'])(
    'is not an amount of a line: "%s"',
    text => {
      expect(positiveCentsOfDecimalText(text)).toBeNull()
    }
  )
})
