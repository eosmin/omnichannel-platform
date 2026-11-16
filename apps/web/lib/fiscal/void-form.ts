import { FiscalLimits } from '@platform/core/domain'

// The reason a person gives to void a fiscal document: it goes to the authority's records through the provider and to the audit log
export type VoidReasonProblem = 'required' | 'tooLong'

export function voidReasonProblem(reason: string): VoidReasonProblem | null {
  const text = reason.trim()
  if (text === '') return 'required'
  return text.length > FiscalLimits.VOID_REASON_MAX_LENGTH ? 'tooLong' : null
}
