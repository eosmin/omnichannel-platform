import {
  FiscalConsultState,
  FiscalSubmitOutcome,
  FiscalVoidConsultState
} from '@platform/core/domain'
import type {
  BuiltDocument,
  ConsultResult,
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
  SvCodePatterns,
  SvCredentialKeys,
  SvEndpoints,
  SvEnvironmentCodes,
  SvInvalidation,
  SvProviderDataKeys,
  SvRejectionReasons,
  SvTimeouts,
  SvUserAgent,
  SvVoidRefusals
} from './sv-constants'
import {
  callSv,
  recordOf,
  SvTransportError,
  SvTransportFailures,
  textOf,
  type SvFetch
} from './sv-http'
import { buildInvalidation, invalidatedOf, invalidationCode } from './sv-invalidation'
import { digitsOf } from './sv-parties'
import { classifyReception, type SvReception } from './sv-responses'
import type { SvSigner } from './sv-signer'

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
    code: invalidationCode(ctx.idempotencyKey),
    now: new Date((deps.now ?? Date.now)()).toISOString()
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
      throw new SvTransportError(SvTransportFailures.NETWORK)
    }
    return { voided: false, reason: answer.code, response: answer.body }
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
