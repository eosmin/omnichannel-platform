import type { BuiltDocument, FiscalContingencyEvent, FiscalIssuerInput } from '@platform/fiscal/sdk'

import {
  SvCodePatterns,
  SvContingency,
  SvContingencyReasonCodes,
  SvContingencyRefusals,
  SvEnvironmentCodes,
  SvLimits,
  SvTransmission
} from './sv-constants'
import { recordOf, textOf } from './sv-http'
import { partyOf } from './sv-invalidation'
import { digitsOf, issuerProblems } from './sv-parties'
import { salvadorMoment } from './sv-time'

// The event that reports a contingency to the authority (Manual Técnico §3.3; schema `contingencia-schema-v4`): the window, the reason and
// the documents made in it, by their generation code. Pure. A refusal is a code of this provider's own (nothing is sent), never a value.

export type SvContingencyBuilt =
  | { readonly ok: true; readonly event: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string }

const refuse = (reason: string): SvContingencyBuilt => ({ ok: false, reason })

// What the event says of one document: its type and its generation code, read from what was built and kept
export function listedOf(
  built: Pick<BuiltDocument, 'payload'>
): { type: string; generationCode: string } | null {
  const id = recordOf(built.payload['identificacion'])
  const type = textOf(id['tipoDte'])
  const generationCode = textOf(id['codigoGeneracion'])
  return type === null || generationCode === null ? null : { type, generationCode }
}

export function buildContingencyEvent(
  input: FiscalContingencyEvent,
  issuer: FiscalIssuerInput,
  now: string
): SvContingencyBuilt {
  if (!SvContingencyReasonCodes.includes(input.reason)) {
    return refuse(SvContingencyRefusals.REASON_UNKNOWN)
  }
  const reason = Number(input.reason)
  // The words of a person travel only with the reason "other" (the catalog has no field for them elsewhere)
  const motive = input.motive?.trim() ?? ''
  if (reason === SvContingency.REASONS.OTHER && motive === '') {
    return refuse(SvContingencyRefusals.MOTIVE_REQUIRED)
  }
  if (reason === SvContingency.REASONS.OTHER && motive.length > SvContingency.MOTIVE_MAX) {
    return refuse(SvContingencyRefusals.MOTIVE_TOO_LONG)
  }
  // The generation code of the event is the schema's: a UUID, which is checked here and not after the login and the signature
  if (!SvCodePatterns.GENERATION_CODE.test(input.eventId.toUpperCase())) {
    return refuse(SvContingencyRefusals.EVENT_ID_INVALID)
  }

  const nit = digitsOf(issuer.taxId)
  const phone = (issuer.phone ?? '').trim()
  const email = (issuer.email ?? '').trim()
  const establishment = (issuer.establishmentCode ?? '').trim()
  const pointOfSale = (issuer.pointOfSaleCode ?? '').trim()
  const kind = (issuer.establishmentType ?? '').trim()
  if (
    issuerProblems(issuer).length > 0 ||
    !SvCodePatterns.TAX_ID.test(nit) ||
    issuer.legalName.trim() === '' ||
    issuer.legalName.trim().length > SvLimits.NAME_MAX ||
    !SvCodePatterns.ESTABLISHMENT.test(establishment) ||
    !SvCodePatterns.POINT_OF_SALE.test(pointOfSale) ||
    kind === '' ||
    phone.length < SvLimits.PHONE_MIN ||
    phone.length > SvLimits.PHONE_MAX ||
    email === '' ||
    email.length > SvLimits.EMAIL_MAX
  ) {
    return refuse(SvContingencyRefusals.ISSUER_INCOMPLETE)
  }

  if (input.responsible === null) return refuse(SvContingencyRefusals.RESPONSIBLE_REQUIRED)
  const responsible = partyOf(input.responsible)
  if (responsible === null) {
    return refuse(SvContingencyRefusals.PARTY_INVALID)
  }

  if (input.documents.length === 0) return refuse(SvContingencyRefusals.DOCUMENTS_INVALID)
  if (input.documents.length > SvContingency.MAX_DOCUMENTS) {
    return refuse(SvContingencyRefusals.TOO_MANY_DOCUMENTS)
  }
  const listed: { noItem: number; tipoDoc: string; codigoGeneracion: string }[] = []
  const seen = new Set<string>()
  for (const [index, doc] of input.documents.entries()) {
    const about = listedOf(doc)
    // A document that is not a deferred one of this reason and this environment, or that is listed twice, is not a thing the authority
    // takes: the event must say what its documents say
    const id = recordOf(doc.payload['identificacion'])
    if (
      about === null ||
      seen.has(about.generationCode) ||
      id['tipoOperacion'] !== SvTransmission.OPERATION_CONTINGENCY ||
      id['tipoContingencia'] !== reason ||
      id['ambiente'] !== SvEnvironmentCodes[issuer.environment]
    ) {
      return refuse(SvContingencyRefusals.DOCUMENTS_INVALID)
    }
    seen.add(about.generationCode)
    listed.push({ noItem: index + 1, tipoDoc: about.type, codigoGeneracion: about.generationCode })
  }

  const started = new Date(input.startedAt)
  const ended = new Date(input.endedAt)
  // The window is a past one: it starts before it ends, and it has ended by the moment of the event
  if (
    Number.isNaN(started.getTime()) ||
    Number.isNaN(ended.getTime()) ||
    ended < started ||
    ended.getTime() > new Date(now).getTime()
  ) {
    return refuse(SvContingencyRefusals.WINDOW_INVALID)
  }
  const sent = salvadorMoment(now)
  const from = salvadorMoment(input.startedAt)
  const to = salvadorMoment(input.endedAt)
  return {
    ok: true,
    event: {
      identificacion: {
        version: SvContingency.VERSION,
        ambiente: SvEnvironmentCodes[issuer.environment],
        codigoGeneracion: input.eventId.toUpperCase(),
        fTransmision: sent.date,
        hTransmision: sent.time
      },
      emisor: {
        nit,
        nombre: issuer.legalName.trim(),
        nombreResponsable: responsible.name,
        tipoDocResponsable: responsible.idType,
        numeroDocResponsable: responsible.idNumber,
        tipoEstablecimiento: kind,
        codEstableMH: establishment,
        codPuntoVentaMH: pointOfSale,
        telefono: phone,
        correo: email
      },
      detalleDTE: listed,
      motivo: {
        fInicio: from.date,
        fFin: to.date,
        hInicio: from.time,
        hFin: to.time,
        tipoContingencia: reason,
        motivoContingencia: reason === SvContingency.REASONS.OTHER ? motive : null
      }
    }
  }
}
