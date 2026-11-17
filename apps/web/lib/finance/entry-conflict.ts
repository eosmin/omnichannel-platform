import { ApiError } from '@platform/api-client'
import { FinanceConflicts } from '@platform/core/domain'

// The refusals of the reversal of an entry that carry no code of their own (a 409 `RESOURCE_CONFLICT` names its kind in
// `metadata.conflict`), each with its own sentence under `finance.entry.reverse.conflicts.<kind>`. Null when the error names none of
// them: the caller then shows the message of its code.
export const REVERSE_CONFLICTS = [
  FinanceConflicts.REVERSAL_NOT_REVERSIBLE,
  FinanceConflicts.ENTRY_OWNED_BY_TRANSACTION
] as const

export type ReverseConflict = (typeof REVERSE_CONFLICTS)[number]

export function reverseConflictOf(error: unknown): ReverseConflict | null {
  if (!(error instanceof ApiError)) return null
  const conflict: unknown = error.metadata['conflict']
  return REVERSE_CONFLICTS.find(known => known === conflict) ?? null
}
