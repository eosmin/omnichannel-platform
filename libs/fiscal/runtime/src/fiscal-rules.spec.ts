import { FiscalDocumentStatus } from '@platform/core/domain'

import {
  canTransition,
  documentLines,
  isImmutable,
  maskTaxId,
  receiverEditable,
  receiverOf,
  receiverRecord,
  retryable,
  saleAddsUp,
  saleOf,
  sameIssuer
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

  it('is exactly the table: every edge, in both directions', () => {
    const allowed: Record<string, string[]> = {
      [S.DRAFT]: [S.QUEUED],
      [S.QUEUED]: [S.SUBMITTED],
      // QUEUED again when the provider could not answer: the contingency path
      [S.SUBMITTED]: [S.ACCEPTED, S.REJECTED, S.QUEUED],
      [S.ACCEPTED]: [S.VOIDED],
      [S.REJECTED]: [S.QUEUED],
      [S.VOIDED]: []
    }
    for (const from of Object.values(S)) {
      for (const to of Object.values(S)) {
        expect(canTransition(from, to)).toBe(allowed[from]?.includes(to) ?? false)
      }
    }
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
    expect(receiverEditable(S.QUEUED, 0)).toBe(true)
    expect(receiverEditable(S.REJECTED, 2)).toBe(true)
    // Back in the queue after an attempt: it may already be at the authority
    expect(receiverEditable(S.QUEUED, 1)).toBe(false)
    expect(receiverEditable(S.SUBMITTED, 1)).toBe(false)
    expect(receiverEditable(S.ACCEPTED, 1)).toBe(false)
    expect(retryable(S.REJECTED)).toBe(true)
    expect(retryable(S.ACCEPTED)).toBe(false)
    expect(retryable(S.VOIDED)).toBe(false)
    expect(retryable(S.SUBMITTED)).toBe(false)
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
      },
      {
        productName: 'Partial snapshot',
        variantName: null,
        quantity: 1,
        unitPriceCents: 100,
        taxRateBps: 1300,
        taxCents: null
      }
    ])
    // A rate with no tax amount says no rate: never a rate beside a zero tax
    expect(lines[2]?.taxRateBps).toBeNull()
    expect(lines.slice(0, 2)).toEqual([
      {
        description: 'Shirt (M)',
        quantity: 2,
        unitPriceCents: 1000,
        taxRateBps: 1300,
        taxCents: 230,
        totalCents: 2000
      },
      {
        description: 'Old order line',
        quantity: 1,
        unitPriceCents: 500,
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
    expect(record).toEqual({ name: 'Ana', taxId: '12345678-9', address: { city: 'X' } })
    expect(receiverOf(record)).toEqual({
      name: 'Ana',
      taxId: '12345678-9',
      registrationId: null,
      address: { city: 'X' },
      email: null,
      phone: null
    })
  })

  it('stores an address the way it reads it back: trimmed, with no empty value, and none when nothing is left', () => {
    const base = { name: null, taxId: null, registrationId: null, email: null, phone: null }
    expect(receiverRecord({ ...base, address: { line1: '   ', city: '' } })).toEqual({})
    expect(
      receiverOf(receiverRecord({ ...base, address: { line1: ' Calle 1 ' } })).address
    ).toEqual({
      line1: 'Calle 1'
    })
    expect(receiverOf({ address: { line1: '' } }).address).toBeNull()
  })

  it('masks a tax id: a third of it at most, four characters at most', () => {
    expect(maskTaxId('0614-010101-101-1')).toBe(`${'*'.repeat(13)}01-1`)
    expect(maskTaxId('12345678-9')).toBe('*******8-9')
    expect(maskTaxId('12345')).toBe('****5')
    expect(maskTaxId('123')).toBe('**3')
    expect(maskTaxId('12')).toBe('**')
    expect(maskTaxId(null)).toBeNull()
  })
})

describe('a sale that adds up', () => {
  const line = (totalCents: number, taxCents: number) => ({
    description: 'x',
    quantity: 1,
    unitPriceCents: totalCents,
    taxRateBps: 1300,
    taxCents,
    totalCents
  })
  const sale = (over: Partial<ReturnType<typeof saleOf>> = {}) => ({
    lines: [line(2260, 260)],
    shippingCents: 565,
    shippingTaxCents: 65,
    discountCents: 0,
    pricesIncludeTax: true,
    totalCents: 2825,
    taxCents: 325,
    ...over
  })

  it('accepts the lines plus the shipping when the prices include the tax', () => {
    expect(saleAddsUp(sale())).toBe(true)
  })

  it('takes the discount off once, for the whole document', () => {
    expect(saleAddsUp(sale({ discountCents: 100, totalCents: 2725 }))).toBe(true)
    expect(saleAddsUp(sale({ discountCents: 100 }))).toBe(false)
  })

  it('adds the tax to the total when the prices did not include it', () => {
    expect(saleAddsUp(sale({ pricesIncludeTax: false, totalCents: 3150 }))).toBe(true)
    expect(saleAddsUp(sale({ pricesIncludeTax: false }))).toBe(false)
  })

  it('refuses a tax that is not the one of the lines and the shipping, and a total that is not theirs', () => {
    expect(saleAddsUp(sale({ taxCents: 326 }))).toBe(false)
    expect(saleAddsUp(sale({ shippingTaxCents: 0 }))).toBe(false)
    expect(saleAddsUp(sale({ totalCents: 2826 }))).toBe(false)
  })

  it('reads the parts of the snapshot, and reads a missing or odd one as nothing', () => {
    expect(
      saleOf(
        { totalCents: 10, taxCents: 1 },
        { lines: [line(10, 1)], shippingCents: 'x', discountCents: 1.5, pricesIncludeTax: false }
      )
    ).toEqual({
      lines: [line(10, 1)],
      shippingCents: 0,
      shippingTaxCents: 0,
      discountCents: 0,
      pricesIncludeTax: false,
      totalCents: 10,
      taxCents: 1
    })
    // An order made before the tax columns kept no flag: its prices are read as tax included
    expect(saleOf({ totalCents: 0, taxCents: 0 }, {}).pricesIncludeTax).toBe(true)
  })
})

describe('the issuer a document was made with', () => {
  const live = {
    legalName: 'Acme',
    taxId: 'T-1',
    registrationId: null,
    activityCode: null,
    establishmentCode: 'M001',
    environment: 'sandbox',
    address: { line1: 'x', city: 'y' }
  }
  const snapshot = { ...live, address: { city: 'y', line1: 'x' } }

  it('is the same when nothing of its identity moved, whatever the order of the address', () => {
    expect(sameIssuer(snapshot, live)).toBe(true)
  })

  it.each([
    ['the tax id', { taxId: 'T-2' }],
    ['the legal name', { legalName: 'Other' }],
    ['the registration', { registrationId: 'R-1' }],
    ['the establishment', { establishmentCode: 'M002' }],
    ['the environment', { environment: 'production' }],
    ['the address', { address: { line1: 'z', city: 'y' } }]
  ])('is not the same when %s changed', (_label, patch) => {
    expect(sameIssuer(snapshot, { ...live, ...patch })).toBe(false)
  })
})
