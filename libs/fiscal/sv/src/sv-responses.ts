import { SvAnswerStates } from './sv-constants'
import { codeOf, recordOf, textOf } from './sv-http'

// What the authority answered to a document, read into the three things the platform cares about. Pure.

// The codes of the reception service that are a fault of the moment and not of the document (Manual Técnico §4.2): 22 the validation of the
// signature is not available, 99 an uncatalogued error, 101 "contact technical support" (Manual Técnico, table of response codes). None of
// them is a verdict on the document, so none starts the 24 hours to correct and send it again. **[TO CONFIRM IN THE SANDBOX]** the manual
// does not say which codes may be retried: this is a judgment, in one place.
export const SvTransientCodes: ReadonlySet<number> = new Set([22, 99, 101])

// The codes of the authentication service: those that say the token is bad (ask for another), and those that say the credentials are
// (never retried). **[TO CONFIRM IN THE SANDBOX]**
// The code that says a document with that generation code (or that control number) is already there: what a document the authority
// accepted before an answer was lost gets when it is sent again. It is not a refusal of the document: the authority is asked about it.
export const SvDuplicateCodes: ReadonlySet<number> = new Set([4])

// The codes that, with the field `identificacion.codigoGeneracion` in the answer, say the refusal is about the generation code of the event itself:
// 4 (a record with that value exists), 6 (the value is not valid) and 25 (Manual Tecnológico, tables of response codes). **[TO CONFIRM IN THE
// SANDBOX]** where the answer names the field (`observaciones` and `descripcionMsg` are read).
export const SvEventCodeFaultCodes: ReadonlySet<number> = new Set([4, 6, 25])
export const SvEventCodeField = 'identificacion.codigoGeneracion'

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
      // What the answer says about when it took the event, in every field it may say it (the first that reads is the one used)
      readonly receivedAtTexts: readonly string[]
      readonly body: Readonly<Record<string, unknown>>
    }
  | {
      readonly kind: 'rejected'
      readonly code: string
      readonly body: Readonly<Record<string, unknown>>
    }
  // The authority holds an event with this generation code already: an answer that was lost, sent again
  | { readonly kind: 'duplicate'; readonly body: Readonly<Record<string, unknown>> }
  | { readonly kind: 'transient' }
  | { readonly kind: 'token' }
  | { readonly kind: 'credentials' }

// What the authority said when it did not take the document or the event: one reading for both, so a new code is learned once. A status that
// says the token is bad, a code that says the credentials are, a fault of the moment, a repeated generation code, or a refusal.
export type SvFailure =
  | { readonly kind: 'token' }
  | { readonly kind: 'credentials' }
  | { readonly kind: 'transient' }
  | {
      readonly kind: 'duplicate'
      readonly code: string
      readonly body: Readonly<Record<string, unknown>>
    }
  | {
      readonly kind: 'rejected'
      readonly code: string
      readonly body: Readonly<Record<string, unknown>>
    }

export function classifyFailure(
  status: number,
  body: Readonly<Record<string, unknown>>
): SvFailure {
  if (status === 401 || status === 403) return { kind: 'token' }
  if (status >= 500) return { kind: 'transient' }
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

export function classifyEventAnswer(status: number, json: unknown): SvEventAnswer {
  const body = recordOf(json)
  const seal = textOf(body['selloRecibido'])
  if (
    status < 400 &&
    (body['estado'] === SvAnswerStates.RECEIVED || body['estado'] === SvAnswerStates.PROCESSED) &&
    seal !== null
  ) {
    return {
      kind: 'accepted',
      seal,
      receivedAtTexts: [textOf(body['fechaHora']), textOf(body['fhProcesamiento'])].filter(
        (text): text is string => text !== null
      ),
      body
    }
  }
  const failure = classifyFailure(status, body)
  return failure.kind === 'duplicate' ? { kind: 'duplicate', body: failure.body } : failure
}

export function classifyReception(status: number, json: unknown): SvReception {
  const body = recordOf(json)
  // A bad token or a fault of the server is never read as an answer, whatever the body says
  if (status === 401 || status === 403) return { kind: 'token' }
  if (status >= 500) return { kind: 'transient' }
  const seal = textOf(body['selloRecibido'])
  // A status of refusal is never an acceptance, whatever the body says (the same reading as the event's)
  if (status < 400 && body['estado'] === SvAnswerStates.PROCESSED && seal !== null) {
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
  return classifyFailure(status, body)
}

// Whether a refusal of an event is about its own generation code. The Normativa (apartado 10) lets a corrected event keep the code of the refused
// one "salvo que el motivo de rechazo se deba a dicho Código": only then is a new one made. A code of those above without the field named is a
// refusal about something else (6 is also a schema error), so the code is kept.
export function eventCodeFault(code: string, body: Readonly<Record<string, unknown>>): boolean {
  if (!SvEventCodeFaultCodes.has(codeNumber(code))) return false
  const observations = Array.isArray(body['observaciones'])
    ? (body['observaciones'] as unknown[])
    : []
  const texts = [textOf(body['descripcionMsg']), ...observations.map(item => textOf(item))]
  return texts.some(
    text => text !== null && text.toLowerCase().includes(SvEventCodeField.toLowerCase())
  )
}
