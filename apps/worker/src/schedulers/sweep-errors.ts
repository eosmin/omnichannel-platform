import { ConversationConflictReasons } from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'
import { ConversationSweep } from '@platform/core/queues'

// What a sweep gets when a person changed the conversation after the sweep chose it: not a fault
export function isNoLongerDue(error: unknown): boolean {
  return (
    error instanceof PlatformException &&
    error.code === ErrorCodes.RESOURCE_CONFLICT &&
    error.metadata?.['reason'] === ConversationConflictReasons.NO_LONGER_DUE
  )
}

export interface SweepBatch {
  // How many conversations the batch found due, and how many of them it changed
  fetched: number
  changed: number
}

// The loop of a sweep run: batches while one comes back full, up to MAX_BATCHES. The ids that failed
// in this run are shared with the next batches, which leave them out, so they cannot hold back the
// healthy ones. `limited` is true when the run stopped at the limit with more possibly waiting.
export async function runBatches(
  batch: (failed: Set<string>) => Promise<SweepBatch>
): Promise<{ changed: number; limited: boolean }> {
  const failed = new Set<string>()
  let changed = 0
  for (let count = 0; count < ConversationSweep.MAX_BATCHES; count += 1) {
    const result = await batch(failed)
    changed += result.changed
    if (result.fetched < ConversationSweep.BATCH) return { changed, limited: false }
  }
  return { changed, limited: true }
}
