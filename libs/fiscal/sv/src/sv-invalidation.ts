import { createHash } from 'node:crypto'

import type {
  FiscalIssuerInput,
  FiscalVoidDetails,
  FiscalVoidParty,
  StoredFiscalDocument
} from '@platform/fiscal/sdk'

import { isIdentityDocument } from './sv-catalog'
import {
  SvCodePatterns,
  SvDocumentTypes,
  SvEnvironmentCodes,
  SvHolidays,
  SvInvalidation,
  SvInvalidationAllowed,
  SvInvalidationEnforceDeadline,
  SvIdentityDocuments,
  SvLimits,
  SvProviderDataKeys,
  SvVoidRefusals,
  type SvDocumentType
} from './sv-constants'
import { recordOf, textOf } from './sv-http'
import { digitsOf, identityOf } from './sv-parties'
import { salvadorMoment } from './sv-time'

// The invalidation event of an accepted document (Manual Técnico §4.4, Funcional §VII). Pure: the document, the issuer and the people become
// the event the signer signs, or a code that says what is missing. Nothing here calls the authority.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const GENERATION_CODE = /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/
const SEAL_LENGTH = 40

const daysIn = (year: number, month: number): number =>
  new Date(Date.UTC(year, month, 0)).getUTCDate()
const pad = (value: number, width = 2): string => String(value).padStart(width, '0')

function parts(date: string): { year: number; month: number; day: number } | null {
  const match = DATE.exec(date)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month)
    ? { year, month, day }
    : null
}

// A date some months later, on the same day or on the last day of a shorter month (31 January + 1 month = 28 or 29 February)
export function addMonths(date: string, months: number): string {
  const at = parts(date)
  if (at === null) throw new RangeError('not a date')
  const total = at.year * 12 + (at.month - 1) + months
  const year = Math.floor(total / 12)
  const month = (total % 12) + 1
  return `${pad(year, 4)}-${pad(month)}-${pad(Math.min(at.day, daysIn(year, month)))}`
}

// The date of the n-th business day (Monday to Friday, holidays apart) of the month after the one the date is in
function businessDayOfNextMonth(date: string, n: number, holidays: readonly string[]): string {
  const at = parts(date)
  if (at === null) throw new RangeError('not a date')
  const next = addMonths(`${pad(at.year, 4)}-${pad(at.month)}-01`, 1)
  const [year, month] = [Number(next.slice(0, 4)), Number(next.slice(5, 7))]
  let count = 0
  for (let day = 1; day <= daysIn(year, month); day += 1) {
    const iso = `${pad(year, 4)}-${pad(month)}-${pad(day)}`
    const weekday = new Date(`${iso}T00:00:00Z`).getUTCDay()
    if (weekday === 0 || weekday === 6 || holidays.includes(iso)) continue
    count += 1
    if (count === n) return iso
  }
  throw new RangeError('the month has fewer business days than asked')
}

// The last day a document may be invalidated, as yyyy-MM-dd: an invoice, three months after its date; a tax credit document or a credit
// note, the tenth business day of the month after its own
export function invalidationDeadline(
  type: SvDocumentType,
  issueDate: string,
  holidays: readonly string[] = SvHolidays
): string {
  return type === SvDocumentTypes.INVOICE
    ? addMonths(issueDate, SvInvalidation.INVOICE_MONTHS)
    : businessDayOfNextMonth(issueDate, SvInvalidation.BUSINESS_DAYS_OF_NEXT_MONTH, holidays)
}

// The generation code of an event: the same for the same request (its key), so that an invalidation sent again is the same event and the
// authority answers it as the one it has. The shape of a version 4 UUID, in capitals as the schema asks.
export function invalidationCode(seed: string): string {
  const hex = createHash('sha256').update(`sv-invalidation:${seed}`).digest('hex')
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`.toUpperCase()
}

// What the invalidation says about the original document, read from what was kept of it
export interface SvInvalidated {
  readonly type: SvDocumentType
  readonly generationCode: string
  readonly controlNumber: string
  readonly issueDate: string
  readonly seal: string
}

const isDocumentType = (value: string): value is SvDocumentType =>
  (Object.values(SvDocumentTypes) as string[]).includes(value)

export function invalidatedOf(doc: StoredFiscalDocument): SvInvalidated | null {
  const id = recordOf(doc.payload['identificacion'])
  const type = textOf(id['tipoDte'])
  const generationCode = textOf(id['codigoGeneracion'])
  const controlNumber = textOf(id['numeroControl'])
  const issueDate = textOf(id['fecEmi'])
  const seal = textOf(doc.providerData?.[SvProviderDataKeys.RECEPTION_SEAL])
  return type === null ||
    !isDocumentType(type) ||
    generationCode === null ||
    !GENERATION_CODE.test(generationCode) ||
    controlNumber === null ||
    !SvCodePatterns.CONTROL_NUMBER.test(controlNumber) ||
    issueDate === null ||
    parts(issueDate) === null ||
    seal === null ||
    seal.length !== SEAL_LENGTH
    ? null
    : { type, generationCode, controlNumber, issueDate, seal }
}

export type SvInvalidationBuilt =
  | { readonly ok: true; readonly event: Record<string, unknown>; readonly original: SvInvalidated }
  | { readonly ok: false; readonly reason: string }

const refuse = (reason: string): SvInvalidationBuilt => ({ ok: false, reason })

// A person of the event as the authority's schema takes them; null when the name or the number is empty or too long
export function partyOf(
  party: FiscalVoidParty | undefined
): { name: string; idType: string; idNumber: string } | null {
  if (party === undefined) return null
  const name = party.name.trim()
  const idType = party.idType.trim()
  // The type is one of CAT-022 and the number has the form of its type (a tax number or a national id are digits, whatever the dashes)
  const identity = isIdentityDocument(idType) ? identityOf(party.idNumber, idType) : null
  return name === '' ||
    name.length > SvInvalidation.PARTY_NAME_MAX ||
    identity === null ||
    identity.number.length > SvInvalidation.PARTY_ID_MAX
    ? null
    : { name, idType, idNumber: identity.number }
}

// The receiver as the event repeats it: the identity document and the contact, as the document had them (an invoice with no receiver has none)
function receiverOf(payload: Readonly<Record<string, unknown>>): {
  tipoDocumento: string | null
  numDocumento: string | null
  nombre: string | null
  telefono: string | null
  correo: string | null
} {
  const receiver = recordOf(payload['receptor'])
  const tax = textOf(receiver['nit'])
  const phone = textOf(receiver['telefono'])
  const number = textOf(receiver['numDocumento']) ?? tax
  return {
    tipoDocumento:
      textOf(receiver['tipoDocumento']) ?? (tax === null ? null : SvIdentityDocuments.TAX_ID),
    numDocumento: number,
    nombre: textOf(receiver['nombre']),
    // The schema asks at least eight characters of a phone that is there
    telefono: phone !== null && phone.length >= SvLimits.PHONE_MIN ? phone : null,
    correo: textOf(receiver['correo'])
  }
}

export interface SvInvalidationInput {
  readonly doc: StoredFiscalDocument
  readonly issuer: FiscalIssuerInput
  readonly reason: string
  readonly details: FiscalVoidDetails | undefined
  // The generation code of the event (`invalidationCode`) and the instant it is made
  readonly code: string
  readonly now: string
  readonly holidays?: readonly string[]
}

export function buildInvalidation(input: SvInvalidationInput): SvInvalidationBuilt {
  const { doc, issuer, details } = input
  const original = invalidatedOf(doc)
  if (original === null) return refuse(SvVoidRefusals.DOCUMENT_INCOMPLETE)
  if (!SvInvalidationAllowed[original.type]) return refuse(SvVoidRefusals.NOT_ALLOWED)
  // The event repeats the receiver of the document: a number the schema would not take is never cut, the document is refused as unreadable
  const receiver = receiverOf(doc.payload)
  if (
    (receiver.numDocumento?.length ?? 0) > SvInvalidation.PARTY_ID_MAX ||
    (receiver.nombre?.length ?? 0) > SvLimits.NAME_MAX ||
    (receiver.correo?.length ?? 0) > SvLimits.EMAIL_MAX ||
    (receiver.telefono?.length ?? 0) > SvLimits.PHONE_MAX
  ) {
    return refuse(SvVoidRefusals.DOCUMENT_INCOMPLETE)
  }

  const nit = digitsOf(issuer.taxId)
  const phone = (issuer.phone ?? '').trim()
  const email = (issuer.email ?? '').trim()
  const establishment = (issuer.establishmentCode ?? '').trim()
  const pointOfSale = (issuer.pointOfSaleCode ?? '').trim()
  if (
    !SvCodePatterns.TAX_ID.test(nit) ||
    issuer.legalName.trim() === '' ||
    issuer.legalName.trim().length > SvLimits.NAME_MAX ||
    !SvCodePatterns.ESTABLISHMENT.test(establishment) ||
    !SvCodePatterns.POINT_OF_SALE.test(pointOfSale) ||
    phone.length < SvLimits.PHONE_MIN ||
    phone.length > SvLimits.PHONE_MAX ||
    email === '' ||
    email.length > SvLimits.EMAIL_MAX
  ) {
    return refuse(SvVoidRefusals.ISSUER_INCOMPLETE)
  }

  const kind = details?.kind
  if (kind === undefined) return refuse(SvVoidRefusals.KIND_REQUIRED)
  const reason = input.reason.trim()
  if (reason === '' || reason.length > SvInvalidation.REASON_MAX) {
    return refuse(SvVoidRefusals.REASON_INVALID)
  }
  if (details?.responsible === undefined || details.requester === undefined) {
    return refuse(SvVoidRefusals.PARTIES_REQUIRED)
  }
  const responsible = partyOf(details.responsible)
  const requester = partyOf(details.requester)
  if (responsible === null || requester === null) return refuse(SvVoidRefusals.PARTY_INVALID)

  // The document that takes its place is named first (a correction, or another reason that replaces it); a rescission names none
  let replacementCode: string | null = null
  if (SvInvalidation.KINDS_WITH_REPLACEMENT.includes(kind)) {
    if (details.replacement === undefined) return refuse(SvVoidRefusals.REPLACEMENT_REQUIRED)
    const other = invalidatedOf(details.replacement)
    if (other === null || other.generationCode === original.generationCode) {
      return refuse(SvVoidRefusals.REPLACEMENT_INVALID)
    }
    replacementCode = other.generationCode
  }

  const moment = salvadorMoment(input.now)
  // A deadline counted in business days is enforced only with a list of holidays (without it the count could end too early)
  const holidays = input.holidays ?? SvHolidays
  const countable = original.type === SvDocumentTypes.INVOICE || holidays.length > 0
  if (
    SvInvalidationEnforceDeadline &&
    countable &&
    moment.date > invalidationDeadline(original.type, original.issueDate, holidays)
  ) {
    return refuse(SvVoidRefusals.DEADLINE_PASSED)
  }

  return {
    ok: true,
    original,
    event: {
      identificacion: {
        version: SvInvalidation.VERSION,
        ambiente: SvEnvironmentCodes[issuer.environment],
        codigoGeneracion: input.code,
        fecEmi: moment.date,
        horEmi: moment.time,
        fusion: null
      },
      emisor: {
        nit,
        nombre: issuer.legalName.trim(),
        codEstableMH: establishment,
        codEstable: null,
        codPuntoVentaMH: pointOfSale,
        codPuntoVenta: null,
        telefono: phone,
        correo: email
      },
      documento: {
        tipoDte: original.type,
        codigoGeneracion: original.generationCode,
        selloRecibido: original.seal,
        numeroControl: original.controlNumber,
        fecEmi: original.issueDate,
        codigoGeneracionR: replacementCode,
        ...receiver
      },
      motivo: {
        tipoAnulacion: SvInvalidation.KINDS[kind],
        motivoAnulacion: reason,
        nombreResponsable: responsible.name,
        tipDocResponsable: responsible.idType,
        numDocResponsable: responsible.idNumber,
        nombreSolicita: requester.name,
        tipDocSolicita: requester.idType,
        numDocSolicita: requester.idNumber
      }
    }
  }
}
