import { FiscalLimits, voidFiscalDocumentSchema } from '@platform/core/domain'

// The reason a person gives to void a fiscal document (and to confirm an issuer change): it goes to the authority's records through the
// provider and to the audit log. One line of visible text, as the api reads it: a line break or an invisible character is `invalid`.
export type VoidReasonProblem = 'required' | 'tooLong' | 'invalid'

export function voidReasonProblem(reason: string): VoidReasonProblem | null {
  const text = reason.trim()
  if (text === '') return 'required'
  if (text.length > FiscalLimits.VOID_REASON_MAX_LENGTH) return 'tooLong'
  return voidFiscalDocumentSchema.safeParse({ reason: text }).success ? null : 'invalid'
}
