// A category that failed after it had deleted something: what it had deleted is not lost from the report
export class PartialRunError extends Error {
  constructor(
    readonly deleted: number,
    readonly original: unknown
  ) {
    super(original instanceof Error ? original.message : 'a batch of the retention failed')
  }
}

export interface BatchOutcome {
  // Rows the category removed in this run
  deleted: number
  // True when the run stopped on a full batch: more waits for the next run
  more: boolean
}

// Runs `step` (one batch: it returns how many rows it took and how many it removed) until a batch comes back short,
// or `maxBatches` batches were taken. A category never holds the run for more than that: what is left waits for the
// next night, and `more` says so.
export async function inBatches(
  batchSize: number,
  maxBatches: number,
  step: () => Promise<{ taken: number; deleted: number }>
): Promise<BatchOutcome> {
  let deleted = 0
  let more = false
  for (let batch = 0; batch < maxBatches; batch += 1) {
    let result: { taken: number; deleted: number }
    try {
      result = await step()
    } catch (error) {
      throw deleted > 0 ? new PartialRunError(deleted, error) : error
    }
    deleted += result.deleted
    if (result.taken < batchSize) return { deleted, more: false }
    more = true
  }
  return { deleted, more }
}

// The bookkeeping of a run that has categories: each one is run apart, its count and its `more` go in the report, and
// one that throws is logged by `onError` and remembered in `failed`, so the others still run
export function categoryRunner<K extends string>(
  report: Record<K, number> & { more: string[] },
  failed: K[],
  onError: (category: K, error: unknown) => void
): (category: K, work: () => Promise<BatchOutcome>) => Promise<void> {
  // The counts of the categories, as numbers by name (a report type that mixes them with `more` cannot be indexed)
  const counts: Record<string, number> = report
  return async (category, work) => {
    try {
      const outcome = await work()
      counts[category] = outcome.deleted
      if (outcome.more) report.more.push(category)
    } catch (error) {
      failed.push(category)
      if (error instanceof PartialRunError) {
        counts[category] = error.deleted
        onError(category, error.original)
      } else {
        onError(category, error)
      }
    }
  }
}
