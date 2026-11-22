// What an entry of a nightly run holds: the count of each category, the categories that stopped on a full batch and the ones that failed.
// Only numbers and the names of categories (constants of the code) go in: never a row, an id of a customer or a text of one.
export interface RunAuditMetadata extends Record<string, unknown> {
  counts: Record<string, number>
  more: string[]
  failed: string[]
}

export function runAuditMetadata(
  report: object,
  more: readonly string[],
  failed: readonly string[]
): RunAuditMetadata {
  const counts: Record<string, number> = {}
  for (const [name, value] of Object.entries(report)) {
    if (typeof value === 'number') counts[name] = value
  }
  return { counts, more: [...more], failed: [...failed] }
}

// A run that deleted nothing, stopped on nothing and failed nowhere leaves no entry (the log line says it ran): one row for each store each
// night would bury the entries that matter
// `notNews`: counters that say what was looked at and not what was done (they do not make an entry by themselves)
export function runHasNews(metadata: RunAuditMetadata, notNews: readonly string[] = []): boolean {
  return (
    metadata.more.length > 0 ||
    metadata.failed.length > 0 ||
    Object.entries(metadata.counts).some(([name, count]) => count > 0 && !notNews.includes(name))
  )
}
