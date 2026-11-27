import {
  FiscalDocumentKind,
  FiscalEnvironment,
  FiscalOperationCondition,
  PaymentMethod,
  TaxTreatment
} from '@platform/core/domain'

import { buildDocument, resolveDocumentType } from './sv-build'
import { SvBuildError, SvBuildErrors, SvDocumentTypes, SvProviderDataKeys } from './sv-constants'
import {
  BUSINESS,
  CONSUMER,
  credited,
  ISSUER,
  line,
  purchase,
  SELLER,
  sale,
  schemaErrors
} from './testing/sv-fixtures'

type Section = Record<string, unknown>
// The parts of a document the specs read: every figure is read with `toMatchObject` or `toBe`, so a section is a record of unknowns
interface Payload {
  identificacion: Section
  emisor: Section
  receptor: Section | null
  documentoRelacionado: Section[] | null
  cuerpoDocumento: Section[]
  resumen: Section & { pagos: Section[] }
}

const build = (input: ReturnType<typeof sale>) => buildDocument(input)
const payloadOf = (input: ReturnType<typeof sale>): Payload =>
  build(input).payload as unknown as Payload
const refused = (input: ReturnType<typeof sale>): string => {
  try {
    buildDocument(input)
  } catch (error) {
    return error instanceof SvBuildError ? error.code : 'other'
  }
  return 'built'
}

// 3 units at $3.33 with 13 % inside: the books split the $1.15 of tax of the three as 38, 39 and 38 cents, one unit back at a time
const creditNote = (over: Partial<ReturnType<typeof sale>> = {}) =>
  sale({
    kind: FiscalDocumentKind.CREDIT_NOTE,
    credited: credited(),
    receiver: BUSINESS,
    lines: [
      line({
        description: 'Gorra',
        quantity: 1,
        unitPriceCents: 333,
        totalCents: 333,
        taxCents: 38
      })
    ],
    shippingCents: 0,
    shippingTaxCents: 0,
    totalCents: 333,
    taxCents: 38,
    payments: [],
    ...over
  })

// The debit note charges more on a tax credit document: the same shape as the credit note, an amount that adds instead of cancelling
const debitNote = (over: Partial<ReturnType<typeof sale>> = {}) =>
  creditNote({ kind: FiscalDocumentKind.DEBIT_NOTE, ...over })

// The remission note backs the goods on their way before the sale document exists: the lines of the order, no document it names, and a
// receiver identified the way a note is (any identity document), with an economic activity and an address, but no registration number
const remissionNote = (over: Partial<ReturnType<typeof sale>> = {}) =>
  sale({
    kind: FiscalDocumentKind.REMISSION_NOTE,
    receiver: { ...CONSUMER, ...DELIVERY_RECEIVER },
    ...over
  })

const DELIVERY_RECEIVER = {
  name: 'Ana Pérez',
  taxId: '012345678',
  address: { department: '06', municipality: '20', district: '02', complement: 'Avenida 2' },
  economicActivity: '47119',
  email: 'ana@example.test',
  phone: '7777-0001'
}

describe('the check against the schema of the authority', () => {
  it('is a real check: a document with a figure of three decimals, a missing field or an extra one is refused', () => {
    const good = payloadOf(sale())
    expect(schemaErrors('01', good)).toEqual([])
    expect(schemaErrors('01', {})).not.toEqual([])
    expect(schemaErrors('01', { ...good, extra: 1 })).not.toEqual([])
    const bad = JSON.parse(JSON.stringify(good)) as unknown as Payload
    bad['resumen'].totalPagar = 28.255
    expect(schemaErrors('01', bad)).not.toEqual([])
    const broken = JSON.parse(JSON.stringify(good)) as unknown as Payload
    delete broken['emisor'].codEstable
    expect(schemaErrors('01', broken)).not.toEqual([])
  })
})

describe('which document a sale is', () => {
  it('is an invoice for anyone with no registration number, and a tax credit document for a taxpayer', () => {
    expect(resolveDocumentType({ kind: FiscalDocumentKind.SALE, receiver: CONSUMER })).toBe('01')
    expect(
      resolveDocumentType({
        kind: FiscalDocumentKind.SALE,
        receiver: { ...CONSUMER, taxId: '06140202021023' }
      })
    ).toBe('01')
    expect(resolveDocumentType({ kind: FiscalDocumentKind.SALE, receiver: BUSINESS })).toBe('03')
  })

  it('is a credit note for the credit note of a return, whoever the receiver is', () => {
    expect(resolveDocumentType({ kind: FiscalDocumentKind.CREDIT_NOTE, receiver: CONSUMER })).toBe(
      '05'
    )
  })

  it('is a debit note for the debit note of a charge, whoever the receiver is', () => {
    expect(resolveDocumentType({ kind: FiscalDocumentKind.DEBIT_NOTE, receiver: CONSUMER })).toBe(
      '06'
    )
  })

  it('is a remission note for the remission note of a dispatch, whoever the receiver is', () => {
    expect(
      resolveDocumentType({ kind: FiscalDocumentKind.REMISSION_NOTE, receiver: CONSUMER })
    ).toBe('04')
  })

  it('is the type build puts in the document', () => {
    for (const input of [
      sale(),
      sale({ receiver: BUSINESS }),
      creditNote(),
      debitNote(),
      remissionNote()
    ]) {
      expect(build(input).documentType).toBe(
        resolveDocumentType({ kind: input.kind, receiver: input.receiver })
      )
    }
  })
})

describe('the invoice to a final consumer (01)', () => {
  it('is a document the schema of the authority accepts, with the figures of the order', () => {
    const built = build(sale())
    expect(built.documentType).toBe('01')
    expect(schemaErrors('01', built.payload)).toEqual([])
    const p = built.payload as unknown as Payload
    // The tax is inside the price: $22.60 of shirts and $5.65 of shipping are $28.25 of taxed sales, with $3.25 of tax
    expect(p['resumen']).toMatchObject({
      totalGravada: 28.25,
      totalExenta: 0,
      totalNoSuj: 0,
      subTotalVentas: 28.25,
      montoTotalOperacion: 28.25,
      totalPagar: 28.25,
      totalIva: 3.25,
      totalLetras: 'VEINTIOCHO 25/100 DÓLARES',
      condicionOperacion: 1
    })
    expect(p['cuerpoDocumento']).toHaveLength(2)
    expect(p['cuerpoDocumento'][0]).toMatchObject({
      cantidad: 2,
      precioUni: 11.3,
      ventaGravada: 22.6,
      ivaItem: 2.6
    })
    // The shipping fee is a service of its own, taxed
    expect(p['cuerpoDocumento'][1]).toMatchObject({ tipoItem: 2, cantidad: 1, ventaGravada: 5.65 })
  })

  it('numbers it from the series of its type and the codes of the issuer, with the identifier of the document in capitals', () => {
    const id = payloadOf(sale())['identificacion']
    expect(id).toMatchObject({
      version: 2,
      ambiente: '00',
      tipoDte: '01',
      numeroControl: 'DTE-01-M001P001-000000000000041',
      codigoGeneracion: '1B9D6BCD-BBFD-4B2D-9B5D-AB8DFBBD4BED',
      tipoModelo: 1,
      tipoOperacion: 1,
      tipoMoneda: 'USD'
    })
  })

  it('dates it in the time of El Salvador, six hours behind UTC', () => {
    // 03:30:15 UTC of the 17th is 21:30:15 of the 16th there
    expect(payloadOf(sale())['identificacion']).toMatchObject({
      fecEmi: '2026-11-16',
      horEmi: '21:30:15'
    })
  })

  it('has no receiver when the order says nothing about the customer, and names only what it says otherwise', () => {
    expect(payloadOf(sale())['receptor']).toBeNull()
    const named = build(sale({ receiver: { ...CONSUMER, name: 'Ana Pérez' } }))
    expect(schemaErrors('01', named.payload)).toEqual([])
    expect((named.payload as unknown as Payload)['receptor']).toMatchObject({
      nombre: 'Ana Pérez',
      tipoDocumento: null,
      numDocumento: null,
      nrc: null
    })
    // An identity document typed by the customer goes with its kind: nine digits are a national id
    const withId = build(sale({ receiver: { ...CONSUMER, name: 'Ana', taxId: '01234567-8' } }))
    expect(schemaErrors('01', withId.payload)).toEqual([])
    expect((withId.payload as unknown as Payload)['receptor']).toMatchObject({
      tipoDocumento: '13',
      numDocumento: '012345678'
    })
  })

  it('spreads the discount of the order over the items, and the total is still what was charged', () => {
    // $1.00 off the $22.60 of shirts: the tax (inside) goes from $2.60 to $2.55 and the order is $27.25
    const input = sale({
      discountCents: 100,
      lines: [line({ taxCents: 249 })],
      totalCents: 2725,
      taxCents: 314
    })
    const built = build(input)
    expect(schemaErrors('01', built.payload)).toEqual([])
    const p = built.payload as unknown as Payload
    expect(p['cuerpoDocumento'][0]).toMatchObject({ montoDescu: 1, ventaGravada: 21.6 })
    expect(p['resumen']).toMatchObject({
      totalDescu: 1,
      totalGravada: 27.25,
      totalPagar: 27.25,
      totalIva: 3.14
    })
  })

  it('keeps the exempt and the not subject sales apart from the taxed ones, with no tax on them', () => {
    const input = sale({
      lines: [
        line(),
        line({
          description: 'Libro',
          quantity: 1,
          unitPriceCents: 1000,
          totalCents: 1000,
          taxRateBps: null,
          taxCents: 0,
          taxTreatment: TaxTreatment.EXEMPT
        }),
        line({
          description: 'Servicio',
          quantity: 1,
          unitPriceCents: 500,
          totalCents: 500,
          taxRateBps: null,
          taxCents: 0,
          taxTreatment: TaxTreatment.NOT_SUBJECT
        })
      ],
      totalCents: 4325,
      taxCents: 325
    })
    const built = build(input)
    expect(schemaErrors('01', built.payload)).toEqual([])
    expect((built.payload as unknown as Payload)['resumen']).toMatchObject({
      totalGravada: 28.25,
      totalExenta: 10,
      totalNoSuj: 5,
      subTotalVentas: 43.25,
      totalPagar: 43.25,
      totalIva: 3.25
    })
  })

  it('carries a shipping fee with no tax as an exempt service', () => {
    const built = build(
      sale({ shippingTaxCents: 0, taxCents: 260, totalCents: 2825, lines: [line()] })
    )
    expect(schemaErrors('01', built.payload)).toEqual([])
    expect((built.payload as unknown as Payload)['cuerpoDocumento'][1]).toMatchObject({
      ventaExenta: 5.65,
      ventaGravada: 0
    })
  })

  it('says how it was paid: the form of the authority, the reference, and a sale on credit when the payment is not completed', () => {
    const paid = (build(sale()).payload as unknown as Payload)['resumen']
    expect(paid.pagos).toEqual([
      { codigo: '05', montoPago: 28.25, referencia: 'TRF-1', plazo: null, periodo: null }
    ])
    const owed = build(
      sale({
        condition: FiscalOperationCondition.DEFERRED,
        payments: [{ method: PaymentMethod.CASH_ON_DELIVERY, amountCents: 2825, reference: null }]
      })
    )
    expect(schemaErrors('01', owed.payload)).toEqual([])
    const resumen = (owed.payload as unknown as Payload)['resumen']
    expect(resumen.condicionOperacion).toBe(2)
    // Condition 2 (Anexo IV, 160.5, 161.6 and 162.5): no form, $0.00 and no reference; the term is what stays required
    expect(resumen.pagos).toEqual([
      { codigo: null, montoPago: 0, referencia: null, plazo: '01', periodo: 1 }
    ])
  })

  it('reads an order with no recorded payment as paid in cash', () => {
    const resumen = (build(sale({ payments: [] })).payload as unknown as Payload)['resumen']
    expect(resumen.pagos[0]).toMatchObject({ codigo: '01', montoPago: 28.25 })
  })

  it('is refused for an order whose prices do not include the tax: the consumer pays the tax inside the price', () => {
    expect(refused(sale({ pricesIncludeTax: false, totalCents: 3150, taxCents: 325 }))).toBe(
      SvBuildErrors.PRICES_EXCLUDE_TAX_FOR_INVOICE
    )
  })
})

describe('the tax credit document to a taxpayer (03)', () => {
  it('is a document the schema accepts, with net prices and the tax apart', () => {
    const built = build(sale({ receiver: BUSINESS }))
    expect(built.documentType).toBe('03')
    expect(schemaErrors('03', built.payload)).toEqual([])
    const p = built.payload as unknown as Payload
    expect(p['identificacion']).toMatchObject({
      version: 4,
      tipoDte: '03',
      numeroControl: 'DTE-03-M001P001-000000000000041'
    })
    // $28.25 with the tax inside: $3.25 of tax (the books) and $25.00 of sales (28.25 - 3.25)
    expect(p['resumen']).toMatchObject({
      totalGravada: 25,
      subTotalVentas: 25,
      subTotal: 25,
      montoTotalOperacion: 28.25,
      totalPagar: 28.25
    })
    expect(p['resumen'].tributos).toEqual([
      { codigo: '20', descripcion: 'Impuesto al Valor Agregado 13%', valor: 3.25 }
    ])
    expect(p['cuerpoDocumento'][0]).toMatchObject({
      cantidad: 2,
      tributos: ['20'],
      ventaGravada: 20.0
    })
    expect(p['receptor']).toMatchObject({
      nit: '06140202021023',
      nrc: '7654321',
      nombre: 'Cliente Contribuyente S.A.'
    })
    expect(p['emisor']).toMatchObject({
      nit: '06140101011011',
      nrc: '1234567',
      codEstable: 'M001',
      codPuntoVenta: 'P001'
    })
  })

  it('takes net prices as they are when the order does not include the tax, and adds the tax on top', () => {
    // $22.60 + $5.00 of shipping, net: the tax of the books is 294 + 65 = 359 cents (the formula says 358.8), total $31.19
    const input = sale({
      receiver: BUSINESS,
      pricesIncludeTax: false,
      lines: [line({ taxCents: 294 })],
      shippingCents: 500,
      shippingTaxCents: 65,
      totalCents: 3119,
      taxCents: 359
    })
    const built = build(input)
    expect(schemaErrors('03', built.payload)).toEqual([])
    const p = built.payload as unknown as Payload
    expect(p['resumen']).toMatchObject({
      totalGravada: 27.6,
      montoTotalOperacion: 31.19,
      totalPagar: 31.19
    })
    expect(p['cuerpoDocumento'][0]).toMatchObject({ precioUni: 11.3, ventaGravada: 22.6 })
  })

  it('puts the discount of the order in the items, never making one negative', () => {
    const input = sale({
      receiver: BUSINESS,
      discountCents: 100,
      lines: [line({ taxCents: 249 })],
      totalCents: 2725,
      taxCents: 314
    })
    const built = build(input)
    expect(schemaErrors('03', built.payload)).toEqual([])
    const body = (built.payload as unknown as Payload)['cuerpoDocumento']
    for (const item of body) expect(item.montoDescu).toBeGreaterThanOrEqual(0)
    // $1.00 off the shirts ($22.60): $20.00 net before, $19.11 net after (21.60 - 2.49 of tax), so $0.89 of discount net of the tax
    expect(body[0]).toMatchObject({ precioUni: 10, ventaGravada: 19.11, montoDescu: 0.89 })
    expect((built.payload as unknown as Payload)['resumen'].montoTotalOperacion).toBe(27.25)
  })

  it('has no tax and no breakdown for a sale of exempt goods only', () => {
    const input = sale({
      receiver: BUSINESS,
      lines: [
        line({
          description: 'Libro',
          quantity: 1,
          unitPriceCents: 1000,
          totalCents: 1000,
          taxRateBps: null,
          taxCents: 0,
          taxTreatment: TaxTreatment.EXEMPT
        })
      ],
      shippingCents: 0,
      shippingTaxCents: 0,
      totalCents: 1000,
      taxCents: 0
    })
    const built = build(input)
    expect(schemaErrors('03', built.payload)).toEqual([])
    expect((built.payload as unknown as Payload)['resumen']).toMatchObject({
      totalExenta: 10,
      totalGravada: 0,
      tributos: null,
      montoTotalOperacion: 10
    })
  })

  it('returns what the receiver lacks, with nothing to send, when it is not a taxpayer fully identified', () => {
    const built = build(
      sale({ receiver: { ...BUSINESS, economicActivity: null, address: null, name: ' ' } })
    )
    expect(built.missingReceiverFields).toEqual(['name', 'economicActivity', 'address'])
    expect(built.payload).toEqual({})
  })
})

describe('the credit note (05)', () => {
  it('is a document the schema accepts, naming the document it cancels in the relation and in the item', () => {
    const built = build(creditNote())
    expect(built.documentType).toBe('05')
    expect(schemaErrors('05', built.payload)).toEqual([])
    const p = built.payload as unknown as Payload
    expect(p['identificacion']).toMatchObject({
      version: 4,
      tipoDte: '05',
      numeroControl: 'DTE-05-M001P001-000000000000041'
    })
    expect(p['documentoRelacionado']).toEqual([
      {
        tipoDocumento: '03',
        tipoGeneracion: 2,
        numeroDocumento: 'AC54E9DB-79C5-42CE-B430-EC552C97EFBA',
        fechaEmision: '2026-11-16'
      }
    ])
    expect(p['cuerpoDocumento'][0]?.numeroDocumento).toBe('AC54E9DB-79C5-42CE-B430-EC552C97EFBA')
    expect(p['emisor']).not.toHaveProperty('codEstable')
    expect(p['receptor']).toMatchObject({ tipoDocumento: '36', numDocumento: '06140202021023' })
  })

  it('credits one unit at a time with the shares of the books: 38, 39 and 38 cents of the 115 of three units', () => {
    const units = [
      { tax: 38, net: 295 },
      { tax: 39, net: 294 },
      { tax: 38, net: 295 }
    ]
    for (const unit of units) {
      const built = build(
        creditNote({
          lines: [
            line({
              description: 'Gorra',
              quantity: 1,
              unitPriceCents: 333,
              totalCents: 333,
              taxCents: unit.tax
            })
          ],
          taxCents: unit.tax
        })
      )
      expect(schemaErrors('05', built.payload)).toEqual([])
      const resumen = (built.payload as unknown as Payload)['resumen']
      expect(resumen).toMatchObject({
        totalGravada: unit.net / 100,
        totalIva: unit.tax / 100,
        montoTotalOperacion: 3.33,
        totalPagar: 3.33
      })
      expect(resumen.tributos).toEqual([expect.objectContaining({ valor: unit.tax / 100 })])
    }
    // The three together: the same $9.99, $1.15 of tax
    const all = build(
      creditNote({
        lines: [
          line({
            description: 'Gorra',
            quantity: 3,
            unitPriceCents: 333,
            totalCents: 999,
            taxCents: 115
          })
        ],
        totalCents: 999,
        taxCents: 115
      })
    )
    expect(schemaErrors('05', all.payload)).toEqual([])
    expect((all.payload as unknown as Payload)['resumen']).toMatchObject({
      totalGravada: 8.84,
      totalIva: 1.15,
      totalPagar: 9.99
    })
  })

  it('carries the discount of the sale in the items, as the manual asks of a credit note', () => {
    const built = build(
      creditNote({
        discountCents: 33,
        totalCents: 300,
        taxCents: 35,
        lines: [
          line({
            description: 'Gorra',
            quantity: 1,
            unitPriceCents: 333,
            totalCents: 333,
            taxCents: 35
          })
        ]
      })
    )
    expect(schemaErrors('05', built.payload)).toEqual([])
    expect((built.payload as unknown as Payload)['cuerpoDocumento'][0]?.montoDescu).toBeGreaterThan(
      0
    )
  })

  it('carries no payment: what it gives back is not a payment', () => {
    expect((build(creditNote()).payload as unknown as Payload)['resumen']).not.toHaveProperty(
      'pagos'
    )
  })

  it('refuses to credit an invoice to a final consumer until the accountant says it may be done', () => {
    expect(refused(creditNote({ credited: { ...credited(), documentType: '01' } }))).toBe(
      SvBuildErrors.CREDITED_DOCUMENT_NOT_CREDITABLE
    )
  })

  it('refuses a credit note whose original has no generation code, and one that names no original', () => {
    expect(
      refused(
        creditNote({ credited: credited({ [SvProviderDataKeys.GENERATION_CODE]: undefined }) })
      )
    ).toBe(SvBuildErrors.CREDITED_DOCUMENT_UNKNOWN)
    expect(refused(creditNote({ credited: null }))).toBe(SvBuildErrors.CREDITED_DOCUMENT_UNKNOWN)
  })

  it('names the original by the date it was generated with, and refuses one whose date was not kept', () => {
    const kept = (
      build(creditNote({ credited: credited({ [SvProviderDataKeys.ISSUE_DATE]: '2026-11-15' }) }))
        .payload as unknown as Payload
    )['documentoRelacionado']?.[0]
    expect(kept?.fechaEmision).toBe('2026-11-15')
    // The instant of the acceptance is another day when a document is sent the day after: never a substitute
    expect(
      refused(creditNote({ credited: credited({ [SvProviderDataKeys.ISSUE_DATE]: undefined }) }))
    ).toBe(SvBuildErrors.CREDITED_DOCUMENT_UNKNOWN)
  })

  it('writes the generation code of the original in capitals, however it was kept', () => {
    const related = (
      build(
        creditNote({
          credited: credited({
            [SvProviderDataKeys.GENERATION_CODE]: 'ac54e9db-79c5-42ce-b430-ec552c97efba'
          })
        })
      ).payload as unknown as Payload
    )['documentoRelacionado']?.[0]
    expect(related?.numeroDocumento).toBe('AC54E9DB-79C5-42CE-B430-EC552C97EFBA')
  })
})

describe('details the authority would refuse after the number is spent', () => {
  it('shows no discount on an item that had none, even when the tax of the order rounds', () => {
    // $11.00 with the tax inside: the books say 127 cents of tax, the formula 126.55, and neither is a discount
    const input = sale({
      receiver: BUSINESS,
      lines: [line({ quantity: 1, unitPriceCents: 1100, totalCents: 1100, taxCents: 127 })],
      shippingCents: 0,
      shippingTaxCents: 0,
      totalCents: 1100,
      taxCents: 127
    })
    const built = build(input)
    expect(schemaErrors('03', built.payload)).toEqual([])
    const p = built.payload as unknown as Payload
    expect(p['cuerpoDocumento'][0]?.montoDescu).toBe(0)
    expect(p['resumen']['totalDescu']).toBe(0)
  })

  it('cuts a long payment reference to the 50 characters of the schema, and sends none for blanks', () => {
    const long = build(
      sale({
        payments: [{ method: PaymentMethod.TRANSFER, amountCents: 2825, reference: 'R'.repeat(80) }]
      })
    )
    expect(schemaErrors('01', long.payload)).toEqual([])
    expect(
      ((long.payload as unknown as Payload)['resumen'].pagos[0]?.referencia as string).length
    ).toBe(50)
    const blank = build(
      sale({ payments: [{ method: PaymentMethod.TRANSFER, amountCents: 2825, reference: '   ' }] })
    )
    expect((blank.payload as unknown as Payload)['resumen'].pagos[0]?.referencia).toBeNull()
  })

  it('does not put a passport in the tax number of a tax credit document: it asks for the number', () => {
    const built = build(sale({ receiver: { ...BUSINESS, taxId: 'AB123456', documentType: '03' } }))
    expect(built.missingReceiverFields).toEqual(['taxId'])
    expect(built.payload).toEqual({})
  })

  it.each([
    ['no units', { lines: [line({ quantity: 0 })] }],
    ['half a unit', { lines: [line({ quantity: 0.5 })] }]
  ])('refuses a line with %s with a code of its own', (_label, over) => {
    expect(refused(sale(over as Partial<ReturnType<typeof sale>>))).toBe(
      SvBuildErrors.QUANTITY_INVALID
    )
  })

  it('refuses a negative amount in a line', () => {
    expect(refused(sale({ lines: [line({ totalCents: -1 })] }))).toBe(
      SvBuildErrors.SALE_TOTALS_MISMATCH
    )
  })
})

describe('what the authority refuses by schema', () => {
  it('sends no contact that is not valid: an email of three characters never blocks the invoice', () => {
    const built = build(
      sale({ receiver: { ...CONSUMER, name: 'Ana', email: 'a@b.c', phone: '123' } })
    )
    expect(schemaErrors('01', built.payload)).toEqual([])
    expect((built.payload as unknown as Payload)['receptor']).toMatchObject({
      correo: null,
      telefono: null
    })
    const good = build(
      sale({
        receiver: { ...CONSUMER, name: 'Ana', email: 'ana@example.test', phone: '7777-0000' }
      })
    )
    expect((good.payload as unknown as Payload)['receptor']).toMatchObject({
      correo: 'ana@example.test',
      telefono: '7777-0000'
    })
  })

  it('refuses an item with no description, and an item whose tax is more than what it was sold for', () => {
    expect(refused(sale({ lines: [line({ description: '   ' })] }))).toBe(
      SvBuildErrors.ITEM_DESCRIPTION_EMPTY
    )
    // 100 cents of tax in an item sold for 50, with a shipping fee that takes up the difference of the totals
    expect(
      refused(
        sale({
          lines: [line({ quantity: 1, unitPriceCents: 50, totalCents: 50, taxCents: 100 })],
          shippingCents: 0,
          shippingTaxCents: 0,
          totalCents: 50,
          taxCents: 100
        })
      )
    ).toBe(SvBuildErrors.SALE_TOTALS_MISMATCH)
  })

  it('refuses a credit note whose original date is not a date', () => {
    for (const issued of ['2026-11-16T15:00:00.000Z', '16/11/2026', ' 2026-11-16']) {
      expect(
        refused(creditNote({ credited: credited({ [SvProviderDataKeys.ISSUE_DATE]: issued }) }))
      ).toBe(SvBuildErrors.CREDITED_DOCUMENT_UNKNOWN)
    }
  })
})

describe('how it is paid', () => {
  it('refuses payments that do not add up to the total, and takes several that do', () => {
    expect(
      refused(
        sale({ payments: [{ method: PaymentMethod.CASH, amountCents: 2800, reference: null }] })
      )
    ).toBe(SvBuildErrors.SALE_TOTALS_MISMATCH)
    const split = build(
      sale({
        payments: [
          { method: PaymentMethod.CASH, amountCents: 1000, reference: null },
          { method: PaymentMethod.CARD, amountCents: 1825, reference: 'AUTH-9' }
        ]
      })
    )
    expect(schemaErrors('01', split.payload)).toEqual([])
    expect(
      (split.payload as unknown as Payload)['resumen'].pagos.map(pago => pago['codigo'])
    ).toEqual(['01', '03'])
  })

  it('says a sale on credit in a tax credit document too, with its term', () => {
    const built = build(sale({ receiver: BUSINESS, condition: FiscalOperationCondition.DEFERRED }))
    expect(schemaErrors('03', built.payload)).toEqual([])
    const resumen = (built.payload as unknown as Payload)['resumen']
    expect(resumen['condicionOperacion']).toBe(2)
    expect(resumen.pagos).toEqual([
      { codigo: null, montoPago: 0, referencia: null, plazo: '01', periodo: 1 }
    ])
  })

  it('says cash, whatever the order says, when there is nothing to pay (Anexo IV, 159.2)', () => {
    const free = sale({
      lines: [line({ unitPriceCents: 0, totalCents: 0, taxCents: 0 })],
      shippingCents: 0,
      shippingTaxCents: 0,
      totalCents: 0,
      taxCents: 0,
      payments: [],
      condition: FiscalOperationCondition.DEFERRED
    })
    const built = build(free)
    expect(schemaErrors('01', built.payload)).toEqual([])
    const resumen = (built.payload as unknown as Payload)['resumen']
    expect(resumen['totalPagar']).toBe(0)
    expect(resumen['condicionOperacion']).toBe(1)
    expect(resumen.pagos[0]).toMatchObject({ montoPago: 0, plazo: null, periodo: null })
  })

  it('builds a sale on credit that was paid in part, and refuses payments over the total', () => {
    const part = build(
      sale({
        condition: FiscalOperationCondition.DEFERRED,
        payments: [{ method: PaymentMethod.CASH, amountCents: 1000, reference: null }]
      })
    )
    expect(schemaErrors('01', part.payload)).toEqual([])
    expect((part.payload as unknown as Payload)['resumen'].pagos[0]).toMatchObject({
      codigo: null,
      montoPago: 0
    })
    expect(
      refused(
        sale({
          condition: FiscalOperationCondition.DEFERRED,
          payments: [{ method: PaymentMethod.CASH, amountCents: 9999, reference: null }]
        })
      )
    ).toBe(SvBuildErrors.SALE_TOTALS_MISMATCH)
  })

  it('declares an item of kind 4 in unit 99 and a credit sale of a tax credit document by the schema of 03', () => {
    const built = build(
      sale({
        receiver: BUSINESS,
        lines: [line({ itemKind: '4', unit: '59' })],
        shippingCents: 0,
        shippingTaxCents: 0,
        totalCents: 2260,
        taxCents: 260,
        condition: FiscalOperationCondition.DEFERRED
      })
    )
    expect(schemaErrors('03', built.payload)).toEqual([])
    expect((built.payload as unknown as Payload)['cuerpoDocumento'][0]).toMatchObject({
      uniMedida: 99
    })
  })

  it('declares a service in unit 99 (other), the shipping fee and a service line of the order', () => {
    const built = build(
      sale({
        lines: [line(), line({ itemKind: '2', unit: '59', description: 'Instalación' })],
        totalCents: 5085,
        taxCents: 585
      })
    )
    expect(schemaErrors('01', built.payload)).toEqual([])
    const body = (built.payload as unknown as Payload)['cuerpoDocumento']
    expect(body.map(item => item['uniMedida'])).toEqual([59, 99, 99])
  })

  it('sends a final consumer with no activity, no department, no municipality and no address (Anexo IV, 43.1, 47.1, 48.1, 50)', () => {
    const built = build(
      sale({
        receiver: { ...BUSINESS, name: 'Ana Pérez', taxId: null, registrationId: null }
      })
    )
    expect(schemaErrors('01', built.payload)).toEqual([])
    expect((built.payload as unknown as Payload)['receptor']).toMatchObject({
      nombre: 'Ana Pérez',
      codActividad: null,
      descActividad: null,
      direccion: null,
      correo: 'compras@example.test'
    })
    // A delivery address alone says nothing about who bought: there is no receiver
    expect(
      payloadOf(sale({ receiver: { ...CONSUMER, address: BUSINESS.address } }))['receptor']
    ).toBeNull()
  })

  it('does not read the payments of the order for a credit note, whatever they say', () => {
    const built = build(
      creditNote({
        payments: [{ method: PaymentMethod.CASH, amountCents: 99999, reference: null }],
        condition: FiscalOperationCondition.DEFERRED
      })
    )
    expect(schemaErrors('05', built.payload)).toEqual([])
    expect((built.payload as unknown as Payload)['resumen']['condicionOperacion']).toBe(2)
  })
})

describe('what is never sent wrong', () => {
  it.each([
    [
      'a line with no tax treatment and no rate',
      { lines: [line({ taxTreatment: null, taxRateBps: null })] },
      SvBuildErrors.TAX_TREATMENT_UNKNOWN
    ],
    [
      'a taxed line at another rate',
      { lines: [line({ taxRateBps: 1500 })] },
      SvBuildErrors.TAX_RATE_UNSUPPORTED
    ],
    [
      'a sale whose total is not what its lines add up to',
      { totalCents: 2826 },
      SvBuildErrors.SALE_TOTALS_MISMATCH
    ],
    [
      'a sale whose tax is not the tax of its lines',
      { taxCents: 326 },
      SvBuildErrors.SALE_TOTALS_MISMATCH
    ],
    [
      'a discount larger than the sale',
      { discountCents: 999999 },
      SvBuildErrors.SALE_TOTALS_MISMATCH
    ],
    [
      'a sale with no lines',
      { lines: [], shippingCents: 0, shippingTaxCents: 0, totalCents: 0, taxCents: 0 },
      SvBuildErrors.NO_ITEMS
    ],
    [
      'an issuer with no point of sale',
      { issuer: { ...ISSUER, pointOfSaleCode: null } },
      SvBuildErrors.ISSUER_INCOMPLETE
    ],
    [
      'an issuer with an activity the catalog does not have',
      { issuer: { ...ISSUER, activityCode: '00000' } },
      SvBuildErrors.ISSUER_INCOMPLETE
    ]
  ])('refuses %s', (_label, over, code) => {
    expect(refused(sale(over as Partial<ReturnType<typeof sale>>))).toBe(code)
  })

  it('refuses a tax that is more than a hundredth away from the formula of the authority', () => {
    // 2825 of taxed sales hold 325 of tax; the books say 327 here (the lines and the order agree with each other, the formula does not)
    expect(refused(sale({ lines: [line({ taxCents: 262 })], taxCents: 327 }))).toBe(
      SvBuildErrors.TAX_OUTSIDE_TOLERANCE
    )
  })

  it('says only a code, never a value of the sale', () => {
    try {
      buildDocument(
        sale({
          lines: [line({ description: 'SECRET-NAME', taxRateBps: 1500 })],
          receiver: { ...CONSUMER, name: 'SECRET-PERSON' }
        })
      )
    } catch (error) {
      expect(String(error)).not.toContain('SECRET')
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('SECRET')
      return
    }
    throw new Error('expected a refusal')
  })
})

describe('the construction is pure', () => {
  it('builds the same document from the same sale, and never changes what it is given', () => {
    const input = sale({ receiver: BUSINESS })
    const copy = JSON.parse(JSON.stringify(input)) as unknown
    expect(build(input)).toEqual(build(input))
    expect(JSON.parse(JSON.stringify(input))).toEqual(copy)
  })

  it('is for the environment of the issuer: production says 01', () => {
    const production = payloadOf(
      sale({ issuer: { ...ISSUER, environment: FiscalEnvironment.PRODUCTION } })
    )
    expect(production['identificacion'].ambiente).toBe('01')
  })

  it('only makes the types the manifest declares', () => {
    expect(Object.values(SvDocumentTypes)).toEqual(['01', '03', '04', '05', '06', '14'])
  })
})

describe('the debit note (06)', () => {
  it('is a document the official schema accepts, naming the tax credit document it adds to, in the relation and in each item', () => {
    const built = build(debitNote())
    expect(built.documentType).toBe('06')
    expect(built.missingReceiverFields).toEqual([])
    expect(schemaErrors('06', built.payload)).toEqual([])
    const p = built.payload as unknown as Payload
    expect(p['identificacion']).toMatchObject({
      version: 4,
      tipoDte: '06',
      numeroControl: 'DTE-06-M001P001-000000000000041',
      fusion: null
    })
    expect(p['documentoRelacionado']).toEqual([
      {
        tipoDocumento: '03',
        tipoGeneracion: 2,
        numeroDocumento: 'AC54E9DB-79C5-42CE-B430-EC552C97EFBA',
        fechaEmision: '2026-11-16'
      }
    ])
    expect(p['cuerpoDocumento'][0]?.numeroDocumento).toBe('AC54E9DB-79C5-42CE-B430-EC552C97EFBA')
    // The schema of the note has no establishment code in the issuer
    expect(p['emisor']).not.toHaveProperty('codEstable')
  })

  it('has the receiver of the tax credit document it names, by its tax number (identity document 36)', () => {
    const p = payloadOf(debitNote())
    expect(p['receptor']).toMatchObject({ tipoDocumento: '36', numDocumento: '06140202021023' })
    expect(p['receptor']).not.toHaveProperty('nit')
  })

  it('says the amounts the way the credit note does, with the electronic payment number the schema of the debit note asks for', () => {
    const summary = payloadOf(debitNote())['resumen']
    expect(summary).toMatchObject({
      totalGravada: 2.95,
      totalIva: 0.38,
      montoTotalOperacion: 3.33,
      totalPagar: 3.33,
      condicionOperacion: 1,
      numPagoElectronico: null
    })
    // What it charges is not a payment
    expect(summary).not.toHaveProperty('pagos')
  })

  it('takes the number of the series of its own type, from the correlative of the order (the same mechanism of every type)', () => {
    expect(payloadOf(debitNote({ correlative: 7 }))['identificacion']['numeroControl']).toBe(
      'DTE-06-M001P001-000000000000007'
    )
  })

  it('is refused without the document it adds to, or with one that is not a tax credit document', () => {
    expect(refused(debitNote({ credited: null }))).toBe(SvBuildErrors.CREDITED_DOCUMENT_UNKNOWN)
    expect(refused(debitNote({ credited: { ...credited(), documentType: '01' } }))).toBe(
      SvBuildErrors.CREDITED_DOCUMENT_NOT_CREDITABLE
    )
    // Nor a credit note: it is not what a debit note adds to
    expect(refused(debitNote({ credited: { ...credited(), documentType: '05' } }))).toBe(
      SvBuildErrors.CREDITED_DOCUMENT_NOT_CREDITABLE
    )
    expect(
      refused(
        debitNote({ credited: credited({ [SvProviderDataKeys.GENERATION_CODE]: undefined }) })
      )
    ).toBe(SvBuildErrors.CREDITED_DOCUMENT_UNKNOWN)
  })

  it('is refused when the receiver lacks what a taxpayer needs, like any document to a taxpayer', () => {
    const built = build(debitNote({ receiver: CONSUMER }))
    expect(built.payload).toEqual({})
    expect(built.missingReceiverFields.length).toBeGreaterThan(0)
  })

  it('is checked against the schema in a deferred document too (contingency)', () => {
    const built = build(debitNote({ contingency: { reason: '3', motive: null } }))
    expect(schemaErrors('06', built.payload)).toEqual([])
    expect((built.payload as unknown as Payload)['identificacion']).toMatchObject({
      tipoModelo: 2,
      tipoOperacion: 2,
      tipoContingencia: 3
    })
  })
})

describe('the remission note (04)', () => {
  it('is a document the official schema accepts, with the control number of its own series and no relation', () => {
    const built = build(remissionNote())
    expect(built.documentType).toBe('04')
    expect(built.missingReceiverFields).toEqual([])
    expect(schemaErrors('04', built.payload)).toEqual([])
    const p = built.payload as unknown as Payload
    expect(p['identificacion']).toMatchObject({
      version: 4,
      tipoDte: '04',
      numeroControl: 'DTE-04-M001P001-000000000000041'
    })
    expect(p['documentoRelacionado']).toBeNull()
    // Unlike a note, the issuer of a remission note carries the codes of the establishment and of the point of sale
    expect(p['emisor']).toMatchObject({ codEstable: 'M001', codPuntoVenta: 'P001' })
    expect(p['cuerpoDocumento'][0]?.numeroDocumento).toBeNull()
  })

  it('says the title the goods are sent under (CAT-025), the one of the provider unless told otherwise', () => {
    expect(payloadOf(remissionNote())['receptor']).toMatchObject({ bienTitulo: '04' })
  })

  it('names the receiver with an identity document of any kind, with no registration number', () => {
    const p = payloadOf(remissionNote())
    expect(p['receptor']).toMatchObject({
      tipoDocumento: '13',
      numDocumento: '012345678',
      nrc: null,
      nombre: 'Ana Pérez',
      codActividad: '47119',
      nombreComercial: null
    })
    expect(p['receptor']).not.toHaveProperty('nit')
    const taxpayer = payloadOf(remissionNote({ receiver: BUSINESS }))
    expect(taxpayer['receptor']).toMatchObject({ tipoDocumento: '36', nrc: '7654321' })
    expect(schemaErrors('04', taxpayer)).toEqual([])
  })

  it('has the net prices and the tax of the tax credit document, and no payment or condition of operation', () => {
    const p = payloadOf(remissionNote())
    expect(p['resumen']).toMatchObject({
      totalGravada: 25.0,
      subTotalVentas: 25.0,
      subTotal: 25.0,
      montoTotalOperacion: 28.25,
      tributos: [{ codigo: '20', valor: 3.25 }]
    })
    expect(p['resumen']).not.toHaveProperty('pagos')
    expect(p['resumen']).not.toHaveProperty('condicionOperacion')
    expect(p['cuerpoDocumento'][0]).toMatchObject({ tributos: ['20'] })
  })

  it('takes the number from the correlative of the order, the same mechanism of every type', () => {
    expect(payloadOf(remissionNote({ correlative: 7 }))['identificacion']['numeroControl']).toBe(
      'DTE-04-M001P001-000000000000007'
    )
  })

  it('is refused, for a person to complete, when the receiver lacks what the goods need to be sent to someone', () => {
    for (const lacking of [{ name: null }, { taxId: null }, { address: null }]) {
      const built = build(
        remissionNote({ receiver: { ...CONSUMER, ...DELIVERY_RECEIVER, ...lacking } })
      )
      expect(built.payload).toEqual({})
      expect(built.missingReceiverFields).toEqual([Object.keys(lacking)[0]])
    }
    const missing = build(remissionNote({ receiver: CONSUMER })).missingReceiverFields
    expect(missing).toHaveLength(3)
    expect(missing).toEqual(expect.arrayContaining(['name', 'taxId', 'address']))
  })

  it('takes the activity the customer declares, and "other" (10005) when there is none, so a final consumer can have one', () => {
    const declared = payloadOf(remissionNote())['receptor']
    expect(declared).toMatchObject({ codActividad: '47119' })
    const none = build(
      remissionNote({ receiver: { ...CONSUMER, ...DELIVERY_RECEIVER, economicActivity: null } })
    )
    expect(none.missingReceiverFields).toEqual([])
    expect(schemaErrors('04', none.payload)).toEqual([])
    expect((none.payload as unknown as Payload)['receptor']).toMatchObject({
      codActividad: '10005',
      descActividad: 'Otros'
    })
    // Blanks are none too
    const blank = payloadOf(
      remissionNote({ receiver: { ...CONSUMER, ...DELIVERY_RECEIVER, economicActivity: '  ' } })
    )
    expect(blank['receptor']).toMatchObject({ codActividad: '10005' })
  })

  it('is refused too when what the person typed is present but wrong: a national id with a bad check digit, an unknown activity, an address outside the catalogs', () => {
    for (const [wrong, field] of [
      [{ taxId: '012345679' }, 'taxId'],
      [{ economicActivity: '00000' }, 'economicActivity'],
      [
        { address: { department: '99', municipality: '99', district: '99', complement: 'x' } },
        'address'
      ]
    ] as const) {
      const built = build(
        remissionNote({ receiver: { ...CONSUMER, ...DELIVERY_RECEIVER, ...wrong } })
      )
      expect(built.payload).toEqual({})
      expect(built.missingReceiverFields).toEqual([field])
    }
  })

  it('sends no registration number when the saved one is malformed: the schema takes it as null, so it never refuses the note', () => {
    const built = build(
      remissionNote({ receiver: { ...CONSUMER, ...DELIVERY_RECEIVER, registrationId: 'ABC' } })
    )
    expect(built.missingReceiverFields).toEqual([])
    expect((built.payload as unknown as Payload)['receptor']).toMatchObject({ nrc: null })
    expect(schemaErrors('04', built.payload)).toEqual([])
  })

  it('is checked against the schema in a deferred document too (contingency)', () => {
    const built = build(remissionNote({ contingency: { reason: '3', motive: null } }))
    expect(schemaErrors('04', built.payload)).toEqual([])
    expect((built.payload as unknown as Payload)['identificacion']).toMatchObject({
      tipoModelo: 2,
      tipoOperacion: 2,
      tipoContingencia: 3
    })
  })

  it('is no sale: it never reads the payments of the order, and it builds with none', () => {
    const built = build(remissionNote({ payments: [] }))
    expect(schemaErrors('04', built.payload)).toEqual([])
  })
})

describe('the invoice of an excluded subject (14)', () => {
  it('is a document the official schema accepts, from the buyer to the seller, with no tax and no relation to another document', () => {
    const built = build(purchase())
    expect(built.documentType).toBe('14')
    expect(built.missingReceiverFields).toEqual([])
    expect(schemaErrors('14', built.payload)).toEqual([])
    const p = built.payload as unknown as Payload
    expect(p['identificacion']).toMatchObject({
      version: 2,
      tipoDte: '14',
      numeroControl: 'DTE-14-M001P001-000000000000041'
    })
    expect(Object.keys(p).sort()).toEqual([
      'apendice',
      'cuerpoDocumento',
      'emisor',
      'identificacion',
      'receptor',
      'resumen'
    ])
    // The issuer is the store and carries no trade name; the receiver is the seller
    expect(p['emisor']).toMatchObject({ codEstable: 'M001', codPuntoVenta: 'P001' })
    expect(p['emisor']).not.toHaveProperty('nombreComercial')
    expect(p['receptor']).toMatchObject({
      tipoDocumento: '13',
      numDocumento: '012345678',
      nombre: 'Juan Pérez Ramos',
      codActividad: null,
      descActividad: null
    })
  })

  it('says the purchase of each item and the totals the authority checks: sub-total = purchases, to pay = sub-total - withheld', () => {
    const p = payloadOf(purchase())
    expect(p['cuerpoDocumento'][0]).toEqual({
      numItem: 1,
      tipoItem: 1,
      cantidad: 3,
      codigo: null,
      uniMedida: 59,
      descripcion: 'Café en grano',
      precioUni: 12.5,
      montoDescu: 0,
      compra: 37.5
    })
    expect(p['resumen']).toMatchObject({
      totalCompra: 37.5,
      descu: 0,
      totalDescu: 0,
      subTotal: 37.5,
      reteRenta: 0,
      totalPagar: 37.5,
      condicionOperacion: 1
    })
  })

  it('subtracts the withholding the caller states from what is paid, and refuses a purchase that does not state one', () => {
    const withheld = payloadOf(
      purchase({
        withheldIncomeTaxCents: 375,
        payments: [{ method: PaymentMethod.CASH, amountCents: 3375, reference: null }]
      })
    )
    expect(withheld['resumen']).toMatchObject({
      subTotal: 37.5,
      reteRenta: 3.75,
      totalPagar: 33.75
    })
    expect(schemaErrors('14', withheld)).toEqual([])
    // Nothing is assumed: not stating it is not the same as stating zero
    const without = purchase()
    delete (without as { withheldIncomeTaxCents?: number }).withheldIncomeTaxCents
    expect(refused(without)).toBe(SvBuildErrors.WITHHOLDING_REQUIRED)
    for (const bad of [-1, 3751, 1.5, Number.NaN]) {
      expect(refused(purchase({ withheldIncomeTaxCents: bad }))).toBe(
        SvBuildErrors.WITHHOLDING_INVALID
      )
    }
  })

  it('spreads the discount over the items and keeps the figures exact', () => {
    const built = build(
      purchase({
        lines: [
          line({
            description: 'A',
            quantity: 1,
            unitPriceCents: 333,
            totalCents: 333,
            taxRateBps: null,
            taxCents: 0,
            taxTreatment: null
          }),
          line({
            description: 'B',
            quantity: 2,
            unitPriceCents: 1667,
            totalCents: 3334,
            taxRateBps: null,
            taxCents: 0,
            taxTreatment: null
          })
        ],
        discountCents: 367,
        totalCents: 3300,
        payments: [{ method: PaymentMethod.CASH, amountCents: 3300, reference: null }]
      })
    )
    expect(schemaErrors('14', built.payload)).toEqual([])
    const p = built.payload as unknown as Payload
    expect(p['resumen']).toMatchObject({
      totalCompra: 33,
      totalDescu: 3.67,
      subTotal: 33,
      totalPagar: 33
    })
    const items = p['cuerpoDocumento']
    expect(items.reduce((sum, item) => sum + Number(item['montoDescu']), 0)).toBeCloseTo(3.67, 2)
    expect(items.reduce((sum, item) => sum + Number(item['compra']), 0)).toBeCloseTo(33, 2)
  })

  it('is refused when something carries tax, a shipping fee, or totals that are not the lines minus the discount', () => {
    const taxed = line({
      description: 'X',
      quantity: 1,
      unitPriceCents: 100,
      totalCents: 100,
      taxRateBps: 1300,
      taxCents: 12
    })
    expect(refused(purchase({ lines: [taxed], totalCents: 100, payments: [] }))).toBe(
      SvBuildErrors.PURCHASE_HAS_TAX
    )
    expect(refused(purchase({ taxCents: 1 }))).toBe(SvBuildErrors.PURCHASE_HAS_TAX)
    expect(refused(purchase({ shippingCents: 100, totalCents: 3850 }))).toBe(
      SvBuildErrors.SALE_TOTALS_MISMATCH
    )
    expect(refused(purchase({ totalCents: 3751 }))).toBe(SvBuildErrors.SALE_TOTALS_MISMATCH)
    expect(refused(purchase({ discountCents: 3751, totalCents: 0 }))).toBe(
      SvBuildErrors.SALE_TOTALS_MISMATCH
    )
    expect(refused(purchase({ lines: [], totalCents: 0 }))).toBe(SvBuildErrors.NO_ITEMS)
  })

  it('is refused when a line says another purchase than its quantity times its unit price, or the purchase is worth nothing', () => {
    const odd = line({
      description: 'X',
      quantity: 3,
      unitPriceCents: 1000,
      totalCents: 2500,
      taxRateBps: null,
      taxCents: 0,
      taxTreatment: null
    })
    expect(refused(purchase({ lines: [odd], totalCents: 2500, payments: [] }))).toBe(
      SvBuildErrors.SALE_TOTALS_MISMATCH
    )
    const free = line({
      description: 'X',
      quantity: 1,
      unitPriceCents: 0,
      totalCents: 0,
      taxRateBps: null,
      taxCents: 0,
      taxTreatment: null
    })
    expect(refused(purchase({ lines: [free], totalCents: 0, payments: [] }))).toBe(
      SvBuildErrors.SALE_TOTALS_MISMATCH
    )
  })

  it('asks the seller for a name, an identity document and an address, and nothing of a taxpayer', () => {
    // No registration number and no activity are needed: the seller is not a taxpayer
    expect(build(purchase()).missingReceiverFields).toEqual([])
    const lacking = build(
      purchase({ receiver: { ...SELLER, name: null, taxId: null, address: null } })
    )
    expect(lacking.payload).toEqual({})
    expect(lacking.missingReceiverFields).toEqual(['name', 'taxId', 'address'])
  })

  it('takes a seller who has a tax number or another document, and the activity only when the catalog knows it', () => {
    const tax = payloadOf(
      purchase({ receiver: { ...SELLER, taxId: '0614-020202-102-3', documentType: '36' } })
    )
    expect(tax['receptor']).toMatchObject({ tipoDocumento: '36', numDocumento: '06140202021023' })
    const other = purchase({
      receiver: { ...SELLER, taxId: 'P1234567', documentType: '37', economicActivity: '47119' }
    })
    expect(payloadOf(other)['receptor']).toMatchObject({
      tipoDocumento: '37',
      numDocumento: 'P1234567',
      codActividad: '47119'
    })
    expect(schemaErrors('14', payloadOf(other))).toEqual([])
  })

  it('takes the number of the series of its own type, like every type, and is built in contingency like any other', () => {
    expect(payloadOf(purchase({ correlative: 9 }))['identificacion']['numeroControl']).toBe(
      'DTE-14-M001P001-000000000000009'
    )
    const deferred = build(purchase({ contingency: { reason: '3', motive: null } }))
    expect(schemaErrors('14', deferred.payload)).toEqual([])
    expect((deferred.payload as unknown as Payload)['identificacion']).toMatchObject({
      tipoModelo: 2,
      tipoOperacion: 2,
      tipoContingencia: 3
    })
  })

  it('pays what is left after the withholding: the payments must add up to it', () => {
    expect(refused(purchase({ withheldIncomeTaxCents: 375 }))).toBe(
      SvBuildErrors.SALE_TOTALS_MISMATCH
    )
    // On credit nothing is paid yet
    const credit = payloadOf(
      purchase({ condition: FiscalOperationCondition.DEFERRED, payments: [] })
    )
    expect(credit['resumen']).toMatchObject({ condicionOperacion: 2 })
  })
})

// Normativa DTE v2.0, Anexo IV, field 17 rule 2 c: a note that names a tax credit document is generated within three months of the
// generation of that document. Counted in calendar months of the date it carries (`fecEmi`), the last day included, in Salvador time.
describe.each([
  ['credit note', creditNote],
  ['debit note', debitNote]
])('the three months a %s has to name its tax credit document', (_name, make) => {
  const noteOn = (parentDate: string, noteInstant: string) =>
    make({
      issuedAt: noteInstant,
      credited: credited({ [SvProviderDataKeys.ISSUE_DATE]: parentDate })
    })

  it('is built on the last day of the three months and refused the day after', () => {
    expect(refused(noteOn('2026-08-16', '2026-11-16T15:00:00.000Z'))).toBe('built')
    expect(refused(noteOn('2026-08-16', '2026-11-17T15:00:00.000Z'))).toBe(
      SvBuildErrors.RELATED_DOCUMENT_DEADLINE_PASSED
    )
  })

  it('is built on the same day it was generated', () => {
    expect(refused(noteOn('2026-11-16', '2026-11-16T15:00:00.000Z'))).toBe('built')
  })

  it('counts the date in the time of El Salvador, not in UTC', () => {
    // 2026-11-17 03:30 UTC is still 2026-11-16 in El Salvador: the last day
    expect(refused(noteOn('2026-08-16', '2026-11-17T03:30:00.000Z'))).toBe('built')
    // 2026-11-17 06:00 UTC is 2026-11-17 00:00 in El Salvador: the day after
    expect(refused(noteOn('2026-08-16', '2026-11-17T06:00:00.000Z'))).toBe(
      SvBuildErrors.RELATED_DOCUMENT_DEADLINE_PASSED
    )
  })

  it('ends on the last day of a shorter month: a document of 30 or 31 November lasts until 28 February', () => {
    expect(refused(noteOn('2026-11-30', '2027-02-28T15:00:00.000Z'))).toBe('built')
    expect(refused(noteOn('2026-11-30', '2027-03-01T15:00:00.000Z'))).toBe(
      SvBuildErrors.RELATED_DOCUMENT_DEADLINE_PASSED
    )
    expect(refused(noteOn('2026-12-31', '2027-03-31T15:00:00.000Z'))).toBe('built')
    expect(refused(noteOn('2026-12-31', '2027-04-01T15:00:00.000Z'))).toBe(
      SvBuildErrors.RELATED_DOCUMENT_DEADLINE_PASSED
    )
    // A leap year
    expect(refused(noteOn('2023-11-30', '2024-02-29T15:00:00.000Z'))).toBe('built')
    expect(refused(noteOn('2023-11-30', '2024-03-01T15:00:00.000Z'))).toBe(
      SvBuildErrors.RELATED_DOCUMENT_DEADLINE_PASSED
    )
  })

  it('crosses the year', () => {
    expect(refused(noteOn('2026-10-15', '2027-01-15T15:00:00.000Z'))).toBe('built')
    expect(refused(noteOn('2026-10-15', '2027-01-16T15:00:00.000Z'))).toBe(
      SvBuildErrors.RELATED_DOCUMENT_DEADLINE_PASSED
    )
  })

  it('refuses a document whose date is not a day of the calendar, and builds a note dated before it', () => {
    expect(refused(noteOn('2026-02-30', '2026-03-16T15:00:00.000Z'))).toBe(
      SvBuildErrors.CREDITED_DOCUMENT_UNKNOWN
    )
    expect(refused(noteOn('2026-11-16', '2026-11-10T15:00:00.000Z'))).toBe('built')
  })

  it('still refuses a document whose date was not kept before looking at the deadline', () => {
    expect(
      refused(make({ credited: credited({ [SvProviderDataKeys.ISSUE_DATE]: undefined }) }))
    ).toBe(SvBuildErrors.CREDITED_DOCUMENT_UNKNOWN)
  })
})

// A sale document names the remission notes that backed its goods (Anexo IV, fields 14, 16 and 17)
describe('a sale document that follows remission notes', () => {
  // The notes are the ones core offers: accepted, of the order. 2026-11-17T03:30Z is the 16th of November in El Salvador.
  const note = (suffix: number, date: string, over: Record<string, unknown> = {}) => ({
    ...credited({
      [SvProviderDataKeys.GENERATION_CODE]: `AC54E9DB-79C5-42CE-B430-${String(suffix).padStart(12, '0')}`,
      [SvProviderDataKeys.ISSUE_DATE]: date,
      ...over
    }),
    documentType: '04'
  })
  const invoice = (
    follows: ReturnType<typeof note>[],
    over: Partial<ReturnType<typeof sale>> = {}
  ) => sale({ follows, ...over })
  const taxCredit = (
    follows: ReturnType<typeof note>[],
    over: Partial<ReturnType<typeof sale>> = {}
  ) => sale({ follows, receiver: BUSINESS, ...over })

  it('names a note of the same period on an invoice and on a tax credit document, as the official schema takes it', () => {
    for (const make of [invoice, taxCredit]) {
      const built = build(make([note(1, '2026-11-10')]))
      expect(schemaErrors(built.documentType, built.payload)).toEqual([])
      expect((built.payload as unknown as Payload).documentoRelacionado).toEqual([
        {
          tipoDocumento: '04',
          tipoGeneracion: 2,
          numeroDocumento: 'AC54E9DB-79C5-42CE-B430-000000000001',
          fechaEmision: '2026-11-10'
        }
      ])
    }
  })

  it('names nothing when there are no notes, or when none is allowed, and never refuses the sale for it', () => {
    expect(payloadOf(invoice([]))['documentoRelacionado']).toBeNull()
    expect(payloadOf(sale())['documentoRelacionado']).toBeNull()
    expect(payloadOf(invoice([note(1, '2026-10-01')]))['documentoRelacionado']).toBeNull()
  })

  it('names a note of the month before only until the third day after that month (rule 2 a)', () => {
    // A note of the last day of October: the document of the 3rd of November is in time, the one of the 4th is not
    const named = (madeAt: string) =>
      payloadOf(invoice([note(1, '2026-10-31')], { issuedAt: madeAt }))['documentoRelacionado']
    expect(named('2026-11-04T01:00:00.000Z')).not.toBeNull() // 3 November, 19:00 in El Salvador
    expect(named('2026-11-04T07:00:00.000Z')).toBeNull() // 4 November, 01:00 in El Salvador
  })

  it('leaves out a note dated after the document, other types, a note without its code and a repeated one', () => {
    const list = [
      note(1, '2026-11-20'),
      { ...note(2, '2026-11-10'), documentType: '03' },
      note(3, '2026-11-10', { [SvProviderDataKeys.GENERATION_CODE]: undefined }),
      note(4, '2026-11-10', { [SvProviderDataKeys.ISSUE_DATE]: 'yesterday' }),
      note(5, '2026-11-10'),
      note(5, '2026-11-10')
    ]
    const related = payloadOf(invoice(list))['documentoRelacionado']
    expect(related?.map(item => item['numeroDocumento'])).toEqual([
      'AC54E9DB-79C5-42CE-B430-000000000005'
    ])
  })

  it('names at most the five the schema of an invoice takes, the oldest first', () => {
    const list = [1, 2, 3, 4, 5, 6, 7].map(n => note(n, '2026-11-10'))
    const built = build(invoice(list))
    expect(schemaErrors(built.documentType, built.payload)).toEqual([])
    const related = (built.payload as unknown as Payload).documentoRelacionado
    expect(related?.map(item => item['numeroDocumento'])).toEqual(
      [1, 2, 3, 4, 5].map(n => `AC54E9DB-79C5-42CE-B430-${String(n).padStart(12, '0')}`)
    )
  })

  it('does not change the notes that name the document they change', () => {
    const built = build(creditNote({ follows: [note(1, '2026-11-10')] }))
    expect((built.payload as unknown as Payload).documentoRelacionado).toEqual([
      expect.objectContaining({ tipoDocumento: '03' })
    ])
  })
})
