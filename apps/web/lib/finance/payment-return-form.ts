import type { RecordPaymentReturnInput } from '@platform/api-client'
import { isIsoDate, PurchaseLimits } from '@platform/core/domain'

import { centsOfText, decimalOfCentsText } from './purchase-form'

// What a supplier gave back of a payment (TDD_18 §4.2 E11b): typed as dollars, sent as cents. The api checks the same rules again
// under a lock, against what is left of the payment after the returns that are alive.

export interface ReturnDraft {
  receivedIntoAccountId: string
  amount: string
  returnedOn: string
  reference: string
}

export const ReturnFields = {
  ACCOUNT: 'receivedIntoAccountId',
  AMOUNT: 'amount',
  DATE: 'returnedOn',
  REFERENCE: 'reference'
} as const
export type ReturnField = (typeof ReturnFields)[keyof typeof ReturnFields]

// The payment the return is of: the money comes back into the account it left from, and at most the whole payment
export interface ReturnedPayment {
  paidFromAccountId: string
  amountCents: number
  paidOn: string
}

export const emptyReturnDraft = (today: string, payment: ReturnedPayment): ReturnDraft => ({
  receivedIntoAccountId: payment.paidFromAccountId,
  amount: decimalOfCentsText(payment.amountCents),
  returnedOn: today,
  reference: ''
})

export function returnProblem(
  draft: ReturnDraft,
  payment: ReturnedPayment,
  today: string
): ReturnField | null {
  if (draft.receivedIntoAccountId === '') return ReturnFields.ACCOUNT
  const amount = centsOfText(draft.amount)
  if (amount === null || amount < 1 || amount > payment.amountCents) return ReturnFields.AMOUNT
  const day = draft.returnedOn.trim()
  if (!isIsoDate(day) || day < payment.paidOn || day > today) return ReturnFields.DATE
  if (draft.reference.trim().length > PurchaseLimits.REFERENCE_MAX_LENGTH) {
    return ReturnFields.REFERENCE
  }
  return null
}

// Call only after `returnProblem` said null
export function returnInputOf(
  draft: ReturnDraft,
  idempotencyKey: string
): RecordPaymentReturnInput {
  const reference = draft.reference.trim()
  return {
    idempotencyKey,
    receivedIntoAccountId: draft.receivedIntoAccountId,
    amountCents: centsOfText(draft.amount) ?? 0,
    returnedOn: draft.returnedOn.trim(),
    ...(reference === '' ? {} : { reference })
  }
}
