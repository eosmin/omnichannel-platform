// A state or a source from a server newer than this page is not one of ours: the screens draw it as "unknown" and never as an
// empty cell, and offer nothing for it
export function isKnown<T extends string>(values: Record<string, T>, value: string): value is T {
  return Object.values(values).some(known => known === value)
}
