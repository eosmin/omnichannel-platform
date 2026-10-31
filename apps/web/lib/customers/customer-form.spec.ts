import type { CustomerAddressView } from '@platform/api-client'

import {
  addressChanges,
  addressValuesOf,
  changedFields,
  EMPTY_ADDRESS,
  newAddress
} from './customer-form'

const customer = { name: 'Ana', email: 'ana@example.com', phone: '+50370001111' }
const values = { name: 'Ana', email: 'ana@example.com', phone: '+50370001111' }

describe('changedFields', () => {
  it('sends nothing when nothing changed, so a saved phone is never judged again', () => {
    expect(changedFields(customer, values)).toEqual({})
  })

  it('sends only the fields that differ, trimmed', () => {
    expect(changedFields(customer, { ...values, name: '  Ana María ' })).toEqual({
      name: 'Ana María'
    })
  })

  it('clears a field that was emptied', () => {
    expect(changedFields(customer, { ...values, email: '   ' })).toEqual({ email: null })
  })

  it('does not send null for a field that was empty and still is', () => {
    expect(changedFields({ ...customer, phone: null }, { ...values, phone: '' })).toEqual({})
  })
})

const address: CustomerAddressView = {
  id: 'a1',
  label: 'Home',
  line1: 'Calle 1',
  line2: null,
  city: 'San Salvador',
  state: null,
  postalCode: '1101',
  country: 'SV',
  isDefault: false
}

describe('newAddress', () => {
  it('leaves out what is blank and trims the rest', () => {
    expect(
      newAddress({ ...EMPTY_ADDRESS, line1: ' Calle 2 ', city: 'Santa Ana', country: 'sv' })
    ).toEqual({ line1: 'Calle 2', city: 'Santa Ana', isDefault: false, country: 'sv' })
  })
})

describe('addressChanges', () => {
  it('sends nothing for an untouched form', () => {
    expect(addressChanges(address, addressValuesOf(address))).toEqual({})
  })

  it('clears an optional field that was emptied and sets one that was filled', () => {
    expect(
      addressChanges(address, {
        ...addressValuesOf(address),
        label: '',
        line2: 'Apt 4',
        isDefault: true
      })
    ).toEqual({ label: null, line2: 'Apt 4', isDefault: true })
  })

  it('does not treat a lower-case country as a change', () => {
    expect(addressChanges(address, { ...addressValuesOf(address), country: 'sv' })).toEqual({})
  })
})
