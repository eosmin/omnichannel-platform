import { StorageKeys } from '@platform/api-client'
import { CountLimits } from '@platform/core/domain'

import type { CountEdits } from './count-sheet'

// The quantities typed on a phone that the api has not confirmed (no signal in the aisle, a closed tab) are kept in
// the browser, by count, and sent again when the page is open and online. A draft is only ever what the person
// typed: the api stays the one that decides.

// By person as well as by count: a phone shared in a warehouse must not hand one person's unsent quantities to the next
export const draftKeyOf = (userId: string, countId: string): string =>
  `${StorageKeys.COUNT_DRAFT}:${userId}:${countId}`

// Anything the storage held that is not a map of line id to a whole number or null is thrown away
export function parseDraft(raw: string | null): CountEdits {
  if (raw === null) return {}
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
    const edits: Record<string, number | null> = {}
    for (const [lineId, quantity] of Object.entries(value)) {
      if (
        quantity === null ||
        (typeof quantity === 'number' &&
          Number.isSafeInteger(quantity) &&
          quantity >= 0 &&
          quantity <= CountLimits.MAX_COUNTED_QUANTITY)
      ) {
        edits[lineId] = quantity as number | null
      }
    }
    return edits
  } catch {
    return {}
  }
}

// The part of a Storage the draft uses, so the page gives it `window.localStorage` and the specs a map
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function loadDraft(storage: DraftStorage, userId: string, countId: string): CountEdits {
  try {
    return parseDraft(storage.getItem(draftKeyOf(userId, countId)))
  } catch {
    return {}
  }
}

// An empty draft leaves nothing behind. A storage that refuses (private window, full) is not an error: the quantities
// are still on the screen, only the safety net is missing.
export function saveDraft(
  storage: DraftStorage,
  userId: string,
  countId: string,
  edits: CountEdits
): void {
  try {
    if (Object.keys(edits).length === 0) storage.removeItem(draftKeyOf(userId, countId))
    else storage.setItem(draftKeyOf(userId, countId), JSON.stringify(edits))
  } catch {
    // nothing to do
  }
}

// What the api confirmed leaves the draft; what was typed again while the request was in flight stays
export function withoutConfirmed(edits: CountEdits, sent: CountEdits): CountEdits {
  const rest: Record<string, number | null> = {}
  for (const [lineId, quantity] of Object.entries(edits)) {
    if (!(lineId in sent) || sent[lineId] !== quantity) rest[lineId] = quantity
  }
  return rest
}

// Lines that are not (or no longer) on the sheet are dropped, so a draft of a recounted sheet cannot name a stranger
export function onlyLinesOf(edits: CountEdits, lineIds: ReadonlySet<string>): CountEdits {
  const kept: Record<string, number | null> = {}
  for (const [lineId, quantity] of Object.entries(edits)) {
    if (lineIds.has(lineId)) kept[lineId] = quantity
  }
  return kept
}

// The draft cut in requests of at most `size` lines (the api takes CountLimits.MAX_LINES_PER_UPDATE at a time), in the
// order the lines were first typed
export function chunkEdits(edits: CountEdits, size: number): CountEdits[] {
  const entries = Object.entries(edits)
  const chunks: CountEdits[] = []
  for (let start = 0; start < entries.length; start += size) {
    chunks.push(Object.fromEntries(entries.slice(start, start + size)))
  }
  return chunks
}
