import type {
  CustomerAddressChanges,
  CustomerAddressInput,
  CustomerAddressView,
  CustomerChanges
} from '@platform/api-client'

export interface ProfileValues {
  name: string
  email: string
  phone: string
}

// A blank field is a field the customer does not have
const blankToNull = (value: string): string | null => {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

// Only what differs from the customer is sent, so that saving an untouched field never rewrites it
// (the api normalizes the phone: a phone sent again as typed would be judged again for nothing).
export function changedFields(
  customer: { name: string | null; email: string | null; phone: string | null },
  values: ProfileValues
): CustomerChanges {
  const changes: CustomerChanges = {}
  for (const key of ['name', 'email', 'phone'] as const) {
    const next = blankToNull(values[key])
    if (next !== customer[key]) changes[key] = next
  }
  return changes
}

export interface AddressValues {
  label: string
  line1: string
  line2: string
  city: string
  state: string
  postalCode: string
  country: string
  isDefault: boolean
}

export const EMPTY_ADDRESS: AddressValues = {
  label: '',
  line1: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
  isDefault: false
}

export function addressValuesOf(address: CustomerAddressView): AddressValues {
  return {
    label: address.label ?? '',
    line1: address.line1,
    line2: address.line2 ?? '',
    city: address.city,
    state: address.state ?? '',
    postalCode: address.postalCode ?? '',
    country: address.country,
    isDefault: address.isDefault
  }
}

const OPTIONAL_TEXT = ['label', 'line2', 'state', 'postalCode'] as const

// A new address: what is blank is left out
export function newAddress(values: AddressValues): CustomerAddressInput {
  const address: CustomerAddressInput = {
    line1: values.line1.trim(),
    city: values.city.trim(),
    isDefault: values.isDefault
  }
  for (const key of OPTIONAL_TEXT) {
    const text = blankToNull(values[key])
    if (text !== null) address[key] = text
  }
  const country = blankToNull(values.country)
  if (country !== null) address.country = country
  return address
}

// An edit: only what changed, a blank optional field cleared with null
export function addressChanges(
  address: CustomerAddressView,
  values: AddressValues
): CustomerAddressChanges {
  const changes: CustomerAddressChanges = {}
  const line1 = values.line1.trim()
  const city = values.city.trim()
  if (line1 !== address.line1) changes.line1 = line1
  if (city !== address.city) changes.city = city
  for (const key of OPTIONAL_TEXT) {
    const next = blankToNull(values[key])
    if (next !== address[key]) changes[key] = next
  }
  const country = values.country.trim()
  if (country !== '' && country.toUpperCase() !== address.country) changes.country = country
  if (values.isDefault !== address.isDefault) changes.isDefault = values.isDefault
  return changes
}
