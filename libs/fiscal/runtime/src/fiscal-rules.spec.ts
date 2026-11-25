import {
  FiscalDocumentKind,
  FiscalDocumentStatus,
  FiscalEnvironment,
  FiscalLimits,
  FiscalOperationCondition,
  FiscalRejectionDeadlineState,
  FiscalRejectionReasons,
  FiscalRejectionRetry,
  PaymentMethod,
  PaymentStatus,
  TaxTreatment
} from '@platform/core/domain'

import {
  allowedActionsOf,
  canTransition,
  type CreditNoteOrder,
  creditNoteSaleOf,
  documentDetailOf,
  documentLines,
  fiscalDocumentUuid,
  fiscalSequenceKey,
  isImmutable,
  isStuck,
  operationConditionOf,
  paymentOfSnapshot,
  paymentsOf,
  maskedCustomerFiscalData,
  maskTaxId,
  originalStateOf,
  receiverEditable,
  receiverOf,
  receiverRecord,
  receiverWithFiscalData,
  rejectionDeadline,
  retryable,
  saleAddsUp,
  shippingTaxFits,
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
        taxCents: 230,
        taxTreatment: TaxTreatment.TAXED
      },
      {
        productName: 'Old order line',
        variantName: null,
        quantity: 1,
        unitPriceCents: 500,
        taxRateBps: null,
        taxCents: null,
        taxTreatment: null
      },
      {
        productName: 'Exempt line',
        variantName: null,
        quantity: 1,
        unitPriceCents: 700,
        taxRateBps: null,
        taxCents: 0,
        taxTreatment: TaxTreatment.EXEMPT
      },
      {
        productName: 'Partial snapshot',
        variantName: null,
        quantity: 1,
        unitPriceCents: 100,
        taxRateBps: 1300,
        taxCents: null,
        taxTreatment: TaxTreatment.TAXED
      }
    ])
    // A rate with no tax amount says no rate: never a rate beside a zero tax
    expect(lines[3]?.taxRateBps).toBeNull()
    expect(lines.slice(0, 3)).toEqual([
      {
        description: 'Shirt (M)',
        quantity: 2,
        unitPriceCents: 1000,
        taxRateBps: 1300,
        taxCents: 230,
        totalCents: 2000,
        taxTreatment: TaxTreatment.TAXED
      },
      {
        description: 'Old order line',
        quantity: 1,
        unitPriceCents: 500,
        taxRateBps: null,
        taxCents: 0,
        totalCents: 500,
        // An order that predates the snapshot has no treatment: core does not invent one
        taxTreatment: null
      },
      {
        description: 'Exempt line',
        quantity: 1,
        unitPriceCents: 700,
        taxRateBps: null,
        taxCents: 0,
        totalCents: 700,
        taxTreatment: TaxTreatment.EXEMPT
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
      phone: null,
      taxpayerType: null,
      economicActivity: null,
      documentType: null
    })
  })

  it('keeps the kind of identity document the way it keeps the other fields of the receiver', () => {
    const base = {
      name: null,
      taxId: '123',
      registrationId: null,
      address: null,
      email: null,
      phone: null
    }
    const record = receiverRecord({ ...base, documentType: ' passport ' })
    expect(record['documentType']).toBe('passport')
    expect(receiverOf(record).documentType).toBe('passport')
    expect(receiverRecord({ ...base, documentType: '  ' })['documentType']).toBeUndefined()
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
    totalCents,
    taxTreatment: TaxTreatment.TAXED
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

  it('says whether the tax of the shipping fits in the fee, and leaves the sum check alone', () => {
    // 2 x $11.30 with 13 % in the price and no shipping: the order says $3.10 of tax, the lines carry $2.60
    const noShipping = { shippingCents: 0, totalCents: 2260 }
    expect(shippingTaxFits(sale({ ...noShipping, shippingTaxCents: 0, taxCents: 260 }))).toBe(true)
    expect(shippingTaxFits(sale({ ...noShipping, shippingTaxCents: 50, taxCents: 310 }))).toBe(
      false
    )
    // never more than the fee, never negative; the whole fee is allowed
    expect(shippingTaxFits(sale({ shippingCents: 565, shippingTaxCents: 566 }))).toBe(false)
    expect(shippingTaxFits(sale({ shippingCents: 565, shippingTaxCents: 565 }))).toBe(true)
    expect(shippingTaxFits(sale({ shippingTaxCents: -5 }))).toBe(false)
    // a sealed document that was already sent keeps adding up as before: the sum check does not ask it
    expect(saleAddsUp(sale({ ...noShipping, shippingTaxCents: 50, taxCents: 310 }))).toBe(true)
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
    establishmentType: null,
    pointOfSaleCode: null,
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
    ['the address', { address: { line1: 'z', city: 'y' } }],
    ['the kind of establishment', { establishmentType: 'branch' }],
    ['the point of sale', { pointOfSaleCode: 'P001' }]
  ])('is not the same when %s changed', (_label, patch) => {
    expect(sameIssuer(snapshot, { ...live, ...patch })).toBe(false)
  })
})

describe('an issuer made before the contact and the point of sale existed', () => {
  // The snapshot of a document made before these fields have no key for them: that is the same issuer as one that has them empty, so
  // a document in flight is not refused as "issuer changed" by a deploy
  const live = {
    legalName: 'Acme',
    taxId: 'T-1',
    registrationId: null,
    activityCode: null,
    establishmentCode: null,
    establishmentType: null,
    pointOfSaleCode: null,
    environment: 'sandbox',
    address: {}
  }
  const old = {
    legalName: 'Acme',
    taxId: 'T-1',
    environment: 'sandbox',
    address: {}
  }

  it('is the same issuer as one that has them empty', () => {
    expect(sameIssuer(old, live)).toBe(true)
  })

  it('is another issuer once one of them is set', () => {
    expect(sameIssuer(old, { ...live, pointOfSaleCode: 'P001' })).toBe(false)
  })

  it('does not count the contact of the issuer as its identity: fixing a typo in it refuses no document in flight', () => {
    const withContact = { ...live, phone: '2222-0000', email: 'a@b.test' }
    expect(sameIssuer({ ...old, phone: 'old', email: 'old@b.test' }, withContact)).toBe(true)
  })
})

describe('the series of a correlative', () => {
  const base = {
    providerId: 'p',
    environment: FiscalEnvironment.SANDBOX,
    documentType: 'invoice',
    establishmentCode: 'M001',
    pointOfSaleCode: 'P001'
  }

  it('has no series of its own when the manifest declares no scope: the organization counts them all', () => {
    expect(fiscalSequenceKey(undefined, base)).toBeNull()
    expect(fiscalSequenceKey({}, base)).toBeNull()
    expect(
      fiscalSequenceKey(
        { perDocumentType: false, perEstablishment: false, perPointOfSale: false },
        base
      )
    ).toBeNull()
  })

  it('is one series for what the manifest declares and no more', () => {
    const byType = fiscalSequenceKey({ perDocumentType: true }, base)
    expect(byType).not.toBeNull()
    // The establishment and the point of sale are not part of this series: changing them does not move it
    expect(
      fiscalSequenceKey(
        { perDocumentType: true },
        { ...base, establishmentCode: 'M002', pointOfSaleCode: 'P009' }
      )
    ).toBe(byType)
    expect(
      fiscalSequenceKey({ perDocumentType: true }, { ...base, documentType: 'credit' })
    ).not.toBe(byType)
  })

  it.each([
    ['perDocumentType', { documentType: 'credit' }],
    ['perEstablishment', { establishmentCode: 'M002' }],
    ['perPointOfSale', { pointOfSaleCode: 'P009' }]
  ] as const)('moves with %s only when the manifest declares it', (flag, change) => {
    const declared = fiscalSequenceKey({ [flag]: true }, base)
    expect(fiscalSequenceKey({ [flag]: true }, { ...base, ...change })).not.toBe(declared)
  })

  it('never shares a series across providers or environments', () => {
    const scope = { perDocumentType: true }
    const key = fiscalSequenceKey(scope, base)
    expect(fiscalSequenceKey(scope, { ...base, providerId: 'q' })).not.toBe(key)
    expect(
      fiscalSequenceKey(scope, { ...base, environment: FiscalEnvironment.PRODUCTION })
    ).not.toBe(key)
  })

  it('cannot be confused by the parts of the key running into each other', () => {
    const scope = { perEstablishment: true, perPointOfSale: true }
    expect(
      fiscalSequenceKey(scope, { ...base, establishmentCode: 'a|b', pointOfSaleCode: 'c' })
    ).not.toBe(
      fiscalSequenceKey(scope, { ...base, establishmentCode: 'a', pointOfSaleCode: 'b|c' })
    )
    expect(
      fiscalSequenceKey(scope, { ...base, establishmentCode: null, pointOfSaleCode: 'x' })
    ).not.toBe(fiscalSequenceKey(scope, { ...base, establishmentCode: 'x', pointOfSaleCode: null }))
  })

  it('is short whatever the parts are, so it fits the column', () => {
    const key = fiscalSequenceKey(
      { perDocumentType: true, perEstablishment: true, perPointOfSale: true },
      { ...base, documentType: 'x'.repeat(500) }
    )
    expect(key?.length).toBeLessThanOrEqual(200)
  })
})

describe('the stable identifier of a document', () => {
  const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

  it('has the shape of a random UUID version 4', () => {
    expect(fiscalDocumentUuid('org-1', 'doc-1')).toMatch(V4)
  })

  it('is the same for the same document, whenever it is asked', () => {
    expect(fiscalDocumentUuid('org-1', 'doc-1')).toBe(fiscalDocumentUuid('org-1', 'doc-1'))
  })

  it('is another for another document or another organization', () => {
    const one = fiscalDocumentUuid('org-1', 'doc-1')
    expect(fiscalDocumentUuid('org-1', 'doc-2')).not.toBe(one)
    expect(fiscalDocumentUuid('org-2', 'doc-1')).not.toBe(one)
    // The pair is not a concatenation that two pairs could share
    expect(fiscalDocumentUuid('a', 'bc')).not.toBe(fiscalDocumentUuid('ab', 'c'))
  })
})

describe('how a sale was paid', () => {
  it('is one payment for the whole order, with the reference the person recorded', () => {
    expect(paymentsOf(PaymentMethod.TRANSFER, ' T-9 ', 5000)).toEqual([
      { method: PaymentMethod.TRANSFER, amountCents: 5000, reference: 'T-9' }
    ])
    expect(paymentsOf(PaymentMethod.CASH, null, 100)[0]?.reference).toBeNull()
    expect(paymentsOf(PaymentMethod.CARD, '  ', 100)[0]?.reference).toBeNull()
  })

  it('reads a payment that is completed as immediate and anything else as deferred', () => {
    expect(operationConditionOf(PaymentStatus.COMPLETED)).toBe(FiscalOperationCondition.IMMEDIATE)
    for (const status of [PaymentStatus.PENDING, PaymentStatus.FAILED, PaymentStatus.REFUNDED]) {
      expect(operationConditionOf(status)).toBe(FiscalOperationCondition.DEFERRED)
    }
    // A status core does not know is not paid
    expect(operationConditionOf('SOMETHING_ELSE')).toBe(FiscalOperationCondition.DEFERRED)
  })
})

describe('the payment a document kept', () => {
  it('is read from the snapshot: the method, the reference, and the condition from the status', () => {
    expect(
      paymentOfSnapshot(
        { paymentMethod: 'TRANSFER', paymentReference: 'T-1', paymentStatus: 'COMPLETED' },
        900
      )
    ).toEqual({
      payments: [{ method: PaymentMethod.TRANSFER, amountCents: 900, reference: 'T-1' }],
      condition: FiscalOperationCondition.IMMEDIATE
    })
  })

  it('carries no payment on a credit note: what it gives back is not a payment of its own', () => {
    const parts = { paymentMethod: 'CASH', paymentStatus: 'COMPLETED' }
    expect(paymentOfSnapshot(parts, 900, true).payments).toEqual([])
    expect(paymentOfSnapshot(parts, 900, true).condition).toBe(FiscalOperationCondition.IMMEDIATE)
  })

  it('says no payment, and not paid, for a snapshot that predates it or a method this version does not know', () => {
    const none = { payments: [], condition: FiscalOperationCondition.DEFERRED }
    expect(paymentOfSnapshot({}, 900)).toEqual(none)
    expect(
      paymentOfSnapshot({ paymentMethod: 'BITCOIN', paymentStatus: 'COMPLETED' }, 900).payments
    ).toEqual([])
  })
})

describe('the lines of a snapshot', () => {
  it('read a snapshot made before the tax treatment was kept as having none', () => {
    const sale = saleOf(
      { totalCents: 100, taxCents: 0 },
      {
        lines: [
          {
            description: 'old',
            quantity: 1,
            unitPriceCents: 100,
            taxRateBps: null,
            taxCents: 0,
            totalCents: 100
          },
          {
            description: 'new',
            quantity: 1,
            unitPriceCents: 100,
            taxRateBps: null,
            taxCents: 0,
            totalCents: 100,
            taxTreatment: 'exempt'
          },
          {
            description: 'odd',
            quantity: 1,
            unitPriceCents: 100,
            taxRateBps: null,
            taxCents: 0,
            totalCents: 100,
            taxTreatment: 'weird'
          }
        ]
      }
    )
    expect(sale.lines.map(line => line.taxTreatment)).toEqual([null, TaxTreatment.EXEMPT, null])
  })
})

describe('the credit note of a return', () => {
  // Two shirts at 11.30 and one hat at 5.65, 13% tax included, 2.00 off the order: the books split it line by line
  const order: CreditNoteOrder = {
    subtotalCents: 2825,
    discountCents: 200,
    shippingCents: 500,
    totalCents: 3125,
    taxCents: 322,
    pricesIncludeTax: true,
    lines: [
      {
        orderItemId: 'a',
        productName: 'Shirt',
        variantName: 'M',
        quantity: 2,
        unitPriceCents: 1130,
        taxRateBps: 1300,
        taxCents: 235,
        taxTreatment: TaxTreatment.TAXED
      },
      {
        orderItemId: 'b',
        productName: 'Hat',
        variantName: null,
        quantity: 1,
        unitPriceCents: 565,
        taxRateBps: 1300,
        taxCents: 59,
        taxTreatment: TaxTreatment.TAXED
      }
    ]
  }
  const back = (entries: [string, number][]): Map<string, number> => new Map(entries)

  it('adds up like the document of a sale, so the provider is never told an inconsistent one', () => {
    const result = creditNoteSaleOf(order, back([]), back([['a', 1]]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.sale.lines).toHaveLength(1)
    expect(result.sale.lines[0]).toMatchObject({
      description: 'Shirt (M)',
      quantity: 1,
      unitPriceCents: 1130
    })
    expect(result.sale.shippingCents).toBe(0)
    expect(saleAddsUp(result.sale)).toBe(true)
  })

  it('credits the whole sale of the goods, to the cent, once every unit has come back in pieces', () => {
    const first = creditNoteSaleOf(order, back([]), back([['a', 1]]))
    const second = creditNoteSaleOf(
      order,
      back([['a', 1]]),
      back([
        ['a', 1],
        ['b', 1]
      ])
    )
    if (!first.ok || !second.ok) throw new Error('fixture')
    expect(saleAddsUp(second.sale)).toBe(true)
    // What the goods brought in, after the discount and without the shipping fee
    expect(first.sale.totalCents + second.sale.totalCents).toBe(
      order.totalCents - order.shippingCents
    )
    // The tax of the lines (the order's own tax also has the shipping's, which is not credited)
    expect(first.sale.taxCents + second.sale.taxCents).toBe(235 + 59)
  })

  it('adds up when the prices did not include the tax', () => {
    const excluded: CreditNoteOrder = {
      ...order,
      pricesIncludeTax: false,
      totalCents: 3125 + 294
    }
    const result = creditNoteSaleOf(excluded, back([]), back([['b', 1]]))
    expect(result.ok).toBe(true)
    if (result.ok) expect(saleAddsUp(result.sale)).toBe(true)
  })

  it('refuses more units back than were sold, a unit that is not on the order, nothing back and an order with no tax snapshot', () => {
    expect(creditNoteSaleOf(order, back([['b', 1]]), back([['b', 1]])).ok).toBe(false)
    expect(creditNoteSaleOf(order, back([]), back([['zzz', 1]])).ok).toBe(false)
    expect(creditNoteSaleOf(order, back([]), back([])).ok).toBe(false)
    expect(creditNoteSaleOf({ ...order, taxCents: null }, back([]), back([['a', 1]])).ok).toBe(
      false
    )
  })
})

describe('the rounding of the books in a credit note', () => {
  // 2 units at 10.00, tax included: net 17.39 and tax 2.61 are odd, so the split is on what was paid (10.00 and 10.00), never 10.01 + 9.99
  const odd: CreditNoteOrder = {
    subtotalCents: 2000,
    discountCents: 0,
    shippingCents: 0,
    totalCents: 2000,
    taxCents: 261,
    pricesIncludeTax: true,
    lines: [
      {
        orderItemId: 'a',
        productName: 'Shirt',
        variantName: null,
        quantity: 2,
        unitPriceCents: 1000,
        taxRateBps: 1500,
        taxCents: 261,
        taxTreatment: TaxTreatment.TAXED
      }
    ]
  }

  it('credits a unit for what it was sold for, to the cent, and adds up', () => {
    const first = creditNoteSaleOf(odd, new Map(), new Map([['a', 1]]))
    const second = creditNoteSaleOf(odd, new Map([['a', 1]]), new Map([['a', 1]]))
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.sale.totalCents).toBe(1000)
    expect(first.sale.discountCents).toBe(0)
    expect(saleAddsUp(first.sale)).toBe(true)
    expect(saleAddsUp(second.sale)).toBe(true)
  })

  it('credits the whole sale across the notes of 2 returns of one unit, to the cent (HC-107)', () => {
    const first = creditNoteSaleOf(odd, new Map(), new Map([['a', 1]]))
    const second = creditNoteSaleOf(odd, new Map([['a', 1]]), new Map([['a', 1]]))
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.sale.totalCents + second.sale.totalCents).toBe(2000)
    expect(first.sale.taxCents + second.sale.taxCents).toBe(261)
    expect(first.sale.discountCents + second.sale.discountCents).toBe(0)
  })
})

describe('the original of a credit note', () => {
  it('is ready only when accepted, gone when voided and still on its way in any other state', () => {
    const S = FiscalDocumentStatus
    expect(originalStateOf(S.ACCEPTED)).toBe('ready')
    expect(originalStateOf(S.VOIDED)).toBe('voided')
    for (const status of [S.DRAFT, S.QUEUED, S.SUBMITTED, S.REJECTED]) {
      expect(originalStateOf(status)).toBe('waiting')
    }
  })
})

describe('the fiscal data of a customer', () => {
  const sale = {
    name: 'Contact Name',
    taxId: null,
    registrationId: null,
    address: { line1: 'Shipping street' },
    email: 'contact@example.com',
    phone: '+10000000000'
  }

  it('is the receiver of the document when there is none, and wins over the contact when there is', () => {
    expect(receiverWithFiscalData(sale, null)).toBe(sale)
    const merged = receiverWithFiscalData(sale, {
      name: 'Fiscal Name',
      taxId: 'T-1',
      registrationId: 'R-1',
      address: { line1: 'Fiscal street' },
      email: 'other@example.com',
      phone: '+19999999999',
      taxpayerType: 'company',
      economicActivity: 'retail'
    })
    expect(merged).toEqual({
      name: 'Fiscal Name',
      taxId: 'T-1',
      registrationId: 'R-1',
      address: { line1: 'Fiscal street' },
      // The contact stays the sale's: the fiscal record holds no email or phone
      email: 'contact@example.com',
      phone: '+10000000000',
      taxpayerType: 'company',
      economicActivity: 'retail',
      documentType: null
    })
  })

  it('leaves what the sale had where the fiscal data says nothing', () => {
    const merged = receiverWithFiscalData(sale, {
      name: null,
      taxId: 'T-1',
      registrationId: null,
      address: null,
      email: null,
      phone: null
    })
    expect(merged.name).toBe('Contact Name')
    expect(merged.address).toEqual({ line1: 'Shipping street' })
    expect(merged.taxpayerType).toBeNull()
    expect(merged.economicActivity).toBeNull()
  })

  it('keeps the kind of taxpayer and the activity in the sealed record and reads them back', () => {
    const record = receiverRecord({
      ...sale,
      taxpayerType: ' company ',
      economicActivity: ''
    })
    expect(record['taxpayerType']).toBe('company')
    expect('economicActivity' in record).toBe(false)
    expect(receiverOf(record).taxpayerType).toBe('company')
    expect(receiverOf(record).economicActivity).toBeNull()
  })

  it('is shown masked: the identifiers by their last characters, the address only as set or not', () => {
    const view = maskedCustomerFiscalData({
      ...sale,
      taxId: '0614-010101-101-1',
      registrationId: '123456-7',
      taxpayerType: 'company',
      economicActivity: 'retail'
    })
    expect(view).toEqual({
      name: 'Contact Name',
      taxId: `${'*'.repeat(13)}01-1`,
      registrationId: '******-7',
      taxpayerType: 'company',
      economicActivity: 'retail',
      documentType: null,
      addressSet: true
    })
    expect(JSON.stringify(view)).not.toContain('Shipping street')
    expect(maskedCustomerFiscalData({ ...sale, address: null }).addressSet).toBe(false)
  })
})

describe('the detail of a sealed document', () => {
  const doc = { totalCents: 4000, taxCents: 390 }
  const lines = [
    {
      description: 'A',
      quantity: 1,
      unitPriceCents: 1130,
      taxRateBps: 1300,
      taxCents: 130,
      totalCents: 1130
    },
    {
      description: 'B',
      quantity: 2,
      unitPriceCents: 1130,
      taxRateBps: 1300,
      taxCents: 260,
      totalCents: 2260
    },
    {
      description: 'C',
      quantity: 1,
      unitPriceCents: 500,
      taxRateBps: null,
      taxCents: 0,
      totalCents: 500
    }
  ]

  it('groups the tax by rate, with the base without the tax when the prices include it', () => {
    const detail = documentDetailOf(doc, { lines, pricesIncludeTax: true }, {})
    expect(detail.taxBreakdown).toEqual([
      { taxRateBps: null, baseCents: 500, taxCents: 0 },
      { taxRateBps: 1300, baseCents: 3000, taxCents: 390 }
    ])
    expect(documentDetailOf(doc, { lines, pricesIncludeTax: false }, {}).taxBreakdown[1]).toEqual({
      taxRateBps: 1300,
      baseCents: 3390,
      taxCents: 390
    })
  })

  it('says whether the sealed parts add up to the totals of the document', () => {
    // 1130 + 2260 + 500 = 3890; plus 110 of shipping with 0 tax: 4000, tax 390
    const sound = { lines, pricesIncludeTax: true, shippingCents: 110, shippingTaxCents: 0 }
    expect(documentDetailOf(doc, sound, {}).consistent).toBe(true)
    expect(documentDetailOf({ ...doc, taxCents: 391 }, sound, {}).consistent).toBe(false)
    expect(documentDetailOf(doc, { lines: 'x' }, {}).consistent).toBe(false)
  })

  it('copies fields by name: a credential or a provider field in a snapshot never reaches the view', () => {
    const detail = documentDetailOf(
      doc,
      { lines: [{ ...lines[0], providerData: 'raw' }], orderNumber: 'N-1', secret: 'x' },
      {
        legalName: 'Issuer',
        taxId: 'T',
        address: { line1: 'Street', nested: { a: 1 }, empty: '' },
        credentials: { signingKey: 'k' },
        environment: 'sandbox'
      }
    )
    const text = JSON.stringify(detail)
    for (const leaked of ['providerData', 'raw', 'secret', 'credentials', 'signingKey', 'nested']) {
      expect(text).not.toContain(leaked)
    }
    expect(detail.issuer.address).toEqual({ line1: 'Street' })
    expect(detail.orderNumber).toBe('N-1')
  })

  it('reads a snapshot that is empty or malformed as an empty detail, never a crash', () => {
    for (const bad of [null, 'text', 7, [], { lines: 'x' }]) {
      const detail = documentDetailOf(doc, bad, bad)
      expect(detail.lines).toEqual([])
      expect(detail.taxBreakdown).toEqual([])
      expect(detail.issuer.legalName).toBe('')
    }
    const odd = documentDetailOf(doc, { lines: [null, { quantity: 'many', taxRateBps: 1.5 }] }, {})
    expect(odd.lines[1]).toMatchObject({ quantity: 0, taxRateBps: null, description: '' })
  })
})

describe('what a person may do with a document', () => {
  const base = {
    kind: FiscalDocumentKind.SALE,
    status: FiscalDocumentStatus.ACCEPTED,
    attempts: 1,
    rejectionReason: null,
    replacedByDocumentId: null
  }
  const none = {
    editReceiver: false,
    retry: false,
    void: false,
    replace: false,
    confirmIssuerChange: false
  }

  it('says a document is stuck only when it is queued with every attempt spent', () => {
    const max = FiscalLimits.MAX_ATTEMPTS
    expect(isStuck(FiscalDocumentStatus.QUEUED, max)).toBe(true)
    expect(isStuck(FiscalDocumentStatus.QUEUED, max - 1)).toBe(false)
    expect(isStuck(FiscalDocumentStatus.REJECTED, max)).toBe(false)
    expect(isStuck(FiscalDocumentStatus.ACCEPTED, max)).toBe(false)
  })

  it('lets an accepted document be voided and nothing else', () => {
    expect(allowedActionsOf(base)).toEqual({ ...none, void: true })
  })

  it('lets a refused sale document be fixed and sent again, and the issuer change be confirmed only after an attempt', () => {
    const refused = { ...base, status: FiscalDocumentStatus.REJECTED, attempts: 2 }
    expect(allowedActionsOf(refused)).toEqual({ ...none, editReceiver: true, retry: true })
    expect(
      allowedActionsOf({ ...refused, rejectionReason: FiscalRejectionReasons.ISSUER_CHANGED })
    ).toMatchObject({ confirmIssuerChange: true })
    expect(
      allowedActionsOf({
        ...refused,
        attempts: 0,
        rejectionReason: FiscalRejectionReasons.ISSUER_CHANGED
      })
    ).toMatchObject({ confirmIssuerChange: false })
  })

  it('keeps the receiver of a credit note and of a queued document that was already sent', () => {
    const queued = { ...base, status: FiscalDocumentStatus.QUEUED }
    expect(allowedActionsOf({ ...queued, attempts: 0 })).toMatchObject({
      editReceiver: true,
      retry: true
    })
    expect(allowedActionsOf({ ...queued, attempts: 3 })).toMatchObject({
      editReceiver: false,
      retry: true
    })
    expect(
      allowedActionsOf({
        ...queued,
        attempts: 0,
        kind: FiscalDocumentKind.CREDIT_NOTE
      }).editReceiver
    ).toBe(false)
  })

  it('lets a voided sale document be replaced once, and a voided credit note be replaced', () => {
    const voided = { ...base, status: FiscalDocumentStatus.VOIDED }
    expect(allowedActionsOf(voided).replace).toBe(true)
    expect(allowedActionsOf({ ...voided, replacedByDocumentId: 'd2' }).replace).toBe(false)
    expect(
      allowedActionsOf({
        ...voided,
        kind: FiscalDocumentKind.CREDIT_NOTE,
        replacedByDocumentId: 'd2'
      }).replace
    ).toBe(true)
    expect(allowedActionsOf({ ...base, replacedByDocumentId: 'd2' }).replace).toBe(false)
  })
})

describe('the window to send again a document the authority refused', () => {
  const rejectedAt = new Date('2027-02-01T10:00:00.000Z')
  const after = (ms: number): Date => new Date(rejectedAt.getTime() + ms)

  it('has none for a document the authority did not refuse', () => {
    expect(rejectionDeadline(null, rejectedAt)).toBeNull()
  })

  it('ends 24 hours after the refusal was communicated', () => {
    const deadline = rejectionDeadline(rejectedAt, rejectedAt)
    expect(FiscalRejectionRetry.WINDOW_MS).toBe(24 * 60 * 60 * 1000)
    expect(deadline?.endsAt.toISOString()).toBe('2027-02-02T10:00:00.000Z')
    expect(deadline?.state).toBe(FiscalRejectionDeadlineState.OPEN)
  })

  it('is open until the closing stretch, closing inside it and expired from the end', () => {
    const closing = FiscalRejectionRetry.WINDOW_MS - FiscalRejectionRetry.WARN_BEFORE_MS
    expect(rejectionDeadline(rejectedAt, after(closing - 1))?.state).toBe(
      FiscalRejectionDeadlineState.OPEN
    )
    expect(rejectionDeadline(rejectedAt, after(closing))?.state).toBe(
      FiscalRejectionDeadlineState.CLOSING
    )
    expect(rejectionDeadline(rejectedAt, after(FiscalRejectionRetry.WINDOW_MS - 1))?.state).toBe(
      FiscalRejectionDeadlineState.CLOSING
    )
    expect(rejectionDeadline(rejectedAt, after(FiscalRejectionRetry.WINDOW_MS))?.state).toBe(
      FiscalRejectionDeadlineState.EXPIRED
    )
  })
})
