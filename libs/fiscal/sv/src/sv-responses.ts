import { SvAnswerStates } from './sv-constants'
import { codeOf, recordOf, textOf } from './sv-http'

// What the authority answered to a document, read into the three things the platform cares about. Pure.

// The codes of the reception service that are a fault of the moment and not of the document (Manual Técnico §4.2): 22 the validation of the
// signature is not available, 99 an uncatalogued error. **[TO CONFIRM IN THE SANDBOX]** the manual does not say which codes may be
// retried: this is a judgment, in one place.
export const SvTransientCodes: ReadonlySet<number> = new Set([22, 99])

// The codes of the authentication service: those that say the token is bad (ask for another), and those that say the credentials are
// (never retried). **[TO CONFIRM IN THE SANDBOX]**
// The code that says a document with that generation code (or that control number) is already there: what a document the authority
// accepted before an answer was lost gets when it is sent again. It is not a refusal of the document: the authority is asked about it.
export const SvDuplicateCodes: ReadonlySet<number> = new Set([4])

export const SvTokenCodes: ReadonlySet<number> = new Set([107, 108, 109])
export const SvCredentialCodes: ReadonlySet<number> = new Set([100, 102, 103, 106])

export type SvReception =
  | {
      readonly kind: 'accepted'
      readonly seal: string
      readonly processedAt: string | null
      readonly observations: readonly string[]
      readonly body: Readonly<Record<string, unknown>>
    }
  | {
      readonly kind: 'rejected'
      readonly code: string
      readonly body: Readonly<Record<string, unknown>>
    }
  // The document is already at the authority
  | {
      readonly kind: 'duplicate'
      readonly code: string
      readonly body: Readonly<Record<string, unknown>>
    }
  // A fault of the moment: the answer says nothing about the document
  | { readonly kind: 'transient' }
  // The token was not accepted: another one is asked for and the call is made again, once
  | { readonly kind: 'token' }
  // The credentials were not accepted
  | { readonly kind: 'credentials' }

const codeNumber = (code: string | null): number =>
  code === null ? Number.NaN : Number.parseInt(code, 10)

// The answer to the event of a contingency: taken (with its seal), refused, or a fault of the moment. The event has no duplicate: one sent
// again with the same generation code is the same event, which the authority answers with the seal it gave.
export type SvEventAnswer =
  | {
      readonly kind: 'accepted'
      readonly seal: string
      readonly receivedAt: string | null
      readonly body: Readonly<Record<string, unknown>>
    }
  | {
      readonly kind: 'rejected'
      readonly code: string
      readonly body: Readonly<Record<string, unknown>>
    }
  | { readonly kind: 'transient' }
  | { readonly kind: 'token' }
  | { readonly kind: 'credentials' }

export function classifyEventAnswer(status: number, json: unknown): SvEventAnswer {
  const body = recordOf(json)
  if (status === 401 || status === 403) return { kind: 'token' }
  if (status >= 500) return { kind: 'transient' }
  const seal = textOf(body['selloRecibido'])
  if (
    (body['estado'] === SvAnswerStates.RECEIVED || body['estado'] === SvAnswerStates.PROCESSED) &&
    seal !== null
  ) {
    return {
      kind: 'accepted',
      seal,
      receivedAt: textOf(body['fechaHora']) ?? textOf(body['fhProcesamiento']),
      body
    }
  }
  const code = codeOf(body['codigoMsg'])
  const number = codeNumber(code)
  if (SvTokenCodes.has(number)) return { kind: 'token' }
  if (SvCredentialCodes.has(number)) return { kind: 'credentials' }
  if (body['estado'] === SvAnswerStates.REFUSED || status === 400) {
    if (code === null) return { kind: 'transient' }
    return SvTransientCodes.has(number) ? { kind: 'transient' } : { kind: 'rejected', code, body }
  }
  return { kind: 'transient' }
}

export function classifyReception(status: number, json: unknown): SvReception {
  const body = recordOf(json)
  if (status === 401 || status === 403) return { kind: 'token' }
  if (status >= 500) return { kind: 'transient' }
  const seal = textOf(body['selloRecibido'])
  if (body['estado'] === SvAnswerStates.PROCESSED && seal !== null) {
    const observations = Array.isArray(body['observaciones'])
      ? (body['observaciones'] as unknown[]).filter(
          (item): item is string => typeof item === 'string'
        )
      : []
    return {
      kind: 'accepted',
      seal,
      processedAt: textOf(body['fhProcesamiento']),
      observations,
      body
    }
  }
  const code = codeOf(body['codigoMsg'])
  const number = codeNumber(code)
  if (SvTokenCodes.has(number)) return { kind: 'token' }
  if (SvCredentialCodes.has(number)) return { kind: 'credentials' }
  if (body['estado'] === SvAnswerStates.REFUSED || status === 400) {
    if (code === null) return { kind: 'transient' }
    if (SvDuplicateCodes.has(number)) return { kind: 'duplicate', code, body }
    return SvTransientCodes.has(number) ? { kind: 'transient' } : { kind: 'rejected', code, body }
  }
  // Anything else (a page of a proxy, a shape nobody knows) is not a verdict on the document
  return { kind: 'transient' }
}
