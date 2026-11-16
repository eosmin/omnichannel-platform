import { MarginWarning, VatLineKind, VatSide } from '@platform/core/domain'

// What the pages of the VAT report, the margin and the state of the chain read from an answer. Nothing here knows a country: the kinds
// of line and the sides are the closed lists of `libs/core/domain`, and every word is a message. A code the screen does not know (a newer
// api) is drawn as it came, never dropped.

const lookup = <E extends string>(values: Record<string, E>): ReadonlyMap<string, E> =>
  new Map(Object.values(values).map(value => [value as string, value]))

const KIND_KEYS = lookup<VatLineKind>(VatLineKind)
export const vatKindKeyOf = (kind: string): VatLineKind | null => KIND_KEYS.get(kind) ?? null

const SIDE_KEYS = lookup<VatSide>(VatSide)
export const vatSideKeyOf = (side: string): VatSide | null => SIDE_KEYS.get(side) ?? null

const MARGIN_WARNING_KEYS = lookup<MarginWarning>(MarginWarning)
export const marginWarningKeyOf = (warning: string): MarginWarning | null =>
  MARGIN_WARNING_KEYS.get(warning) ?? null

// The balance of a month is output less input: above zero it is owed to the tax office, below it is carried forward
export type VatBalanceKind = 'toPay' | 'carriedForward' | 'even'
export const vatBalanceKind = (balanceCents: number): VatBalanceKind =>
  balanceCents > 0 ? 'toPay' : balanceCents < 0 ? 'carriedForward' : 'even'

// The lines of a month, output side first and then input, each in the order the api sent them
export function vatRowsOfMonth<T extends { month: string; side: string }>(
  rows: readonly T[],
  month: string
): { output: T[]; input: T[]; other: T[] } {
  const inMonth = rows.filter(row => row.month === month)
  const output = inMonth.filter(row => row.side === String(VatSide.OUTPUT))
  const input = inMonth.filter(row => row.side === String(VatSide.INPUT))
  // A side the screen does not know (a newer api) is listed apart, never dropped: the totals of the month count it
  const other = inMonth.filter(row => vatSideKeyOf(row.side) === null)
  return { output, input, other }
}

// The rows of the margin by store, the stores in the order of their name (what the person reads) and the products in the order the api
// sent them (by margin). A store the person has no name for is its short id.
export function marginGroups<T extends { storeId: string }>(
  rows: readonly T[],
  nameOf: (storeId: string) => string
): { storeId: string; name: string; rows: T[] }[] {
  const groups = new Map<string, T[]>()
  for (const row of rows) {
    const list = groups.get(row.storeId)
    if (list === undefined) groups.set(row.storeId, [row])
    else list.push(row)
  }
  return [...groups.entries()]
    .map(([storeId, list]) => ({ storeId, name: nameOf(storeId), rows: list }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.storeId.localeCompare(b.storeId))
}

export const shortStoreId = (storeId: string): string => storeId.slice(0, 8)
