import { ApiError, type MergeFieldChoices } from '@platform/api-client'
import {
  MergeableFields,
  MergeFieldSources,
  type MergeableField,
  type MergeFieldSource
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

// The conflicts this page can draw: the api may name a field a newer server added
export function knownConflicts(conflicts: readonly string[]): MergeableField[] {
  return MergeableFields.filter(field => conflicts.includes(field))
}

// What the user picked for each conflict, as the body of the merge. A conflict not picked keeps the
// survivor, which is what the api does when a field is left out.
export function fieldChoicesOf(
  conflicts: readonly MergeableField[],
  picks: Partial<Record<MergeableField, MergeFieldSource>>
): MergeFieldChoices {
  return Object.fromEntries(
    conflicts.map(field => [field, picks[field] ?? MergeFieldSources.SURVIVOR])
  )
}

// "Merge instead" (TDD_09 §6): linking a handle that belongs to another customer is refused with the
// id of its owner. Null for any other answer, and for an owner this page cannot use.
export function handleOwnerOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || !error.is(ErrorCodes.RESOURCE_CONFLICT)) return null
  const owner = error.metadata['customerId']
  return typeof owner === 'string' && owner !== '' ? owner : null
}

// A merge can be undone until its date, and only once
export function canUnmerge(
  entry: { unmergeUntil: string; unmergedAt: string | null },
  now: Date
): boolean {
  if (entry.unmergedAt !== null) return false
  const until = new Date(entry.unmergeUntil)
  return !Number.isNaN(until.getTime()) && until.getTime() > now.getTime()
}
