import { ApiError } from '@platform/api-client'
import { FinanceConflicts } from '@platform/core/domain'
import { ClientErrorCodes } from '@platform/core/errors'

import messages from '../../messages/en.json'
import esMessages from '../../messages/es.json'

import { RECEIPT_REFUSALS, receiptRefusalOf } from './receipt-refusal'

const conflict = (kind: unknown): ApiError =>
  new ApiError(409, 'RESOURCE_CONFLICT', 'refused', null, { conflict: kind })

describe('the kind of refusal of a receipt', () => {
  it('reads the conflicts of attaching a receipt, and only those', () => {
    expect(receiptRefusalOf(conflict(FinanceConflicts.TRANSACTION_DOCUMENT_REFUSED))).toBe(
      'transaction_document_refused'
    )
    expect(receiptRefusalOf(conflict(FinanceConflicts.TRANSACTION_DOCUMENT_NOT_CLEAN))).toBe(
      'transaction_document_not_clean'
    )
    expect(receiptRefusalOf(conflict(FinanceConflicts.TRANSACTION_DOCUMENT_ALREADY_SET))).toBe(
      'transaction_document_already_set'
    )
    expect(receiptRefusalOf(conflict(FinanceConflicts.ACCOUNT_LIMIT))).toBeNull()
    expect(receiptRefusalOf(conflict(7))).toBeNull()
  })

  it('reads a file the scan gave up on, which the wait for the verdict throws before attaching', () => {
    expect(
      receiptRefusalOf(new ApiError(410, ClientErrorCodes.FILE_UNSCANNABLE, 'gone', null, {}))
    ).toBe('file_unscannable')
  })

  it('is null for what is not an api error', () => {
    expect(receiptRefusalOf(new Error('x'))).toBeNull()
    expect(receiptRefusalOf(null)).toBeNull()
  })

  it('has a sentence in both languages for every refusal it reads', () => {
    for (const kind of RECEIPT_REFUSALS) {
      const en = messages.finance.transactions.receipt.refusals as Record<string, string>
      const es = esMessages.finance.transactions.receipt.refusals as Record<string, string>
      expect(en[kind]).toBeTruthy()
      expect(es[kind]).toBeTruthy()
    }
  })
})
