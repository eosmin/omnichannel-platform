import { FiscalDocumentKind, FiscalEnvironment, FiscalLimits } from '@platform/core/domain'
import type { StoredFiscalDocument } from '@platform/fiscal/sdk'

import { SvLimits, SvProviderDataKeys, SvRepresentation } from './sv-constants'
import { representDocument } from './sv-representation'
import { acceptedDocument, BUSINESS, credited, ISSUER, line } from './testing/sv-fixtures'

const SEAL = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678'
const JWS = 'aaa.bbb.ccc'

function kept(doc: StoredFiscalDocument, over: Record<string, unknown> = {}): StoredFiscalDocument {
  return {
    ...doc,
    providerData: {
      ...doc.providerData,
      [SvProviderDataKeys.RECEPTION_SEAL]: SEAL,
      [SvProviderDataKeys.SIGNED_DOCUMENT]: JWS,
      ...over
    }
  }
}

const invoice = (): StoredFiscalDocument => kept(acceptedDocument())
const taxCredit = (): StoredFiscalDocument => kept(acceptedDocument({ receiver: BUSINESS }))
const creditNote = (): StoredFiscalDocument =>
  kept(
    acceptedDocument({
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
      payments: []
    })
  )

const valueOf = (rep: ReturnType<typeof representDocument>, label: string): string | undefined =>
  [
    ...(rep?.sections.flatMap(s => s.rows) ?? []),
    ...(rep?.totals ?? []),
    ...(rep?.footnotes ?? [])
  ].find(row => row.label === label)?.value

describe('the representation of an accepted document', () => {
  it.each([
    ['01', invoice],
    ['03', taxCredit],
    ['05', creditNote]
  ])('draws type %s with the identification block of the authority', (type, make) => {
    const rep = representDocument(make())
    expect(rep).not.toBeNull()
    expect(rep?.title).toBe(SvRepresentation.TITLES[type as '01'])
    expect(valueOf(rep, 'Código de Generación')).toBe('1B9D6BCD-BBFD-4B2D-9B5D-AB8DFBBD4BED')
    expect(valueOf(rep, 'Número de Control')).toMatch(/^DTE-\d{2}-M001P001-\d{15}$/)
    expect(valueOf(rep, 'Sello de Recepción')).toBe(SEAL)
    expect(valueOf(rep, 'Modelo de Facturación')).toBe(SvRepresentation.MODELS[1])
    expect(valueOf(rep, 'Tipo de Transmisión')).toBe(SvRepresentation.TRANSMISSIONS[1])
    expect(valueOf(rep, 'Fecha de Generación')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(valueOf(rep, 'Hora de Generación')).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })

  it('names the issuer with its address by the names of the catalogs', () => {
    const rep = representDocument(invoice())
    expect(valueOf(rep, 'Nombre (Emisor)')).toBe(ISSUER.legalName)
    expect(valueOf(rep, 'NIT')).toBe('06140101011011')
    expect(valueOf(rep, 'Complemento')).toBe('Calle 1, Colonia Centro')
    expect(valueOf(rep, 'Departamento')).toBe('San Salvador')
    expect(valueOf(rep, 'Municipio')).toBe('SAN SALVADOR CENTRO')
  })

  it('names the receiver of a tax credit document by the fields of the authority', () => {
    const rep = representDocument(taxCredit())
    expect(rep?.sections.map(section => section.heading)).toEqual([
      'Identificación',
      'Emisor',
      'Receptor'
    ])
    const receiver = rep?.sections.find(section => section.heading === 'Receptor')
    expect(receiver?.rows.map(row => row.label)).toEqual(
      expect.arrayContaining([
        'Nombre (Receptor)',
        'NIT',
        'NRC',
        'Departamento',
        'Municipio',
        'Complemento'
      ])
    )
  })

  it('lists the items and the summary with the amounts of the document', () => {
    const rep = representDocument(taxCredit())
    expect(rep?.table?.columns).toContain('Descripción')
    expect(rep?.table?.columns[rep.table.wideColumn]).toBe('Descripción')
    expect(rep?.table?.rows).toHaveLength(2)
    expect(valueOf(rep, 'Total a pagar')).toBe('28.25')
    expect(rep?.footnotes.find(row => row.label === 'Valor en letras')?.value).toMatch(
      /28\/100|25\/100/
    )
  })

  it('a credit note names the document it adjusts', () => {
    const rep = representDocument(creditNote())
    expect(rep?.table?.columns).toContain('N° Documento relacionado')
    const related = rep?.sections.find(section => section.heading === 'Documentos relacionados')
    expect(related?.rows).toEqual([
      { label: 'Tipo de documento relacionado', value: 'Comprobante de crédito fiscal' },
      {
        label: 'Número de documento relacionado',
        value: 'AC54E9DB-79C5-42CE-B430-EC552C97EFBA'
      },
      { label: 'Fecha de generación del documento relacionado', value: '2026-11-16' }
    ])
    expect(rep?.table?.columns[rep.table.wideColumn]).toBe('Descripción')
  })

  it('has the public consultation code of the environment, the date and the generation code', () => {
    const sandbox = representDocument(invoice())
    expect(sandbox?.qrUrl).toBe(
      'https://admin.factura.gob.sv/consultaPublica?ambiente=00&codGen=1B9D6BCD-BBFD-4B2D-9B5D-AB8DFBBD4BED&fechaEmi=2026-11-16'
    )
    const prod = representDocument(
      kept(acceptedDocument({ issuer: { ...ISSUER, environment: FiscalEnvironment.PRODUCTION } }))
    )
    expect(prod?.qrUrl).toContain('ambiente=01')
  })

  it('says it has no legal value only in the test environment', () => {
    expect(representDocument(invoice())?.notices).toEqual([SvRepresentation.TEST_NOTICE])
    expect(SvRepresentation.TEST_NOTICE).toContain('carece de valor legal')
    const prod = representDocument(
      kept(acceptedDocument({ issuer: { ...ISSUER, environment: FiscalEnvironment.PRODUCTION } }))
    )
    expect(prod?.notices).toEqual([])
  })

  it('makes the file of the document: the structure, the signature and the seal, named by the generation code', () => {
    const doc = invoice()
    const file = representDocument(doc)?.file
    expect(representDocument(doc)?.name).toBe('1B9D6BCD-BBFD-4B2D-9B5D-AB8DFBBD4BED')
    expect(file?.filename).toBe('1B9D6BCD-BBFD-4B2D-9B5D-AB8DFBBD4BED.json')
    expect(file?.content).toEqual({ ...doc.payload, firmaElectronica: JWS, selloRecibido: SEAL })
  })

  it('a document with no seal (made in contingency) carries a null seal and a dash', () => {
    const rep = representDocument(
      kept(acceptedDocument(), { [SvProviderDataKeys.RECEPTION_SEAL]: null })
    )
    expect(rep?.file?.content['selloRecibido']).toBeNull()
    expect(valueOf(rep, 'Sello de Recepción')).toBe(SvRepresentation.NO_SEAL)
  })

  it('has no file when the signed document was not kept', () => {
    const rep = representDocument(
      kept(acceptedDocument(), { [SvProviderDataKeys.SIGNED_DOCUMENT]: null })
    )
    expect(rep).not.toBeNull()
    expect(rep?.file).toBeNull()
  })

  it('is the same every time and reads nothing but the stored document', () => {
    const doc = invoice()
    expect(representDocument(doc)).toEqual(representDocument(structuredClone(doc)))
  })

  it('has none for a type it does not draw or a payload that is not a document', () => {
    expect(representDocument({ ...invoice(), documentType: '04' })).toBeNull()
    expect(representDocument({ ...invoice(), payload: {} })).toBeNull()
  })

  // The fields the Normativa v2.0 (Anexo II, column "Representación Gráfica") marks A for each type, by the names the representation uses.
  // A field marked A that the document has is always shown: omitting one is a fine.
  const COMMON_A = [
    'Versión',
    'Tipo de Documento',
    'Código de Generación',
    'Número de Control',
    'Sello de Recepción',
    'Modelo de Facturación',
    'Tipo de Transmisión',
    'Fecha de Generación',
    'Hora de Generación',
    'Nombre (Emisor)',
    'NIT',
    'Departamento',
    'Municipio',
    'Dirección Distrito (Emisor)',
    'Complemento',
    'Teléfono',
    'Correo electrónico',
    'Total de operaciones no sujetas',
    'Total de operaciones exentas',
    'Total de operaciones gravadas',
    'Suma de operaciones',
    'Monto total de la operación',
    'Total a pagar',
    'Condición de la operación'
  ]
  const ITEM_A = [
    'N°',
    'Cantidad',
    'Unidad de Medida',
    'Descripción',
    'Precio Unitario',
    'Descuento por ítem',
    'Ventas No Sujetas',
    'Ventas Exentas',
    'Ventas Gravadas'
  ]
  it.each([
    ['01', invoice, [...COMMON_A], ['Sub total']],
    [
      '03',
      taxCredit,
      [
        ...COMMON_A,
        'Nombre (Receptor)',
        'Dirección Distrito (Receptor)',
        'NRC',
        'Actividad económica'
      ],
      ['Sub total']
    ],
    [
      '05',
      creditNote,
      [
        ...COMMON_A,
        'Nombre (Receptor)',
        'Dirección Distrito (Receptor)',
        'NRC',
        'Actividad económica',
        'Tipo de documento de identificación',
        'Número de documento de identificación (Receptor)',
        'Tipo de documento relacionado',
        'Número de documento relacionado',
        'Fecha de generación del documento relacionado'
      ],
      []
    ]
  ] as const)('shows every field marked A for type %s', (_type, make, fields, summary) => {
    const rep = representDocument(make())
    const shown = [
      ...(rep?.sections.flatMap(section => section.rows.map(row => row.label)) ?? []),
      ...(rep?.totals.map(row => row.label) ?? []),
      ...(rep?.footnotes.map(row => row.label) ?? [])
    ]
    for (const field of [...fields, ...summary]) expect(shown).toContain(field)
    for (const column of ITEM_A) expect(rep?.table?.columns).toContain(column)
  })

  it('does not show the optional fields (C) nor those of the law (B) that are zero', () => {
    const labels = (representDocument(invoice())?.totals.map(row => row.label) ?? []).join('|')
    expect(labels).not.toContain('IVA 13%')
    expect(labels).not.toContain('IVA Retenido')
    expect(labels).not.toContain('Descuento global')
  })

  it('shows the district by the code the document carries, and not in the receiver of an invoice', () => {
    const rep = representDocument(invoice())
    expect(valueOf(rep, 'Dirección Distrito (Emisor)')).toBe('01')
    expect(valueOf(rep, 'Dirección Distrito (Receptor)')).toBeUndefined()
    expect(valueOf(representDocument(taxCredit()), 'Dirección Distrito (Receptor)')).toBe('02')
  })

  it('names the summary and the columns as the Anexo does', () => {
    const rep = representDocument(creditNote())
    expect(rep?.table?.columns).toContain('Unidad de Medida')
    const labels = [...(rep?.totals ?? [])].map(row => row.label)
    expect(labels).toEqual(
      expect.arrayContaining(['Total de operaciones gravadas', 'Suma de operaciones'])
    )
    // The totals of a note are "Total IVA ...", those of an invoice or a tax credit document "IVA ..."
    expect(labels).toContain('Total IVA 13%')
  })

  it('draws a debit note like a credit note: the same fields and its related document', () => {
    const debit = kept(
      acceptedDocument({
        kind: FiscalDocumentKind.DEBIT_NOTE,
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
        payments: []
      })
    )
    const rep = representDocument(debit)
    expect(rep?.title).toBe(SvRepresentation.TITLES['06'])
    expect(rep?.table?.columns).toContain('N° Documento relacionado')
    const related = rep?.sections.find(section => section.heading === 'Documentos relacionados')
    expect(related?.rows.map(row => row.label)).toEqual([
      'Tipo de documento relacionado',
      'Número de documento relacionado',
      'Fecha de generación del documento relacionado'
    ])
    expect(valueOf(rep, 'Total a pagar')).toBeDefined()
  })

  it('the bounds of the picture hold a document with the most items the provider builds', () => {
    expect(FiscalLimits.REPRESENTATION_MAX_TABLE_ROWS).toBeGreaterThan(SvLimits.ITEMS_MAX)
    const lines = Array.from({ length: SvLimits.ITEMS_MAX }, () =>
      line({
        description: 'Clavo',
        quantity: 1,
        unitPriceCents: 113,
        totalCents: 113,
        taxCents: 13
      })
    )
    const big = kept(
      acceptedDocument({
        lines,
        shippingCents: 0,
        shippingTaxCents: 0,
        totalCents: 113 * SvLimits.ITEMS_MAX,
        taxCents: 13 * SvLimits.ITEMS_MAX
      })
    )
    const rep = representDocument(big)
    expect(rep?.table?.rows).toHaveLength(SvLimits.ITEMS_MAX)
    const other =
      (rep?.sections.reduce((sum, section) => sum + section.rows.length, 0) ?? 0) +
      (rep?.totals.length ?? 0) +
      (rep?.footnotes.length ?? 0)
    expect(other).toBeLessThan(FiscalLimits.REPRESENTATION_MAX_OTHER_ROWS)
  })
})
