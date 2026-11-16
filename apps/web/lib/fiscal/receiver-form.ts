import { FiscalFieldLimits, type FiscalReceiverPatchBody } from '@platform/core/domain'

import {
  type AddressProblem,
  type AddressRow,
  addressOf,
  addressProblemOf,
  emptyAddressRow
} from './address-rows'

// The form that fixes the receiver of a fiscal document that was refused or never sent. The api gives the receiver minimized (the name,
// the tax id masked), so the form cannot show what is stored: it starts empty, a field left empty stays as it is, and what is written
// replaces it. An address written replaces the whole address.

export interface ReceiverDraft {
  name: string
  taxId: string
  registrationId: string
  email: string
  phone: string
  address: AddressRow[]
}

export const ReceiverFields = {
  NAME: 'name',
  TAX_ID: 'taxId',
  REGISTRATION_ID: 'registrationId',
  EMAIL: 'email',
  PHONE: 'phone',
  ADDRESS: 'address'
} as const
export type ReceiverField = (typeof ReceiverFields)[keyof typeof ReceiverFields]

export interface ReceiverProblem {
  field: ReceiverField | null
  kind: 'nothing' | 'tooLong' | AddressProblem
}

export const emptyReceiverDraft = (): ReceiverDraft => ({
  name: '',
  taxId: '',
  registrationId: '',
  email: '',
  phone: '',
  address: [emptyAddressRow()]
})

const LIMITS: Record<Exclude<ReceiverField, 'address'>, number> = {
  name: FiscalFieldLimits.NAME,
  taxId: FiscalFieldLimits.TAX_ID,
  registrationId: FiscalFieldLimits.REGISTRATION_ID,
  email: FiscalFieldLimits.EMAIL,
  phone: FiscalFieldLimits.PHONE
}
const TEXT_FIELDS = Object.keys(LIMITS) as (keyof typeof LIMITS)[]

export function receiverProblem(draft: ReceiverDraft): ReceiverProblem | null {
  for (const field of TEXT_FIELDS) {
    if (draft[field].trim().length > LIMITS[field]) return { field, kind: 'tooLong' }
  }
  const address = addressProblemOf(draft.address)
  if (address !== null) return { field: ReceiverFields.ADDRESS, kind: address }
  const patch = receiverPatchOf(draft)
  return Object.keys(patch).length === 0 ? { field: null, kind: 'nothing' } : null
}

// What was written, and only that. Call it to know whether there is anything to send; send it only after `receiverProblem` said null.
export function receiverPatchOf(draft: ReceiverDraft): FiscalReceiverPatchBody {
  const patch: FiscalReceiverPatchBody = {}
  for (const field of TEXT_FIELDS) {
    const value = draft[field].trim()
    if (value !== '') patch[field] = value
  }
  const address = addressProblemOf(draft.address) === null ? addressOf(draft.address) : {}
  if (Object.keys(address).length > 0) patch.address = address
  return patch
}
