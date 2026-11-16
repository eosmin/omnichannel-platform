import { FiscalFieldLimits } from '@platform/core/domain'

import { addressOf, addressProblemOf, addressRowsOf, emptyAddressRow } from './address-rows'

const row = (key: string, value: string) => ({ ...emptyAddressRow(), key, value })

describe('the address rows', () => {
  it('makes an address of the rows that are filled, trimmed, and none of the empty ones', () => {
    const rows = [row(' line1 ', ' Street 1 '), emptyAddressRow(), row('city', 'Town')]
    expect(addressProblemOf(rows)).toBeNull()
    expect(addressOf(rows)).toEqual({ line1: 'Street 1', city: 'Town' })
  })

  it('has no address when every row is empty', () => {
    expect(addressProblemOf([emptyAddressRow()])).toBeNull()
    expect(addressOf([emptyAddressRow()])).toEqual({})
  })

  it('refuses a name with no value, a value with no name and a name twice', () => {
    expect(addressProblemOf([row('line1', '')])).toBe('incomplete')
    expect(addressProblemOf([row('', 'Street')])).toBe('incomplete')
    expect(addressProblemOf([row('a', '1'), row('a', '2')])).toBe('duplicate')
  })

  it('keeps to the limits of the api', () => {
    expect(addressProblemOf([row('k'.repeat(FiscalFieldLimits.ADDRESS_KEY + 1), 'v')])).toBe(
      'tooLong'
    )
    expect(addressProblemOf([row('k', 'v'.repeat(FiscalFieldLimits.ADDRESS_VALUE + 1))])).toBe(
      'tooLong'
    )
    const many = Array.from({ length: FiscalFieldLimits.ADDRESS_MAX_FIELDS + 1 }, (_, index) =>
      row(`k${String(index)}`, 'v')
    )
    expect(addressProblemOf(many)).toBe('tooMany')
  })

  it('reads the rows of a stored address, text values only, each with its own id', () => {
    const rows = addressRowsOf({ line1: 'Street 1', odd: 5 })
    expect(rows).toEqual([expect.objectContaining({ key: 'line1', value: 'Street 1' })])
    expect(new Set([...rows, emptyAddressRow()].map(each => each.id)).size).toBe(2)
  })
})
