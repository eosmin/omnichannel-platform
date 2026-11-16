import { FiscalDocumentStatus } from '@platform/core/domain'

import {
  canTransition,
  documentLines,
  isImmutable,
  maskTaxId,
  receiverEditable,
  receiverOf,
  receiverRecord,
  retryable
} from './fiscal-rules'

describe('the transitions of a fiscal document', () => {
  const S = FiscalDocumentStatus
  it('follows the table of TDD_18 §3', () => {
    expect(canTransition(S.DRAFT, S.QUEUED)).toBe(true)
    expect(canTransition(S.QUEUED, S.SUBMITTED)).toBe(true)
    expect(canTransition(S.SUBMITTED, S.ACCEPTED)).toBe(true)
    expect(canTransition(S.SUBMITTED, S.REJECTED)).toBe(true)
    expect(canTransition(S.REJECTED, S.QUEUED)).toBe(true)
    expect(canTransition(S.ACCEPTED, S.VOIDED)).toBe(true)
  })

  it('refuses the rest: nothing leaves VOIDED, an accepted document is only voided, a refusal is not accepted at once', () => {
    expect(canTransition(S.VOIDED, S.QUEUED)).toBe(false)
    expect(canTransition(S.ACCEPTED, S.REJECTED)).toBe(false)
    expect(canTransition(S.ACCEPTED, S.QUEUED)).toBe(false)
    expect(canTransition(S.REJECTED, S.ACCEPTED)).toBe(false)
    expect(canTransition(S.QUEUED, S.ACCEPTED)).toBe(false)
  })

  it('is immutable from ACCEPTED on, and only a waiting or refused document has an editable receiver', () => {
    expect(isImmutable(S.ACCEPTED)).toBe(true)
    expect(isImmutable(S.VOIDED)).toBe(true)
    expect(isImmutable(S.REJECTED)).toBe(false)
    expect(receiverEditable(S.QUEUED)).toBe(true)
    expect(receiverEditable(S.REJECTED)).toBe(true)
    expect(receiverEditable(S.SUBMITTED)).toBe(false)
    expect(receiverEditable(S.ACCEPTED)).toBe(false)
    expect(retryable(S.REJECTED)).toBe(true)
    expect(retryable(S.ACCEPTED)).toBe(false)
  })
})

describe('the lines of a document', () => {
  it('take the amounts and the tax snapshot of the order as they are', () => {
    const lines = documentLines([
      {
        productName: 'Shirt',
        variantName: 'M',
        quantity: 2,
        unitPriceCents: 1000,
        taxRateBps: 1300,
        taxCents: 230
      },
      {
        productName: 'Old order line',
        variantName: null,
        quantity: 1,
        unitPriceCents: 500,
        taxRateBps: null,
        taxCents: null
      }
    ])
    expect(lines).toEqual([
      {
        description: 'Shirt (M)',
        quantity: 2,
        unitPriceCents: 1000,
        discountCents: 0,
        taxRateBps: 1300,
        taxCents: 230,
        totalCents: 2000
      },
      {
        description: 'Old order line',
        quantity: 1,
        unitPriceCents: 500,
        discountCents: 0,
        taxRateBps: null,
        taxCents: 0,
        totalCents: 500
      }
    ])
  })
})

describe('the receiver', () => {
  it('keeps only what is filled and reads back the same', () => {
    const receiver = {
      name: ' Ana ',
      taxId: '12345678-9',
      registrationId: null,
      address: { city: 'X', line1: '' },
      email: null,
      phone: ''
    }
    const record = receiverRecord(receiver)
    expect(record).toEqual({ name: 'Ana', taxId: '12345678-9', address: { city: 'X', line1: '' } })
    expect(receiverOf(record)).toEqual({
      name: 'Ana',
      taxId: '12345678-9',
      registrationId: null,
      address: { city: 'X' },
      email: null,
      phone: null
    })
  })

  it('masks a tax id except for its last four characters', () => {
    expect(maskTaxId('12345678-9')).toBe('******78-9')
    expect(maskTaxId('123')).toBe('***')
    expect(maskTaxId(null)).toBeNull()
  })
})
