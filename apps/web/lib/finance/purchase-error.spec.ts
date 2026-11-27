import { ApiError } from '@platform/api-client'
import {
  PaymentReturnRule,
  PaymentRule,
  PurchaseConflicts,
  PurchaseDocumentProblems,
  PurchaseRule
} from '@platform/core/domain'

import messages from '../../messages/en.json'
import esMessages from '../../messages/es.json'

import { purchaseErrorKeyOf } from './purchase-error'

const error = (metadata: Record<string, unknown>): ApiError =>
  new ApiError(409, 'RESOURCE_CONFLICT', 'refused', null, metadata)

describe('the reason an api refusal of a purchase gives', () => {
  it('reads the conflict the api names, and only one it knows', () => {
    expect(purchaseErrorKeyOf(error({ conflict: PurchaseConflicts.DOCUMENT_NUMBER_IN_USE }))).toBe(
      'conflicts.document_number_in_use'
    )
    expect(purchaseErrorKeyOf(error({ conflict: 'a_conflict_of_a_newer_api' }))).toBeNull()
  })

  it('reads the first rule of purchases a request broke, and none that is unknown', () => {
    expect(purchaseErrorKeyOf(error({ problems: ['nonsense', PurchaseRule.NO_LINES] }))).toBe(
      'rules.no_lines'
    )
    expect(purchaseErrorKeyOf(error({ problems: [PaymentRule.FROM_NOT_CASH] }))).toBe(
      'rules.from_not_cash'
    )
    expect(purchaseErrorKeyOf(error({ problems: ['nonsense'] }))).toBeNull()
  })

  it('is null for what is not an api error or names nothing', () => {
    expect(purchaseErrorKeyOf(new Error('x'))).toBeNull()
    expect(purchaseErrorKeyOf(error({}))).toBeNull()
  })

  it.each([
    ['en', messages],
    ['es', esMessages]
  ])(
    'has a message in %s for every conflict and every rule the api can name',
    (_locale, bundle) => {
      const purchases = bundle.finance.purchases as unknown as {
        conflicts: Record<string, string>
        rules: Record<string, string>
      }
      for (const conflict of Object.values(PurchaseConflicts)) {
        expect(purchases.conflicts[conflict]).toEqual(expect.any(String))
      }
      for (const rule of [
        ...Object.values(PurchaseRule),
        ...Object.values(PaymentRule),
        ...Object.values(PaymentReturnRule),
        ...Object.values(PurchaseDocumentProblems)
      ]) {
        expect(purchases.rules[rule]).toEqual(expect.any(String))
      }
    }
  )
})
