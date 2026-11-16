import type { FiscalIssuerView, FiscalProviderView } from '@platform/api-client'
import {
  FiscalEnvironment,
  FiscalFieldLimits,
  FiscalIssueOn,
  FiscalLimits,
  type PutFiscalIssuerBody
} from '@platform/core/domain'

import {
  type AddressProblem,
  type AddressRow,
  addressOf,
  addressProblemOf,
  addressRowsOf,
  emptyAddressRow
} from './address-rows'

// The form of the issuer of the organization (TDD_18 §8.2): the legal entity the documents are made in the name of and the provider that
// makes them. What the provider needs (its required issuer fields, the names of its credentials, its environments) comes from its
// manifest, so the form knows no provider. Credentials are written and never read back: a blank one keeps what is stored.

export interface IssuerDraft {
  providerId: string
  legalName: string
  taxId: string
  registrationId: string
  address: AddressRow[]
  activityCode: string
  establishmentCode: string
  environment: string
  issueOn: string
  nextSequence: string
  credentials: Record<string, string>
}

export const IssuerFields = {
  PROVIDER: 'providerId',
  LEGAL_NAME: 'legalName',
  TAX_ID: 'taxId',
  REGISTRATION_ID: 'registrationId',
  ADDRESS: 'address',
  ACTIVITY_CODE: 'activityCode',
  ESTABLISHMENT_CODE: 'establishmentCode',
  ENVIRONMENT: 'environment',
  NEXT_SEQUENCE: 'nextSequence',
  CREDENTIALS: 'credentials'
} as const
export type IssuerField = (typeof IssuerFields)[keyof typeof IssuerFields]

export interface IssuerProblem {
  field: IssuerField
  // The kind of problem, for the words: a field the provider asks for, a text too long, a correlative that goes back, a credential the
  // provider reads that was never given, or a problem of the address rows
  kind: 'required' | 'tooLong' | 'sequence' | 'environment' | AddressProblem
}

export const emptyIssuerDraft = (provider: FiscalProviderView | undefined): IssuerDraft => ({
  providerId: provider?.id ?? '',
  legalName: '',
  taxId: '',
  registrationId: '',
  address: [emptyAddressRow()],
  activityCode: '',
  establishmentCode: '',
  environment: provider?.manifest.environments[0] ?? FiscalEnvironment.SANDBOX,
  issueOn: FiscalIssueOn.DELIVERED,
  nextSequence: '',
  credentials: {}
})

export function issuerDraftOf(issuer: FiscalIssuerView): IssuerDraft {
  const rows = addressRowsOf(issuer.address)
  return {
    providerId: issuer.providerId,
    legalName: issuer.legalName,
    taxId: issuer.taxId,
    registrationId: issuer.registrationId ?? '',
    address: rows.length === 0 ? [emptyAddressRow()] : rows,
    activityCode: issuer.activityCode ?? '',
    establishmentCode: issuer.establishmentCode ?? '',
    environment: issuer.environment,
    issueOn: issuer.issueOn,
    // Left empty: the next correlative is what the issuer has, and it only moves forward
    nextSequence: '',
    credentials: {}
  }
}

const present = (text: string): boolean => text.trim() !== ''

// The fields the provider cannot work without are the ones of its manifest; the legal name, the tax id and the address the api asks
// of every issuer, whatever the provider says
const requiredBy = (provider: FiscalProviderView, field: string): boolean =>
  provider.manifest.requiredIssuerFields.includes(field)

export function issuerProblems(
  draft: IssuerDraft,
  provider: FiscalProviderView | undefined,
  current: FiscalIssuerView | null
): IssuerProblem[] {
  const problems: IssuerProblem[] = []
  if (provider === undefined) return [{ field: IssuerFields.PROVIDER, kind: 'required' }]
  const text = (field: IssuerField, value: string, max: number, mustBePresent: boolean): void => {
    if (mustBePresent && !present(value)) problems.push({ field, kind: 'required' })
    else if (value.trim().length > max) problems.push({ field, kind: 'tooLong' })
  }
  text(IssuerFields.LEGAL_NAME, draft.legalName, FiscalFieldLimits.NAME, true)
  text(IssuerFields.TAX_ID, draft.taxId, FiscalFieldLimits.TAX_ID, true)
  text(
    IssuerFields.REGISTRATION_ID,
    draft.registrationId,
    FiscalFieldLimits.REGISTRATION_ID,
    requiredBy(provider, 'registrationId')
  )
  text(
    IssuerFields.ACTIVITY_CODE,
    draft.activityCode,
    FiscalFieldLimits.CODE,
    requiredBy(provider, 'activityCode')
  )
  text(
    IssuerFields.ESTABLISHMENT_CODE,
    draft.establishmentCode,
    FiscalFieldLimits.CODE,
    requiredBy(provider, 'establishmentCode')
  )
  const addressProblem = addressProblemOf(draft.address)
  if (addressProblem !== null) problems.push({ field: IssuerFields.ADDRESS, kind: addressProblem })
  else if (Object.keys(addressOf(draft.address)).length === 0) {
    problems.push({ field: IssuerFields.ADDRESS, kind: 'required' })
  }
  if (
    !provider.manifest.environments.some(environment => String(environment) === draft.environment)
  ) {
    problems.push({ field: IssuerFields.ENVIRONMENT, kind: 'environment' })
  }
  const next = sequenceOf(draft.nextSequence)
  if (draft.nextSequence.trim() !== '') {
    if (next === null || (current !== null && next < current.nextSequence)) {
      problems.push({ field: IssuerFields.NEXT_SEQUENCE, kind: 'sequence' })
    }
  }
  // The credentials sent replace the stored ones whole, so a person gives all of them or none. None keeps what is stored, which is
  // only right for the same provider in the same environment (a key of one is never the key of the other).
  const keys = provider.manifest.credentialKeys
  const given = keys.filter(key => present(draft.credentials[key] ?? ''))
  const keepable =
    current !== null &&
    current.credentialsSet &&
    current.providerId === draft.providerId &&
    String(current.environment) === draft.environment
  if (keys.length > 0 && given.length < keys.length && !(given.length === 0 && keepable)) {
    problems.push({ field: IssuerFields.CREDENTIALS, kind: 'required' })
  }
  return problems
}

// A correlative is a whole number between 1 and the limit of the database
// The digits of the largest correlative
export const SEQUENCE_DIGITS = String(FiscalLimits.MAX_SEQUENCE).length

export function sequenceOf(text: string): number | null {
  if (!new RegExp(`^\\d{1,${String(SEQUENCE_DIGITS)}}$`).test(text.trim())) return null
  const value = Number(text.trim())
  return value >= 1 && value <= FiscalLimits.MAX_SEQUENCE ? value : null
}

const orNull = (text: string): string | null => (present(text) ? text.trim() : null)

// Call only after `issuerProblems` said none. The correlative is sent only when it was typed; the credentials only when they were.
export function issuerInputOf(
  draft: IssuerDraft,
  provider: FiscalProviderView
): PutFiscalIssuerBody {
  const credentials = Object.fromEntries(
    provider.manifest.credentialKeys.flatMap(key => {
      const value = draft.credentials[key] ?? ''
      return present(value) ? [[key, value.trim()]] : []
    })
  )
  const next = draft.nextSequence.trim() === '' ? null : sequenceOf(draft.nextSequence)
  return {
    providerId: provider.id,
    legalName: draft.legalName.trim(),
    taxId: draft.taxId.trim(),
    registrationId: orNull(draft.registrationId),
    address: addressOf(draft.address),
    activityCode: orNull(draft.activityCode),
    establishmentCode: orNull(draft.establishmentCode),
    environment: draft.environment as FiscalEnvironment,
    issueOn: draft.issueOn as FiscalIssueOn,
    ...(next === null ? {} : { nextSequence: next }),
    ...(Object.keys(credentials).length === 0 ? {} : { credentials })
  }
}
