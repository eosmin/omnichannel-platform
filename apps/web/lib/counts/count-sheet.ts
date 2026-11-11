import type { CountLineView } from '@platform/api-client'

// The quantities a person typed that the api may not hold yet, by line id: a number, or null for "take it back".
export type CountEdits = Readonly<Record<string, number | null>>

export const SheetFilters = { ALL: 'all', UNCOUNTED: 'uncounted', COUNTED: 'counted' } as const
export type SheetFilter = (typeof SheetFilters)[keyof typeof SheetFilters]

// What the line holds on the sheet: the quantity typed (even if it is not saved yet) over the one the api has
export function countedOf(line: CountLineView, edits: CountEdits): number | null {
  const edit = edits[line.id]
  return edit === undefined ? line.countedQuantity : edit
}

// Counted minus the snapshot; null while the line is not counted. Sales made during the count are not in it: the
// snapshot is the quantity the count began with, and the variance is measured against that.
export function varianceOfLine(line: CountLineView, edits: CountEdits): number | null {
  const counted = countedOf(line, edits)
  return counted === null ? null : counted - line.expectedQuantity
}

export interface SheetProgress {
  total: number
  counted: number
}

export function progressOf(lines: readonly CountLineView[], edits: CountEdits): SheetProgress {
  return {
    total: lines.length,
    counted: lines.filter(line => countedOf(line, edits) !== null).length
  }
}

// The order of the screen (the api orders by id): by product name, then by variant, so that two counters walking the
// shelves read the same list
export function sortLines(lines: readonly CountLineView[]): CountLineView[] {
  return [...lines].sort(
    (a, b) =>
      a.productName.localeCompare(b.productName) ||
      (a.variantName ?? '').localeCompare(b.variantName ?? '') ||
      a.id.localeCompare(b.id)
  )
}

const normalize = (text: string): string => text.trim().toLocaleLowerCase()

// A line matches when what was typed is in its product, its variant or its sku
export function matchesSearch(line: CountLineView, term: string): boolean {
  const needle = normalize(term)
  if (needle === '') return true
  return [line.productName, line.variantName, line.sku].some(
    field => field !== null && normalize(field).includes(needle)
  )
}

// A scanner types the code and presses Enter: the lines whose sku is exactly that code
export function exactSkuMatches(lines: readonly CountLineView[], code: string): CountLineView[] {
  const needle = normalize(code)
  if (needle === '') return []
  return lines.filter(line => line.sku !== null && normalize(line.sku) === needle)
}

export function visibleLines(
  lines: readonly CountLineView[],
  edits: CountEdits,
  filter: SheetFilter,
  term: string
): CountLineView[] {
  return sortLines(lines).filter(line => {
    if (!matchesSearch(line, term)) return false
    if (filter === SheetFilters.ALL) return true
    const counted = countedOf(line, edits) !== null
    return filter === SheetFilters.COUNTED ? counted : !counted
  })
}

export interface VarianceSummary {
  // Lines whose count differs from the snapshot
  withVariance: number
  // Units the shelves hold more than the snapshot, and fewer
  unitsIn: number
  unitsOut: number
  // Lines nobody counted: left untouched by the apply
  uncounted: number
}

export function varianceSummary(lines: readonly CountLineView[]): VarianceSummary {
  const summary: VarianceSummary = { withVariance: 0, unitsIn: 0, unitsOut: 0, uncounted: 0 }
  for (const line of lines) {
    if (line.variance === null) summary.uncounted += 1
    else if (line.variance > 0) {
      summary.withVariance += 1
      summary.unitsIn += line.variance
    } else if (line.variance < 0) {
      summary.withVariance += 1
      summary.unitsOut += -line.variance
    }
  }
  return summary
}

// The lines to review: those with a variance, the biggest difference first
export function linesWithVariance(lines: readonly CountLineView[]): CountLineView[] {
  return lines
    .filter(line => line.variance !== null && line.variance !== 0)
    .sort(
      (a, b) =>
        Math.abs(b.variance ?? 0) - Math.abs(a.variance ?? 0) ||
        a.productName.localeCompare(b.productName) ||
        a.id.localeCompare(b.id)
    )
}
