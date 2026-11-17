import type { FiscalProviderView } from '@platform/api-client'
import {
  FiscalFieldLimits,
  FiscalLimits,
  type FiscalVoidKind,
  voidFiscalDocumentSchema,
  type VoidFiscalDocumentBody
} from '@platform/core/domain'

// The reason a person gives to void a fiscal document (and to confirm an issuer change): it goes to the authority's records through the
// provider and to the audit log. One line of visible text, as the api reads it: a line break or an invisible character is `invalid`.
export type VoidReasonProblem = 'required' | 'tooLong' | 'invalid'

// `maxLength`: the longest reason the provider's authority takes (its manifest), when it is shorter than the api's own limit
export function voidReasonProblem(reason: string, maxLength?: number): VoidReasonProblem | null {
  const text = reason.trim()
  if (text === '') return 'required'
  if (
    text.length >
    Math.min(maxLength ?? Number.POSITIVE_INFINITY, FiscalLimits.VOID_REASON_MAX_LENGTH)
  ) {
    return 'tooLong'
  }
  return voidFiscalDocumentSchema.safeParse({ reason: text }).success ? null : 'invalid'
}

// What the provider's authority asks besides the reason (its manifest), as the form keeps it
export interface VoidPartyDraft {
  readonly name: string
  readonly idType: string
  readonly idNumber: string
}
export const EMPTY_VOID_PARTY: VoidPartyDraft = { name: '', idType: '', idNumber: '' }

export interface VoidDraft {
  readonly reason: string
  readonly kind: FiscalVoidKind | ''
  readonly responsible: VoidPartyDraft
  readonly requester: VoidPartyDraft
  readonly replacementDocumentId: string
}

// The documents a person may name as the replacement of `original`: the accepted ones that were made to replace it (the api takes no other:
// the authority is told its generation code as the document that takes the place of the invalidated one)
export function replacementCandidates<T extends { id: string; replacesDocumentId: string | null }>(
  documents: readonly T[],
  original: T
): T[] {
  return documents.filter(
    candidate => candidate.id !== original.id && candidate.replacesDocumentId === original.id
  )
}

// What the provider asks, as the api sends it (one definition: the schema of the api-client)
export type VoidInputsView = NonNullable<FiscalProviderView['manifest']['voidInputs']>

export type VoidFormProblem =
  | { readonly field: 'reason'; readonly problem: VoidReasonProblem }
  | { readonly field: 'kind' | 'replacement'; readonly problem: 'required' }
  | { readonly field: 'responsible' | 'requester'; readonly problem: 'required' | 'tooLong' }

const partyProblem = (
  party: VoidPartyDraft,
  identityCodes: readonly string[] | null
): 'required' | 'tooLong' | null => {
  const name = party.name.trim()
  const idType = party.idType.trim()
  const idNumber = party.idNumber.trim()
  if (name === '' || idType === '' || idNumber === '') return 'required'
  // The kind of identity document is one of the provider's list when it names one
  if (identityCodes !== null && !identityCodes.includes(idType)) return 'required'
  return name.length > FiscalLimits.VOID_PARTY_NAME_MAX_LENGTH ||
    idType.length > FiscalFieldLimits.CODE ||
    idNumber.length > FiscalLimits.VOID_PARTY_ID_MAX_LENGTH
    ? 'tooLong'
    : null
}

// What is wrong in the form, the first thing of each field; empty when it can be sent. With no `inputs` the provider asks for the reason alone.
export function voidFormProblems(
  draft: VoidDraft,
  inputs: VoidInputsView | undefined,
  // The codes of the identity documents the provider lists, when it does
  identityCodes: readonly string[] | null = null
): VoidFormProblem[] {
  const problems: VoidFormProblem[] = []
  const reason = voidReasonProblem(draft.reason, inputs?.reasonMaxLength)
  if (reason !== null) problems.push({ field: 'reason', problem: reason })
  if (inputs === undefined) return problems
  if (draft.kind === '') problems.push({ field: 'kind', problem: 'required' })
  if (inputs.requiresParties) {
    const responsible = partyProblem(draft.responsible, identityCodes)
    if (responsible !== null) problems.push({ field: 'responsible', problem: responsible })
    const requester = partyProblem(draft.requester, identityCodes)
    if (requester !== null) problems.push({ field: 'requester', problem: requester })
  }
  if (
    draft.kind !== '' &&
    inputs.kindsWithReplacement?.includes(draft.kind) === true &&
    draft.replacementDocumentId === ''
  ) {
    problems.push({ field: 'replacement', problem: 'required' })
  }
  return problems
}

const trimmed = (party: VoidPartyDraft): VoidPartyDraft => ({
  name: party.name.trim(),
  idType: party.idType.trim(),
  idNumber: party.idNumber.trim()
})

// The body the api takes: only what the provider asks for, so a person who changed their mind about the kind does not send the old
// replacement
export function voidBodyOf(
  draft: VoidDraft,
  inputs: VoidInputsView | undefined
): VoidFiscalDocumentBody {
  const reason = draft.reason.trim()
  if (inputs === undefined || draft.kind === '') return { reason }
  const needsReplacement = inputs.kindsWithReplacement?.includes(draft.kind) === true
  return {
    reason,
    kind: draft.kind,
    ...(inputs.requiresParties
      ? { responsible: trimmed(draft.responsible), requester: trimmed(draft.requester) }
      : {}),
    ...(needsReplacement && draft.replacementDocumentId !== ''
      ? { replacementDocumentId: draft.replacementDocumentId }
      : {})
  }
}
