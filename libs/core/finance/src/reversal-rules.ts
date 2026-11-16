import { dateToDay } from './period-rules'

// A memo is what a person typed with the edges trimmed, and nothing at all when it is blank: so what is stored, what is
// hashed and what a retry sends are the same text
export const normalizedMemo = (memo: string | null | undefined): string | null => {
  const trimmed = memo?.trim() ?? ''
  return trimmed.length === 0 ? null : trimmed
}

// Whether a reversal that exists is the answer to this request. A person's request is a retry only when it is the same one: the same
// author and the same reason, written the way it is stored, and, when a day is named, the day it was written on (no day named is any
// day). The system asks to see the entry reversed, not to write its own words: whoever reversed it, the books are as it wants them,
// and a voided remittance whose entry a person reversed first settles as done instead of failing a posting that blocks the close
export function isRetryOfReversal(
  stored: { createdBy: string | null; memo: string | null; entryDate: Date },
  input: { createdBy: string | null; memo: string; entryDate: string | null }
): boolean {
  if (input.createdBy === null) return true
  return (
    stored.createdBy === input.createdBy &&
    stored.memo === normalizedMemo(input.memo) &&
    (input.entryDate === null || input.entryDate === dateToDay(stored.entryDate))
  )
}
