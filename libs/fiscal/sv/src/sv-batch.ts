import { FiscalSubmitOutcome, type FiscalEnvironment } from '@platform/core/domain'
import type { FiscalBatchVerdict, StoredFiscalDocument } from '@platform/fiscal/sdk'

import {
  SvAnswerStates,
  SvBatch,
  SvCodePatterns,
  SvEnvironmentCodes,
  SvProviderDataKeys
} from './sv-constants'
import { codeOf, recordOf, textOf } from './sv-http'
import { classifyFailure, SvTransientCodes, type SvFailure } from './sv-responses'

// The lots of the documents of a contingency (Manual Tecnológico V2.0 4.2.2 and 4.3.2). Pure: what is sent, how the answers are read and how the
// verdicts of a lot are matched to its documents. Nothing here reaches the authority.

// The generation code a stored document carries, in capitals as the authority writes it; null when it has none of the shape
export function generationCodeOf(document: StoredFiscalDocument): string | null {
  const code = textOf(recordOf(document.payload['identificacion'])['codigoGeneracion'])
  const upper = code === null ? null : code.toUpperCase()
  return upper !== null && SvCodePatterns.GENERATION_CODE.test(upper) ? upper : null
}

// The documents of a lot read for sending: each one's generation code, and no code twice (the authority would refuse the lot for it).
// Null when the lot is empty, holds more than the authority takes or holds a document that cannot be told.
export function lotCodes(documents: readonly StoredFiscalDocument[]): readonly string[] | null {
  if (documents.length < 1 || documents.length > SvBatch.MAX_DOCUMENTS) return null
  const codes: string[] = []
  for (const document of documents) {
    const code = generationCodeOf(document)
    if (code === null || codes.includes(code)) return null
    codes.push(code)
  }
  return codes
}

// The body of the send: the identifier of the send in capitals, the issuer's tax id without dashes and the signed documents in order
export function batchSendBody(
  environment: FiscalEnvironment,
  nit: string,
  sendId: string,
  signedDocuments: readonly string[]
): Record<string, unknown> {
  return {
    ambiente: SvEnvironmentCodes[environment],
    idEnvio: sendId.toUpperCase(),
    version: SvBatch.VERSION,
    nitEmisor: nit,
    documentos: signedDocuments
  }
}

export type SvBatchSend =
  | {
      readonly kind: 'received'
      readonly batchCode: string
      readonly body: Readonly<Record<string, unknown>>
    }
  | SvFailure

// The answer to the send of a lot: RECIBIDO with the code of the lot (a UUID, in capitals). A status of refusal is never a reception.
export function classifyBatchSend(status: number, json: unknown): SvBatchSend {
  const body = recordOf(json)
  if (status === 401 || status === 403) return { kind: 'token' }
  if (status >= 500) return { kind: 'transient' }
  const batchCode = textOf(body['codigoLote'])
  if (
    status < 400 &&
    body['estado'] === SvAnswerStates.RECEIVED &&
    batchCode !== null &&
    SvCodePatterns.GENERATION_CODE.test(batchCode.toUpperCase())
  ) {
    return { kind: 'received', batchCode, body }
  }
  return classifyFailure(status, body)
}

export type SvBatchConsult =
  | { readonly kind: 'pending' }
  | { readonly kind: 'done'; readonly verdicts: readonly FiscalBatchVerdict[] }
  | { readonly kind: 'token' }
  | { readonly kind: 'transient' }
  // An answer that says it is finished and cannot be matched to the lot (a document it does not hold, one twice, an index that is not its place)
  | { readonly kind: 'invalid' }

const arrayOf = (value: unknown): readonly unknown[] | null => (Array.isArray(value) ? value : null)

function textsOf(value: unknown): readonly string[] {
  return (arrayOf(value) ?? []).filter((item): item is string => typeof item === 'string')
}

// The answer to the consultation of a lot: `procesados` and `rechazados`, each entry with the generation code of its document and its place in the
// lot (`index`). The code is what matches an entry to a document; the place, when the answer gives it, must be the one of that document, or the
// whole answer is not believed. A document that is neither processed nor refused is not in the answer: it is asked about again.
export function classifyBatchConsult(
  status: number,
  json: unknown,
  documents: readonly StoredFiscalDocument[]
): SvBatchConsult {
  if (status === 401 || status === 403) return { kind: 'token' }
  if (status >= 500) return { kind: 'transient' }
  const body = recordOf(json)
  const processed = arrayOf(body['procesados'])
  const refused = arrayOf(body['rechazados'])
  if (status >= 400) return { kind: 'transient' }
  // Not finished: the service answers with neither list
  if (processed === null && refused === null) {
    return codeOf(body['codigoMsg']) === null && body['estado'] === undefined
      ? { kind: 'transient' }
      : { kind: 'pending' }
  }
  const byCode = new Map<string, number>()
  documents.forEach((document, index) => {
    const code = generationCodeOf(document)
    if (code !== null) byCode.set(code, index)
  })
  const verdicts: FiscalBatchVerdict[] = []
  const seen = new Set<number>()
  const entries: { entry: Readonly<Record<string, unknown>>; accepted: boolean }[] = [
    ...(processed ?? []).map(entry => ({ entry: recordOf(entry), accepted: true })),
    ...(refused ?? []).map(entry => ({ entry: recordOf(entry), accepted: false }))
  ]
  for (const { entry, accepted } of entries) {
    const code = textOf(entry['codigoGeneracion'])?.toUpperCase() ?? null
    const index = code === null ? undefined : byCode.get(code)
    if (index === undefined || seen.has(index)) return { kind: 'invalid' }
    const stated = entry['index']
    if (stated !== undefined && stated !== null && stated !== index) return { kind: 'invalid' }
    seen.add(index)
    const document = documents[index]
    if (document === undefined) return { kind: 'invalid' }
    if (accepted) {
      const seal = textOf(entry['selloRecibido'])
      // A "processed" without a seal is not an acceptance: it is not a verdict either, and the document is asked about again
      if (entry['estado'] !== SvAnswerStates.PROCESSED || seal === null) continue
      const identification = recordOf(document.payload['identificacion'])
      const controlNumber = textOf(identification['numeroControl'])
      if (controlNumber === null || !SvCodePatterns.CONTROL_NUMBER.test(controlNumber)) {
        return { kind: 'invalid' }
      }
      const signed = textOf(recordOf(document.providerData)[SvProviderDataKeys.SIGNED_DOCUMENT])
      verdicts.push({
        index,
        outcome: FiscalSubmitOutcome.ACCEPTED,
        externalNumber: controlNumber,
        providerData: {
          [SvProviderDataKeys.GENERATION_CODE]: code,
          [SvProviderDataKeys.CONTROL_NUMBER]: controlNumber,
          [SvProviderDataKeys.RECEPTION_SEAL]: seal,
          [SvProviderDataKeys.ISSUE_DATE]: textOf(identification['fecEmi']),
          [SvProviderDataKeys.PROCESSED_AT]: textOf(entry['fhProcesamiento']),
          [SvProviderDataKeys.OBSERVATIONS]: textsOf(entry['observaciones']),
          // What was sent is what the authority answers for: the signed document the lot carried, kept with the seal
          ...(signed === null ? {} : { [SvProviderDataKeys.SIGNED_DOCUMENT]: signed })
        },
        response: entry
      })
      continue
    }
    const reason = codeOf(entry['codigoMsg'])
    // A fault of the moment is not a verdict on the document (as for a document sent alone: it does not start the time to correct it)
    if (reason === null || SvTransientCodes.has(Number.parseInt(reason, 10))) continue
    verdicts.push({
      index,
      outcome: FiscalSubmitOutcome.REJECTED,
      reason,
      response: entry
    })
  }
  return { kind: 'done', verdicts }
}
