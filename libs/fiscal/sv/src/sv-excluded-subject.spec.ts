import { ExcludedSubjectProblems } from '@platform/core/domain'
import type { FiscalExcludedSubjectPurchaseInput } from '@platform/fiscal/sdk'

import { excludedSubjectPurchaseProblems } from './sv-excluded-subject'

const base: FiscalExcludedSubjectPurchaseInput = {
  purchasedOn: '2026-11-10',
  sellerDocumentType: '2',
  sellerDocumentNumber: '012345678',
  documentSeries: null,
  generationCode: null,
  amountCents: 10_000,
  vatWithheldCents: 0,
  operationType: '1',
  expenseClass: '2',
  sector: '2',
  costType: '1'
}
const problems = (change: Partial<FiscalExcludedSubjectPurchaseInput>) =>
  excludedSubjectPurchaseProblems({ ...base, ...change })

describe('excludedSubjectPurchaseProblems (annex 5 of the F-07)', () => {
  it('accepts a purchase that follows the manual', () => {
    expect(problems({})).toEqual([])
    expect(
      problems({
        sellerDocumentType: '1',
        sellerDocumentNumber: '06141234567890',
        generationCode: 'A1B2C3D4-0000-4000-8000-000000000001',
        documentSeries: '2026ABCDEF',
        vatWithheldCents: 1300
      })
    ).toEqual([])
  })

  it('checks the document of the seller against its type, with no dashes', () => {
    expect(problems({ sellerDocumentType: '1', sellerDocumentNumber: '012345678' })).toEqual([
      ExcludedSubjectProblems.SELLER_DOCUMENT_NUMBER_INVALID
    ])
    expect(problems({ sellerDocumentNumber: '01234567-8' })).toEqual([
      ExcludedSubjectProblems.SELLER_DOCUMENT_NUMBER_INVALID
    ])
    expect(problems({ sellerDocumentType: '3', sellerDocumentNumber: 'AB1234567890123' })).toEqual([
      ExcludedSubjectProblems.SELLER_DOCUMENT_NUMBER_INVALID
    ])
    expect(problems({ sellerDocumentType: '3', sellerDocumentNumber: 'P1234567' })).toEqual([])
    expect(problems({ sellerDocumentType: '9' })).toEqual([
      ExcludedSubjectProblems.SELLER_DOCUMENT_TYPE_INVALID
    ])
  })

  it('takes the VAT withheld as 13 % of the amount or 0.00, with a cent of rounding', () => {
    expect(problems({ vatWithheldCents: 1300 })).toEqual([])
    expect(problems({ vatWithheldCents: 1301 })).toEqual([])
    expect(problems({ vatWithheldCents: 1299 })).toEqual([])
    expect(problems({ vatWithheldCents: 1000 })).toEqual([
      ExcludedSubjectProblems.VAT_WITHHELD_INVALID
    ])
    expect(problems({ vatWithheldCents: 1 })).toEqual([
      ExcludedSubjectProblems.VAT_WITHHELD_INVALID
    ])
  })

  it('checks the code of generation and the type of operation', () => {
    expect(problems({ generationCode: 'not-a-uuid' })).toEqual([
      ExcludedSubjectProblems.GENERATION_CODE_INVALID
    ])
    expect(problems({ operationType: '5' })).toEqual([
      ExcludedSubjectProblems.OPERATION_TYPE_INVALID
    ])
  })

  it('checks the classification of the cost or expense like the annex of purchases', () => {
    expect(problems({ expenseClass: '2', sector: '2', costType: '7' })).toEqual([
      ExcludedSubjectProblems.CLASSIFICATION_INVALID
    ])
    expect(problems({ expenseClass: '1', sector: '1', costType: '7' })).toEqual([])
    expect(problems({ expenseClass: '1', sector: '2', costType: '7' })).toEqual([
      ExcludedSubjectProblems.CLASSIFICATION_INVALID
    ])
  })
})
