import { isPlausiblePartyTaxId, isValidSvNationalId, taxIdDigits } from './sv-tax-id'

// Every number here is made up for the test
describe('isValidSvNationalId', () => {
  it.each(['012345678', '000000000', '123456784', '999999994'])('accepts %s', value => {
    // 012345678: 0*9+1*8+2*7+3*6+4*5+5*4+6*3+7*2 = 112, so the check digit is 8
    expect(isValidSvNationalId(value)).toBe(true)
  })

  it.each(['012345679', '012345670', '123456789', '999999999', '123456780'])(
    'refuses %s: the check digit does not match',
    value => {
      expect(isValidSvNationalId(value)).toBe(false)
    }
  )

  it.each(['', '01234567', '0123456780', '01234567a', '0123 4567', '01234567-8'])(
    'refuses %j: nine digits and nothing else',
    value => {
      expect(isValidSvNationalId(value)).toBe(false)
    }
  )
})

describe('taxIdDigits', () => {
  it('drops hyphens and spaces and nothing else', () => {
    expect(taxIdDigits('0614-010101-101-3')).toBe('06140101011013')
    expect(taxIdDigits(' 01234567 8 ')).toBe('012345678')
    expect(taxIdDigits('12a45')).toBeNull()
    expect(taxIdDigits('<script>')).toBeNull()
    expect(taxIdDigits('')).toBeNull()
  })
})

describe('isPlausiblePartyTaxId', () => {
  it.each([
    '06140101011013', // a tax number: 14 digits
    '0614-010101-101-3', // with the hyphens of the document
    '0614 010101 101 3',
    '01234567-8', // a national id with a good check digit
    '012345678',
    '123456-7', // a registration number
    '12',
    '12345678',
    '  06140101011013  '
  ])('accepts %j', value => {
    expect(isPlausiblePartyTaxId(value)).toBe(true)
  })

  it.each([
    'x',
    '<script>',
    'NIT-123',
    '1',
    '',
    '   ',
    '123456789012345', // 15 digits
    '1234567890123', // 13 digits
    '01234567-9', // nine digits with a wrong check digit
    '0614-010101-101-A',
    '--',
    '1234-5678-9012-A'
  ])('refuses %j', value => {
    expect(isPlausiblePartyTaxId(value)).toBe(false)
  })
})
