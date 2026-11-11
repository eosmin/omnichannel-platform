import { DEFAULT_PHONE_REGION } from '@platform/core/domain'

import {
  addressBody,
  cleanPhones,
  digitsOnly,
  EMPTY_ADDRESS,
  phoneListProblem,
  PhoneProblems,
  readAddress
} from './order-fields'

describe('phones', () => {
  it('keeps digits only', () => {
    expect(digitsOnly('+1 (809) 555-0100')).toBe('18095550100')
    expect(cleanPhones(['(809) 555 0100', '   ', ''])).toEqual(['8095550100'])
  })

  it('checks the list the way the api does', () => {
    expect(phoneListProblem([])).toBe(PhoneProblems.EMPTY_LIST)
    expect(phoneListProblem(['12345'])).toBe(PhoneProblems.TOO_SHORT)
    expect(phoneListProblem(['1'.repeat(16)])).toBe(PhoneProblems.TOO_LONG)
    expect(phoneListProblem(['8095550100', '8095550100'])).toBe(PhoneProblems.REPEATED)
    expect(phoneListProblem(['8095550100', '8095550101'])).toBeNull()
    expect(phoneListProblem(['123456'])).toBeNull()
    expect(phoneListProblem(['1'.repeat(15)])).toBeNull()
  })
})

describe('address', () => {
  it('reads what the api sent and nothing that is not text', () => {
    expect(
      readAddress({ line1: 'Calle 1', city: 'Santo Domingo', country: 'DO', state: 5 })
    ).toEqual({
      line1: 'Calle 1',
      line2: '',
      city: 'Santo Domingo',
      state: '',
      postalCode: '',
      country: 'DO'
    })
  })

  it('reads no address from a missing, empty or hidden value', () => {
    expect(readAddress(null)).toBeNull()
    expect(readAddress(undefined)).toBeNull()
    expect(readAddress('x')).toBeNull()
    expect(readAddress({})).toBeNull()
    // Only a state is still an address: the form opens with it and nothing is lost
    expect(readAddress({ state: 'X' })?.state).toBe('X')
  })

  it('needs the street and the city, and leaves out the empty optional fields', () => {
    expect(addressBody(EMPTY_ADDRESS)).toBeNull()
    expect(addressBody({ ...EMPTY_ADDRESS, line1: 'A' })).toBeNull()
    expect(addressBody({ ...EMPTY_ADDRESS, line1: ' A ', city: 'B ' })).toEqual({
      line1: 'A',
      city: 'B',
      country: DEFAULT_PHONE_REGION
    })
  })

  it('writes the country in capitals and refuses one that is not two letters', () => {
    const base = { ...EMPTY_ADDRESS, line1: 'A', city: 'B', postalCode: ' 10101 ' }
    expect(addressBody({ ...base, country: 'do' })).toEqual({
      line1: 'A',
      city: 'B',
      postalCode: '10101',
      country: 'DO'
    })
    expect(addressBody({ ...base, country: '' })?.country).toBe(DEFAULT_PHONE_REGION)
    expect(addressBody({ ...base, country: 'DOM' })).toBeNull()
  })
})
