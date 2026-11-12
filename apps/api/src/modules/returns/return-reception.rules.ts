import { CustomerLimits } from '@platform/core/domain'

// The reason of a flag when the agent wrote none: the note of the package, in one line that fits the flag. Neither: no reason, and a
// customer is not flagged without one.
export function flagReasonOf(item: {
  flagReason: string | null
  note: string | null
}): string | null {
  const own = item.flagReason?.trim()
  if (own !== undefined && own !== '') return own
  const fromNote = (item.note ?? '').replace(/\s+/g, ' ').trim()
  return fromNote === '' ? null : fromNote.slice(0, CustomerLimits.CAUTION_REASON_MAX_LENGTH)
}
