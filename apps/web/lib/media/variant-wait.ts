// A picture is clean as soon as it is scanned, and its variants come a moment later (the worker
// announces both). Until they exist the thread keeps the placeholder of the picture; the realtime event
// of the second announcement refreshes the links of the pictures that wait, and a slow poll covers a
// lost event. The wait is bounded by the number of times the links were read: a job that died never
// makes the variants, and after that many reads the picture reads as a download, as it did before the
// placeholder existed. The count lives in the query, so it is the same however often the picture is
// drawn again; a picture drawn as a download is still repaired by the event if the variants do come,
// because its links stay among those the event refreshes.
export const VariantWait = {
  // The seconds between two reads of the links of a picture whose variants are awaited
  POLL_MS: 15_000,
  // Reads of the links after the first one, polls and events alike, before the picture reads as a
  // download: with the poll alone, two minutes
  MAX_POLLS: 8
} as const

// How long until the links of a file are read again. A picture whose variants are awaited is read
// every POLL_MS, as many times as MAX_POLLS allows (`updates` is the number of reads that succeeded,
// the first included); every other file, and a picture past that number, waits `steadyMs`, the life
// of the links.
export function linksIntervalMs(
  processed: boolean | undefined,
  updates: number,
  steadyMs: number
): number {
  return processed === false && updates <= VariantWait.MAX_POLLS ? VariantWait.POLL_MS : steadyMs
}

// Whether the links were read as many times as the wait allows
export const hasGivenUpWaiting = (updates: number): boolean => updates > VariantWait.MAX_POLLS

export function isWaitingForVariants(state: {
  processed: boolean
  hasPreview: boolean
  givenUp: boolean
}): boolean {
  return !state.processed && !state.hasPreview && !state.givenUp
}
