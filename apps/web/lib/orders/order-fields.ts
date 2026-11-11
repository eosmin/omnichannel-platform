import { DEFAULT_PHONE_REGION, RecipientPhones } from '@platform/core/domain'

// What a person types in the phone fields of an order, checked before the request the way the api checks it (digits only,
// 6 to 15, up to three, none repeated), so the person hears it next to the field. The api is still the authority.

// "(809) 555-0100" -> "8095550100": the carriers take national digits and nothing else
export function digitsOnly(text: string): string {
  return text.replace(/\D/g, '')
}

export const PhoneProblems = {
  TOO_SHORT: 'tooShort',
  TOO_LONG: 'tooLong',
  REPEATED: 'repeated',
  EMPTY_LIST: 'emptyList'
} as const
export type PhoneProblem = (typeof PhoneProblems)[keyof typeof PhoneProblems]

// The first problem of the list, or null; an empty field is dropped before this is asked (a blank row is no phone)
export function phoneListProblem(phones: readonly string[]): PhoneProblem | null {
  if (phones.length === 0) return PhoneProblems.EMPTY_LIST
  for (const phone of phones) {
    if (phone.length < RecipientPhones.MIN_DIGITS) return PhoneProblems.TOO_SHORT
    if (phone.length > RecipientPhones.MAX_DIGITS) return PhoneProblems.TOO_LONG
  }
  return new Set(phones).size === phones.length ? null : PhoneProblems.REPEATED
}

// The rows of the editor to the list that is sent: digits only, blanks dropped
export function cleanPhones(rows: readonly string[]): string[] {
  return rows.map(digitsOnly).filter(phone => phone !== '')
}

// The address of the order as the form edits it. The api sends it as JSON of unknown shape (it left it out for a reader
// without permission), so every part is read as text and what is not text is an empty field.
export interface AddressFields {
  line1: string
  line2: string
  city: string
  state: string
  postalCode: string
  country: string
}

export const EMPTY_ADDRESS: AddressFields = {
  line1: '',
  line2: '',
  city: '',
  state: '',
  postalCode: '',
  country: ''
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function readAddress(value: unknown): AddressFields | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const address = {
    line1: text(record.line1),
    line2: text(record.line2),
    city: text(record.city),
    state: text(record.state),
    postalCode: text(record.postalCode),
    country: text(record.country)
  }
  return Object.values(address).every(part => part === '') ? null : address
}

// The fields of the form to the body of the edit: the required ones must hold text, the optional ones are left out when empty
// (the api refuses an empty string for them), the country is two letters and the one of the store's region when left empty (what
// the api does too)
export type AddressBody = {
  line1: string
  city: string
  country: string
  line2?: string
  state?: string
  postalCode?: string
}

export function addressBody(fields: AddressFields): AddressBody | null {
  const line1 = fields.line1.trim()
  const city = fields.city.trim()
  if (line1 === '' || city === '') return null
  const country = fields.country.trim()
  if (country !== '' && !/^[A-Za-z]{2}$/.test(country)) return null
  const body: AddressBody = {
    line1,
    city,
    country: country === '' ? DEFAULT_PHONE_REGION : country.toUpperCase()
  }
  const optional = [
    ['line2', fields.line2],
    ['state', fields.state],
    ['postalCode', fields.postalCode]
  ] as const
  for (const [key, value] of optional) {
    const trimmed = value.trim()
    if (trimmed !== '') body[key] = trimmed
  }
  return body
}
