// The accesses of the worker to the database that still run with no tenant context (RLS phase 0b). A file of apps/worker/src counts
// its accesses (`prisma.client`, `prisma.transaction`, raw queries) unless it has adopted a context in one of two ways that a reviewer
// can see: it calls `assertSeesEveryRow` (a sweep that proves it sees every row, or does not run), or it carries the marker
// `rls-context:` in a comment, which says that EVERY access of the file runs inside a JobContext that the caller opens. Naming
// JobContext is not enough: a file that wraps one read and leaves ten others bare is still counted.
// The count of each file is frozen in scripts/rls-worker-baseline.json and can only go down; the worker loses BYPASSRLS in the last
// phase, when the baseline is empty.
export type WorkerBaseline = Record<string, number>

const ACCESS = /\bprisma\.(?:client|transaction)\b|\$queryRaw|\$executeRaw/g
const SWEEP = /\bassertSeesEveryRow\(/
const MARKER = /^\s*\/\/ rls-context: /m

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

export function isScanned(file: string): boolean {
  return (
    file.startsWith('apps/worker/src/') &&
    file.endsWith('.ts') &&
    !/\.(spec|integration\.spec)\.ts$/.test(file) &&
    !file.startsWith('apps/worker/src/testing/')
  )
}

// How many accesses of a file run with no context: all of them, unless the file adopted one
export function countContextFree(source: string): number {
  if (MARKER.test(source)) return 0
  const code = stripComments(source)
  if (SWEEP.test(code)) return 0
  return code.match(ACCESS)?.length ?? 0
}

export interface BaselineProblem {
  file: string
  allowed: number
  found: number
}

export function checkAgainstBaseline(
  baseline: WorkerBaseline,
  current: Record<string, number>
): BaselineProblem[] {
  return Object.entries(current)
    .filter(([file, found]) => found > (baseline[file] ?? 0))
    .map(([file, found]) => ({ file, allowed: baseline[file] ?? 0, found }))
}

// The files whose entry can go down or go away
export function slackOf(baseline: WorkerBaseline, current: Record<string, number>): string[] {
  return Object.entries(baseline)
    .filter(([file, allowed]) => (current[file] ?? 0) < allowed)
    .map(([file]) => file)
}

export function lowerBaseline(
  baseline: WorkerBaseline,
  current: Record<string, number>
): WorkerBaseline {
  const problems = checkAgainstBaseline(baseline, current)
  if (problems.length > 0) {
    throw new Error(
      `cannot lower the baseline while these files go up: ${problems.map(p => p.file).join(', ')}`
    )
  }
  const lowered: WorkerBaseline = {}
  for (const [file, allowed] of Object.entries(baseline)) {
    const found = current[file] ?? 0
    if (found > 0) lowered[file] = Math.min(allowed, found)
  }
  return lowered
}

// An entry that rose against main: the file cannot be edited to make the check pass
export function baselineGrowth(previous: WorkerBaseline, next: WorkerBaseline): string[] {
  return Object.entries(next)
    .filter(([file, allowed]) => allowed > (previous[file] ?? 0))
    .map(([file]) => file)
}
