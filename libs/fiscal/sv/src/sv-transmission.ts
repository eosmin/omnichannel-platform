import {
  FiscalAuthorityProbeOutcome,
  FiscalConsultState,
  FiscalContingencyReportOutcome,
  FiscalDeferOutcome,
  FiscalSubmitOutcome,
  FiscalVoidConsultState
} from '@platform/core/domain'
import type {
  BuiltDocument,
  ConsultResult,
  ContingencyReportResult,
  DeferResult,
  FiscalContingencyEvent,
  FiscalIssuerInput,
  FiscalVoidDetails,
  ProviderContext,
  StoredFiscalDocument,
  SubmitResult,
  VoidConsultResult,
  VoidResult
} from '@platform/fiscal/sdk'

import { type SvAuthenticator } from './sv-auth'
import {
  SvAnswerStates,
  SvContingency,
  SvContingencyRefusals,
  SvCodePatterns,
  SvCredentialKeys,
  SvDocumentTypes,
  SvEndpoints,
  SvEnvironmentCodes,
  SvInvalidation,
  SvProbe,
  SvProviderDataKeys,
  SvRejectionReasons,
  SvTimeouts,
  SvUserAgent,
  SvVoidRefusals
} from './sv-constants'
import { buildContingencyEvent } from './sv-contingency'
import { readDeferred } from './sv-contingency-reason'
import {
  callSv,
  codeOf,
  recordOf,
  SvTransportError,
  SvTransportFailures,
  textOf,
  type SvFetch
} from './sv-http'
import { buildInvalidation, invalidatedOf, invalidationCode } from './sv-invalidation'
import { digitsOf } from './sv-parties'
import {
  classifyEventAnswer,
  classifyReception,
  eventCodeFault,
  type SvEventAnswer,
  type SvReception
} from './sv-responses'
import type { SvSigner } from './sv-signer'
import { SALVADOR_OFFSET_HOURS } from './sv-time'

// Sending a document to the authority and asking about one (Manual Técnico §3, §4.2, §4.3). The platform's queue retries, and before it
// sends a document that may already be there it asks (`consult`), so this module makes one attempt per call and never loops by itself.

export interface SvTransmissionDeps {
  readonly auth: SvAuthenticator
  readonly signer: SvSigner
  readonly fetch: SvFetch
  readonly endpoints?: typeof SvEndpoints
  readonly userAgent?: string
  readonly receptionTimeoutMs?: number
  // The clock (milliseconds), for the instant of an invalidation
  readonly now?: () => number
}

interface Identity {
  readonly nit: string
  readonly apiPassword: string
  readonly privateKeyPassword: string
}

// The credentials of the issuer: both passwords, as text. Missing ones are a thing a person fixes.
function identityOf(
  issuer: FiscalIssuerInput,
  credentials: Readonly<Record<string, unknown>>
): Identity | null {
  const apiPassword = textOf(credentials[SvCredentialKeys.API_PASSWORD])
  const privateKeyPassword = textOf(credentials[SvCredentialKeys.CERTIFICATE_PASSWORD])
  const nit = digitsOf(issuer.taxId)
  return apiPassword === null || privateKeyPassword === null || nit === ''
    ? null
    : { nit, apiPassword, privateKeyPassword }
}

// The authority's refusal of a document, with its code and its answer
const refused = (reason: string, response?: Readonly<Record<string, unknown>>): SubmitResult => ({
  outcome: FiscalSubmitOutcome.REJECTED,
  reason,
  ...(response === undefined ? {} : { response })
})

// A refusal of this provider before anything was sent (a credential that is missing or that the authority refused, a document that is
// incomplete): it is not a refusal of the authority, and core gives the attempt back
const notSent = (reason: string): SubmitResult => ({
  outcome: FiscalSubmitOutcome.REJECTED,
  reason,
  neverSent: true
})

// What a document says about itself, read from what was built
function identificationOf(built: BuiltDocument): {
  generationCode: string
  controlNumber: string
  type: string
  version: number
  issueDate: string
} | null {
  const id = recordOf(built.payload['identificacion'])
  const generationCode = textOf(id['codigoGeneracion'])
  const controlNumber = textOf(id['numeroControl'])
  const type = textOf(id['tipoDte'])
  const issueDate = textOf(id['fecEmi'])
  const version = id['version']
  // The control number has the form of the authority (its last digits are the number of the shipment)
  return generationCode === null ||
    controlNumber === null ||
    !SvCodePatterns.CONTROL_NUMBER.test(controlNumber) ||
    type === null ||
    issueDate === null ||
    typeof version !== 'number'
    ? null
    : { generationCode, controlNumber, type, version, issueDate }
}

export async function submitDocument(
  deps: SvTransmissionDeps,
  built: BuiltDocument,
  ctx: ProviderContext
): Promise<SubmitResult> {
  const identity = identityOf(ctx.issuer, ctx.credentials)
  if (identity === null) return notSent(SvRejectionReasons.CREDENTIALS_INCOMPLETE)
  const about = identificationOf(built)
  if (about === null) return notSent(SvRejectionReasons.DOCUMENT_INCOMPLETE)
  const environment = ctx.issuer.environment
  const endpoints = (deps.endpoints ?? SvEndpoints)[environment]

  // The token first: when the authority cannot be reached or the password is refused, the private key password is not sent to the signer
  // for nothing (the login is kept, so the loop below finds it)
  const first = await deps.auth.login(environment, identity.nit, identity.apiPassword)
  if (first.kind === 'rejected') return notSent(SvRejectionReasons.CREDENTIALS_REJECTED)
  if (first.kind === 'unavailable') return { outcome: FiscalSubmitOutcome.UNAVAILABLE }
  const signed = await deps.signer.sign({
    nit: identity.nit,
    privateKeyPassword: identity.privateKeyPassword,
    document: built.payload
  })
  if (signed.kind === 'unavailable') return { outcome: FiscalSubmitOutcome.UNAVAILABLE }
  if (signed.kind === 'rejected') return notSent(SvRejectionReasons.SIGNING_CREDENTIALS_REJECTED)

  // One more call with a new token when the authority says the one it has is not good
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const login = await deps.auth.login(environment, identity.nit, identity.apiPassword)
    if (login.kind === 'rejected') return notSent(SvRejectionReasons.CREDENTIALS_REJECTED)
    if (login.kind === 'unavailable') return { outcome: FiscalSubmitOutcome.UNAVAILABLE }
    let reception: SvReception
    try {
      const result = await callSv(
        deps.fetch,
        `${endpoints.baseUrl}${endpoints.reception}`,
        {
          method: 'POST',
          headers: {
            Authorization: login.token,
            'Content-Type': 'application/json',
            'User-Agent': deps.userAgent ?? SvUserAgent
          },
          body: JSON.stringify({
            ambiente: SvEnvironmentCodes[environment],
            // A number of the shipment "at the discretion" of the issuer: the correlative of the document
            idEnvio: Number.parseInt(about.controlNumber.slice(-9), 10),
            version: about.version,
            tipoDte: about.type,
            documento: signed.jws,
            codigoGeneracion: about.generationCode
          })
        },
        deps.receptionTimeoutMs ?? SvTimeouts.RECEPTION_MS
      )
      reception = classifyReception(result.status, result.json)
    } catch (error) {
      // No answer: the queue asks the authority about the document before it sends it again
      if (error instanceof SvTransportError) return { outcome: FiscalSubmitOutcome.UNAVAILABLE }
      throw error
    }
    if (reception.kind === 'token') {
      deps.auth.forget(environment, identity.nit, identity.apiPassword, login.token)
      continue
    }
    if (reception.kind === 'credentials') return notSent(SvRejectionReasons.CREDENTIALS_REJECTED)
    if (reception.kind === 'transient') return { outcome: FiscalSubmitOutcome.UNAVAILABLE }
    if (reception.kind === 'duplicate') {
      // Already there (its answer was lost): the authority says what it has. If it cannot say now, the queue asks again.
      const found = await consultDocument(deps, built, ctx, signed.jws).catch(() => null)
      if (found === null) return { outcome: FiscalSubmitOutcome.UNAVAILABLE }
      if (found.state === FiscalConsultState.ACCEPTED) {
        return {
          outcome: FiscalSubmitOutcome.ACCEPTED,
          externalNumber: found.externalNumber,
          ...(found.providerData === undefined ? {} : { providerData: found.providerData }),
          ...(found.response === undefined ? {} : { response: found.response })
        }
      }
      // It says it is there and cannot say what it has (not yet visible, a fault of the moment, another document holding the number): the
      // queue asks again; after its attempts a person is told. A document the authority holds is never marked refused for that.
      return { outcome: FiscalSubmitOutcome.UNAVAILABLE }
    }
    if (reception.kind === 'rejected') return refused(reception.code, reception.body)
    return {
      outcome: FiscalSubmitOutcome.ACCEPTED,
      externalNumber: about.controlNumber,
      providerData: {
        [SvProviderDataKeys.GENERATION_CODE]: about.generationCode,
        [SvProviderDataKeys.CONTROL_NUMBER]: about.controlNumber,
        [SvProviderDataKeys.RECEPTION_SEAL]: reception.seal,
        [SvProviderDataKeys.ISSUE_DATE]: about.issueDate,
        [SvProviderDataKeys.PROCESSED_AT]: reception.processedAt,
        [SvProviderDataKeys.OBSERVATIONS]: reception.observations,
        // The signed document the authority received: the evidence of what was sent, and what a delivery to the receiver carries
        [SvProviderDataKeys.SIGNED_DOCUMENT]: signed.jws
      },
      response: reception.body
    }
  }
  // The token was refused twice: not a verdict on the document
  return { outcome: FiscalSubmitOutcome.UNAVAILABLE }
}

// Whether the authority has a document, by its generation code. Anything that is not a clear "processed" is UNKNOWN, and a call that cannot be
// made throws: the queue then asks again later, and a document that may be there is never sent a second time.
export async function consultDocument(
  deps: SvTransmissionDeps,
  built: BuiltDocument,
  ctx: ProviderContext,
  // The signed document the caller just sent, when it has it
  signedDocument?: string
): Promise<ConsultResult> {
  const identity = identityOf(ctx.issuer, ctx.credentials)
  const about = identificationOf(built)
  // Nothing can be asked without them: the document goes to `submit`, which says exactly what is missing
  if (identity === null || about === null) return { state: FiscalConsultState.UNKNOWN }
  const environment = ctx.issuer.environment
  const endpoints = (deps.endpoints ?? SvEndpoints)[environment]
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const login = await deps.auth.login(environment, identity.nit, identity.apiPassword)
    // A password the authority refused is for `submit` to report; an authority that cannot be reached is not an answer
    if (login.kind === 'rejected') return { state: FiscalConsultState.UNKNOWN }
    if (login.kind === 'unavailable') throw new SvTransportError(SvTransportFailures.NETWORK)
    const result = await callSv(
      deps.fetch,
      `${endpoints.baseUrl}${endpoints.consult}`,
      {
        method: 'POST',
        headers: {
          Authorization: login.token,
          'Content-Type': 'application/json',
          'User-Agent': deps.userAgent ?? SvUserAgent
        },
        body: JSON.stringify({
          nitEmisor: identity.nit,
          tdte: about.type,
          codigoGeneracion: about.generationCode
        })
      },
      deps.receptionTimeoutMs ?? SvTimeouts.RECEPTION_MS
    )
    const reception = classifyReception(result.status, result.json)
    if (reception.kind === 'token') {
      deps.auth.forget(environment, identity.nit, identity.apiPassword, login.token)
      continue
    }
    if (reception.kind === 'accepted') {
      return {
        state: FiscalConsultState.ACCEPTED,
        externalNumber: about.controlNumber,
        providerData: {
          [SvProviderDataKeys.GENERATION_CODE]: about.generationCode,
          [SvProviderDataKeys.CONTROL_NUMBER]: about.controlNumber,
          [SvProviderDataKeys.RECEPTION_SEAL]: reception.seal,
          [SvProviderDataKeys.ISSUE_DATE]: about.issueDate,
          [SvProviderDataKeys.PROCESSED_AT]: reception.processedAt,
          [SvProviderDataKeys.OBSERVATIONS]: reception.observations,
          // The signed document is kept only when this call signed and sent it (a duplicate of its own attempt): one found later is not
          // signed again, because a renewed certificate would sign something the authority never received
          ...(signedDocument === undefined
            ? {}
            : { [SvProviderDataKeys.SIGNED_DOCUMENT]: signedDocument })
        },
        response: reception.body
      }
    }
    // The authority failed (5xx): no answer. Any other answer that is not "processed" (a 404, a page, a refusal that says the document is
    // not there) is "I do not know": sending again is safe, because a document that is there is refused as a duplicate and consulted
    if (result.status >= 500) throw new SvTransportError(SvTransportFailures.NETWORK)
    return { state: FiscalConsultState.UNKNOWN }
  }
  throw new SvTransportError(SvTransportFailures.NETWORK)
}

// What an invalidation of this provider is told when it stops before the authority: a code of ours, nothing was sent
const notVoided = (reason: string): VoidResult => ({ voided: false, reason })

// Invalidates an accepted document (Manual Técnico §4.4): the event is built, signed and sent. An answer the authority gives is a verdict
// (voided, or refused with its code); no answer (the network, a fault of the moment) throws, and core asks `consultVoid` before it tells the
// person to try again. One attempt per call.
export async function voidDocument(
  deps: SvTransmissionDeps,
  doc: StoredFiscalDocument,
  reason: string,
  ctx: ProviderContext,
  details: FiscalVoidDetails | undefined
): Promise<VoidResult> {
  const identity = identityOf(ctx.issuer, ctx.credentials)
  if (identity === null) return notVoided(SvVoidRefusals.CREDENTIALS_INCOMPLETE)
  const built = buildInvalidation({
    doc,
    issuer: ctx.issuer,
    reason,
    details,
    // The same request is the same event: a second call after a lost answer carries the generation code the authority has already seen
    // The event a person corrects and sends again keeps the code and the moment it had (Normativa DTE, apartado 10): core gives them, fixed at
    // the first attempt. The deadline, the date and the hour of the event are those of that moment, not of the retry.
    code: ctx.voidEvent?.code ?? invalidationCode(ctx.idempotencyKey),
    now: ctx.voidEvent?.at ?? new Date((deps.now ?? Date.now)()).toISOString()
  })
  if (!built.ok) return notVoided(built.reason)
  const environment = ctx.issuer.environment
  const endpoints = (deps.endpoints ?? SvEndpoints)[environment]

  // The token first, as `submitDocument` does: a refused password never reaches the signer (the login is kept, so the loop finds it)
  const first = await deps.auth.login(environment, identity.nit, identity.apiPassword)
  if (first.kind === 'rejected') return notVoided(SvVoidRefusals.CREDENTIALS_REJECTED)
  if (first.kind === 'unavailable') throw new SvTransportError(SvTransportFailures.NETWORK)
  const signed = await deps.signer.sign({
    nit: identity.nit,
    privateKeyPassword: identity.privateKeyPassword,
    document: built.event
  })
  if (signed.kind === 'unavailable') throw new SvTransportError(SvTransportFailures.NETWORK)
  if (signed.kind === 'rejected') return notVoided(SvVoidRefusals.SIGNING_CREDENTIALS_REJECTED)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const login = await deps.auth.login(environment, identity.nit, identity.apiPassword)
    if (login.kind === 'rejected') return notVoided(SvVoidRefusals.CREDENTIALS_REJECTED)
    if (login.kind === 'unavailable') throw new SvTransportError(SvTransportFailures.NETWORK)
    const result = await callSv(
      deps.fetch,
      `${endpoints.baseUrl}${endpoints.invalidation}`,
      {
        method: 'POST',
        headers: {
          Authorization: login.token,
          'Content-Type': 'application/json',
          'User-Agent': deps.userAgent ?? SvUserAgent
        },
        body: JSON.stringify({
          ambiente: SvEnvironmentCodes[environment],
          // The number of the shipment "at the discretion" of the issuer: the one of the document being invalidated
          idEnvio: Number.parseInt(built.original.controlNumber.slice(-9), 10),
          version: SvInvalidation.VERSION,
          documento: signed.jws
        })
      },
      deps.receptionTimeoutMs ?? SvTimeouts.RECEPTION_MS
    )
    const answer = classifyReception(result.status, result.json)
    if (answer.kind === 'token') {
      deps.auth.forget(environment, identity.nit, identity.apiPassword, login.token)
      continue
    }
    if (answer.kind === 'credentials') return notVoided(SvVoidRefusals.CREDENTIALS_REJECTED)
    if (answer.kind === 'transient') throw new SvTransportError(SvTransportFailures.NETWORK)
    if (answer.kind === 'accepted') return { voided: true, response: answer.body }
    if (answer.kind === 'duplicate') {
      // The authority has this very event (an earlier call whose answer was lost): it is asked what it holds, and a document it has
      // invalidated is the voided one this call wanted. Anything else is no answer yet: core asks again, nothing is told as refused.
      const held = await consultVoided(deps, doc, ctx)
      if (held.state === FiscalVoidConsultState.VOIDED) {
        return { voided: true, ...(held.response === undefined ? {} : { response: held.response }) }
      }
      // It holds the document as processed: the event is not in effect, and the person is told the authority's code
      if (held.state === FiscalVoidConsultState.NOT_VOIDED) {
        return {
          voided: false,
          reason: answer.code,
          response: answer.body,
          byAuthority: true,
          // The authority holds a record with this event's code and the document is still processed: the code belongs to something else, and
          // that is so whether or not the answer names the field
          eventCodeRefused: true
        }
      }
      throw new SvTransportError(SvTransportFailures.NETWORK)
    }
    return {
      voided: false,
      reason: answer.code,
      response: answer.body,
      byAuthority: true,
      ...(eventCodeFault(answer.code, answer.body) ? { eventCodeRefused: true } : {})
    }
  }
  // The token was refused twice: not a verdict on the document
  throw new SvTransportError(SvTransportFailures.NETWORK)
}

// Whether the authority has the document invalidated already, by asking for the document (its state says so). Anything that is not a clear
// "invalidated" or a clear "still processed" is UNKNOWN: a request is then made, and the authority refuses what is already done.
export async function consultVoided(
  deps: SvTransmissionDeps,
  doc: StoredFiscalDocument,
  ctx: ProviderContext
): Promise<VoidConsultResult> {
  const identity = identityOf(ctx.issuer, ctx.credentials)
  const original = invalidatedOf(doc)
  if (identity === null || original === null) return { state: FiscalVoidConsultState.UNKNOWN }
  const environment = ctx.issuer.environment
  const endpoints = (deps.endpoints ?? SvEndpoints)[environment]
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const login = await deps.auth.login(environment, identity.nit, identity.apiPassword)
    if (login.kind === 'rejected') return { state: FiscalVoidConsultState.UNKNOWN }
    if (login.kind === 'unavailable') throw new SvTransportError(SvTransportFailures.NETWORK)
    const result = await callSv(
      deps.fetch,
      `${endpoints.baseUrl}${endpoints.consult}`,
      {
        method: 'POST',
        headers: {
          Authorization: login.token,
          'Content-Type': 'application/json',
          'User-Agent': deps.userAgent ?? SvUserAgent
        },
        body: JSON.stringify({
          nitEmisor: identity.nit,
          tdte: original.type,
          codigoGeneracion: original.generationCode
        })
      },
      deps.receptionTimeoutMs ?? SvTimeouts.RECEPTION_MS
    )
    const body = recordOf(result.json)
    if (result.status === 401 || result.status === 403) {
      deps.auth.forget(environment, identity.nit, identity.apiPassword, login.token)
      continue
    }
    if (result.status >= 500) throw new SvTransportError(SvTransportFailures.NETWORK)
    // "Invalidated" is believed only when the answer is about this document: a body that names another one (or none) says nothing of it
    if (
      body['estado'] === SvAnswerStates.INVALIDATED &&
      textOf(body['codigoGeneracion'])?.toUpperCase() === original.generationCode
    ) {
      return { state: FiscalVoidConsultState.VOIDED, response: body }
    }
    return body['estado'] === SvAnswerStates.PROCESSED
      ? { state: FiscalVoidConsultState.NOT_VOIDED }
      : { state: FiscalVoidConsultState.UNKNOWN }
  }
  throw new SvTransportError(SvTransportFailures.NETWORK)
}

// A document made in contingency (the deferred model): it is signed and its signed form is kept, and nothing is sent. The authority is what
// is down, so no login is asked for; only the signature. A document that cannot be signed is not made in contingency either.
export async function deferDocument(
  deps: SvTransmissionDeps,
  built: BuiltDocument,
  ctx: ProviderContext
): Promise<DeferResult> {
  const privateKeyPassword = textOf(ctx.credentials[SvCredentialKeys.CERTIFICATE_PASSWORD])
  const nit = digitsOf(ctx.issuer.taxId)
  if (privateKeyPassword === null || nit === '') {
    return {
      outcome: FiscalDeferOutcome.REJECTED,
      reason: SvContingencyRefusals.CREDENTIALS_INCOMPLETE
    }
  }
  const about = identificationOf(built)
  const id = recordOf(built.payload['identificacion'])
  // Only a document built for the deferred model is kept: it says so (model 2, operation 2), and it is the issuer's own: the key that signs
  // it is the one of the NIT in the document
  if (
    about === null ||
    // Read the way the event reads it, and of this environment: a document the event could not list is not kept (it would refuse the whole
    // lot with it)
    !readDeferred(id).ok ||
    !SvCodePatterns.GENERATION_CODE.test(about.generationCode) ||
    id['ambiente'] !== SvEnvironmentCodes[ctx.issuer.environment] ||
    digitsOf(textOf(recordOf(built.payload['emisor'])['nit']) ?? '') !== nit
  ) {
    return {
      outcome: FiscalDeferOutcome.REJECTED,
      reason: SvContingencyRefusals.DOCUMENT_INCOMPLETE
    }
  }
  const signed = await deps.signer.sign({ nit, privateKeyPassword, document: built.payload })
  if (signed.kind === 'unavailable') return { outcome: FiscalDeferOutcome.UNAVAILABLE }
  if (signed.kind === 'rejected') {
    return {
      outcome: FiscalDeferOutcome.REJECTED,
      reason: SvContingencyRefusals.SIGNING_CREDENTIALS_REJECTED
    }
  }
  return {
    outcome: FiscalDeferOutcome.DEFERRED,
    providerData: {
      [SvProviderDataKeys.GENERATION_CODE]: about.generationCode,
      [SvProviderDataKeys.CONTROL_NUMBER]: about.controlNumber,
      [SvProviderDataKeys.ISSUE_DATE]: about.issueDate,
      // What a delivery to the receiver carries until the authority gives its seal
      [SvProviderDataKeys.SIGNED_DOCUMENT]: signed.jws
    }
  }
}

// The authority's time of an answer, "dd/MM/yyyy HH:mm:ss" in the time of El Salvador (UTC-6), as an instant; null when it is not that shape
export function authorityInstant(text: string | null): number | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(text ?? '')
  if (match === null) return null
  const [day, month, year, hour, minute, second] = match.slice(1).map(Number)
  if (
    day === undefined ||
    month === undefined ||
    year === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return null
  }
  const instant = Date.UTC(year, month - 1, day, hour + SALVADOR_OFFSET_HOURS, minute, second)
  // A field out of its range would roll over into another instant: the date is read back and must be the one that was written
  const back = new Date(instant - SALVADOR_OFFSET_HOURS * 3_600_000)
  return back.getUTCFullYear() === year &&
    back.getUTCMonth() === month - 1 &&
    back.getUTCDate() === day &&
    back.getUTCHours() === hour &&
    back.getUTCMinutes() === minute &&
    back.getUTCSeconds() === second
    ? instant
    : null
}

// Whether the authority answers now (D2c, D2d). Two things are asked, in this order. A fresh login: the authentication service is the one every
// call of this provider needs first, and a token kept in memory is never taken for an answer. Then, with that token, the reception side: a
// consultation of a document by a generation code that cannot exist (`SvProbe`). The manual's documented calls of the reception service all carry
// a document, and a document is never sent to find out whether the service is up (it would take a number, ask for a seal and leave a trace in
// the books of the authority); the consultation is read-only, carries none, and any answer in the form of the authority (a document found, or
// "there is no such document") says the side that receives the documents is up. A fault of the service (5xx), a token it does not take, no
// connection, no answer in time, or a page that is not the authority's, is no answer: the contingency goes on. A password the authority refused
// is reported as such and never asked again by the caller.
export async function probeAuthority(
  deps: SvTransmissionDeps,
  ctx: ProviderContext
): Promise<FiscalAuthorityProbeOutcome> {
  const identity = identityOf(ctx.issuer, ctx.credentials)
  if (identity === null) return FiscalAuthorityProbeOutcome.INCONCLUSIVE
  const environment = ctx.issuer.environment
  const login = await deps.auth.probe(environment, identity.nit, identity.apiPassword)
  if (login.kind === 'rejected') return FiscalAuthorityProbeOutcome.CREDENTIALS_REJECTED
  if (login.kind !== 'token') return FiscalAuthorityProbeOutcome.UNREACHABLE
  const endpoints = (deps.endpoints ?? SvEndpoints)[environment]
  try {
    const result = await callSv(
      deps.fetch,
      `${endpoints.baseUrl}${endpoints.consult}`,
      {
        method: 'POST',
        headers: {
          Authorization: login.token,
          'Content-Type': 'application/json',
          'User-Agent': deps.userAgent ?? SvUserAgent
        },
        body: JSON.stringify({
          nitEmisor: identity.nit,
          tdte: SvDocumentTypes.INVOICE,
          codigoGeneracion: SvProbe.GENERATION_CODE
        })
      },
      deps.receptionTimeoutMs ?? SvTimeouts.RECEPTION_MS
    )
    if (result.status === 401 || result.status === 403) {
      // The token it gave a moment ago is not taken by the side that receives: that is not an answer about the documents
      deps.auth.forget(environment, identity.nit, identity.apiPassword, login.token)
      return FiscalAuthorityProbeOutcome.UNREACHABLE
    }
    // Only what the authority itself says counts: a document found (200), or a refusal (400, as for a document that does not exist), with BOTH
    // marks of its answers: a state of its own words and a code of three digits. A 404, a 408, a 429, a body that is not a record, or a gateway
    // or a WAF that answers 400 with a state or a message of its own, is not proof that the documents are taken, so the contingency goes on
    const body = recordOf(result.json)
    const state = textOf(body['estado'])
    const code = codeOf(body['codigoMsg'])
    const speaksAsTheAuthority =
      state !== null &&
      SvProbe.ANSWER_STATES.includes(state) &&
      code !== null &&
      SvCodePatterns.RESPONSE_CODE.test(code)
    return (result.status === 200 || result.status === 400) && speaksAsTheAuthority
      ? FiscalAuthorityProbeOutcome.REACHABLE
      : FiscalAuthorityProbeOutcome.UNREACHABLE
  } catch (error) {
    if (error instanceof SvTransportError) return FiscalAuthorityProbeOutcome.UNREACHABLE
    throw error
  }
}

// Reports a contingency: the event is signed and sent, and the window to send its documents runs from the moment the authority took it. The
// window counts from the earlier of the authority's own time and ours, so it is never longer than the authority's.
export async function reportContingencyEvent(
  deps: SvTransmissionDeps,
  event: FiscalContingencyEvent,
  ctx: ProviderContext
): Promise<ContingencyReportResult> {
  const identity = identityOf(ctx.issuer, ctx.credentials)
  if (identity === null) {
    return {
      outcome: FiscalContingencyReportOutcome.REJECTED,
      reason: SvContingencyRefusals.CREDENTIALS_INCOMPLETE,
      neverSent: true
    }
  }
  const clock = deps.now ?? Date.now
  const built = buildContingencyEvent(event, ctx.issuer, new Date(clock()).toISOString())
  if (!built.ok) {
    return {
      outcome: FiscalContingencyReportOutcome.REJECTED,
      reason: built.reason,
      neverSent: true
    }
  }
  const environment = ctx.issuer.environment
  const endpoints = (deps.endpoints ?? SvEndpoints)[environment]
  const first = await deps.auth.login(environment, identity.nit, identity.apiPassword)
  if (first.kind === 'rejected') {
    return {
      outcome: FiscalContingencyReportOutcome.REJECTED,
      reason: SvContingencyRefusals.CREDENTIALS_REJECTED,
      neverSent: true
    }
  }
  if (first.kind === 'unavailable') return { outcome: FiscalContingencyReportOutcome.UNAVAILABLE }
  const signed = await deps.signer.sign({
    nit: identity.nit,
    privateKeyPassword: identity.privateKeyPassword,
    document: built.event
  })
  if (signed.kind === 'unavailable') return { outcome: FiscalContingencyReportOutcome.UNAVAILABLE }
  if (signed.kind === 'rejected') {
    return {
      outcome: FiscalContingencyReportOutcome.REJECTED,
      reason: SvContingencyRefusals.SIGNING_CREDENTIALS_REJECTED,
      neverSent: true
    }
  }
  // What is kept of the event, the same for an event taken now and one the authority held already
  const kept = {
    [SvProviderDataKeys.GENERATION_CODE]: String(
      recordOf(built.event['identificacion'])['codigoGeneracion']
    ),
    // The documents the event listed, for whoever reads the record
    [SvProviderDataKeys.DOCUMENTS]: (built.event['detalleDTE'] as unknown[]).length,
    [SvProviderDataKeys.WINDOW_HOURS]: SvContingency.TRANSMIT_WITHIN_HOURS
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const login = await deps.auth.login(environment, identity.nit, identity.apiPassword)
    if (login.kind === 'rejected') {
      return {
        outcome: FiscalContingencyReportOutcome.REJECTED,
        reason: SvContingencyRefusals.CREDENTIALS_REJECTED,
        neverSent: true
      }
    }
    if (login.kind === 'unavailable') return { outcome: FiscalContingencyReportOutcome.UNAVAILABLE }
    let answer: SvEventAnswer
    try {
      const result = await callSv(
        deps.fetch,
        `${endpoints.baseUrl}${endpoints.contingency}`,
        {
          method: 'POST',
          headers: {
            Authorization: login.token,
            'Content-Type': 'application/json',
            'User-Agent': deps.userAgent ?? SvUserAgent
          },
          body: JSON.stringify({ nit: identity.nit, documento: signed.jws })
        },
        deps.receptionTimeoutMs ?? SvTimeouts.RECEPTION_MS
      )
      answer = classifyEventAnswer(result.status, result.json)
    } catch (error) {
      if (error instanceof SvTransportError) {
        return { outcome: FiscalContingencyReportOutcome.UNAVAILABLE }
      }
      throw error
    }
    if (answer.kind === 'token') {
      deps.auth.forget(environment, identity.nit, identity.apiPassword, login.token)
      continue
    }
    if (answer.kind === 'credentials') {
      return {
        outcome: FiscalContingencyReportOutcome.REJECTED,
        reason: SvContingencyRefusals.CREDENTIALS_REJECTED,
        neverSent: true
      }
    }
    if (answer.kind === 'transient') return { outcome: FiscalContingencyReportOutcome.UNAVAILABLE }
    // The event is the authority's already (the answer of an earlier call was lost): it is taken, as the port says an event it holds is
    // answered; the seal is not here (the authority did not repeat it).
    // **[TO CONFIRM IN THE SANDBOX]** whether the authority repeats the seal, and the code it gives a repeated event.
    if (answer.kind === 'duplicate') {
      return {
        outcome: FiscalContingencyReportOutcome.ACCEPTED,
        // The event was sent after its window ended, so it cannot have been taken before: the end of the window is the earliest instant the
        // authority can have taken it, and a window counted from it is never longer than the authority's
        receivedAt: event.endedAt,
        providerData: { ...kept, [SvProviderDataKeys.DUPLICATE]: true },
        response: answer.body
      }
    }
    if (answer.kind === 'rejected') {
      return {
        outcome: FiscalContingencyReportOutcome.REJECTED,
        reason: answer.code,
        response: answer.body
      }
    }
    const now = clock()
    // The first of the fields the answer says it in that reads as a date: the others may be in a shape nobody knows yet
    const theirs =
      answer.receivedAtTexts
        .map(text => authorityInstant(text))
        .find((instant): instant is number => instant !== null) ?? null
    return {
      outcome: FiscalContingencyReportOutcome.ACCEPTED,
      receivedAt: new Date(theirs === null ? now : Math.min(theirs, now)).toISOString(),
      providerData: { ...kept, [SvProviderDataKeys.RECEPTION_SEAL]: answer.seal },
      response: answer.body
    }
  }
  return { outcome: FiscalContingencyReportOutcome.UNAVAILABLE }
}
