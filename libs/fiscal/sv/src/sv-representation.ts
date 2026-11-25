import type {
  FiscalRepresentation,
  FiscalRepresentationRow,
  FiscalRepresentationSection,
  FiscalRepresentationTable,
  StoredFiscalDocument
} from '@platform/fiscal/sdk'

import { DEPARTMENTS } from './catalogs/departments'
import { MUNICIPALITIES } from './catalogs/municipalities'
import { UNITS } from './catalogs/units'
import { SvDocumentTypes, SvProviderDataKeys, SvRepresentation } from './sv-constants'

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
const UNIT_NAMES = new Map<string, string>(UNITS.map(row => [row.code, row.name]))

// The address as the document gives it: the complement, then the municipality and the department by the name of the catalogs
function addressText(value: unknown): string | null {
  if (!isRecord(value)) return null
  const department = text(value['departamento'])
  const municipality = text(value['municipio'])
  const parts = [
    text(value['complemento']),
    municipality !== null && department !== null
      ? (MUNICIPALITY_NAMES.get(`${department}:${municipality}`) ?? null)
      : null,
    department === null ? null : (DEPARTMENT_NAMES.get(department) ?? null)
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? null : parts.join(', ')
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

// What the summary shows of each type: a field that is always shown (A) and one shown when it is not zero (B: the law asks for it only then)
const LAYOUTS: Readonly<Record<string, Layout>> = {
  [SvDocumentTypes.INVOICE]: {
    relatedColumn: false,
    summary: [
      ['Total No Sujeto', 'totalNoSuj', true],
      ['Total Exento', 'totalExenta', true],
      ['Total Gravado', 'totalGravada', true],
      ['Suma de Ventas', 'subTotalVentas', true],
      ['Descuento total', 'totalDescu', false],
      ['Sub-Total', 'subTotal', true],
      ['IVA incluido en el precio', 'totalIva', true],
      ['IVA Retenido', 'ivaRete', false],
      ['Monto total de la operación', 'montoTotalOperacion', true],
      ['Total a pagar', 'totalPagar', true]
    ]
  },
  [SvDocumentTypes.TAX_CREDIT]: {
    relatedColumn: false,
    summary: [
      ['Total No Sujeto', 'totalNoSuj', true],
      ['Total Exento', 'totalExenta', true],
      ['Total Gravado', 'totalGravada', true],
      ['Suma de Ventas', 'subTotalVentas', true],
      ['Descuento total', 'totalDescu', false],
      ['Sub-Total', 'subTotal', true],
      ['IVA Percibido', 'ivaPerci', false],
      ['IVA Retenido', 'ivaRete', false],
      ['Monto total de la operación', 'montoTotalOperacion', true],
      ['Total a pagar', 'totalPagar', true]
    ]
  },
  [SvDocumentTypes.CREDIT_NOTE]: {
    relatedColumn: true,
    summary: [
      ['Total No Sujeto', 'totalNoSuj', true],
      ['Total Exento', 'totalExenta', true],
      ['Total Gravado', 'totalGravada', true],
      ['Suma de Ventas', 'subTotalVentas', true],
      ['Descuento total', 'totalDescu', false],
      ['IVA Percibido', 'ivaPerci', false],
      ['IVA Retenido', 'ivaRete', false],
      ['Monto total de la operación', 'montoTotalOperacion', true],
      ['Total a pagar', 'totalPagar', true]
    ]
  }
}

function identification(id: Json, seal: string | null): FiscalRepresentationSection {
  const model = SvRepresentation.MODELS[Number(id['tipoModelo']) as 1 | 2] ?? null
  const transmission = SvRepresentation.TRANSMISSIONS[Number(id['tipoOperacion']) as 1 | 2] ?? null
  const date = text(id['fecEmi'])
  const time = text(id['horEmi'])
  return {
    heading: 'Identificación',
    rows: [
      {
        label: 'Código de Generación',
        value: text(id['codigoGeneracion']) ?? SvRepresentation.EMPTY
      },
      { label: 'Número de Control', value: text(id['numeroControl']) ?? SvRepresentation.EMPTY },
      // The seal is always shown: a document made in contingency has none yet (a dash)
      { label: 'Sello de Recepción', value: seal ?? SvRepresentation.NO_SEAL },
      { label: 'Modelo de Facturación', value: model ?? SvRepresentation.EMPTY },
      { label: 'Tipo de Transmisión', value: transmission ?? SvRepresentation.EMPTY },
      {
        label: 'Fecha y Hora de Generación',
        value: date !== null && time !== null ? `${date} ${time}` : SvRepresentation.EMPTY
      }
    ]
  }
}

function party(
  heading: string,
  value: unknown,
  withEstablishment: boolean
): FiscalRepresentationSection {
  const data = isRecord(value) ? value : {}
  return {
    heading,
    rows: rows([
      ['Nombre o razón social', text(data['nombre'])],
      ['Nombre comercial', text(data['nombreComercial'])],
      [
        'NIT',
        text(data['nit']) ?? (data['tipoDocumento'] === '36' ? text(data['numDocumento']) : null)
      ],
      [
        'Documento de identificación',
        data['nit'] === undefined && data['tipoDocumento'] !== '36'
          ? text(data['numDocumento'])
          : null
      ],
      ['NRC', text(data['nrc'])],
      ['Actividad económica', text(data['descActividad'])],
      ['Dirección', addressText(data['direccion'])],
      ['Teléfono', text(data['telefono'])],
      ['Correo electrónico', text(data['correo'])],
      ...(withEstablishment
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
    'Unidad',
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
      ...(isRecord(payload['receptor']) ? [party('Receptor', payload['receptor'], false)] : [])
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
