import { ApiError } from '@platform/api-client'
import { FinanceConflicts } from '@platform/core/domain'

// The refusals of the reversal of an entry that carry no code of their own (a 409 `RESOURCE_CONFLICT` names its kind in
// `metadata.conflict`), each with its own sentence under `finance.entry.reverse.conflicts.<kind>`. Null when the error names none of
// them: the caller then shows the message of its code.
const REVERSE_CONFLICTS: readonly string[] = [
  FinanceConflicts.REVERSAL_NOT_REVERSIBLE,
  FinanceConflicts.ENTRY_OWNED_BY_TRANSACTION
]

export function reverseConflictOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null
  const conflict: unknown = error.metadata['conflict']
  return typeof conflict === 'string' && REVERSE_CONFLICTS.includes(conflict) ? conflict : null
}
