import {
  FiscalAnnexError,
  type FiscalAnnexDocument,
  type FiscalAnnexExporter,
  type FiscalAnnexFile,
  type FiscalAnnexPeriod
} from '@platform/fiscal/sdk'

import {
  SvAnnex,
  SvAnnexErrors,
  SvAnnexIds,
  SvDocumentTypes,
  SvIdentityDocuments,
  SvProviderDataKeys,
  SvVat
} from './sv-constants'
import { salvadorMoment } from './sv-time'

// The annexes of the monthly VAT return (F-07) as the Ministerio de Hacienda loads them: "Manual de Anexos del Formulario de IVA F-07",
// version 14 (January 2025), public (transparencia.mh.gob.sv, DGII manual of annexes). Pure: the documents of the month in, the file out,
// with no clock and no randomness, so the same documents give the same bytes.
//
// What every file shares (manual p.3-6): a CSV with semicolons, no header, a date as DD/MM/YYYY, an amount with a point, two decimals and no
// thousands separator, the last column the number of the annex. The figures are read from the JSON of the document as it was signed, in
// whole cents (a figure that is not one is refused, never rounded), and written with integer arithmetic: no float is ever formatted.
// The month, the day and the hour are the ones of the document, in the time of El Salvador (UTC-6), by arithmetic on the text, never by the
// zone of the machine.

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const textOf = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null
const digitsOf = (value: unknown): string =>
  (typeof value === 'string' || typeof value === 'number' ? String(value) : '').replace(/\D/g, '')

const unreadable = (): never => {
  throw new FiscalAnnexError(SvAnnexErrors.UNREADABLE)
}

// A figure of the JSON in whole cents. The documents are written with two decimals; anything else is a document nobody should declare.
const NO_FRACTION_CENTS = 1e-6
function centsOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return unreadable()
  const cents = Math.round(value * 100)
  if (Math.abs(value * 100 - cents) > NO_FRACTION_CENTS) return unreadable()
  return cents
}

// An amount of the file: "1234.50", "0.05", "-1.20"; never a separator of thousands
export function annexMoney(cents: number): string {
  if (!Number.isSafeInteger(cents)) return unreadable()
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

// DD/MM/YYYY from yyyy-MM-dd
function dateCell(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`
}

// A text of the file: the separator, the quote, the control characters and the line breaks never travel inside a cell, and a leading
// sign or space is dropped (security): the name of a customer is data of the customer, and the accountant opens the file in a
// spreadsheet, where a name that starts with = + - or @ is a formula. It is the choice of data, not an apostrophe: the loader of the
// authority does not read one. A legal name that starts with a sign loses it ([ACCOUNTANT] in the plan).
const CELL_BREAKERS = /[;"\p{Cc}]+/gu
const FORMULA_START = /^[=+\-@\s]+/
function textCell(value: string): string {
  return value.replace(CELL_BREAKERS, ' ').replace(/\s+/g, ' ').replace(FORMULA_START, '').trim()
}

// The files: rows of cells joined as the manual asks, each row ended; an empty month is an empty file
function fileOf(
  id: string,
  period: FiscalAnnexPeriod,
  rows: readonly (readonly string[])[]
): FiscalAnnexFile {
  return {
    id,
    filename: `${SvAnnex.FILE_PREFIX}-${id}-${periodKey(period)}.${SvAnnex.FILE_EXTENSION}`,
    rows: rows.length,
    content: rows.map(row => `${row.join(SvAnnex.SEPARATOR)}${SvAnnex.LINE_END}`).join('')
  }
}

const periodKey = (period: FiscalAnnexPeriod): string =>
  `${period.year}-${String(period.month).padStart(2, '0')}`

// What the files read of a document
interface Parsed {
  readonly document: FiscalAnnexDocument
  readonly type: string
  // yyyy-MM-dd and HH:mm:ss of its generation, in the time of El Salvador
  readonly date: string
  readonly time: string
  readonly control: string
  readonly generationCode: string
  readonly receiver: Json
  readonly summary: Json
}

function parse(document: FiscalAnnexDocument): Parsed {
  const id = document.payload['identificacion']
  const summary = document.payload['resumen']
  if (!isRecord(id) || !isRecord(summary)) return unreadable()
  const type = textOf(id['tipoDte'])
  const date = textOf(id['fecEmi'])
  const time = textOf(id['horEmi'])
  const control = textOf(id['numeroControl'])
  const code = textOf(id['codigoGeneracion'])
  if (
    type === null ||
    type !== document.documentType ||
    date === null ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    time === null ||
    control === null ||
    code === null
  ) {
    return unreadable()
  }
  const receiver = document.payload['receptor']
  return {
    document,
    type,
    date,
    time,
    control,
    generationCode: code.toUpperCase(),
    receiver: isRecord(receiver) ? receiver : {},
    summary
  }
}

const byGeneration = (a: Parsed, b: Parsed): number =>
  a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.control.localeCompare(b.control)

// The seal of reception, 40 characters: a document with none (made in contingency, not reported yet) is not declared before it has one
function sealOf(parsed: Parsed): string {
  const seal = textOf(parsed.document.providerData?.[SvProviderDataKeys.RECEPTION_SEAL])
  if (seal === null) throw new FiscalAnnexError(SvAnnexErrors.UNSEALED)
  return seal
}

// The month a voided document leaves the declaration in: the day the invalidation was accepted, in the time of El Salvador
const voidMonthOf = (document: FiscalAnnexDocument): string | null =>
  document.voidedAt === null
    ? null
    : salvadorMoment(document.voidedAt.toISOString()).date.slice(0, 7)

// The sales of the annexes are the documents issued in the month and still valid at its end (manual p.8: "sin incluir anulados"): one that
// was voided in the same month or before is in the annex of the voided ones, and one voided later was a sale of its month when it was
// declared, so a month asked again keeps the figures it had
function issuedAndValid(
  documents: readonly FiscalAnnexDocument[],
  types: readonly string[],
  period: FiscalAnnexPeriod
): Parsed[] {
  const key = periodKey(period)
  return (
    documents
      .filter(document => types.includes(document.documentType))
      // The month first and the reading after: a document of the days around the month that cannot be read is not this month's problem
      .filter(document => monthOfIssue(document) === key)
      .map(parse)
      .filter(parsed => {
        const voidMonth = voidMonthOf(parsed.document)
        return voidMonth === null || voidMonth > key
      })
      .sort(byGeneration)
  )
}

// The month a document was issued in, read leniently (an unreadable payload falls back to the instant it was issued at)
function monthOfIssue(document: FiscalAnnexDocument): string {
  const id = document.payload['identificacion']
  const date = isRecord(id) ? textOf(id['fecEmi']) : null
  return date !== null && /^\d{4}-\d{2}-/.test(date)
    ? date.slice(0, 7)
    : salvadorMoment(document.issuedAt.toISOString()).date.slice(0, 7)
}

// Whole months from one yyyy-MM to another (the second is the later)
function monthsBetween(from: string, to: string): number {
  const index = (key: string): number => Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7))
  return index(to) - index(from)
}

const rentApplies = (period: FiscalAnnexPeriod): boolean =>
  periodKey(period) >= SvAnnex.RENT_COLUMNS_FROM

// "Tipo de operación (Renta)" from the amounts (manual p.7): taxed only, not taxed or exempt only, or both
function operationOf(taxedCents: number, otherCents: number): string {
  if (taxedCents !== 0 && otherCents !== 0) return SvAnnex.OPERATION_MIXED
  return taxedCents !== 0 ? SvAnnex.OPERATION_TAXED : SvAnnex.OPERATION_NOT_TAXED
}

// The VAT of a tax credit document or a note: the tribute 20 of the summary, or the total tax the notes carry
function taxOf(summary: Json): number {
  const tributes = summary['tributos']
  if (Array.isArray(tributes)) {
    return tributes
      .filter(isRecord)
      .filter(tribute => tribute['codigo'] === SvVat.CODE)
      .reduce((sum, tribute) => sum + centsOf(tribute['valor']), 0)
  }
  return summary['totalIva'] === undefined ? 0 : centsOf(summary['totalIva'])
}

// ANNEX 1, sales to taxpayers, columns A to T (manual V14, p.5-8): a row for each tax credit document (03), credit note (05) and debit note
// (06). A credit note is written with positive figures and its type: "no debe ingresar valores negativos" (p.6-7), the negative figures
// are for the voided documents of the annex of consumers only (p.14).
function salesTaxpayers(
  documents: readonly FiscalAnnexDocument[],
  period: FiscalAnnexPeriod
): FiscalAnnexFile {
  const rows = issuedAndValid(
    documents,
    [SvDocumentTypes.TAX_CREDIT, SvDocumentTypes.CREDIT_NOTE, SvDocumentTypes.DEBIT_NOTE],
    period
  ).map(parsed => {
    const exempt = centsOf(parsed.summary['totalExenta'])
    const notSubject = centsOf(parsed.summary['totalNoSuj'])
    const taxed = centsOf(parsed.summary['totalGravada'])
    const tax = taxOf(parsed.summary)
    // Columns N and O (sales for third parties not domiciled) are not made by this platform: 0.00
    const thirdParties = 0
    // P is J + K + L + N: the tax (M) and the tax of third parties (O) are NOT part of it (the summary screen of the load, manual p.9, adds
    // exempt, not subject, local taxed and third parties and shows the tax apart)
    const total = exempt + notSubject + taxed + thirdParties
    const identity = receiverIdentity(parsed.receiver)
    const rent = rentApplies(period)
    return [
      dateCell(parsed.date), // A fecha de emisión
      SvAnnex.DOCUMENT_CLASS_DTE, // B clase de documento: 4 DTE
      parsed.type, // C tipo de documento: 03, 05, 06
      parsed.control.replace(/-/g, ''), // D número de resolución: DTE, the control number with no dashes (p.6)
      sealOf(parsed), // E serie: DTE, the seal of reception (p.6)
      parsed.generationCode.replace(/-/g, ''), // F número de documento: DTE, the generation code with no dashes (p.6)
      '', // G control interno: blank in a DTE (p.6)
      identity.taxpayer, // H NIT o NRC; empty when the DUI is given (p.6-7)
      textCell(textOf(parsed.receiver['nombre']) ?? ''), // I nombre o razón social
      annexMoney(exempt), // J ventas exentas
      annexMoney(notSubject), // K ventas no sujetas
      annexMoney(taxed), // L ventas gravadas locales
      annexMoney(tax), // M débito fiscal
      annexMoney(thirdParties), // N ventas por cuenta de terceros no domiciliados
      annexMoney(0), // O débito fiscal por cuenta de terceros
      annexMoney(total), // P total ventas: J + K + L + N, never M or O
      identity.dui, // Q DUI del cliente (persona natural)
      rent ? operationOf(taxed, exempt + notSubject) : SvAnnex.RENT_NOT_APPLICABLE, // R tipo de operación (renta)
      rent ? SvAnnex.INCOME_COMMERCIAL : SvAnnex.RENT_NOT_APPLICABLE, // S tipo de ingreso (renta)
      SvAnnex.NUMBER_TAXPAYERS // T número de anexo
    ]
  })
  return fileOf(SvAnnexIds.SALES_TAXPAYERS, period, rows)
}

// The identity of the customer of a document to a taxpayer: the NIT (14 digits) or else the NRC without leading zeros in H, or the DUI
// (9 digits) in Q with H empty (p.6-7: a natural person with a DUI leaves H completely empty). Neither is a document nobody can declare.
function receiverIdentity(receiver: Json): { taxpayer: string; dui: string } {
  const number = digitsOf(textOf(receiver['nit']) ?? textOf(receiver['numDocumento']))
  const kind = textOf(receiver['tipoDocumento'])
  const isDui =
    (kind === null ? number.length === 9 : kind === SvIdentityDocuments.NATIONAL_ID) &&
    number !== ''
  if (isDui) return { taxpayer: '', dui: number }
  const nit = number
  const nrc = digitsOf(receiver['nrc']).replace(/^0+/, '')
  const taxpayer = nit !== '' ? nit : nrc
  if (taxpayer === '') return unreadable()
  return { taxpayer, dui: '' }
}

// ANNEX 2, sales to final consumers, columns A to W (manual V14, p.11-16): the electronic invoices (01) GROUPED BY DAY, one row for each day
// and type, with the generation code of the first and of the last of the day (p.12-13); resolution, series and internal control are "N/A"
// and the cash register is blank. The taxed sales carry the tax inside (p.13).
function salesConsumers(
  documents: readonly FiscalAnnexDocument[],
  period: FiscalAnnexPeriod
): FiscalAnnexFile {
  const days = new Map<
    string,
    {
      date: string
      type: string
      exempt: number
      notSubject: number
      taxed: number
      first: string
      last: string
    }
  >()
  const add = (parsed: Parsed, sign: 1 | -1): void => {
    const code = parsed.generationCode.replace(/-/g, '')
    // A voided document is its own row (first = last = its code), never added to the row of a day: the manual does not say how a negative
    // figure is written, and a row of its own is the one that can be told apart
    const key =
      sign === 1 ? `${parsed.date}|${parsed.type}|1` : `${parsed.date}|${parsed.type}|-1|${code}`
    const day = days.get(key) ?? {
      date: parsed.date,
      type: parsed.type,
      exempt: 0,
      notSubject: 0,
      taxed: 0,
      first: code,
      last: code
    }
    day.exempt += sign * centsOf(parsed.summary['totalExenta'])
    day.notSubject += sign * centsOf(parsed.summary['totalNoSuj'])
    day.taxed += sign * centsOf(parsed.summary['totalGravada'])
    // The documents come in order of generation: the last one seen is the last of the day
    day.last = code
    days.set(key, day)
  }
  for (const parsed of issuedAndValid(documents, [SvDocumentTypes.INVOICE], period)) add(parsed, 1)
  // A document voided in a LATER month, within three periods of its issue, is written again with NEGATIVE figures and the date of the
  // original, in the annex of the month of its invalidation (manual p.11 column A: the date may be of three previous periods for voided
  // documents; p.14: negative values only for voided documents, article 111 of the Tax Code). Out of the three periods nothing is written:
  // the authority does not take it (a debt of the plan).
  const key = periodKey(period)
  for (const parsed of documents
    .filter(document => document.documentType === SvDocumentTypes.INVOICE)
    .filter(document => voidMonthOf(document) === key && monthOfIssue(document) < key)
    .map(parse)
    .filter(parsed => monthsBetween(parsed.date.slice(0, 7), key) <= SvAnnex.VOID_MAX_PERIODS_BACK)
    .sort(byGeneration)) {
    add(parsed, -1)
  }
  const rent = rentApplies(period)
  // In the order of the date of each row: the voided of the earlier months come first
  const rows = [...days.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(day => {
      // L (exempt sales not subject to proportionality) and O to S (exports, free zones, third parties) are not made by this platform: 0.00
      const total = day.exempt + day.notSubject + day.taxed
      return [
        dateCell(day.date), // A fecha de emisión
        SvAnnex.DOCUMENT_CLASS_DTE, // B clase de documento: 4 DTE
        day.type, // C tipo de documento: 01
        SvAnnex.NOT_APPLICABLE, // D número de resolución
        SvAnnex.NOT_APPLICABLE, // E serie
        SvAnnex.NOT_APPLICABLE, // F control interno del
        SvAnnex.NOT_APPLICABLE, // G control interno al
        day.first, // H número de documento del: generation code of the first DTE of the day
        day.last, // I número de documento al: generation code of the last DTE of the day
        '', // J máquina registradora: blank in a DTE (p.13)
        annexMoney(day.exempt), // K ventas exentas
        annexMoney(0), // L ventas internas exentas no sujetas a proporcionalidad
        annexMoney(day.notSubject), // M ventas no sujetas
        annexMoney(day.taxed), // N ventas gravadas locales, tax included
        annexMoney(0), // O exportaciones dentro del área centroamericana
        annexMoney(0), // P exportaciones fuera del área centroamericana
        annexMoney(0), // Q exportaciones de servicios
        annexMoney(0), // R ventas a zonas francas y DPA (tasa cero)
        annexMoney(0), // S ventas a cuenta de terceros no domiciliados
        annexMoney(total), // T total ventas: K to S (the manual gives no formula; by analogy with the annex 1 and column N, with the tax inside)
        rent ? operationOf(day.taxed, day.exempt + day.notSubject) : SvAnnex.RENT_NOT_APPLICABLE, // U tipo de operación (renta)
        rent ? SvAnnex.INCOME_COMMERCIAL : SvAnnex.RENT_NOT_APPLICABLE, // V tipo de ingreso (renta)
        SvAnnex.NUMBER_CONSUMERS // W número de anexo
      ]
    })
  return fileOf(SvAnnexIds.SALES_CONSUMERS, period, rows)
}

// ANNEX of the voided documents, columns A to J (manual V14, p.60-63): a DTE that was invalidated in the month. It is listed in the month of
// its invalidation, whatever month it was issued in (up to three periods back, article 111 of the Tax Code: the authority checks it).
function voided(
  documents: readonly FiscalAnnexDocument[],
  period: FiscalAnnexPeriod
): FiscalAnnexFile {
  const key = periodKey(period)
  const rows = documents
    .filter(document => voidMonthOf(document) === key)
    .map(parse)
    .sort(
      (a, b) =>
        (a.document.voidedAt?.getTime() ?? 0) - (b.document.voidedAt?.getTime() ?? 0) ||
        byGeneration(a, b)
    )
    .map(parsed => {
      if (parsed.generationCode.length !== SvAnnex.GENERATION_CODE_LENGTH) return unreadable()
      return [
        // A número de resolución: DTE, the control number (from October 2022). The manual contradicts itself on the dashes ("incluyendo
        // guiones" and "longitud máxima de 100 caracteres sin guiones"; the other annexes say none): the literal reading is WITH them, one
        // constant to change once a load of the file in a real return, not filed, confirms it
        SvAnnex.VOIDED_CONTROL_NUMBER_WITH_DASHES
          ? parsed.control
          : parsed.control.replace(/-/g, ''),
        SvAnnex.DOCUMENT_CLASS_DTE, // B clase de documento: 4 DTE
        SvAnnex.ZERO, // C desde preimpreso: 0 in a DTE
        SvAnnex.ZERO, // D hasta preimpreso: 0 in a DTE
        parsed.type, // E tipo de documento
        SvAnnex.DETAIL_DTE_INVALIDATED, // F tipo de detalle: D, a DTE invalidated
        sealOf(parsed), // G serie: the seal of reception, 40 characters
        SvAnnex.ZERO, // H desde: 0 in a DTE
        SvAnnex.ZERO, // I hasta: 0 in a DTE
        parsed.generationCode // J código de generación: 36 characters, with dashes (p.62)
      ]
    })
  return fileOf(SvAnnexIds.VOIDED, period, rows)
}

type AnnexBuilder = (
  documents: readonly FiscalAnnexDocument[],
  period: FiscalAnnexPeriod
) => FiscalAnnexFile

// A Map: an id such as "constructor" is not an annex
const BUILDERS = new Map<string, AnnexBuilder>([
  [SvAnnexIds.SALES_TAXPAYERS, salesTaxpayers],
  [SvAnnexIds.SALES_CONSUMERS, salesConsumers],
  [SvAnnexIds.VOIDED, voided]
])

export const svAnnexes: FiscalAnnexExporter = {
  ids: [...BUILDERS.keys()],
  build(id, period, documents) {
    return BUILDERS.get(id)?.(documents, period) ?? null
  }
}
