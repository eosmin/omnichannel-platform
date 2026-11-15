import type { EntryOrigin, FinanceSourceType, JournalEntryType } from '@platform/core/domain'

import type { DraftLine } from './entry-rules'

// What a caller hands the posting service: the entry, as the rules of `entry-rules` see it, and who is posting it.
export interface PostEntryInput {
  organizationId: string
  // The accounting date, 'YYYY-MM-DD': it decides the period
  entryDate: string
  type: JournalEntryType
  sourceType?: FinanceSourceType | null
  sourceId?: string | null
  sourceDate?: string | null
  idempotencyKey: string
  memo?: string | null
  origin: EntryOrigin
  // The user of a manual entry; null for the system. The two go together with `origin` (a user's entry has an author, the
  // system's has none) and the service refuses a pair that does not.
  createdBy: string | null
  lines: readonly DraftLine[]
}

export interface PostedEntry {
  id: string
  number: bigint
  entryDate: string
  periodId: string
  type: JournalEntryType
  totalCents: number
  hash: string
  // true when the key had an entry already and this call only found it (nothing was written)
  replayed: boolean
}

export interface ReverseEntryInput {
  organizationId: string
  entryId: string
  // Why: the auditor reads it, so a reversal always says
  memo: string
  // 'YYYY-MM-DD', or null for the date of the original (the first day of the open period when that one is closed)
  entryDate: string | null
  createdBy: string
}
