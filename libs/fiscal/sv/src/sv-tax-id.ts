// The shape of the tax identifications of El Salvador, checked when a person writes one (FIN-212). Only the SHAPE (and, for the one
// document whose check digit is public, the check digit): whether the number belongs to a real taxpayer is the authority's to say.
// A value already stored is never checked again here, so nothing saved before this rule is broken by it.

// El Salvador: a tax number (NIT) is 14 digits, a national id (DUI) is 8 digits and a check digit, a registration number (NRC) is 2 to 8 digits.
// The separators a person writes between the groups are accepted and ignored: 0614-010101-101-3, 01234567-8, 123456-7.
export const SvTaxIdShapes = {
  TAX_NUMBER_DIGITS: 14,
  NATIONAL_ID_DIGITS: 9,
  REGISTRATION_MIN_DIGITS: 2,
  REGISTRATION_MAX_DIGITS: 8
} as const

// The characters a person may put between the groups of a tax id; anything else that is not a digit is a mistake
const SEPARATORS = /[\s-]/gu
const DIGITS_ONLY = /^\d+$/u

export function taxIdDigits(value: string): string | null {
  const digits = value.replace(SEPARATORS, '')
  return DIGITS_ONLY.test(digits) ? digits : null
}

// The DUI is eight digits and a check digit: the digits take the weights 9 down to 2, and the check digit is what completes their sum
// to a multiple of ten (the public rule of the Registro Nacional de las Personas Naturales).
const DUI_WEIGHTS = [9, 8, 7, 6, 5, 4, 3, 2] as const
const DECIMAL = 10

export function isValidSvNationalId(digits: string): boolean {
  if (digits.length !== SvTaxIdShapes.NATIONAL_ID_DIGITS || !DIGITS_ONLY.test(digits)) return false
  const sum = DUI_WEIGHTS.reduce(
    (total, weight, index) => total + weight * Number(digits[index]),
    0
  )
  return (DECIMAL - (sum % DECIMAL)) % DECIMAL === Number(digits[DUI_WEIGHTS.length])
}

function isSvTaxId(value: string): boolean {
  const digits = taxIdDigits(value)
  if (digits === null) return false
  if (digits.length === SvTaxIdShapes.TAX_NUMBER_DIGITS) return true
  if (digits.length === SvTaxIdShapes.NATIONAL_ID_DIGITS) return isValidSvNationalId(digits)
  return (
    digits.length >= SvTaxIdShapes.REGISTRATION_MIN_DIGITS &&
    digits.length <= SvTaxIdShapes.REGISTRATION_MAX_DIGITS
  )
}

// Whether a tax id typed for a party that is not a receiver (a supplier: a NIT, a DUI or an NRC, as its document shows it) has the shape
// of this country
export const isPlausiblePartyTaxId = (value: string): boolean => isSvTaxId(value.trim())
