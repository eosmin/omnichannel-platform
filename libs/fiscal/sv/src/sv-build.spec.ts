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

  it('is the type build puts in the document', () => {
    for (const input of [sale(), sale({ receiver: BUSINESS }), creditNote()]) {
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
    expect(resumen.pagos).toEqual([
      { codigo: '01', montoPago: 28.25, referencia: null, plazo: '01', periodo: 1 }
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
    expect(resumen.pagos[0]).toMatchObject({ plazo: '01', periodo: 1 })
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
    expect(Object.values(SvDocumentTypes)).toEqual(['01', '03', '05'])
  })
})
