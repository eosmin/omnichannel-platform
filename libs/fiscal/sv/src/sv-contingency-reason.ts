import { SvContingency, SvContingencyReasonCodes, SvTransmission } from './sv-constants'

// The reason of a contingency and the words that go with it, read once for the document and for the event (they must agree, so there is
// one rule). The reason is exactly a code of CAT-005, never one that merely starts with a digit; the words of a person travel only with
// the reason "other" (the catalog has no field for them elsewhere), are required there and have a longest.
export type SvContingencyReading =
  | { readonly ok: true; readonly reason: number; readonly motive: string | null }
  | { readonly ok: false; readonly problem: SvContingencyProblem }

export type SvContingencyProblem = 'reason' | 'motive_required' | 'motive_too_long'

export function readContingency(
  reason: string,
  motive: string | null | undefined
): SvContingencyReading {
  if (!SvContingencyReasonCodes.includes(reason)) return { ok: false, problem: 'reason' }
  const code = Number(reason)
  if (code !== SvContingency.REASONS.OTHER) return { ok: true, reason: code, motive: null }
  const words = motive?.trim() ?? ''
  if (words === '') return { ok: false, problem: 'motive_required' }
  if (words.length > SvContingency.MOTIVE_MAX) return { ok: false, problem: 'motive_too_long' }
  return { ok: true, reason: code, motive: words }
}

// What a document made in the deferred model says about its contingency, read the way the event reads it, so a document that is kept is a
// document the event can list: the deferred model and kind of transmission, a reason that is a code of the catalog, and the words of a
// person only where the reason carries them.
export function readDeferred(
  identification: Readonly<Record<string, unknown>>
): { ok: true; reason: number; motive: string | null } | { ok: false } {
  if (
    identification['tipoModelo'] !== SvTransmission.MODEL_DEFERRED ||
    identification['tipoOperacion'] !== SvTransmission.OPERATION_CONTINGENCY ||
    typeof identification['tipoContingencia'] !== 'number'
  ) {
    return { ok: false }
  }
  const motive = identification['motivoContin']
  const read = readContingency(
    String(identification['tipoContingencia']),
    typeof motive === 'string' ? motive : null
  )
  // The words are the ones the rule keeps (trimmed), and absent where the reason has none
  return read.ok && (motive ?? null) === read.motive
    ? { ok: true, reason: read.reason, motive: read.motive }
    : { ok: false }
}
