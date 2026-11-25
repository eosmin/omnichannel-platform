import { FiscalDocumentKind, FiscalEnvironment } from '@platform/core/domain'
import type { StoredFiscalDocument } from '@platform/fiscal/sdk'

import { SvProviderDataKeys, SvRepresentation } from './sv-constants'
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
    expect(valueOf(rep, 'Fecha y Hora de Generación')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
    )
  })

  it('names the issuer with its address by the names of the catalogs', () => {
    const rep = representDocument(invoice())
    expect(valueOf(rep, 'Nombre o razón social')).toBe(ISSUER.legalName)
    expect(valueOf(rep, 'NIT')).toBe('06140101011011')
    expect(valueOf(rep, 'Dirección')).toContain('Calle 1, Colonia Centro')
    expect(valueOf(rep, 'Dirección')).toContain('San Salvador')
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
      expect.arrayContaining(['Nombre o razón social', 'NIT', 'NRC', 'Dirección'])
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
})
