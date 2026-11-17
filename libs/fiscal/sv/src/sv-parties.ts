import type {
  FiscalIssuerInput,
  FiscalReceiver,
  FiscalReceiverField,
  FiscalReceiverProblem
} from '@platform/fiscal/sdk'

import {
  activityName,
  isDepartment,
  isDistrict,
  isIdentityDocument,
  isMunicipality
} from './sv-catalog'
import {
  SvAddressKeys,
  SvCodePatterns,
  SvIdentityDocuments,
  SvLimits,
  SvProblemCodes
} from './sv-constants'

// The issuer and the receiver of a document, read the way the authority writes them. Pure: no value is ever echoed in a problem, only the
// field and a code.

// A value with nothing in it
export const lacks = (value: string | null | undefined): boolean =>
  value === null || value === undefined || value.trim() === ''

export const digitsOf = (text: string | null | undefined): string => (text ?? '').replace(/\D/g, '')

export interface SvAddress {
  readonly departamento: string
  readonly municipio: string
  readonly distrito: string
  readonly complemento: string
}

// The address of core (a record of text) as the four parts of the authority, or null when any part is missing or not in the catalogs
export function addressOf(
  address: Readonly<Record<string, unknown>> | null | undefined
): SvAddress | null {
  if (address === null || address === undefined) return null
  const part = (key: string): string => {
    const value = address[key]
    return typeof value === 'string' ? value.trim() : ''
  }
  const departamento = part(SvAddressKeys.DEPARTMENT)
  const municipio = part(SvAddressKeys.MUNICIPALITY)
  const distrito = part(SvAddressKeys.DISTRICT)
  const complemento = part(SvAddressKeys.COMPLEMENT)
  if (
    !isDepartment(departamento) ||
    !isMunicipality(departamento, municipio) ||
    !isDistrict(distrito) ||
    complemento === '' ||
    complemento.length > SvLimits.COMPLEMENT_MAX
  ) {
    return null
  }
  return { departamento, municipio, distrito, complemento }
}

// The tax id of a receiver as the authority wants it: digits only, 14 (a tax number) or 9 (a national id) of them. Another kind of
// document (a passport, a residence card) is kept as written, up to 20 characters.
export function identityOf(
  taxId: string | null,
  documentType: string | null | undefined
): { type: string; number: string } | null {
  if (taxId === null || taxId.trim() === '') return null
  const kind = documentType ?? null
  const digits = digitsOf(taxId)
  if (
    kind === null ||
    kind === SvIdentityDocuments.TAX_ID ||
    kind === SvIdentityDocuments.NATIONAL_ID
  ) {
    if (
      kind === SvIdentityDocuments.NATIONAL_ID
        ? digits.length !== 9
        : !SvCodePatterns.TAX_ID.test(digits)
    )
      return null
    // No kind said: nine digits are a national id, fourteen a tax number
    return {
      type:
        kind ??
        (digits.length === 9 ? SvIdentityDocuments.NATIONAL_ID : SvIdentityDocuments.TAX_ID),
      number: digits
    }
  }
  const raw = taxId.trim()
  return raw.length > SvLimits.OTHER_DOCUMENT_MAX ? null : { type: kind, number: raw }
}

export const validEmail = (email: string): boolean =>
  email.length >= SvLimits.EMAIL_MIN &&
  email.length <= SvLimits.EMAIL_MAX &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
export const validPhone = (phone: string): boolean =>
  phone.length >= SvLimits.PHONE_MIN && phone.length <= SvLimits.PHONE_MAX

// What is wrong in the data a person typed about a receiver: only what is present is checked (what a document type needs is `missing`)
export function receiverProblems(receiver: FiscalReceiver): FiscalReceiverProblem[] {
  const problems: FiscalReceiverProblem[] = []
  const add = (field: FiscalReceiverField, code: string): void => {
    problems.push({ field, code })
  }
  const kind = receiver.documentType ?? null
  if (kind !== null && !isIdentityDocument(kind))
    add('documentType', SvProblemCodes.DOCUMENT_TYPE_UNKNOWN)
  if (
    receiver.taxId !== null &&
    receiver.taxId.trim() !== '' &&
    identityOf(receiver.taxId, kind) === null
  ) {
    add('taxId', SvProblemCodes.TAX_ID_INVALID)
  }
  if (receiver.registrationId !== null && receiver.registrationId.trim() !== '') {
    if (!SvCodePatterns.REGISTRATION.test(digitsOf(receiver.registrationId)))
      add('registrationId', SvProblemCodes.REGISTRATION_INVALID)
  }
  if (
    receiver.economicActivity !== null &&
    receiver.economicActivity !== undefined &&
    receiver.economicActivity.trim() !== ''
  ) {
    if (activityName(receiver.economicActivity.trim()) === null)
      add('economicActivity', SvProblemCodes.ACTIVITY_UNKNOWN)
  }
  if (
    receiver.address !== null &&
    Object.keys(receiver.address).length > 0 &&
    addressOf(receiver.address) === null
  ) {
    add('address', SvProblemCodes.ADDRESS_INVALID)
  }
  if (receiver.email !== null && receiver.email.trim() !== '' && !validEmail(receiver.email.trim()))
    add('email', SvProblemCodes.EMAIL_INVALID)
  if (receiver.phone !== null && receiver.phone.trim() !== '' && !validPhone(receiver.phone.trim()))
    add('phone', SvProblemCodes.PHONE_INVALID)
  if (receiver.name !== null && receiver.name.trim().length > SvLimits.NAME_MAX)
    add('name', SvProblemCodes.NAME_INVALID)
  return problems
}

// The fields a tax credit document (and the credit note of one) cannot be made without, that this receiver lacks or has wrong
export function missingForBusiness(receiver: FiscalReceiver): FiscalReceiverField[] {
  const missing: FiscalReceiverField[] = []
  const wrong = new Set(receiverProblems(receiver).map(problem => problem.field))
  if (lacks(receiver.name) || wrong.has('name')) missing.push('name')
  // A taxpayer is identified by a tax number (or a national id): the slot of a tax credit document takes digits, not a passport
  const identity = identityOf(receiver.taxId, receiver.documentType)
  if (
    identity === null ||
    (identity.type !== SvIdentityDocuments.TAX_ID &&
      identity.type !== SvIdentityDocuments.NATIONAL_ID)
  ) {
    missing.push('taxId')
  }
  if (!SvCodePatterns.REGISTRATION.test(digitsOf(receiver.registrationId)))
    missing.push('registrationId')
  if (lacks(receiver.economicActivity) || wrong.has('economicActivity'))
    missing.push('economicActivity')
  if (receiver.address === null || addressOf(receiver.address) === null) missing.push('address')
  return missing
}

// Whether the issuer holds everything a document is made from; the codes are the fields of the issuer
export function issuerProblems(issuer: FiscalIssuerInput): string[] {
  const problems: string[] = []
  if (issuer.legalName.trim() === '' || issuer.legalName.length > SvLimits.NAME_MAX)
    problems.push('legalName')
  if (!SvCodePatterns.TAX_ID.test(digitsOf(issuer.taxId))) problems.push('taxId')
  if (!SvCodePatterns.REGISTRATION.test(digitsOf(issuer.registrationId)))
    problems.push('registrationId')
  if (issuer.activityCode === null || activityName(issuer.activityCode.trim()) === null)
    problems.push('activityCode')
  if (addressOf(issuer.address) === null) problems.push('address')
  if (
    issuer.establishmentCode === null ||
    !SvCodePatterns.ESTABLISHMENT.test(issuer.establishmentCode.trim())
  ) {
    problems.push('establishmentCode')
  }
  if (
    issuer.pointOfSaleCode === null ||
    !SvCodePatterns.POINT_OF_SALE.test(issuer.pointOfSaleCode.trim())
  ) {
    problems.push('pointOfSaleCode')
  }
  if (issuer.phone === null || !validPhone(issuer.phone.trim())) problems.push('phone')
  if (issuer.email === null || !validEmail(issuer.email.trim())) problems.push('email')
  return problems
}
