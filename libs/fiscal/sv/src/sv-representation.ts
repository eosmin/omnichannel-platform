import { FiscalEnvironment } from '@platform/core/domain'
import type {
  FiscalRepresentation,
  FiscalRepresentationRow,
  FiscalRepresentationSection,
  FiscalRepresentationTable,
  StoredFiscalDocument,
  StoredVoidedDocument
} from '@platform/fiscal/sdk'

import { DEPARTMENTS } from './catalogs/departments'
import { IDENTITY_DOCUMENTS } from './catalogs/identity-documents'
import { MUNICIPALITIES } from './catalogs/municipalities'
import { UNITS } from './catalogs/units'
import {
  SvDocumentTypes,
  SvEnvironmentCodes,
  SvProviderDataKeys,
  SvRepresentation
} from './sv-constants'

// The graphic representation of an accepted document (Normativa de Cumplimiento DTE v2.0, apartado 11.3 and Anexo I 4 and 8). It is made
// ONLY from the document as it was kept (the payload that was signed and the data written when the authority accepted it), so it is the
// same every time and never depends on the order, the customer or the issuer as they are now. The values are read from the JSON, as the
// Normativa asks, and shown with the names of the fields of the Anexos. A type is added by describing it in `LAYOUTS`.

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : typeof value === 'number'
      ? String(value)
      : null
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : [])

// Amounts of the summary have two decimals; a unit price keeps the decimals it was made with (up to eight) and never fewer than two
const money = (value: unknown): string => (num(value) ?? 0).toFixed(2)
const price = (value: unknown): string => {
  const amount = num(value) ?? 0
  const trimmed = amount.toFixed(8).replace(/0+$/, '')
  const [whole = '0', decimals = ''] = trimmed.split('.')
  return `${whole}.${decimals.padEnd(2, '0')}`
}

const DEPARTMENT_NAMES = new Map<string, string>(DEPARTMENTS.map(row => [row.code, row.name]))
const MUNICIPALITY_NAMES = new Map<string, string>(
  MUNICIPALITIES.map(row => [`${row.department}:${row.code}`, row.name])
)
const IDENTITY_NAMES = new Map<string, string>(IDENTITY_DOCUMENTS.map(row => [row.code, row.name]))
const UNIT_NAMES = new Map<string, string>(UNITS.map(row => [row.code, row.name]))

// The address as the document gives it, one row for each field of the Anexo (department, municipality, district, complement). Department
// and municipality go by the name of their catalog; the district goes by the CODE the document carries: the catalog of the repository gives
// no municipality for a district code (the same code repeats), so its name cannot be told, and the name is in the complement by the rule of
// field 29. The code is replaced by the name when the whole catalog is here.
function addressRows(value: unknown, role: string): [string, string | null][] {
  const data = isRecord(value) ? value : {}
  const department = text(data['departamento'])
  const municipality = text(data['municipio'])
  return [
    ['Departamento', department === null ? null : (DEPARTMENT_NAMES.get(department) ?? null)],
    [
      'Municipio',
      municipality !== null && department !== null
        ? (MUNICIPALITY_NAMES.get(`${department}:${municipality}`) ?? null)
        : null
    ],
    [`Dirección Distrito (${role})`, text(data['distrito'])],
    ['Complemento', text(data['complemento'])]
  ]
}

// A row that exists only when the document has a value for it
function rows(entries: readonly (readonly [string, string | null])[]): FiscalRepresentationRow[] {
  return entries.flatMap(([label, value]) => (value === null ? [] : [{ label, value }]))
}

const CONDITIONS: Readonly<Record<string, string>> = {
  '1': 'Contado',
  '2': 'A crédito',
  '3': 'Otro'
}

interface Layout {
  // The key of the party of the document that is the receiver, and the column of the table that names the related document
  readonly relatedColumn: boolean
  readonly summary: readonly (readonly [label: string, key: string, always: boolean])[]
}

// What the summary shows of each type, by the names of the fields of the Anexo II: a field the Anexo marks A is always shown; one marked B
// (shown when the law asks for it) only when it is not zero; one marked C (optional) is not shown.
const OPERATIONS: Layout['summary'] = [
  ['Total de operaciones no sujetas', 'totalNoSuj', true],
  ['Total de operaciones exentas', 'totalExenta', true],
  ['Total de operaciones gravadas', 'totalGravada', true],
  ['Suma de operaciones', 'subTotalVentas', true]
]
const GLOBAL_DISCOUNTS: Layout['summary'] = [
  ['Descuento global a ventas no sujetas', 'descuNoSuj', false],
  ['Descuento global a ventas exentas', 'descuExenta', false],
  ['Descuento global a ventas gravadas', 'descuGravada', false]
]
// A credit note and a debit note have the same structure (Anexo II: the fields of the NCE are the ones of the NDE)
const ADJUSTMENT: Layout = {
  relatedColumn: true,
  summary: [
    ...OPERATIONS,
    ['Total IVA Percibido', 'ivaPerci', false],
    ['Total IVA 13%', 'totalIva', false],
    ['Total IVA Retenido', 'ivaRete', false],
    ['Monto total de la operación', 'montoTotalOperacion', true],
    ['Total cargos / abonos que no afectan la base imponible', 'totalNoGravado', false],
    ['Total a pagar', 'totalPagar', true]
  ]
}
const LAYOUTS: Readonly<Record<string, Layout>> = {
  [SvDocumentTypes.INVOICE]: {
    relatedColumn: false,
    summary: [
      ...OPERATIONS,
      ...GLOBAL_DISCOUNTS,
      ['Sub total', 'subTotal', true],
      ['IVA Retenido', 'ivaRete', false],
      ['Monto total de la operación', 'montoTotalOperacion', true],
      ['Total cargos / abonos que no afectan la base imponible', 'totalNoGravado', false],
      ['Total a pagar', 'totalPagar', true]
    ]
  },
  [SvDocumentTypes.TAX_CREDIT]: {
    relatedColumn: false,
    summary: [
      ...OPERATIONS,
      ...GLOBAL_DISCOUNTS,
      ['Sub total', 'subTotal', true],
      ['IVA Percibido', 'ivaPerci', false],
      ['IVA Retenido', 'ivaRete', false],
      ['Monto total de la operación', 'montoTotalOperacion', true],
      ['Total cargos / abonos que no afectan la base imponible', 'totalNoGravado', false],
      ['Total a pagar', 'totalPagar', true]
    ]
  },
  [SvDocumentTypes.CREDIT_NOTE]: ADJUSTMENT,
  [SvDocumentTypes.DEBIT_NOTE]: ADJUSTMENT
}

function identification(id: Json, seal: string | null): FiscalRepresentationSection {
  const model = SvRepresentation.MODELS[Number(id['tipoModelo']) as 1 | 2] ?? null
  const transmission = SvRepresentation.TRANSMISSIONS[Number(id['tipoOperacion']) as 1 | 2] ?? null
  const type = text(id['tipoDte'])
  return {
    heading: 'Identificación',
    rows: [
      { label: 'Versión', value: text(id['version']) ?? SvRepresentation.EMPTY },
      {
        label: 'Tipo de Documento',
        value:
          type === null
            ? SvRepresentation.EMPTY
            : (SvRepresentation.TITLES[type as keyof typeof SvRepresentation.TITLES] ?? type)
      },
      {
        label: 'Código de Generación',
        value: text(id['codigoGeneracion']) ?? SvRepresentation.EMPTY
      },
      { label: 'Número de Control', value: text(id['numeroControl']) ?? SvRepresentation.EMPTY },
      // The seal is always shown: a document made in contingency has none yet (a dash)
      { label: 'Sello de Recepción', value: seal ?? SvRepresentation.NO_SEAL },
      { label: 'Modelo de Facturación', value: model ?? SvRepresentation.EMPTY },
      { label: 'Tipo de Transmisión', value: transmission ?? SvRepresentation.EMPTY },
      { label: 'Fecha de Generación', value: text(id['fecEmi']) ?? SvRepresentation.EMPTY },
      { label: 'Hora de Generación', value: text(id['horEmi']) ?? SvRepresentation.EMPTY }
    ]
  }
}

// The documents the document relates to (a credit note names the one it adjusts: the type, with its description, the number and the date of
// generation of each). Null when it relates none.
function relatedDocuments(value: unknown): FiscalRepresentationSection | null {
  const related = list(value)
  if (related.length === 0) return null
  return {
    heading: 'Documentos relacionados',
    rows: related.flatMap((doc, index) => {
      const type = text(doc['tipoDocumento'])
      const suffix = related.length > 1 ? ` ${index + 1}` : ''
      return [
        {
          label: `Tipo de documento relacionado${suffix}`,
          value:
            type === null
              ? SvRepresentation.EMPTY
              : (SvRepresentation.TITLES[type as keyof typeof SvRepresentation.TITLES] ?? type)
        },
        {
          label: `Número de documento relacionado${suffix}`,
          value: text(doc['numeroDocumento']) ?? SvRepresentation.EMPTY
        },
        {
          label: `Fecha de generación del documento relacionado${suffix}`,
          value: text(doc['fechaEmision']) ?? SvRepresentation.EMPTY
        }
      ]
    })
  }
}

// `role` is the party (Emisor or Receptor); the receiver of an invoice to a final consumer has no address on the picture (the Anexo marks it
// as optional there, C)
function party(
  role: 'Emisor' | 'Receptor',
  value: unknown,
  showAddress: boolean
): FiscalRepresentationSection {
  const data = isRecord(value) ? value : {}
  const kind = text(data['tipoDocumento'])
  return {
    heading: role,
    rows: rows([
      [`Nombre (${role})`, text(data['nombre'])],
      ['Nombre comercial', text(data['nombreComercial'])],
      ['NIT', text(data['nit'])],
      [
        'Tipo de documento de identificación',
        kind === null ? null : (IDENTITY_NAMES.get(kind) ?? kind)
      ],
      [`Número de documento de identificación (${role})`, text(data['numDocumento'])],
      ['NRC', text(data['nrc'])],
      ['Actividad económica', text(data['descActividad'])],
      ...(showAddress ? addressRows(data['direccion'], role) : []),
      ['Teléfono', text(data['telefono'])],
      ['Correo electrónico', text(data['correo'])],
      ...(role === 'Emisor'
        ? ([
            ['Código de establecimiento', text(data['codEstable'])],
            ['Código de punto de venta', text(data['codPuntoVenta'])]
          ] as const)
        : [])
    ])
  }
}

function itemsTable(body: readonly Json[], layout: Layout): FiscalRepresentationTable {
  const columns = [
    'N°',
    ...(layout.relatedColumn ? ['N° Documento relacionado'] : []),
    'Cantidad',
    'Unidad de Medida',
    'Descripción',
    'Precio Unitario',
    'Descuento por ítem',
    'Ventas No Sujetas',
    'Ventas Exentas',
    'Ventas Gravadas'
  ]
  const first = layout.relatedColumn ? 2 : 1
  return {
    columns,
    wideColumn: first + 2,
    numericColumns: [0, first, ...[3, 4, 5, 6, 7].map(offset => first + offset)],
    rows: body.map(item => [
      text(item['numItem']) ?? '',
      ...(layout.relatedColumn ? [text(item['numeroDocumento']) ?? SvRepresentation.EMPTY] : []),
      text(item['cantidad']) ?? '',
      UNIT_NAMES.get(String(item['uniMedida'])) ?? SvRepresentation.EMPTY,
      text(item['descripcion']) ?? '',
      price(item['precioUni']),
      price(item['montoDescu']),
      money(item['ventaNoSuj']),
      money(item['ventaExenta']),
      money(item['ventaGravada'])
    ])
  }
}

// The picture of an accepted document of the types this provider draws, or null (another type, or something that is not a document).
export function representDocument(doc: StoredFiscalDocument): FiscalRepresentation | null {
  const layout = LAYOUTS[doc.documentType]
  const payload = doc.payload
  const id = payload['identificacion']
  const summary = payload['resumen']
  if (layout === undefined || !isRecord(id) || !isRecord(summary)) return null
  const generationCode = text(id['codigoGeneracion'])
  const environment = text(id['ambiente'])
  const issued = text(id['fecEmi'])
  if (generationCode === null || environment === null || issued === null) return null

  const data = doc.providerData ?? {}
  const seal = text(data[SvProviderDataKeys.RECEPTION_SEAL])
  const signed = text(data[SvProviderDataKeys.SIGNED_DOCUMENT])
  const taxes = list(summary['tributos']).map(tax => ({
    label: text(tax['descripcion']) ?? SvRepresentation.EMPTY,
    value: money(tax['valor'])
  }))

  const totals: FiscalRepresentationRow[] = []
  for (const [label, key, always] of layout.summary) {
    if (!always && (num(summary[key]) ?? 0) === 0) continue
    totals.push({ label, value: money(summary[key]) })
    // The taxes sit right after the sum of the sales, where the forms of the authority draw them
    if (key === 'subTotalVentas') totals.push(...taxes)
  }
  const condition = CONDITIONS[String(summary['condicionOperacion'])]
  const footnotes = rows([
    ['Valor en letras', text(summary['totalLetras'])],
    ['Condición de la operación', condition ?? null],
    ['Observaciones', text(summary['observaciones'])]
  ])

  const related = relatedDocuments(payload['documentoRelacionado'])
  const query = new URLSearchParams({
    ambiente: environment,
    codGen: generationCode,
    fechaEmi: issued
  })
  return {
    title: SvRepresentation.TITLES[doc.documentType as keyof typeof SvRepresentation.TITLES],
    name: generationCode,
    notices: environment === '00' ? [SvRepresentation.TEST_NOTICE] : [],
    sections: [
      identification(id, seal),
      party('Emisor', payload['emisor'], true),
      ...(isRecord(payload['receptor'])
        ? [party('Receptor', payload['receptor'], doc.documentType !== SvDocumentTypes.INVOICE)]
        : []),
      ...(related === null ? [] : [related])
    ],
    table: itemsTable(list(payload['cuerpoDocumento']), layout),
    totals,
    footnotes,
    qrUrl: `${SvRepresentation.CONSULT_URL}?${query.toString()}`,
    file:
      signed === null
        ? null
        : {
            filename: `${generationCode}.json`,
            content: { ...payload, firmaElectronica: signed, selloRecibido: seal }
          }
  }
}

// The graphic representation of the event of an invalidation (Manual Funcional v2.0, XXII, page 71) and the file of the event as the authority
// defines it. It is made ONLY from the event as the issuer signed it and the answer of the authority, which holds the seal: a document with no
// seal of the event, or an event that is not what the schema defines, has none (null), never an incomplete one.
export function representVoid(doc: StoredVoidedDocument): FiscalRepresentation | null {
  const event = doc.voidEvent.content
  const id = event['identificacion']
  const issuer = event['emisor']
  const original = event['documento']
  const reason = event['motivo']
  if (!isRecord(id) || !isRecord(issuer) || !isRecord(original) || !isRecord(reason)) return null
  const code = text(id['codigoGeneracion'])
  const originalCode = text(original['codigoGeneracion'])
  const signature = text(doc.voidEvent.signature)
  // The seal is the authority's answer to the event: without it the file is not what the authority holds
  const seal = text(doc.voidResponse?.['selloRecibido'])
  if (code === null || originalCode === null || signature === null || seal === null) return null

  const type = text(original['tipoDte'])
  const kind = text(reason['tipoAnulacion'])
  const originalIdentity = text(original['tipDocumento'] ?? original['tipoDocumento'])
  const person = (role: string, key: 'Responsable' | 'Solicita'): FiscalRepresentationSection => {
    const idType = text(reason[`tipDoc${key}`])
    return {
      heading: role,
      rows: rows([
        ['Nombre', text(reason[`nombre${key}`])],
        [
          'Tipo de documento de identificación',
          idType === null ? null : (IDENTITY_NAMES.get(idType) ?? idType)
        ],
        ['Número de documento de identificación', text(reason[`numDoc${key}`])]
      ])
    }
  }
  const environment = text(id['ambiente'])
  return {
    title: SvRepresentation.VOID_TITLE,
    name: code,
    notices:
      environment === SvEnvironmentCodes[FiscalEnvironment.SANDBOX]
        ? [SvRepresentation.TEST_NOTICE]
        : [],
    sections: [
      {
        heading: 'Identificación',
        rows: [
          { label: 'Versión', value: text(id['version']) ?? SvRepresentation.EMPTY },
          { label: 'Código de Generación', value: code },
          { label: 'Sello de Recepción', value: seal },
          { label: 'Fecha de Generación', value: text(id['fecEmi']) ?? SvRepresentation.EMPTY },
          { label: 'Hora de Generación', value: text(id['horEmi']) ?? SvRepresentation.EMPTY }
        ]
      },
      {
        heading: 'Emisor',
        rows: rows([
          ['Nombre (Emisor)', text(issuer['nombre'])],
          ['NIT', text(issuer['nit'])],
          ['Código de establecimiento', text(issuer['codEstableMH'])],
          ['Código de punto de venta', text(issuer['codPuntoVentaMH'])],
          ['Teléfono', text(issuer['telefono'])],
          ['Correo electrónico', text(issuer['correo'])]
        ])
      },
      {
        heading: 'Receptor del documento invalidado',
        rows: rows([
          ['Nombre (Receptor)', text(original['nombre'])],
          [
            'Tipo de documento de identificación',
            originalIdentity === null
              ? null
              : (IDENTITY_NAMES.get(originalIdentity) ?? originalIdentity)
          ],
          ['Número de documento de identificación', text(original['numDocumento'])],
          ['Teléfono', text(original['telefono'])],
          ['Correo electrónico', text(original['correo'])]
        ])
      },
      {
        heading: 'Documento a invalidar',
        rows: [
          {
            label: 'Tipo de Documento',
            value:
              type === null
                ? SvRepresentation.EMPTY
                : (SvRepresentation.TITLES[type as keyof typeof SvRepresentation.TITLES] ?? type)
          },
          { label: 'Código de Generación', value: originalCode },
          {
            label: 'Número de Control',
            value: text(original['numeroControl']) ?? SvRepresentation.EMPTY
          },
          {
            label: 'Sello de Recepción',
            value: text(original['selloRecibido']) ?? SvRepresentation.EMPTY
          },
          {
            label: 'Fecha de Generación',
            value: text(original['fecEmi']) ?? SvRepresentation.EMPTY
          },
          {
            label: 'Código de Generación que reemplaza al invalidado',
            value: text(original['codigoGeneracionR']) ?? SvRepresentation.EMPTY
          }
        ]
      },
      {
        heading: 'Motivo de la invalidación',
        rows: rows([
          [
            'Tipo de invalidación',
            kind === null ? null : (SvRepresentation.VOID_KINDS[Number(kind) as 1 | 2 | 3] ?? kind)
          ],
          ['Motivo', text(reason['motivoAnulacion'])]
        ])
      },
      person('Quien realiza el evento', 'Responsable'),
      person('Quien solicita la invalidación', 'Solicita')
    ],
    table: null,
    totals: [],
    footnotes: [],
    // The form of the event has no code to scan
    qrUrl: null,
    file: {
      filename: `${code}.json`,
      content: { ...event, firmaElectronica: signature, selloRecibido: seal }
    }
  }
}
