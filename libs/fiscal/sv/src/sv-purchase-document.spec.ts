import { PurchaseDocumentProblems, PurchaseOrigins } from '@platform/core/domain'
import type { FiscalPurchaseDocumentInput } from '@platform/fiscal/sdk'

import { purchaseDocumentProblems } from './sv-purchase-document'

const CODE = '0B7E1C2A-6F34-4D8E-9A51-3C2D7E8F9A10'

const input = (extra: Partial<FiscalPurchaseDocumentInput> = {}): FiscalPurchaseDocumentInput => ({
  issuedOn: '2026-11-05',
  receivedOn: '2026-11-10',
  documentClass: '4',
  documentType: '03',
  generationCode: CODE,
  documentNumber: 'DTE-03-M001P001-000000000000001',
  origin: PurchaseOrigins.INTERNAL,
  expenseClass: '1',
  sector: '2',
  costType: '5',
  ...extra
})

describe('purchaseDocumentProblems (annex 3 of the manual of annexes F-07)', () => {
  it('accepts a received electronic tax credit document', () => {
    expect(purchaseDocumentProblems(input())).toEqual([])
  })

  it('accepts a printed document with no code of generation, and the customs documents of class 3', () => {
    expect(purchaseDocumentProblems(input({ documentClass: '1', generationCode: null }))).toEqual(
      []
    )
    expect(
      purchaseDocumentProblems(
        input({
          documentClass: '3',
          documentType: '12',
          generationCode: null,
          origin: PurchaseOrigins.IMPORT_GOODS
        })
      )
    ).toEqual([])
    expect(
      purchaseDocumentProblems(
        input({
          documentClass: '3',
          documentType: '13',
          generationCode: null,
          origin: PurchaseOrigins.IMPORT_SERVICES
        })
      )
    ).toEqual([])
  })

  it('refuses a class or a type that is not in the catalog, and a class that does not go with its type', () => {
    expect(purchaseDocumentProblems(input({ documentClass: '7' }))).toContain(
      PurchaseDocumentProblems.CLASS_INVALID
    )
    expect(purchaseDocumentProblems(input({ documentType: '14' }))).toContain(
      PurchaseDocumentProblems.TYPE_INVALID
    )
    // Class 3 only holds 12 and 13; the others only go in 1, 2 and 4
    expect(purchaseDocumentProblems(input({ documentClass: '3', generationCode: null }))).toContain(
      PurchaseDocumentProblems.CLASS_TYPE_MISMATCH
    )
    expect(
      purchaseDocumentProblems(input({ documentType: '12', origin: PurchaseOrigins.IMPORT_GOODS }))
    ).toContain(PurchaseDocumentProblems.CLASS_TYPE_MISMATCH)
  })

  it('wants the code of generation of an electronic document and no code on any other', () => {
    expect(purchaseDocumentProblems(input({ generationCode: null }))).toContain(
      PurchaseDocumentProblems.GENERATION_CODE_REQUIRED
    )
    expect(purchaseDocumentProblems(input({ generationCode: 'not-a-uuid' }))).toContain(
      PurchaseDocumentProblems.GENERATION_CODE_INVALID
    )
    expect(purchaseDocumentProblems(input({ documentClass: '1' }))).toContain(
      PurchaseDocumentProblems.GENERATION_CODE_NOT_ELECTRONIC
    )
  })

  it('holds the day of issue between three periods before the day of arrival and that day itself', () => {
    expect(purchaseDocumentProblems(input({ issuedOn: '2026-11-10' }))).toEqual([])
    expect(purchaseDocumentProblems(input({ issuedOn: '2026-08-01' }))).toEqual([])
    expect(purchaseDocumentProblems(input({ issuedOn: '2026-07-31' }))).toContain(
      PurchaseDocumentProblems.ISSUED_TOO_OLD
    )
    // The year turns: a document of October reaches a receipt of January
    expect(
      purchaseDocumentProblems(input({ issuedOn: '2025-10-15', receivedOn: '2026-01-02' }))
    ).toEqual([])
    expect(
      purchaseDocumentProblems(input({ issuedOn: '2025-09-30', receivedOn: '2026-01-02' }))
    ).toContain(PurchaseDocumentProblems.ISSUED_TOO_OLD)
    expect(purchaseDocumentProblems(input({ issuedOn: '2026-11-11' }))).toContain(
      PurchaseDocumentProblems.ISSUED_AFTER_RECEIPT
    )
  })

  it('wants the number the supplier printed', () => {
    expect(purchaseDocumentProblems(input({ documentNumber: null }))).toContain(
      PurchaseDocumentProblems.NUMBER_REQUIRED
    )
    expect(purchaseDocumentProblems(input({ documentNumber: '  ' }))).toContain(
      PurchaseDocumentProblems.NUMBER_REQUIRED
    )
  })

  it('ties the origin to the type: the customs and the treasury documents are imports, the others a purchase in the country', () => {
    expect(purchaseDocumentProblems(input({ origin: PurchaseOrigins.IMPORT_GOODS }))).toContain(
      PurchaseDocumentProblems.ORIGIN_INVALID_FOR_TYPE
    )
    const customs = input({ documentClass: '3', documentType: '12', generationCode: null })
    expect(purchaseDocumentProblems({ ...customs, origin: PurchaseOrigins.INTERNAL })).toContain(
      PurchaseDocumentProblems.ORIGIN_INVALID_FOR_TYPE
    )
    expect(purchaseDocumentProblems({ ...customs, origin: PurchaseOrigins.INTERNATION })).toEqual(
      []
    )
    const treasury = input({ documentClass: '3', documentType: '13', generationCode: null })
    expect(
      purchaseDocumentProblems({ ...treasury, origin: PurchaseOrigins.IMPORT_GOODS })
    ).toContain(PurchaseDocumentProblems.ORIGIN_INVALID_FOR_TYPE)
  })

  it('holds the table of combinations of the cost or expense, the sector and the type (columns R, S and T)', () => {
    const wrong = PurchaseDocumentProblems.CLASSIFICATION_INVALID
    // A cost of the industry: types 4 to 7; a cost of any other sector: 4 and 5
    for (const costType of ['4', '5', '6', '7']) {
      expect(purchaseDocumentProblems(input({ sector: '1', costType }))).toEqual([])
    }
    expect(purchaseDocumentProblems(input({ sector: '1', costType: '3' }))).toContain(wrong)
    for (const sector of ['2', '3', '4']) {
      expect(purchaseDocumentProblems(input({ sector, costType: '5' }))).toEqual([])
      expect(purchaseDocumentProblems(input({ sector, costType: '6' }))).toContain(wrong)
    }
    // An expense of any sector: types 1 to 3
    for (const sector of ['1', '2', '3', '4']) {
      expect(purchaseDocumentProblems(input({ expenseClass: '2', sector, costType: '2' }))).toEqual(
        []
      )
      expect(
        purchaseDocumentProblems(input({ expenseClass: '2', sector, costType: '4' }))
      ).toContain(wrong)
    }
    expect(purchaseDocumentProblems(input({ expenseClass: '3' }))).toContain(wrong)
    expect(purchaseDocumentProblems(input({ sector: '9' }))).toContain(wrong)
  })
})
